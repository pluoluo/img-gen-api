import base64
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient
from PIL import Image

from image_api.main import app
from image_api.services import gallery


class GalleryFormatTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        (self.root / "thumbs").mkdir()
        self.patches = [patch.object(gallery, "_conn", None), patch.object(gallery, "GALLERY_DIR", self.root),
                        patch.object(gallery, "GALLERY_DB", self.root / "gallery.db"), patch.object(gallery, "THUMB_DIR", self.root / "thumbs")]
        for item in self.patches:
            item.start()
        self.client = TestClient(app)
        self.formats = {"svg": (b'<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="green"/></svg>', "image/svg+xml")}
        for fmt, ext, mime in [("PNG", "png", "image/png"), ("JPEG", "jpg", "image/jpeg"), ("WEBP", "webp", "image/webp"), ("GIF", "gif", "image/gif")]:
            buffer = io.BytesIO()
            image = Image.new("RGB", (80, 60), "green")
            options = {"save_all": True, "append_images": [Image.new("RGB", (80, 60), "red")], "duration": 100, "loop": 0} if fmt == "GIF" else {}
            image.save(buffer, format=fmt, **options)
            self.formats[ext] = (buffer.getvalue(), mime)

    def tearDown(self):
        if gallery._conn:
            gallery._conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.folder.cleanup()

    async def save(self, result):
        return (await gallery.save_image("openai", "test", "format test", "80x60", "low", 1, [result]))[0]

    async def test_base64_results_keep_format_bytes_and_response_type(self):
        for ext, (raw, mime) in self.formats.items():
            with self.subTest(ext=ext):
                record = await self.save({"base64": base64.b64encode(raw).decode(), "mime_type": mime})
                self.assertTrue(record["filename"].endswith("." + ext))
                response = self.client.get("/gallery/" + record["filename"])
                self.assertEqual(response.headers["content-type"], mime)
                self.assertEqual(response.content, raw)
                if ext == "gif":
                    self.assertEqual(Image.open(io.BytesIO(response.content)).n_frames, 2)

    async def test_url_results_keep_actual_format_without_mime_metadata(self):
        for ext, (raw, mime) in self.formats.items():
            with self.subTest(ext=ext), patch("image_api.services.openai_img._download_image", new=AsyncMock(return_value=raw)):
                record = await self.save({"url": "https://example.com/result"})
                self.assertTrue(record["filename"].endswith("." + ext))
                self.assertEqual((self.root / record["filename"]).read_bytes(), raw)

    async def test_previously_misnamed_originals_use_actual_type_and_skip_static_thumbnails(self):
        for ext in ("svg", "gif"):
            raw, mime = self.formats[ext]
            record = await self.save({"base64": base64.b64encode(raw).decode()})
            old_name = ext + "-saved-as.png"
            (self.root / record["filename"]).rename(self.root / old_name)
            gallery._get_conn().execute("UPDATE images SET filename=? WHERE id=?", (old_name, record["id"]))
            gallery._get_conn().commit()
            (self.root / "thumbs" / ("thumb_" + old_name)).write_bytes(self.formats["png"][0])
            response = self.client.get("/gallery/" + old_name)
            self.assertEqual(response.headers["content-type"], mime)
            self.assertEqual(response.content, raw)
        listing = self.client.get("/api/v1/gallery").json()
        self.assertTrue(all(item["thumb_filename"] is None for item in listing["items"]))

    async def test_raster_results_still_get_png_thumbnails(self):
        for ext in ("png", "jpg", "webp"):
            raw, _ = self.formats[ext]
            await self.save({"base64": base64.b64encode(raw).decode()})
        listing = self.client.get("/api/v1/gallery").json()
        for item in listing["items"]:
            response = self.client.get("/gallery/thumb/" + item["thumb_filename"])
            self.assertEqual(response.headers["content-type"], "image/png")
            self.assertEqual(Image.open(io.BytesIO(response.content)).size, (400, 400))
