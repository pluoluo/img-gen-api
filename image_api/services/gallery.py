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
    inputs = {"references": [], "mask": None, "preserve_source": None}
    for encoded in request.image_base64s or ([request.image_base64] if request.image_base64 else []):
        inputs["references"].append(_save_reference(base64.b64decode(encoded.split(",", 1)[-1])))
    for url in request.image_urls or ([request.image_url] if request.image_url else []):
        inputs["references"].append(_save_reference(await _download_image(url)))
    for field, encoded in (("mask", request.mask_base64), ("preserve_source", request.preserve_source_base64)):
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
    img_bytes = base64.b64decode(base64_data)
    fname = f"{uuid.uuid4().hex}.png"
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
                fname = f"{uuid.uuid4().hex}.png"
                fpath = GALLERY_DIR / fname
                with open(fpath, "wb") as f:
                    f.write(img_data)
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


def count_images(keyword: str = "") -> int:
    query = "%" + keyword + "%"
    return _get_conn().execute("SELECT COUNT(*) FROM images WHERE prompt LIKE ? OR sub_model LIKE ?", (query, query)).fetchone()[0]


def get_images(limit: int = 50, offset: int = 0, keyword: str = "") -> List[dict]:
    """Return most recent images (newest first). Includes thumb_filename if available."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename
           FROM images WHERE prompt LIKE ? OR sub_model LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        ("%" + keyword + "%", "%" + keyword + "%", limit, offset),
    ).fetchall()
    result = []
    for r in rows:
        rec = _row_to_dict(r)
        # Ensure thumbnail exists for this image
        thumb = get_thumbnail_path(rec["filename"])
        if thumb:
            rec["thumb_filename"] = thumb
        else:
            # Try to generate on-demand (lazy generation)
            generated = _generate_thumbnail(rec["filename"])
            rec["thumb_filename"] = generated
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
