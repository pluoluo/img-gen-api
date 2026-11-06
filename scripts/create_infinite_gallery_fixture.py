"""Seed an explicitly isolated gallery with synthetic history and original inputs."""
import asyncio,base64,os
from pathlib import Path
if not os.environ.get('GALLERY_DATA_DIR') or 'infinite-validation' not in Path(os.environ['GALLERY_DATA_DIR']).parts:raise SystemExit('Requires isolated infinite-validation GALLERY_DATA_DIR')
from image_api.services import gallery
from image_api.api.router import GenerateRequest
from create_infinite_fixture import *
async def main():
    if gallery.count_images():return
    raw=Path('data/infinite-validation/fixture.png').read_bytes();encoded=base64.b64encode(raw).decode()
    from PIL import Image
    import io
    buf=io.BytesIO();Image.new('RGBA',(1024,1024),(255,255,255,0)).save(buf,'PNG');mask=base64.b64encode(buf.getvalue()).decode()
    for label,task in [('旧记录 green fixture',None),('无参考图 green fixture','fixture-none'),('双参考图 green fixture','fixture-refs')]:
        if task:
            await gallery.save_generation_inputs(task,GenerateRequest(model='openai',sub_model='gpt-image-2.5-flare',prompt=label,image_base64s=[encoded,mask] if task=='fixture-refs' else None,mask_base64=mask if task=='fixture-refs' else None))
        await gallery.save_image('openai','gpt-image-2.5-flare',label,'1024x1024','low',1,[{'base64':encoded}],task_id=task)
asyncio.run(main())
