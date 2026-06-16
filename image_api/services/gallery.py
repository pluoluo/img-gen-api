"""
SQLite gallery: stores every successful image generation.
Images are saved to disk, DB holds metadata + file paths.
"""
import sqlite3
import os
import uuid
import base64
from datetime import datetime
from pathlib import Path
from typing import Optional, List

GALLERY_DIR = Path("/vol1/1000/note/memory/AI生成图片")
GALLERY_DB = GALLERY_DIR / ".gallery.db"
THUMB_DIR = GALLERY_DIR / "thumbs"
GALLERY_DIR.mkdir(exist_ok=True)
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
        _conn.commit()
    return _conn


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
            # Download from URL and save (async to not block event loop)
            import httpx
            try:
                async with httpx.AsyncClient(trust_env=False,
                                             timeout=httpx.Timeout(connect=30.0, read=120.0, write=30.0, pool=10.0)) as dl:
                    resp = await dl.get(url)
                    resp.raise_for_status()
                fname = f"{uuid.uuid4().hex}.png"
                fpath = GALLERY_DIR / fname
                with open(fpath, "wb") as f:
                    f.write(resp.content)
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


def get_images(limit: int = 50, offset: int = 0) -> List[dict]:
    """Return most recent images (newest first). Includes thumb_filename if available."""
    conn = _get_conn()
    rows = conn.execute(
        """SELECT id, created_at, model, sub_model, prompt, size, quality, n, image_url, filename
           FROM images ORDER BY created_at DESC LIMIT ? OFFSET ?""",
        (limit, offset),
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
    return dict(zip(keys, row))
