"""PNG mask adapter: alpha=0 edits, alpha=255 protects; preserve original geometry."""
import base64
import binascii
import io
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 30 * 1024 * 1024
MAX_IMAGE_PIXELS = 40_000_000


def decode_image(value: str, *, png_mask: bool = False) -> Image.Image:
    if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        raise ValueError("图片或 mask 超过 30 MB")
    try:
        raw = base64.b64decode(value, validate=True)
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError("图片或 mask 超过 4000 万像素")
        if png_mask and (image.format != "PNG" or "A" not in image.getbands()):
            raise ValueError("mask 必须是带 alpha 通道的 PNG，透明区域表示修改区域")
        image.load()
        return image.convert("RGBA")
    except (binascii.Error, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("无法解码图片或 PNG mask（需要纯 base64）") from exc


def validate_mask(mask_base64: str, reference_base64: str, preserve_source: str | None = None):
    with decode_image(mask_base64, png_mask=True) as mask, decode_image(reference_base64) as source:
        if mask.size != source.size:
            raise ValueError(f"mask 尺寸 {mask.size} 必须与第一张主参考图 {source.size} 一致")
        if mask.getchannel("A").getextrema()[0] == 255:
            raise ValueError("mask 没有可修改区域，请先圈选或涂抹")
        if preserve_source:
            with decode_image(preserve_source) as original:
                if original.size != source.size:
                    raise ValueError("用于区域外保留的原图必须与主参考图尺寸一致")


def preprocess_mask(mask_base64: str, reference_base64: str, actual_size: str) -> bytes:
    validate_mask(mask_base64, reference_base64)
    width, height = map(int, actual_size.split("x"))
    with decode_image(mask_base64, png_mask=True) as mask:
        # Same dimensions as preprocessed primary image. Nearest avoids growing edits.
        resized = mask.resize((width, height), Image.Resampling.NEAREST)
        output = io.BytesIO()
        resized.save(output, format="PNG")
        resized.close()
        return output.getvalue()


def composite_outside(source_base64: str, mask_base64: str, generated_base64: str) -> tuple[str, str, str]:
    with decode_image(source_base64) as source, decode_image(mask_base64, png_mask=True) as mask, decode_image(generated_base64) as generated:
        if mask.size != source.size:
            raise ValueError("合成失败：mask 与原图尺寸不一致")
        upstream_size = f"{generated.width}x{generated.height}"
        resized = generated.resize(source.size, Image.Resampling.LANCZOS)
        # Soft alpha pixels blend; fully protected pixels remain byte-exact RGBA.
        result = Image.composite(resized, source, ImageOps.invert(mask.getchannel("A")))
        output = io.BytesIO()
        result.save(output, format="PNG")
        resized.close()
        result.close()
        return base64.b64encode(output.getvalue()).decode(), f"{source.width}x{source.height}", upstream_size
