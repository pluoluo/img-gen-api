"""
SQLite gallery: stores every successful image generation.
Images are saved to disk, DB holds metadata + file paths.
"""
import sqlite3
import os
import uuid
import base64
import hashlib
import json
import io
import re
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Optional, List

GALLERY_DIR = Path(os.environ.get("GALLERY_DATA_DIR", "/vol1/1000/note/memory/AI生成图片"))
GALLERY_DB = GALLERY_DIR / ".gallery.db"
THUMB_DIR = GALLERY_DIR / "thumbs"
GALLERY_DIR.mkdir(parents=True, exist_ok=True)
THUMB_DIR.mkdir(exist_ok=True)

_conn: Optional[sqlite3.Connection] = None


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(str(GALLERY_DB), check_same_thread=False)
        _conn.execute("""
            CREATE TABLE IF NOT EXISTS images (
                id          TEXT PRIMARY KEY,
                created_at  TEXT NOT NULL,
                model       TEXT NOT NULL,
                sub_model   TEXT NOT NULL,
                prompt      TEXT NOT NULL,
                size        TEXT,
                quality     TEXT,
                n           INTEGER DEFAULT 1,
                image_url   TEXT,
                filename    TEXT NOT NULL
            )
        """)
        _conn.executescript("""
            CREATE TABLE IF NOT EXISTS generation_inputs (task_id TEXT PRIMARY KEY, inputs TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS image_tasks (image_id TEXT PRIMARY KEY, task_id TEXT NOT NULL);
        """)
        _conn.commit()
    return _conn


def _save_reference(raw: bytes) -> dict:
    from PIL import Image
    with Image.open(io.BytesIO(raw)) as image:
        image.verify()
        mime_type = Image.MIME.get(image.format, "application/octet-stream")
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(mime_type, "img")
    filename = hashlib.sha256(raw).hexdigest() + "." + extension
    folder = GALLERY_DIR / "references"
    folder.mkdir(exist_ok=True)
    path = folder / filename
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
    return {"filename": filename, "url": f"/api/v1/gallery/references/{filename}", "mime_type": mime_type, "bytes": len(raw)}


async def save_generation_inputs(task_id, request):
    """Persist original references in request order before contacting the provider."""
    from image_api.services.openai_img import _download_image
    inputs = {"references": [], "mask": None, "markup": None, "preserve_source": None}
    for encoded in request.image_base64s or ([request.image_base64] if request.image_base64 else []):
        inputs["references"].append(_save_reference(base64.b64decode(encoded.split(",", 1)[-1])))
    for url in request.image_urls or ([request.image_url] if request.image_url else []):
        inputs["references"].append(_save_reference(await _download_image(url)))
    for field, encoded in (("mask", request.mask_base64), ("markup", getattr(request, "markup_base64", None)), ("preserve_source", request.preserve_source_base64)):
        if encoded:
            inputs[field] = _save_reference(base64.b64decode(encoded.split(",", 1)[-1]))
    conn = _get_conn()
    conn.execute("INSERT OR REPLACE INTO generation_inputs VALUES (?, ?)", (task_id, json.dumps(inputs)))
    conn.commit()


def reference_path(filename):
    if not re.fullmatch(r"[0-9a-f]{64}\.(png|jpg|webp|gif|img)", filename):
        raise FileNotFoundError("参考图不存在")
    path = GALLERY_DIR / "references" / filename
    if not path.is_file():
        raise FileNotFoundError("参考图不存在")
    return path


def _record_inputs(record_id):
    row = _get_conn().execute("SELECT inputs FROM generation_inputs JOIN image_tasks USING (task_id) WHERE image_id = ?", (record_id,)).fetchone()
    return json.loads(row[0]) if row else None


def _save_image_file(base64_data: str) -> str:
    """Save base64 image to disk, return filename."""
    return _save_image_bytes(base64.b64decode(base64_data))


def image_mime_type(source) -> str:
    """Read the actual format, including originals previously saved with a .png name."""
    from PIL import Image, UnidentifiedImageError
    from xml.etree import ElementTree
    try:
        with Image.open(io.BytesIO(source) if isinstance(source, bytes) else source) as image:
            return Image.MIME.get(image.format, "application/octet-stream")
    except (UnidentifiedImageError, OSError, ValueError):
        try:
            root = ElementTree.parse(io.BytesIO(source) if isinstance(source, bytes) else source).getroot()
            if root.tag in ("{http://www.w3.org/2000/svg}svg", "svg"):
                return "image/svg+xml"
        except (ElementTree.ParseError, OSError, ValueError):
            pass
    return "application/octet-stream"


def _save_image_bytes(img_bytes: bytes) -> str:
    extension = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg"}.get(image_mime_type(img_bytes), "png")
    fname = f"{uuid.uuid4().hex}.{extension}"
    fpath = GALLERY_DIR / fname
    with open(fpath, "wb") as f:
        f.write(img_bytes)
    return fname


def _image_to_base64(filename: str) -> str:
    """Read image file and return base64 string."""
    fpath = GALLERY_DIR / filename
    with open(fpath, "rb") as f:
        return base64.b64encode(f.read()).decode()


