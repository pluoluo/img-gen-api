"""Create a portable canvas fixture with reference-only images, mask, and audio."""
import io,json,zipfile,wave
from pathlib import Path
from PIL import Image
root=Path('data/infinite-validation');root.mkdir(parents=True,exist_ok=True)
files={}
for name,color in [('primary','green'),('reference','blue'),('source','white'),('mask','black')]:
 b=io.BytesIO();Image.new('RGBA',(80,60),color).save(b,format='PNG');files['image:'+name]=(b.getvalue(),'image/png')
b=io.BytesIO()
with wave.open(b,'wb') as w:w.setnchannels(1);w.setsampwidth(2);w.setframerate(8000);w.writeframes(b'\0\0'*800)
files['audio:fixture']=(b.getvalue(),'audio/wav')
def node(id,type,x,y,meta):return dict(id=id,type=type,title=id,position=dict(x=x,y=y),width=200,height=150,metadata=meta)
project=dict(id='archive-fixture',title='迁移验收画布',createdAt='2026-11-01T00:00:00.000Z',updatedAt='2026-11-01T00:00:00.000Z',nodes=[node('fixture-text','text',0,0,dict(content='image:plain-text',status='success')),node('fixture-image','image',250,0,dict(storageKey='image:primary',content='blob:old-origin/image',status='success',naturalWidth=80,naturalHeight=60)),node('fixture-config','config',500,0,dict(prompt='fixture edit',generationType='edit',references=['image:reference'],imageApiMask=dict(storageKey='image:mask',source=dict(storageKey='image:source',url='blob:old-origin/source')),status='idle')),node('fixture-audio','audio',0,250,dict(storageKey='audio:fixture',content='blob:old-origin/audio',status='success'))],connections=[dict(id='connection-text',fromNodeId='fixture-text',toNodeId='fixture-config'),dict(id='connection-image',fromNodeId='fixture-image',toNodeId='fixture-config')],chatSessions=[],activeChatId=None,backgroundMode='dots',showImageInfo=True,viewport=dict(x=300,y=200,k=0.75))
items=[dict(storageKey=k,path=f'files/{k.replace(":","-")}',mimeType=m,bytes=len(data)) for k,(data,m) in files.items()]
manifest=dict(app='infinite-canvas',version=3,exportedAt='2026-11-01T00:00:00.000Z',projects=[dict(project=project,files=items)])
for variant in ['complete','missing-file']:
 with zipfile.ZipFile(root/f'archive-{variant}.zip','w') as z:
  z.writestr('projects.json',json.dumps(manifest,ensure_ascii=False))
  for item in items:
   if variant=='missing-file' and item['storageKey']=='image:reference':continue
   z.writestr(item['path'],files[item['storageKey']][0])
(root/'archive-fixture.json').write_text(json.dumps(manifest,ensure_ascii=False))
