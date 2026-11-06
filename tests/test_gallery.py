import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from image_api.main import app
from image_api.services import gallery


class GalleryListingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.patches = [patch.object(gallery, "_conn", None), patch.object(gallery, "GALLERY_DB", Path(self.folder.name) / "gallery.sqlite3"),
            patch.object(gallery, "get_thumbnail_path", return_value=None), patch.object(gallery, "_generate_thumbnail", return_value=None)]
        for item in self.patches:
            item.start()
        connection = gallery._get_conn()
        for index in range(5):
            connection.execute("INSERT INTO images VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (str(index), str(index), "openai", "special-model" if index == 4 else "image-model", "red flower" if index % 2 else "蓝色风景", "1024x1024", "low", 1, None, f"image-{index}.png"))
        connection.commit()
        self.client = TestClient(app)

    def tearDown(self):
        gallery._conn.close()
        for item in reversed(self.patches):
            item.stop()
        self.folder.cleanup()

    def test_total_is_full_match_count_not_current_page_length(self):
        response = self.client.get("/api/v1/gallery?limit=2&offset=2").json()
        self.assertEqual(response["total"], 5)
        self.assertEqual([item["id"] for item in response["items"]], ["2", "1"])
        self.assertEqual(self.client.get("/api/v1/gallery?limit=2&offset=10").json(), {"items": [], "total": 5})

    def test_keyword_filters_prompt_or_model_and_preserves_pagination(self):
        response = self.client.get("/api/v1/gallery", params={"keyword": " 蓝色 ", "limit": 1}).json()
        self.assertEqual(response["total"], 3)
        self.assertEqual(response["items"][0]["id"], "4")
        response = self.client.get("/api/v1/gallery?keyword=special-model").json()
        self.assertEqual(response["total"], 1)
        self.assertEqual(response["items"][0]["id"], "4")

    def test_unknown_search_has_no_results(self):
        self.assertEqual(self.client.get("/api/v1/gallery?keyword=no-matching-image").json(), {"items": [], "total": 0})
