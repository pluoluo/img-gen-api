"""Offline edit uploads: output geometry, reference size, and HTTP failures."""
import base64
import io
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

from image_api.services.openai_img import (
    APIResponseError,
    _httpx_post,
    generate_openai_image,
    preprocess_reference_image,
    user_facing_message,
)


def encode(image):
    output = io.BytesIO()
    image.save(output, "PNG")
    return base64.b64encode(output.getvalue()).decode()


class ReferenceUploadTests(unittest.TestCase):
    def test_extra_reference_keeps_pixels_instead_of_upscaling_to_4k(self):
        source = Image.effect_noise((800, 600), 64).convert("RGB")
        original = encode(source)
        enlarged, _, _ = preprocess_reference_image(original, "3840")
        compact, size, adjusted = preprocess_reference_image(original, "3840", allow_upscale=False)
        with Image.open(io.BytesIO(compact)) as result:
            self.assertEqual(result.size, source.size)
            self.assertEqual(result.tobytes(), source.tobytes())
        self.assertEqual((size, adjusted), ("800x600", "800x600"))
        self.assertLess(len(compact), len(enlarged))

    def test_extra_reference_can_still_shrink_and_preserves_aspect(self):
        original = encode(Image.new("RGB", (3840, 2160), "green"))
        compact, size, _ = preprocess_reference_image(original, "1664", allow_upscale=False)
        with Image.open(io.BytesIO(compact)) as result:
            self.assertEqual(result.size, (1650, 928))
            self.assertEqual(size, "1650x928")


class EditUploadTests(unittest.IsolatedAsyncioTestCase):
    async def test_4k_mask_with_extra_reference_for_both_providers(self):
        source = encode(Image.new("RGB", (800, 600), (12, 34, 56)))
        layer = Image.new("RGBA", (800, 600), (255, 255, 255, 255))
        layer.paste((255, 255, 255, 0), (200, 150, 400, 300))
        mask = encode(layer)
        extra = encode(Image.new("RGB", (1024, 768), "red"))
        for provider in ("https://api.openai-hk.com/v1", "https://www.packyapi.com/v1"):
            with self.subTest(provider=provider), patch(
                "image_api.services.openai_img._httpx_post",
                new=AsyncMock(return_value={"data": [{"b64_json": source}]}),
            ) as post, patch("image_api.services.openai_img.log_info") as log:
                result = await generate_openai_image(
                    "edit", base_url=provider, api_key="offline-fixture",
                    image_base64s=[source, extra], mask_base64=mask, size="3840x2160",
                )
                files = post.await_args.kwargs["files"]
                self.assertEqual([field for field, _ in files], ["image[]", "mask", "image[]"])
                with Image.open(io.BytesIO(files[0][1][1])) as primary, Image.open(io.BytesIO(files[1][1][1])) as selection:
                    self.assertEqual(primary.size, (3840, 2160))
                    self.assertEqual(selection.size, primary.size)
                    self.assertEqual(selection.mode, "RGBA")
                    self.assertEqual(selection.getpixel((1200, 720))[3], 0)
                    self.assertEqual(selection.getpixel((20, 20))[3], 255)
                with Image.open(io.BytesIO(files[2][1][1])) as reference:
                    self.assertEqual(reference.size, (1024, 768))
                self.assertEqual(post.await_args.kwargs["data"]["size"], "3840x2160")
                self.assertEqual(result[0]["adjusted_size"], "3840x2160")
                ctx = next(call.kwargs["ctx"] for call in log.call_args_list if call.args[0].startswith("提交编辑请求"))
                self.assertEqual(ctx["file_bytes"], sum(len(item[1]) for _, item in files))
                self.assertEqual(ctx["files"][1]["field"], "mask")

    async def test_multipart_http_errors_keep_status_for_json_and_html(self):
        for status, body in (
            (413, "<html>Request Entity Too Large</html>"),
            (413, '{"error":{"message":"payload too large"}}'),
            (502, "<html>Bad Gateway</html>"),
        ):
            with self.subTest(status=status, body=body):
                transport = httpx.MockTransport(lambda request: httpx.Response(status, text=body))
                with patch("image_api.services.openai_img._make_transport", return_value=transport):
                    with self.assertRaises(APIResponseError) as caught:
                        await _httpx_post(
                            "https://offline.invalid/images/edits", {},
                            files=[("image[]", ("reference.png", b"fixture", "image/png"))],
                            data={"size": "3840x2160"},
                        )
                self.assertEqual(caught.exception.status, status)
                self.assertEqual(caught.exception.raw_body, body)
                message = user_facing_message(caught.exception)
                self.assertNotIn("<html>", message)
                self.assertIn("过大" if status == 413 else "上游", message)

    async def test_multipart_success_still_parses_result(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"data": []}))
        with patch("image_api.services.openai_img._make_transport", return_value=transport):
            result = await _httpx_post(
                "https://offline.invalid/images/edits", {},
                files=[("image[]", ("reference.png", b"fixture", "image/png"))],
            )
        self.assertEqual(result, {"data": []})
