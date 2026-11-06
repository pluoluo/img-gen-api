import base64
import copy
import io
import os
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image
from fastapi.testclient import TestClient
from image_api.main import app
from image_api.services import canvas_projects as store


def png():
    out = io.BytesIO()
    Image.new('RGBA', (400,300), (12,34,56,127)).save(out, 'PNG')
    return out.getvalue()


class CanvasProjectTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.env = patch.dict(os.environ, {'CANVAS_DATA_DIR':self.folder.name})
        self.env.start()
        self.client = TestClient(app)
        result = self.client.post('/api/v1/canvas/assets', files={'file':('one.png',png(),'image/png')})
        self.assertEqual(result.status_code,200)
        self.asset = {'id':'asset-1','name':'one.png',**result.json()}
        self.doc = {'schemaVersion':1,'images':[{'id':'image-1','assetId':'asset-1','x':25,'y':70,'scaleX':1,'scaleY':1,'rotation':37,'crop':{'x':30,'y':20,'width':250,'height':200},'marks':[{'id':'text-1','kind':'text','points':[40,40],'color':'#fff','width':2,'fontSize':24,'text':'中文标注'}],'regions':[{'id':'region-1','kind':'lasso','points':[100,100,200,100,200,200],'width':12}]}]}
        self.snapshot={'schemaVersion':1,'document':self.doc,'assets':{'asset-1':self.asset},'view':{'x':-300,'y':125,'scale':.7},'history':{'past':[{'schemaVersion':1,'images':[]}],'future':[]},'selection':['image-1'],'generator':{'prompt':'长提示词','model':'gpt-image-2.5-flare','size':'auto','quality':'medium','refs':['image-1'],'masked':True,'preserve':True,'jobs':[]},'tools':{'tool':'text','color':'#fff','width':2,'fontSize':24,'text':'中文标注'}}

    def tearDown(self):
        self.client.close()
        self.env.stop()
        self.folder.cleanup()

    def save(self, snapshot=None, base=0):
        return self.client.put('/api/v1/canvas/projects/test-project',json={'title':'工作画布','snapshot':snapshot or self.snapshot,'base_revision':base})

    def test_roundtrip_revisions_branch_and_restart(self):
        first=self.save()
        self.assertEqual(first.status_code,200,first.text)
        self.assertEqual(first.json()['revision'],1)
        second=copy.deepcopy(self.snapshot)
        second['document']['images'][0]['x']=700
        second['generator']['prompt']='之后的提示词'
        self.assertEqual(self.save(second,1).json()['revision'],2)
        # Reopen through a fresh client/SQLite connection, as after a server restart.
        with TestClient(app) as restarted:
            loaded=restarted.get('/api/v1/canvas/projects/test-project').json()
            self.assertEqual(loaded['snapshot'],second)
            original=restarted.get('/api/v1/canvas/projects/test-project?revision=1').json()
            self.assertEqual(original['snapshot'],self.snapshot)
            self.assertEqual(original['head_revision'],2)
            self.assertEqual(restarted.get(self.asset['url']).content,png())
        branch=copy.deepcopy(self.snapshot)
        branch['document']['images'][0]['rotation']=80
        self.assertEqual(self.save(branch,2).json()['revision'],3)
        self.assertEqual(self.client.get('/api/v1/canvas/projects/test-project?revision=2').json()['snapshot'],second)
        revisions=self.client.get('/api/v1/canvas/projects/test-project/revisions?limit=2').json()
        self.assertEqual([r['revision'] for r in revisions['items']],[3,2])
        self.assertEqual(revisions['total'],3)
        self.assertEqual(self.client.get('/api/v1/canvas/projects/test-project/revisions?offset=2').json()['items'][0]['revision'],1)

    def test_duplicate_save_and_multi_window_conflict(self):
        self.assertEqual(self.save().json()['revision'],1)
        self.assertEqual(self.save().json()['revision'],1) # response lost; retry is safe
        changed=copy.deepcopy(self.snapshot)
        changed['generator']['prompt']='other window'
        self.assertEqual(self.save(changed,0).status_code,409)
        self.assertEqual(self.client.get('/api/v1/canvas/projects/test-project').json()['snapshot'],self.snapshot)

    def test_assets_are_deduplicated_and_snapshot_has_references_only(self):
        response=self.client.post('/api/v1/canvas/assets',files={'file':('two.png',png(),'image/png')})
        self.assertEqual(response.json()['url'],self.asset['url'])
        self.assertEqual(len(list((store.storage_dir()/'assets').glob('*.png'))),1)
        self.save()
        loaded=self.client.get('/api/v1/canvas/projects/test-project').json()['snapshot']
        self.assertNotIn(base64.b64encode(png()).decode(),str(loaded))
        self.assertEqual(loaded['assets']['asset-1']['url'],self.asset['url'])

    def test_invalid_snapshot_does_not_overwrite_history(self):
        self.save()
        changes=[{'schemaVersion':99},{'assets':{'asset-1':{**self.asset,'url':'blob:temporary'}}},{'assets':{'asset-1':{**self.asset,'url':'data:image/png;base64,aaa'}}},{'assets':{}},{'generator':{'image_base64s':['embedded']}}]
        for change in changes:
            invalid={**self.snapshot,**change}
            self.assertEqual(self.save(invalid,1).status_code,422)
        self.assertEqual(self.client.get('/api/v1/canvas/projects/test-project').json()['snapshot'],self.snapshot)
        self.assertEqual(self.client.post('/api/v1/canvas/assets',files={'file':('bad.png',b'broken','image/png')}).status_code,422)
        self.assertEqual(self.client.get('/api/v1/canvas/assets/invalid').status_code,422)
        self.assertEqual(self.client.get('/api/v1/canvas/assets/'+'0'*64).status_code,404)

    def test_project_listing_and_unknown_version(self):
        self.save()
        self.assertEqual(self.client.get('/api/v1/canvas/projects').json()['items'][0]['title'],'工作画布')
        self.assertEqual(self.client.get('/api/v1/canvas/projects/test-project?revision=99').status_code,404)
        self.assertEqual(self.client.get('/api/v1/canvas/projects/missing').status_code,404)