def _generate_thumbnail(filename: str) -> Optional[str]:
    """Generate a 400x400 thumbnail for the image. Returns thumb filename or None on failure."""
    from PIL import Image
    import io

    src = GALLERY_DIR / filename
    if not src.exists():
        return None

    thumb_name = f"thumb_{filename}"
    thumb_path = THUMB_DIR / thumb_name

    # Return existing thumb if already generated
    if thumb_path.exists():
        return thumb_name

    try:
        img = Image.open(src)
        img.thumbnail((400, 400), Image.LANCZOS)
        # Pad to square 400x400 with black background
        thumb = Image.new("RGB", (400, 400), (0, 0, 0))
        offset_x = (400 - img.width) // 2
        offset_y = (400 - img.height) // 2
        thumb.paste(img, (offset_x, offset_y))
        thumb.save(thumb_path, "PNG", quality=85)
        return thumb_name
    except Exception:
        return None


def get_thumbnail_path(filename: str) -> Optional[str]:
    """Return the thumbnail filename if it exists, else None."""
    thumb_name = f"thumb_{filename}"
    thumb_path = THUMB_DIR / thumb_name
    return thumb_name if thumb_path.exists() else None


async def save_image(
    model: str,
    sub_model: str,
    prompt: str,
    size: Optional[str],
    quality: Optional[str],
    n: int,
    image_results: List[dict],
    task_id: Optional[str] = None,
) -> List[dict]:
    """
    Save successful generation results to gallery.
    Returns list of saved records with id, filename, created_at.
    """
    conn = _get_conn()
    records = []
    now = datetime.now().isoformat()

    for item in image_results:
        record_id = str(uuid.uuid4())[:12]
        b64 = item.get("base64")
        url = item.get("url")

        if b64:
            fname = _save_image_file(b64)
        elif url:
            from image_api.services.openai_img import _download_image
            try:
                img_data = await _download_image(url)
                fname = _save_image_bytes(img_data)
            except Exception:
                fname = ""
        else:
            continue

        conn.execute(
            """INSERT INTO images
               (id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (record_id, now, model, sub_model, prompt, size, quality, n, url, fname),
        )
        if task_id:
            conn.execute("INSERT INTO image_tasks VALUES (?, ?)", (record_id, task_id))
        records.append({
            "id": record_id,
            "created_at": now,
            "model": model,
            "sub_model": sub_model,
            "prompt": prompt,
            "size": size,
            "quality": quality,
            "n": n,
            "image_url": url,
            "filename": fname,
        })

    conn.commit()
    return records


def _local_created_at(value):
    try:
        created = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return created.astimezone().replace(tzinfo=None) if created.tzinfo is not None else created
    except (ValueError, TypeError, AttributeError):
        return None


def _dated_gallery_rows(keyword, start_date, end_date):
    rows = _get_conn().execute(
        "SELECT id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename "
        "FROM images WHERE prompt LIKE ? OR sub_model LIKE ? ORDER BY created_at DESC, id DESC",
        ("%" + keyword + "%", "%" + keyword + "%"),
    ).fetchall()
    return [row for row in rows if (created := _local_created_at(row[1])) is not None
            and (start_date is None or created.date() >= start_date)
            and (end_date is None or created.date() <= end_date)]


def count_images(keyword: str = "", start_date=None, end_date=None) -> int:
    if start_date is not None or end_date is not None:
        return len(_dated_gallery_rows(keyword, start_date, end_date))
    query = "%" + keyword + "%"
    return _get_conn().execute("SELECT COUNT(*) FROM images WHERE prompt LIKE ? OR sub_model LIKE ?", (query, query)).fetchone()[0]


def get_images(limit: int = 50, offset: int = 0, keyword: str = "", start_date=None, end_date=None) -> List[dict]:
    """Return most recent images (newest first). Includes thumb_filename if available."""
    conn = _get_conn()
    if start_date is not None or end_date is not None:
        rows = _dated_gallery_rows(keyword, start_date, end_date)[offset:offset + limit]
    else:
        rows = conn.execute(
            """SELECT id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename
               FROM images WHERE prompt LIKE ? OR sub_model LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?""",
            ("%" + keyword + "%", "%" + keyword + "%", limit, offset),
        ).fetchall()
    result = []
    for r in rows:
        rec = _row_to_dict(r)
        # Preview GIF animation and SVG vectors directly, even if an old PNG thumb exists.
        if image_mime_type(GALLERY_DIR / rec["filename"]) in ("image/gif", "image/svg+xml"):
            rec["thumb_filename"] = None
        else:
            rec["thumb_filename"] = get_thumbnail_path(rec["filename"]) or _generate_thumbnail(rec["filename"])
        result.append(rec)
    return result


def get_image(record_id: str) -> Optional[dict]:
    """Return a single image record with base64 data."""
    conn = _get_conn()
    row = conn.execute(
        "SELECT id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename FROM images WHERE id=?",
        (record_id,),
    ).fetchone()
    if not row:
        return None
    rec = _row_to_dict(row)
    if rec["filename"]:
        rec["base64"] = _image_to_base64(rec["filename"])
    return rec


def delete_image(record_id: str) -> bool:
    """Delete an image record and its file. Returns True if deleted."""
    conn = _get_conn()
    row = conn.execute("SELECT filename FROM images WHERE id=?", (record_id,)).fetchone()
    if not row:
        return False
    fname = row[0]
    # Delete file
    if fname:
        fpath = GALLERY_DIR / fname
        if fpath.exists():
            fpath.unlink()
        # Also delete thumbnail
        thumb_path = THUMB_DIR / f"thumb_{fname}"
        if thumb_path.exists():
            thumb_path.unlink()
    conn.execute("DELETE FROM images WHERE id=?", (record_id,))
    conn.commit()
    return True


def delete_batch(record_ids: List[str]) -> int:
    """Delete multiple image records and their files. Returns count of deleted."""
    conn = _get_conn()
    deleted = 0
    for record_id in record_ids:
        row = conn.execute("SELECT filename FROM images WHERE id=?", (record_id,)).fetchone()
        if not row:
            continue
        fname = row[0]
        if fname:
            fpath = GALLERY_DIR / fname
            if fpath.exists():
                fpath.unlink()
            thumb_path = THUMB_DIR / f"thumb_{fname}"
            if thumb_path.exists():
                thumb_path.unlink()
        conn.execute("DELETE FROM images WHERE id=?", (record_id,))
        deleted += 1
    conn.commit()
    return deleted


def _row_to_dict(row) -> dict:
    keys = ["id", "created_at", "model", "sub_model", "prompt", "size", "quality", "n", "image_url", "filename"]
    result = dict(zip(keys, row))
    result["inputs"] = _record_inputs(result["id"])
    return result


class GalleryCleanupChanged(ValueError):
    """The records selected by a cleanup preview changed before confirmation."""


def cleanup_before_date(*, months=None, before=None, today=None):
    """Resolve calendar-month presets to the start of a local calendar day."""
    import calendar
    from datetime import date
    today = today or date.today()
    if (months is None) == (before is None):
        raise ValueError("请选择一个时间范围或指定截止日期")
    if months is not None:
        if months not in (1, 3, 6):
            raise ValueError("仅支持一个月前、三个月前或半年前")
        year, month = divmod(today.year * 12 + today.month - 1 - months, 12)
        before = date(year, month + 1, min(today.day, calendar.monthrange(year, month + 1)[1]))
    if before > today:
        raise ValueError("截止日期不能晚于今天")
    return before


def _cleanup_rows(conn, before):
    cutoff = datetime.combine(before, datetime.min.time())
    result = []
    for row in conn.execute("SELECT id, filename, created_at FROM images ORDER BY id").fetchall():
        created = _local_created_at(row[2])
        if created is not None and created < cutoff:
            result.append(row)
    return result


def _cleanup_summary(before, rows):
    fingerprint = hashlib.sha256(json.dumps([before.isoformat(), rows], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    return {"before": before.isoformat(), "cutoff": datetime.combine(before, datetime.min.time()).isoformat(), "count": len(rows), "fingerprint": fingerprint}


def preview_gallery_cleanup(before):
    from contextlib import closing
    before = cleanup_before_date(before=before)
    _get_conn()  # Ensure schema exists, without sharing another request's transaction.
    with closing(sqlite3.connect(str(GALLERY_DB))) as conn:
        return _cleanup_summary(before, _cleanup_rows(conn, before))


def delete_gallery_before(before, fingerprint):
    """Delete only the exact, confirmed old-image set; preserve reference archives."""
    from contextlib import closing
    before = cleanup_before_date(before=before)
    _get_conn()
    with closing(sqlite3.connect(str(GALLERY_DB))) as conn:
        try:
            conn.execute("BEGIN IMMEDIATE")
            rows = _cleanup_rows(conn, before)
            summary = _cleanup_summary(before, rows)
            if summary["fingerprint"] != fingerprint:
                raise GalleryCleanupChanged("待删除作品已变化，请重新预览并确认")
            conn.executemany("DELETE FROM image_tasks WHERE image_id = ?", [(row[0],) for row in rows])
            conn.executemany("DELETE FROM images WHERE id = ?", [(row[0],) for row in rows])
            filenames = {row[1] for row in rows if row[1]}
            # A retained gallery record may still use the same image file.
            removable = [name for name in filenames if not conn.execute("SELECT 1 FROM images WHERE filename = ? LIMIT 1", (name,)).fetchone()]
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    failed_files = []
    for filename in removable:
        paths = [(GALLERY_DIR, filename), (THUMB_DIR, f"thumb_{filename}")]
        for folder, name in paths:
            path = folder / name
            try:
                if Path(name).name != name or path.resolve().parent != folder.resolve():
                    raise ValueError("非法文件路径")
                path.unlink(missing_ok=True)
            except (OSError, ValueError):
                failed_files.append(name)
    return {"ok": True, "deleted": len(rows), "before": before.isoformat(), "failed_files": failed_files}
