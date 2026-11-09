"""Geometry, compatibility, multipart propagation and task idempotency regressions."""
import asyncio
import base64
import io
import unittest
from unittest.mock import AsyncMock, patch
import httpx
from PIL import Image
from image_api.main import app
import importlib
import os
import tempfile
api = importlib.import_module('image_api.api.router')
from image_api.services.masking import preprocess_mask, composite_outside
from image_api.services.openai_img import generate_openai_image
from image_api.services.tasks import get_task


def png(size=(400, 300), color=(35, 86, 128, 255)):
    image = Image.new('RGBA', size, color)
    out = io.BytesIO()
    image.save(out, 'PNG')
    return base64.b64encode(out.getvalue()).decode()


def mask():
    image = Image.new('RGBA', (400, 300), (255, 255, 255, 255))
    for x in range(100, 200):
        for y in range(80, 160):
            image.putpixel((x, y), (255, 255, 255, 0))
    out = io.BytesIO()
    image.save(out, 'PNG')
    return base64.b64encode(out.getvalue()).decode()


class PixelTests(unittest.TestCase):
    def test_shared_resize_preserves_alpha_and_region(self):
        raw = preprocess_mask(mask(), png(), '800x600')
        image = Image.open(io.BytesIO(raw))
        self.assertEqual(image.size, (800, 600))
        self.assertEqual(image.mode, 'RGBA')
        self.assertEqual(image.getpixel((250, 200))[3], 0)
        self.assertEqual(image.getpixel((50, 50))[3], 255)

    def test_composite_protected_pixels_exact_at_source_resolution(self):
        source = png(color=(35, 86, 128, 127))
        output, size, upstream = composite_outside(source, mask(), png((800, 600), (200, 50, 10, 255)))
        result = Image.open(io.BytesIO(base64.b64decode(output)))
        original = Image.open(io.BytesIO(base64.b64decode(source)))
        m = Image.open(io.BytesIO(base64.b64decode(mask())))
        for before, after, selection in zip(original.getdata(), result.getdata(), m.getdata()):
            if selection[3] == 255:
                self.assertEqual(before, after)
        self.assertEqual(result.getpixel((150, 100)), (200, 50, 10, 255))
        self.assertEqual((size, upstream), ('400x300', '800x600'))


class MaskApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.task_folder = tempfile.TemporaryDirectory()
        self.task_env = patch.dict(os.environ, {"TASK_DATA_DIR": self.task_folder.name})
        self.task_env.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')
        self.storage = patch.object(api, 'save_image', new=AsyncMock(return_value=[]))
        self.storage.start()
        self.inputs = patch.object(api, "save_generation_inputs", new=AsyncMock())
        self.inputs.start()
        api._submissions.clear()

    async def asyncTearDown(self):
        await self.client.aclose()
        self.storage.stop()
        self.inputs.stop()
        self.task_env.stop()
        self.task_folder.cleanup()

    def payload(self, **extra):
        return dict(model='auto', sub_model='gpt-image-2.5-flare', prompt='edit', image_base64s=[png()], mask_base64=mask(), **extra)

    async def submit(self, body):
        response = await self.client.post('/api/v1/generate', json=body)
        self.assertEqual(response.status_code, 200, response.text[:300])
        task_id = response.json()['task_id']
        for _ in range(30):
            await asyncio.sleep(0)
            if get_task(task_id).status.value in ('completed', 'failed'):
                break
        return get_task(task_id)

    async def test_validation_and_unsupported_model(self):
        for change in [dict(mask_base64='broken'), dict(mask_base64=png((20, 20))), dict(mask_base64=png()), dict(mask_reference_index=1), dict(model='gemini'), dict(model='minimax')]:
            body = self.payload()
            body.update(change)
            response = await self.client.post('/api/v1/generate', json=body)
            self.assertEqual(response.status_code, 422)
        body = self.payload()
        del body['image_base64s']
        self.assertEqual((await self.client.post('/api/v1/generate', json=body)).status_code, 422)
        body = self.payload()
        del body['mask_base64']
        body['preserve_outside_mask'] = True
        self.assertEqual((await self.client.post('/api/v1/generate', json=body)).status_code, 422)

    async def test_auto_retry_and_explicit_provider_keep_mask(self):
        for provider in ('auto', 'openai', 'packy'):
            body = self.payload()
            body['model'] = provider
            output = [{'base64': png(), 'url': None}]
            side_effect = [RuntimeError('first upstream failed'), output] if provider == 'auto' else [output]
            with patch.object(api, 'resolve_gpt_route', return_value=('openai', body['sub_model'])), patch.object(api, 'generate_openai_image', new=AsyncMock(side_effect=side_effect)) as generate:
                task = await self.submit(body)
                self.assertEqual(task.status.value, 'completed', task.error)
                self.assertEqual(generate.await_count, 2 if provider == 'auto' else 1)
                for call in generate.await_args_list:
                    self.assertEqual(call.kwargs['mask_base64'], body['mask_base64'])
                    self.assertEqual(call.kwargs['image_base64s'], body['image_base64s'])

    async def test_old_request_and_duplicate_submission(self):
        with patch.object(api, 'generate_openai_image', new=AsyncMock(return_value=[{'base64': png()}])) as generate:
            body = dict(model='openai', prompt='legacy', client_request_id='once')
            first = await self.submit(body)
            again = await self.client.post('/api/v1/generate', json=body)
            self.assertEqual(again.json()['task_id'], first.id)
            self.assertEqual(generate.await_count, 1)
            self.assertIsNone(generate.await_args.kwargs['mask_base64'])
            conflict = await self.client.post('/api/v1/generate', json={**body, 'prompt':'different'})
            self.assertEqual(conflict.status_code, 409)

    async def test_preservation_is_applied_before_task_and_gallery(self):
        with patch.object(api, 'generate_openai_image', new=AsyncMock(return_value=[{'base64': png((800, 600), (255, 0, 0, 255))}])):
            body = self.payload(preserve_outside_mask=True, preserve_source_base64=png(color=(20, 30, 40, 255)))
            body['model'] = 'openai'
            task = await self.submit(body)
            self.assertEqual(task.status.value, 'completed', task.error)
            image = Image.open(io.BytesIO(base64.b64decode(task.images[0]['base64'])))
            self.assertEqual(image.getpixel((10, 10)), (20, 30, 40, 255))
            self.assertEqual(image.getpixel((150, 100)), (255, 0, 0, 255))
            self.assertEqual(task.images[0]['adjusted_size'], '400x300')
            self.assertEqual(task.images[0]['upstream_size'], '800x600')
            self.assertEqual(api.save_image.await_args.kwargs['image_results'], task.images)

    async def test_url_primary_is_frozen_and_mask_still_matches(self):
        body = self.payload()
        body.pop('image_base64s')
        body.update(model='packy', image_urls=['https://fixture/primary.png', 'https://fixture/secondary.png'])
        with patch('image_api.services.openai_img._download_image', new=AsyncMock(return_value=base64.b64decode(png()))) as download, patch.object(api, 'generate_openai_image', new=AsyncMock(return_value=[{'base64':png()}])) as generate:
            task = await self.submit(body)
            self.assertEqual(task.status.value, 'completed', task.error)
            download.assert_awaited_once_with('https://fixture/primary.png')
            self.assertEqual(generate.await_args.kwargs['image_base64s'], [png()])
            self.assertEqual(generate.await_args.kwargs['image_urls'], ['https://fixture/secondary.png'])
            self.assertEqual(generate.await_args.kwargs['mask_base64'], body['mask_base64'])

    async def test_multipart_mask_and_primary_share_dimensions(self):
        response = {'data':[{'b64_json':png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('edit', image_base64s=[png(), png((512, 512))], mask_base64=mask(), size='1024x1024')
            files = post.await_args.kwargs['files']
            self.assertEqual([f[0] for f in files], ['image[]', 'mask', 'image[]'])
            primary = Image.open(io.BytesIO(files[0][1][1]))
            mask_image = Image.open(io.BytesIO(files[1][1][1]))
            self.assertEqual(primary.size, mask_image.size)
            self.assertEqual(mask_image.mode, 'RGBA')
            self.assertEqual(mask_image.getchannel('A').getextrema(), (0, 255))
            extra = Image.open(io.BytesIO(files[2][1][1]))
            self.assertEqual(extra.size, (1024, 1024))

    async def test_additional_refs_are_scaled_to_target_width(self):
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image(
                'edit',
                image_base64s=[png((3840, 2160)), png((3840, 2160))],
                size='1664x944',
            )
            files = post.await_args.kwargs['files']
            self.assertEqual([f[0] for f in files], ['image[]', 'image[]'])
            first = Image.open(io.BytesIO(files[0][1][1]))
            second = Image.open(io.BytesIO(files[1][1][1]))
            self.assertEqual(first.size, (1664, 928))
            self.assertEqual(second.size, first.size)

    async def test_markup_is_transparent_png_matching_resized_primary(self):
        overlay = Image.new('RGBA', (3840, 2160), (0, 0, 0, 0))
        for x in range(80, 160):
            for y in range(80, 120):
                overlay.putpixel((x, y), (255, 0, 0, 255))
        buf = io.BytesIO()
        overlay.save(buf, 'PNG')
        markup = base64.b64encode(buf.getvalue()).decode()
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('edit', image_base64s=[png((3840, 2160))], markup_base64=markup, size='1664x944')
            files = post.await_args.kwargs['files']
            self.assertEqual([f[0] for f in files], ['image[]', 'markup'])
            primary = Image.open(io.BytesIO(files[0][1][1]))
            layer = Image.open(io.BytesIO(files[1][1][1]))
            self.assertEqual(layer.size, primary.size)
            self.assertEqual(primary.size, (1664, 928))
            self.assertEqual(layer.mode, 'RGBA')
            self.assertLess(layer.getchannel('A').getextrema()[0], 255)
            self.assertGreater(layer.getchannel('A').getextrema()[1], 0)

    async def test_mask_matches_resized_primary_png(self):
        painted = Image.new('RGBA', (3840, 2160), (255, 255, 255, 255))
        for x in range(10, 40):
            for y in range(10, 40):
                painted.putpixel((x, y), (255, 255, 255, 0))
        buf = io.BytesIO()
        painted.save(buf, 'PNG')
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('edit', image_base64s=[png((3840, 2160))], mask_base64=base64.b64encode(buf.getvalue()).decode(), size='1664x944')
            files = post.await_args.kwargs['files']
            primary = Image.open(io.BytesIO(files[0][1][1]))
            mask_image = Image.open(io.BytesIO(files[1][1][1]))
            self.assertEqual([f[0] for f in files], ['image[]', 'mask'])
            self.assertEqual(mask_image.size, primary.size)
            self.assertEqual(mask_image.mode, 'RGBA')

    async def test_markup_rejects_opaque_flatten_and_mask_combo(self):
        with self.assertRaises(ValueError):
            await generate_openai_image('edit', image_base64s=[png()], markup_base64=png(), size='1024x1024')
        with self.assertRaises(ValueError):
            await generate_openai_image('edit', image_base64s=[png()], mask_base64=mask(), markup_base64=mask(), size='1024x1024')

    async def test_svg_rejects_references_and_gif_sends_frame_fields(self):
        with self.assertRaises(ValueError):
            await generate_openai_image('draw', image_base64s=[png()], output_format='svg', size='1024x1024')
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('draw', output_format='gif', frame_count=4, frame_duration_ms=126, size='1024x1024')
            body = post.await_args.kwargs['data']
            self.assertEqual(body['output_format'], 'gif')
            self.assertEqual(body['frame_count'], 4)
            self.assertEqual(body['frame_duration_ms'], 130)
            self.assertEqual(post.await_args.kwargs.get('files'), None)

    async def test_text_to_image_forwards_auto_size(self):
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('draw', size='auto')
            self.assertEqual(post.await_args.kwargs['data']['size'], 'auto')
            self.assertEqual(post.await_args.kwargs['data']['complexity'], 'high')
            self.assertEqual(post.await_args.kwargs.get('files'), None)

    async def test_complexity_is_sent_for_26_and_skipped_for_25(self):
        response = {'data': [{'b64_json': png()}]}
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('draw', model='gpt-image-2.6-flare', complexity='low', size='1024x1024')
            self.assertEqual(post.await_args.kwargs['data']['complexity'], 'low')
        with patch('image_api.services.openai_img._httpx_post', new=AsyncMock(return_value=response)) as post:
            await generate_openai_image('draw', model='gpt-image-2.5-flare', complexity='low', size='1024x1024')
            self.assertNotIn('complexity', post.await_args.kwargs['data'])
