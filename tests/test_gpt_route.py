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
        self.assertEqual(p, "openai")

    def test_openai_first_ignores_size(self):
        self._openai_first()
        p, sub = self.gr.resolve_gpt_route("3840x2160", "gpt-image-2.5-sunburst")
        self.assertEqual((p, sub), ("openai", "gpt-image-2.5-sunburst"))
        p, sub = self.gr.resolve_gpt_route("1024x1024", "gpt-image-2.5-flare")
        self.assertEqual((p, sub), ("openai", "gpt-image-2.5-flare"))

    def test_size_split_uses_1920_boundary(self):
        self.gr.save_state({
            "mode": self.gr.MODE_SIZE_SPLIT,
            "undersize_streak": 5,
            "reverted_at": "x",
        })
        p, sub = self.gr.resolve_gpt_route("1920x1080", "gpt-image-2.5-flare")
        self.assertEqual(p, "openai")
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

    def test_hint_follows_mode(self):
        st = self.gr.route_status()
        self.assertIn("Packy 按量", st["hint"])
        self.assertNotIn("大小同价", st["hint"])
        self._openai_first()
        st = self.gr.route_status()
        self.assertIn("大小同价", st["hint"])


if __name__ == "__main__":
    unittest.main()
