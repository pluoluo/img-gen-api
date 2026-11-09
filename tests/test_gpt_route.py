import base64
import io
import os
import tempfile
import unittest

from PIL import Image


def _png_b64(w, h) -> str:
    img = Image.new("RGB", (w, h), (10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class GptRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        os.environ["GPT_ROUTE_STATE_PATH"] = self.tmp.name
        if os.path.exists(self.tmp.name):
            os.unlink(self.tmp.name)
        import importlib
        import image_api.services.gpt_route as gpt_route
        importlib.reload(gpt_route)
        self.gr = gpt_route

    def _openai_first(self):
        self.gr.save_state({
            "mode": self.gr.MODE_OPENAI_FIRST,
            "undersize_streak": 0,
            "reverted_at": None,
        })

    def tearDown(self):
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass
        os.environ.pop("GPT_ROUTE_STATE_PATH", None)

    def test_default_size_split_sends_large_to_packy(self):
        p, _ = self.gr.resolve_gpt_route("2272x752", "gpt-image-2.5-flare")
        self.assertEqual(p, "packy")
        p, _ = self.gr.resolve_gpt_route("1920x1080", "gpt-image-2.5-flare")
        self.assertEqual(p, "packy")

    def test_openai_first_ignores_size(self):
        self._openai_first()
        p, sub = self.gr.resolve_gpt_route("3840x2160", "gpt-image-2.5-sunburst")
        self.assertEqual((p, sub), ("openai", "gpt-image-2.5-sunburst"))
        p, sub = self.gr.resolve_gpt_route("1024x1024", "gpt-image-2.5-flare")
        self.assertEqual((p, sub), ("openai", "gpt-image-2.5-flare"))

    def test_size_split_uses_total_pixel_boundary(self):
        self.gr.save_state({
            "mode": self.gr.MODE_SIZE_SPLIT,
            "undersize_streak": 5,
            "reverted_at": "x",
        })
        p, sub = self.gr.resolve_gpt_route("2048x768", "gpt-image-2.5-flare")
        self.assertEqual(p, "openai")
        p, sub = self.gr.resolve_gpt_route("2048x784", "gpt-image-2.5-flare")
        self.assertEqual(p, "packy")
        p, sub = self.gr.resolve_gpt_route("2560x1440", "gpt-image-2.5-flare")
        self.assertEqual(p, "packy")

    def test_auto_size_no_ref_goes_openai(self):
        p, sub = self.gr.resolve_gpt_route("auto", "gpt-image-2.5-sunburst")
        self.assertEqual((p, sub), ("openai", "gpt-image-2.5-sunburst"))
        p, sub = self.gr.resolve_gpt_route(
            "auto", "gpt-image-2.5-flare", has_reference=False,
        )
        self.assertEqual(p, "openai")

    def test_auto_size_with_large_ref_goes_packy(self):
        b64 = _png_b64(2560, 1440)
        p, _ = self.gr.resolve_gpt_route("auto", "gpt-image-2.5-flare", b64)
        self.assertEqual(p, "packy")

    def test_auto_size_url_ref_skips_noref_shortcut(self):
        # URL-only: has_reference=True so we don't take the 文生图 shortcut.
        # Unknown pixels still estimate 1024 → openai under size_split.
        p, _ = self.gr.resolve_gpt_route(
            "auto", "gpt-image-2.5-flare", has_reference=True,
        )
        self.assertEqual(p, "openai")

    def test_auto_size_openai_first_still_openai(self):
        self._openai_first()
        p, _ = self.gr.resolve_gpt_route("auto", "gpt-image-2.5-flare")
        self.assertEqual(p, "openai")

    def test_five_consecutive_undersize_reverts(self):
        self._openai_first()
        tiny = [{"base64": _png_b64(1254, 1254)}]
        for i in range(4):
            st = self.gr.note_openai_output(
                "3840x2160", tiny, sub_model="gpt-image-2.5-flare",
            )
            self.assertEqual(st["mode"], self.gr.MODE_OPENAI_FIRST)
            self.assertEqual(st["undersize_streak"], i + 1)
        st = self.gr.note_openai_output(
            "3840x2160", tiny, sub_model="gpt-image-2.5-sunburst",
        )
        self.assertEqual(st["mode"], self.gr.MODE_SIZE_SPLIT)
        self.assertGreaterEqual(st["undersize_streak"], 5)
        p, _ = self.gr.resolve_gpt_route("3840x2160", "gpt-image-2.5-flare")
        self.assertEqual(p, "packy")

    def test_adequate_output_resets_streak(self):
        self._openai_first()
        tiny = [{"base64": _png_b64(800, 600)}]
        big = [{"base64": _png_b64(2560, 1440)}]
        self.gr.note_openai_output("2560x1440", tiny, sub_model="gpt-image-2.5-flare")
        self.gr.note_openai_output("2560x1440", tiny, sub_model="gpt-image-2.5-flare")
        st = self.gr.note_openai_output(
            "2560x1440", big, sub_model="gpt-image-2.5-flare",
        )
        self.assertEqual(st["undersize_streak"], 0)
        self.assertEqual(st["mode"], self.gr.MODE_OPENAI_FIRST)

    def test_sub_1k_request_does_not_count(self):
        tiny = [{"base64": _png_b64(800, 600)}]
        st = self.gr.note_openai_output(
            "1024x1024", tiny, sub_model="gpt-image-2.5-flare",
        )
        self.assertEqual(st["undersize_streak"], 0)

    def test_ultrawide_157mp_counts_as_undersize(self):
        """2272x752 at ~1.57MP has long edge >1920; must still count."""
        self._openai_first()
        wide = [{"base64": _png_b64(2181, 721)}]  # 1,572,501 px, long edge 2181
        st = self.gr.note_openai_output(
            "2272x752", wide, sub_model="gpt-image-2.5-flare",
        )
        self.assertEqual(st["undersize_streak"], 1)
        self.assertEqual(st["mode"], self.gr.MODE_OPENAI_FIRST)

    def test_wide_images_below_budget_and_square_images_above_budget(self):
        for size in ("2160x720", "720x2160", "1920x816", "1248x1248", "1536x1024"):
            with self.subTest(size=size):
                self.assertEqual(self.gr.resolve_gpt_route(size, "gpt-image-2.5-flare")[0], "openai")
        for size in ("1536x1536", "1920x1080", "2016x864"):
            with self.subTest(size=size):
                self.assertEqual(self.gr.resolve_gpt_route(size, "gpt-image-2.5-flare")[0], "packy")

    def test_wide_1k_request_does_not_count_as_large_output_miss(self):
        self._openai_first()
        state = self.gr.note_openai_output("2160x720", [{"base64": _png_b64(800, 600)}], sub_model="gpt-image-2.5-flare")
        self.assertEqual(state["undersize_streak"], 0)

    def test_adequate_square_output_resets_streak_despite_short_long_edge(self):
        self._openai_first()
        self.gr.note_openai_output("2560x1440", [{"base64": _png_b64(800, 600)}], sub_model="gpt-image-2.5-flare")
        state = self.gr.note_openai_output("2560x1440", [{"base64": _png_b64(1600, 1600)}], sub_model="gpt-image-2.5-flare")
        self.assertEqual(state["undersize_streak"], 0)

    def test_legacy_1k_presets_fill_budget_and_stay_on_openai(self):
        import json
        from pathlib import Path
        config = json.loads((Path(__file__).resolve().parents[1] / "frontend/model-config.json").read_text())
        for row in config["SIZES"]:
            dimensions = row["d"].get("1K")
            if not dimensions:
                continue
            width, height = dimensions
            self.assertLessEqual(width * height, self.gr._1K_MAX_PIXELS)
            self.assertGreaterEqual(width * height, self.gr._1K_MAX_PIXELS * 0.99)
            self.assertEqual(width % 16 + height % 16, 0)
            self.assertEqual(self.gr.resolve_gpt_route(f"{width}x{height}", "gpt-image-2.5-flare")[0], "openai")

    def test_auto_uses_reference_total_pixels(self):
        self.assertEqual(self.gr.resolve_gpt_route("auto", "gpt-image-2.5-flare", _png_b64(2048, 768))[0], "openai")
        self.assertEqual(self.gr.resolve_gpt_route("auto", "gpt-image-2.5-flare", _png_b64(1536, 1536))[0], "packy")

    def test_hint_follows_mode(self):
        st = self.gr.route_status()
        self.assertIn("Packy 按量", st["hint"])
        self.assertNotIn("大小同价", st["hint"])
        self._openai_first()
        st = self.gr.route_status()
        self.assertIn("大小同价", st["hint"])


if __name__ == "__main__":
    unittest.main()
