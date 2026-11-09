"""Persist original generation inputs before provider work, without real calls."""
import asyncio
import base64
import io
import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient
from PIL import Image
from image_api.main import app
from image_api.services import gallery,tasks
api=importlib.import_module('image_api.api.router')

def png(color):
    stream=io.BytesIO();Image.new('RGBA',(32,24),color).save(stream,'PNG');return stream.getvalue()

class GenerationInputTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.patches=[patch.object(gallery,'_conn',None),patch.object(gallery,'GALLERY_DIR',self.root),patch.object(gallery,'GALLERY_DB',self.root/'gallery.db'),patch.object(gallery,'THUMB_DIR',self.root),patch.dict(os.environ,{'TASK_DATA_DIR':str(self.root/'tasks')})]
        for p in self.patches:p.start()
        self.client=TestClient(app);self.first=png((25,50,75,128));self.second=png('blue');self.mask=png('black')
    async def asyncTearDown(self):
        if gallery._conn:gallery._conn.close()
        for p in reversed(self.patches):p.stop()
        self.temp.cleanup()
    def request(self,**extra):
        return api.GenerateRequest(model='openai',sub_model='gpt-image-2.5-flare',prompt='input archive fixture',size='1024x1024',**extra)
    async def test_batch_inputs_are_saved_before_provider_and_survive_reopen(self):
        req=self.request(image_base64s=[base64.b64encode(x).decode() for x in [self.first,self.second]],mask_base64=base64.b64encode(self.mask).decode(),n=2)
        task_id=tasks.create_task(req.model,req.sub_model,req.prompt,req.size,req.quality,req.n)
        async def provider(**kwargs):
            saved=json.loads(gallery._get_conn().execute('SELECT inputs FROM generation_inputs WHERE task_id=?',(task_id,)).fetchone()[0])
            self.assertEqual([gallery.reference_path(item['filename']).read_bytes() for item in saved['references']],[self.first,self.second])
            return [{'base64':base64.b64encode(self.second).decode()} for _ in range(2)]
        with patch.object(api,'generate_openai_image',new=AsyncMock(side_effect=provider)) as generate:
            await api._run_generation(task_id,req);self.assertEqual(generate.await_count,1)
        self.assertEqual(tasks.get_task(task_id).status,tasks.TaskStatus.COMPLETED)
        gallery._conn.close();gallery._conn=None
        items=self.client.get('/api/v1/gallery').json()['items'];self.assertEqual(len(items),2)
        self.assertEqual(items[0]['inputs'],items[1]['inputs'])
        for ref,expected in zip(items[0]['inputs']['references'],[self.first,self.second]):
            r=self.client.get(ref['url']);self.assertEqual(r.content,expected);self.assertEqual(r.headers['content-type'],'image/png')
        self.assertEqual(self.client.get(items[0]['inputs']['mask']['url']).content,self.mask)
        self.assertEqual(self.client.get('/api/v1/gallery/references/not-an-image.png').status_code,404)
        self.assertEqual(self.client.get('/api/v1/gallery/'+items[0]['id']).json()['inputs'],items[0]['inputs'])
        self.assertNotIn(base64.b64encode(self.first).decode(),json.dumps(items))
    async def test_storage_failure_prevents_paid_call(self):
        req=self.request(image_base64=base64.b64encode(self.first).decode())
        tid=tasks.create_task(req.model,req.sub_model,req.prompt,req.size,req.quality,1)
        with patch.object(gallery,'_save_reference',side_effect=OSError('disk fixture unavailable')),patch.object(api,'generate_openai_image',new=AsyncMock()) as generate:
            await api._run_generation(tid,req);generate.assert_not_awaited()
        self.assertEqual(tasks.get_task(tid).status,tasks.TaskStatus.FAILED)
    async def test_legacy_unknown_and_new_text_only_are_distinct(self):
        result=[{'base64':base64.b64encode(self.first).decode()}]
        legacy=(await gallery.save_image('openai','image','old','1024x1024',None,1,result))[0]
        self.assertIsNone(gallery.get_image(legacy['id'])['inputs'])
        await gallery.save_generation_inputs('text-fixture',self.request())
        new=(await gallery.save_image('openai','image','new','1024x1024',None,1,result,task_id='text-fixture'))[0]
        self.assertEqual(gallery.get_image(new['id'])['inputs'],{'references':[],'mask':None,'markup':None,'preserve_source':None})
    async def test_url_snapshot_and_preserve_source_keep_exact_bytes(self):
        req=self.request(image_base64s=[base64.b64encode(self.first).decode()],image_urls=['https://example.invalid/reference'],mask_base64=base64.b64encode(self.mask).decode(),preserve_source_base64=base64.b64encode(self.first).decode())
        with patch('image_api.services.openai_img._download_image',new=AsyncMock(return_value=self.second)) as download:
            await gallery.save_generation_inputs('url-fixture',req);download.assert_awaited_once()
        saved=json.loads(gallery._get_conn().execute('SELECT inputs FROM generation_inputs WHERE task_id=?',('url-fixture',)).fetchone()[0])
        self.assertEqual([gallery.reference_path(ref['filename']).read_bytes() for ref in saved['references']],[self.first,self.second])
        self.assertEqual(gallery.reference_path(saved['preserve_source']['filename']).read_bytes(),self.first)
