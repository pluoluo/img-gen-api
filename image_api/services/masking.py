"""PNG mask/markup adapters: keep alpha, match the preprocessed primary size."""
import base64
import binascii
import io
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_777_216


def decode_image(value: str, *, png_mask: bool = False, png_markup: bool = False) -> Image.Image:
    if len(value) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        raise ValueError("图片、mask 或标注超过 50 MB")
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("图片、mask 或标注超过 50 MB")
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > MAX_IMAGE_PIXELS:
            raise ValueError("图片、mask 或标注超过 16,777,216 像素")
        if (png_mask or png_markup) and (image.format != "PNG" or "A" not in image.getbands()):
            raise ValueError(
                "mask 必须是带 alpha 通道的 PNG，透明区域表示修改区域"
                if png_mask
                else "标注必须是带透明通道的 PNG，不能叠在原图上"
            )
        image.load()
        return image.convert("RGBA")
    except (binascii.Error, OSError, Image.DecompressionBombError) as exc:
        raise ValueError("无法解码图片、PNG mask 或标注（需要纯 base64）") from exc


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


def _png_rgba(image: Image.Image, size: tuple[int, int], resample) -> bytes:
    resized = image.resize(size, resample)
    try:
        if resized.mode != "RGBA":
            resized = resized.convert("RGBA")
        output = io.BytesIO()
        resized.save(output, format="PNG")
        data = output.getvalue()
    finally:
        resized.close()
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError("缩放后的 mask 或标注超过 50 MB")
    return data


def preprocess_mask(mask_base64: str, reference_base64: str, actual_size: str) -> bytes:
    validate_mask(mask_base64, reference_base64)
    width, height = map(int, actual_size.split("x"))
    with decode_image(mask_base64, png_mask=True) as mask:
        # Same dimensions as preprocessed primary image. Nearest avoids growing edits.
        return _png_rgba(mask, (width, height), Image.Resampling.NEAREST)


def preprocess_markup(markup_base64: str, actual_size: str) -> bytes:
    width, height = map(int, actual_size.split("x"))
    with decode_image(markup_base64, png_markup=True) as layer:
        alpha = layer.getchannel("A").getextrema()
        if alpha[1] == 0:
            raise ValueError("标注图层是空的")
        if alpha[0] == 255:
            raise ValueError("标注图层必须包含透明像素，不能叠在原图上")
        return _png_rgba(layer, (width, height), Image.Resampling.LANCZOS)


def composite_outside(source_base64: str, mask_base64: str, generated_base64: str, target_size: str = "auto") -> tuple[str, str, str]:
    with decode_image(source_base64) as source, decode_image(mask_base64, png_mask=True) as mask, decode_image(generated_base64) as generated:
        if mask.size != source.size:
            raise ValueError("合成失败：mask 与原图尺寸不一致")
        upstream_size = f"{generated.width}x{generated.height}"
        # Match the primary/mask geometry sent upstream instead of shrinking the
        # completed image back to the original reference size.
        if target_size and target_size.strip().lower() != "auto":
            from image_api.services.openai_img import validate_and_adjust_size
            width, height, _ = validate_and_adjust_size(target_size, source.width, source.height)
            source = source.resize((width, height), Image.Resampling.LANCZOS)
            mask = mask.resize((width, height), Image.Resampling.NEAREST)
        resized = generated.resize(source.size, Image.Resampling.LANCZOS)
        # Soft alpha pixels blend; fully protected pixels remain byte-exact RGBA.
        result = Image.composite(resized, source, ImageOps.invert(mask.getchannel("A")))
        output = io.BytesIO()
        result.save(output, format="PNG")
        final_size = f"{source.width}x{source.height}"
        resized.close()
        result.close()
        source.close()
        mask.close()
        return base64.b64encode(output.getvalue()).decode(), final_size, upstream_size
