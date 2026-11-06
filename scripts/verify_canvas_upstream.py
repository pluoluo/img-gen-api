"""One explicitly invoked, paid upstream mask probe. Never runs in test discovery."""
import asyncio
import base64
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from PIL import Image, ImageDraw, ImageChops
from image_api.config import settings
from image_api.services.openai_img import generate_openai_image
from image_api.services.masking import composite_outside


def encode(image):
    buffer = io.BytesIO()
    image.save(buffer, 'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


async def main():
    output = Path('data/canvas-validation')
    output.mkdir(parents=True, exist_ok=True)
    source = Image.new('RGB', (1024, 1024), '#235680')
    draw = ImageDraw.Draw(source)
    draw.rectangle((64, 64, 960, 960), outline='#ebbe54', width=24)
    draw.rectangle((400, 400, 624, 624), fill='#d83030')
    mask = Image.new('RGBA', source.size, (255, 255, 255, 255))
    ImageDraw.Draw(mask).rectangle((352, 352, 672, 672), fill=(255, 255, 255, 0))
    source.save(output/'source.png')
    mask.save(output/'mask.png')
    metadata = {'date':datetime.now(timezone.utc).isoformat(), 'provider':'openai', 'host':urlparse(settings.openai_base_url).hostname, 'model':'gpt-image-2.5-flare', 'size':'1024x1024', 'quality':'low', 'mask_semantics':'RGBA: alpha=0 edit; alpha=255 protect', 'input_size':[1024,1024], 'calls':1}
    if not settings.openai_api_key:
        raise RuntimeError('openai key is not configured')
    try:
        images = await generate_openai_image(
            'Change the red square in the center into a bright green circle. The transparent area of the mask is the only edit region. Preserve the dark blue background and the gold frame.',
            model=metadata['model'], image_base64s=[encode(source)], mask_base64=encode(mask), size='1024x1024', quality='low',
        )
        if not images or not images[0].get('base64'):
            raise RuntimeError('No downloadable image returned')
        generated = Image.open(io.BytesIO(base64.b64decode(images[0]['base64']))).convert('RGBA')
        generated.save(output/'upstream.png')
        metadata['output_size'] = list(generated.size)
        raw_diff = ImageChops.difference(source, generated.resize(source.size).convert('RGB'))
        metadata['raw_outside_changed_pixels'] = sum(any(pixel) and alpha == 255 for pixel, alpha in zip(raw_diff.getdata(), mask.getchannel('A').getdata()))
        metadata['protected_pixel_count'] = mask.getchannel('A').histogram()[255]
        composed, final_size, _ = composite_outside(encode(source), encode(mask), images[0]['base64'])
        final = Image.open(io.BytesIO(base64.b64decode(composed)))
        final.save(output/'composed.png')
        difference = ImageChops.difference(source.convert('RGBA'), final)
        outside = mask.getchannel('A')
        changed = difference.convert('RGB').point(lambda v: 255 if v else 0)
        protected_difference = ImageChops.multiply(changed, Image.merge('RGB',(outside,outside,outside)))
        metadata['protected_pixels_exact'] = protected_difference.getbbox() is None
        metadata['final_size'] = final_size
        metadata['raw_center_rgba'] = list(generated.resize(source.size).getpixel((512,512)))
        metadata['status'] = 'success'
    except Exception as exc:
        metadata['status'] = 'failed'
        metadata['error'] = type(exc).__name__ + ': ' + str(exc)[:500]
    (output/'result.json').write_text(json.dumps(metadata, indent=2, ensure_ascii=False))
    print(json.dumps(metadata, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
