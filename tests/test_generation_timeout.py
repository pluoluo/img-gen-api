import unittest

from image_api.services.openai_img import _generation_timeout


class GenerationTimeoutTests(unittest.TestCase):
    """按长边分级超时：1K/2K → 360s，4K → 600s（硬上限）。

    背景：原先统一 900s，open-hk 拥堵时用户要干等 15 分钟才回切 Packy。
    """

    def test_1k_and_2k_sizes_use_360s(self):
        for size in ("1024x1024", "1248x1248", "1344x1968", "2048x2048"):
            with self.subTest(size=size):
                self.assertEqual(_generation_timeout(size), 360)

    def test_sizes_above_2048_use_600s_cap(self):
        for size in ("3840x2160", "2160x3840", "2560x1440"):
            with self.subTest(size=size):
                self.assertEqual(_generation_timeout(size), 600)

    def test_auto_and_invalid_fall_back_to_default(self):
        for size in ("auto", None, "", "bad"):
            with self.subTest(size=size):
                self.assertEqual(_generation_timeout(size), 360)

    def test_custom_default(self):
        self.assertEqual(_generation_timeout("auto", default=180), 180)


if __name__ == "__main__":
    unittest.main()
