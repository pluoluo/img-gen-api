"""Durable canvas projects. Revisions are append-only; image resources are immutable."""
import hashlib
import io
import json
import os
import re
import sqlite3
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image


class ProjectConflict(Exception):
    pass


def storage_dir():
    return Path(os.environ.get("CANVAS_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "canvas"))


@contextmanager
def database():
    root = storage_dir()
    root.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(root / "projects.sqlite3", timeout=30) as conn:
        conn.row_factory = sqlite3.Row
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL, head_revision INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS revisions (
                project_id TEXT NOT NULL, revision INTEGER NOT NULL,
                created_at TEXT NOT NULL, fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL,
                image_count INTEGER NOT NULL, PRIMARY KEY(project_id, revision)
            );
        """)
        yield conn


def validate_id(value):
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value):
        raise ValueError("画布 ID 格式不正确")


def save_asset(raw):
    if len(raw) > 40 * 1024 * 1024:
        raise ValueError("画布图片超过 40 MB，请减小图片尺寸")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG" or image.width * image.height > 40_000_000:
                raise ValueError("画布资源需要 PNG，且不能超过 4000 万像素")
            image.load()
            width, height = image.size
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError("画布图片损坏或格式不支持") from exc
    digest = hashlib.sha256(raw).hexdigest()
    folder = storage_dir() / "assets"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{digest}.png"
    # Readers only see complete files, including after interrupted/concurrent uploads.
    if not path.exists():
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=folder, delete=False) as file:
                temporary = Path(file.name)
                file.write(raw)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"url": f"/api/v1/canvas/assets/{digest}", "width": width, "height": height}


def asset_path(digest):
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ValueError("资源 ID 格式不正确")
    path = storage_dir() / "assets" / f"{digest}.png"
    if not path.is_file():
        raise FileNotFoundError("画布图片不存在")
    return path


def validate_snapshot(snapshot):
    for key in ("document", "assets", "history", "generator", "view", "tools"):
        if not isinstance(snapshot.get(key), dict):
            raise ValueError("画布缺少状态或状态格式不正确：" + key)
    if not isinstance(snapshot.get("selection"), list):
        raise ValueError("画布选择状态格式不正确")
    view = snapshot["view"]
    if any(not isinstance(view.get(key), (int, float)) for key in ("x", "y", "scale")) or view["scale"] <= 0:
        raise ValueError("画布视口格式不正确")
    generator = snapshot["generator"]
    if not isinstance(generator.get("jobs", []), list) or not isinstance(generator.get("refs", []), list):
        raise ValueError("生成状态格式不正确")
    if snapshot.get("schemaVersion") != 1:
        raise ValueError("画布版本不兼容，当前仅支持 schema 1")
    document = snapshot.get("document", {})
    if document.get("schemaVersion") != 1 or not isinstance(document.get("images"), list):
        raise ValueError("画布文档格式不正确")
    assets = snapshot.get("assets")
    if not isinstance(assets, dict):
        raise ValueError("画布缺少图片资源列表")
    for key, asset in assets.items():
        if not isinstance(asset, dict) or asset.get("id") != key:
            raise ValueError("画布图片资源引用不正确")
        url = asset.get("url", "")
        match = re.fullmatch(r"/api/v1/canvas/assets/([0-9a-f]{64})", url)
        if not match:
            raise ValueError("请先上传画布资源，历史中不能包含临时地址或 Base64 图片")
        try:
            asset_path(match[1])
        except FileNotFoundError as exc:
            raise ValueError("画布引用的图片资源尚未保存") from exc
    documents = [document]
    history = snapshot.get("history", {})
    for direction in ("past", "future"):
        stack = history.get(direction, [])
        if not isinstance(stack, list) or len(stack) > 80:
            raise ValueError("撤销历史格式不正确或超过 80 步")
        documents.extend(stack)
    for doc in documents:
        if not isinstance(doc, dict) or doc.get("schemaVersion") != 1 or not isinstance(doc.get("images"), list):
            raise ValueError("历史画布文档格式不正确")
        if any(not isinstance(image, dict) or image.get("assetId") not in assets for image in doc["images"]):
            raise ValueError("历史中包含未保存的图片资源")
    jobs = snapshot.get("generator", {}).get("jobs", [])
    for job in jobs:
        if any(picture.get("assetId") not in assets for picture in job.get("snapshot", {}).get("pictures", [])):
            raise ValueError("生成快照中包含未保存的参考图")
    # Reject embedded image bytes anywhere, including generation retries.
    def inspect(value):
        if isinstance(value, dict):
            for key, item in value.items():
                if key in ("image_base64", "image_base64s", "mask_base64", "preserve_source_base64"):
                    raise ValueError("历史快照不能嵌入 Base64 图片")
                inspect(item)
        elif isinstance(value, list):
            for item in value:
                inspect(item)
    inspect(snapshot)


def save_project(project_id, title, snapshot, base_revision):
    validate_id(project_id)
    validate_snapshot(snapshot)
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    if len(encoded.encode()) > 25 * 1024 * 1024:
        raise ValueError("画布文档超过 25 MB，请另存为新画布减少历史大小")
    fingerprint = hashlib.sha256((title + "\n" + encoded).encode()).hexdigest()
    now = datetime.now(timezone.utc).isoformat()
    with database() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        head = project["head_revision"] if project else 0
        if head:
            last = conn.execute("SELECT fingerprint FROM revisions WHERE project_id=? AND revision=?", (project_id, head)).fetchone()
            if last["fingerprint"] == fingerprint:
                return {"id": project_id, "title": title, "revision": head, "updated_at": project["updated_at"]}
        if base_revision != head:
            raise ProjectConflict("该画布已在其他窗口更新。请另存为新画布，避免覆盖其他窗口的编辑。")
        revision = head + 1
        if not project:
            conn.execute("INSERT INTO projects VALUES (?,?,?,?,0)", (project_id, title, now, now))
        conn.execute("INSERT INTO revisions VALUES (?,?,?,?,?,?)", (project_id, revision, now, fingerprint, encoded, len(snapshot["document"]["images"])))
        conn.execute("UPDATE projects SET title=?, updated_at=?, head_revision=? WHERE id=?", (title, now, revision, project_id))
    return {"id": project_id, "title": title, "revision": revision, "updated_at": now}


def get_project(project_id, revision=None):
    validate_id(project_id)
    with database() as conn:
        project = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if not project:
            raise FileNotFoundError("画布项目不存在")
        revision = revision or project["head_revision"]
        row = conn.execute("SELECT snapshot,created_at FROM revisions WHERE project_id=? AND revision=?", (project_id, revision)).fetchone()
        if not row:
            raise FileNotFoundError("画布历史版本不存在")
        return {**dict(project), "revision": revision, "saved_at": row["created_at"], "snapshot": json.loads(row["snapshot"])}


def list_projects(limit=50, offset=0):
    with database() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY updated_at DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        total = conn.execute("SELECT count(*) FROM projects").fetchone()[0]
        return {"items": [dict(row) for row in rows], "total": total}


def list_revisions(project_id, limit=50, offset=0):
    validate_id(project_id)
    with database() as conn:
        rows = conn.execute("SELECT revision,created_at,image_count FROM revisions WHERE project_id=? ORDER BY revision DESC LIMIT ? OFFSET ?", (project_id, limit, offset)).fetchall()
        total = conn.execute("SELECT count(*) FROM revisions WHERE project_id=?", (project_id,)).fetchone()[0]
        return {"items": [dict(row) for row in rows], "total": total}
