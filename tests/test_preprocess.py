import base64
import io
import unittest

import httpx
from PIL import Image

from image_api.services.openai_img import (
    APIResponseError,
    UserFacingError,
    preprocess_reference_image,
    user_facing_message,
)


def _png_b64(w, h) -> str:
    img = Image.new("RGB", (w, h), (10, 20, 30))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _assert_public(msg: str):
    assert msg
    assert any("\u4e00" <= c <= "\u9fff" for c in msg)
    for banned in (
        "Traceback", "DecompressionBomb", "DOS", "httpx.", "PIL.",
        'File "', "stack",
    ):
        assert banned not in msg, msg


class PreprocessOversizedRefTests(unittest.TestCase):
    def setUp(self):
        self._prev_max = Image.MAX_IMAGE_PIXELS

    def tearDown(self):
        Image.MAX_IMAGE_PIXELS = self._prev_max

    def test_huge_ref_raises_chinese_hint_not_bomb_log(self):
        Image.MAX_IMAGE_PIXELS = 100  # 200×200 = 40_000 > 2×100
        with self.assertRaises(UserFacingError) as ctx:
            preprocess_reference_image(_png_b64(200, 200), "1344x576")
        msg = str(ctx.exception)
        self.assertIn("参考图太大", msg)
        self.assertIn("200×200", msg)
        self.assertIn("缩小", msg)
        _assert_public(msg)

    def test_normal_ref_still_resizes(self):
        data, actual, _adjusted = preprocess_reference_image(
            _png_b64(800, 400), "1344x576"
        )
        self.assertTrue(data)
        self.assertTrue(actual)


class PublicErrorMessageTests(unittest.TestCase):
    def test_bomb_error(self):
        exc = Image.DecompressionBombError(
            "Image size (323784727 pixels) exceeds limit of 178956970 pixels, "
            "could be decompression bomb DOS attack."
        )
        msg = user_facing_message(exc)
        self.assertIn("参考图", msg)
        _assert_public(msg)

    def test_unknown_error_is_generic_chinese(self):
        msg = user_facing_message(ValueError("API 返回格式异常，缺少 'data' 字段: {\"error\": 1}" * 20))
        self.assertIn("日志页", msg)
        _assert_public(msg)

    def test_connect_error(self):
        msg = user_facing_message(httpx.ConnectError("TLS/SSL connection has been closed (EOF)"))
        self.assertIn("连不上", msg)
        _assert_public(msg)

    def test_timeout(self):
        msg = user_facing_message(httpx.ReadTimeout("read timeout"))
        self.assertIn("超时", msg)
        _assert_public(msg)

    def test_api_504(self):
        exc = APIResponseError(504, '{"error": {"message": "图片生成超时，请稍后再试。"}}')
        msg = user_facing_message(exc)
        self.assertIn("超时", msg)
        _assert_public(msg)

    def test_api_no_access(self):
        exc = APIResponseError(
            403,
            '{"error": {"message": "This token has no access to model gpt-image-2.5-flare-4k"}}',
        )
        msg = user_facing_message(exc)
        self.assertIn("权限", msg)
        _assert_public(msg)

    def test_never_leaks_traceback_line(self):
        msg = user_facing_message(
            RuntimeError("PIL.Image.DecompressionBombError: Image size (1) exceeds limit")
        )
        _assert_public(msg)


if __name__ == "__main__":
    unittest.main()
