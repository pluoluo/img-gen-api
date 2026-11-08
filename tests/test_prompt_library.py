import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, AsyncMock

import httpx
from PIL import Image
from image_api.main import app
from image_api.services import prompt_library as library
from image_api.config import settings


class PromptLibraryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.portal = self.root / 'portal'
        (self.portal / 'data/gallery_images').mkdir(parents=True)
        self.env = patch.dict(os.environ, {'PROMPT_LIBRARY_DATA_DIR': str(self.root / 'library'), 'PROMPT_PORTAL_DATA_DIR': str(self.portal)})
        self.env.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')
        self.original = 'A cinematic portrait. Keep the printed text "你好".'
        self.image_url = 'https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images/case1.jpg'
        self.write(self.portal / 'prompts_data.json', [{'id': 1, 'title': '人像', 'prompt': '电影感人像，保留文字“你好”。', 'category': '摄影'}])
        self.write(self.portal / 'data/gallery_data.json', {'cases': [{'id': 1, 'title': '人像', 'prompt': self.original, 'image': '/images/case1.jpg', 'sourceLabel': '@Author', 'sourceUrl': 'https://example.com/source'}]})
        Image.new('RGB', (4, 4), 'red').save(self.portal / 'data/gallery_images/case1.jpg')
        self.write(library.data_dir() / 'sources/freestylefly-gpt-image-2.json', [{'id': 'remote-1', 'title': '人像', 'prompt': self.original, 'coverUrl': self.image_url, 'tags': ['Photography', '@Author']}])

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False))

    async def asyncTearDown(self):
        await self.client.aclose()
        self.env.stop()
        self.temp.cleanup()

    async def test_read_only_portal_reuses_local_image_and_chinese_version(self):
        before = (self.portal / 'prompts_data.json').read_bytes()
        response = await self.client.get('/api/v1/infinite/prompt-library/sources/prompt-portal')
        self.assertEqual(response.status_code, 200)
        item, = response.json()
        self.assertEqual(item['originalPrompt'], self.original)
        self.assertEqual(item['promptZh'], '电影感人像，保留文字“你好”。')
        self.assertEqual(item['translationLabel'], '本机中文版本')
        with patch.object(library, 'client') as network:
            image = await self.client.get(item['coverUrl'])
            network.assert_not_called()
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.headers['content-type'], 'image/jpeg')
        self.assertEqual((self.portal / 'prompts_data.json').read_bytes(), before)
        remote = (await self.client.get('/api/v1/infinite/prompt-library/sources/freestylefly-gpt-image-2')).json()[0]
        self.assertEqual(remote['canonicalKey'], item['canonicalKey'])
        self.assertEqual(remote['promptZh'], item['promptZh'])

    async def test_ambiguous_titles_keep_independent_templates(self):
        self.write(self.portal / 'prompts_data.json', [{'id': i, 'title': '人像', 'prompt': text} for i, text in [(1, '红色电影人像'), (2, '蓝色棚拍人像')]])
        items = library.portal_records()
        self.assertEqual(len(items), 3)
        self.assertFalse(items[0]['promptZh'])

    async def test_source_refresh_failure_keeps_previous_snapshot(self):
        path = library.data_dir() / 'sources/freestylefly-gpt-image-2.json'
        before = path.read_bytes()
        mock = AsyncMock()
        mock.get.side_effect = httpx.ConnectError('offline')
        with patch.object(library, 'client') as factory:
            factory.return_value.__aenter__.return_value = mock
            response = await self.client.get('/api/v1/infinite/prompt-library/sources/freestylefly-gpt-image-2?refresh=true')
        self.assertEqual(response.status_code, 502)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual((await self.client.get('/api/v1/infinite/prompt-library/sources/freestylefly-gpt-image-2')).status_code, 200)

    async def test_image_registry_rejects_arbitrary_targets_and_private_redirects(self):
        for url in ['http://127.0.0.1/x', 'https://localhost/x', 'https://raw.githubusercontent.com.evil.test/x', 'https://user:pass@github.com/x', 'https://github.com:8766/x']:
            self.assertFalse(library.safe_image_url(url))
        response = await self.client.get('/api/v1/infinite/prompt-library/images/' + 'a' * 64)
        self.assertEqual(response.status_code, 404)
        mock = AsyncMock()
        mock.max_redirects = 20
        mock.get.return_value = httpx.Response(302, headers={'location': 'http://127.0.0.1/private'}, request=httpx.Request('GET', self.image_url))
        # Remove the local copy so the test exercises a download.
        (self.portal / 'data/gallery_images/case1.jpg').unlink()
        library._image_registry.cache_clear()
        with patch.object(library, 'client') as factory:
            factory.return_value.__aenter__.return_value = mock
            response = await self.client.get('/api/v1/infinite/prompt-library/images/' + library.image_id(self.image_url))
        self.assertEqual(response.status_code, 502)
        self.assertEqual(mock.get.call_count, 1)

    async def test_translation_offline_guard_and_persistent_cache(self):
        with patch.object(settings, 'infinite_offline_validation', True), patch('image_api.api.prompt_library.httpx.AsyncClient') as paid:
            response = await self.client.post('/api/v1/infinite/prompt-library/translate', json={'prompt': self.original})
            self.assertEqual(response.status_code, 503)
            paid.assert_not_called()
        library.atomic_json(library.data_dir() / 'translations' / f'{library.content_key(self.original)}.json', {'promptZh': '忠实中文译文', 'translationLabel': 'AI 中文译文'})
        response = await self.client.post('/api/v1/infinite/prompt-library/translate', json={'prompt': self.original})
        self.assertEqual(response.json()['promptZh'], '忠实中文译文')
        item = (await self.client.get('/api/v1/infinite/prompt-library/sources/freestylefly-gpt-image-2')).json()[0]
        self.assertEqual(item['promptZh'], '忠实中文译文')
        self.assertEqual(item['originalPrompt'], self.original)

    async def test_invalid_source_and_empty_translation(self):
        self.assertEqual((await self.client.get('/api/v1/infinite/prompt-library/sources/unknown')).status_code, 404)
        self.assertEqual((await self.client.post('/api/v1/infinite/prompt-library/translate', json={'prompt': ' '})).status_code, 422)
        self.assertFalse(library.chinese_body(self.original))


    async def test_selected_model_translation_can_be_shared_without_a_model_call(self):
        with patch('image_api.api.prompt_library.httpx.AsyncClient') as paid:
            missing = await self.client.post('/api/v1/infinite/prompt-library/translations', json={'prompt': self.original})
            self.assertEqual(missing.status_code, 404)
            saved = await self.client.post('/api/v1/infinite/prompt-library/translations', json={'prompt': self.original, 'promptZh': '电影感肖像，保留原始文案。'})
            self.assertEqual(saved.status_code, 200)
            again = await self.client.post('/api/v1/infinite/prompt-library/translations', json={'prompt': self.original})
            self.assertEqual(again.json(), saved.json())
            paid.assert_not_called()
        self.assertEqual((await self.client.post('/api/v1/infinite/prompt-library/translations', json={'prompt': self.original, 'promptZh': 'not translated'})).status_code, 422)

    async def test_original_line_breaks_and_literal_escapes_are_not_rewritten(self):
        raw = 'First paragraph\n\nJSON example {"text": "line one\\nline two"}'
        item, = library.prepare_records([{'id': 'raw', 'title': '原文', 'prompt': raw, 'coverUrl': ''}])
        self.assertEqual(item['prompt'], raw)
        self.assertEqual(item['originalPrompt'], raw)

    async def test_original_snapshot_ids_link_translations_even_when_titles_repeat(self):
        self.write(self.portal / 'prompts_data.json', [
            {'id': 10, 'title': '通用界面', 'prompt': '红色的产品界面，保留所有细节。'},
            {'id': 20, 'title': '通用界面', 'prompt': '蓝色的社交界面，保留所有细节。'},
        ])
        self.write(self.portal / 'prompts_data.json.bak', [
            {'id': 10, 'title': 'Original red UI', 'prompt': 'A red product interface.'},
            {'id': 20, 'title': 'Original blue UI', 'prompt': 'A blue social interface.'},
        ])
        self.write(self.portal / 'data/gallery_data.json', {'cases': [
            {'id': 1, 'title': '通用界面', 'prompt': 'A red product interface.'},
            {'id': 2, 'title': '通用界面', 'prompt': 'A blue social interface.'},
        ]})
        items = library.portal_records()
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]['promptZh'], '红色的产品界面，保留所有细节。')
        self.assertEqual(items[1]['promptZh'], '蓝色的社交界面，保留所有细节。')
