import base64
import io
import unittest
import asyncio
import importlib
import os
import tempfile
from unittest.mock import AsyncMock, patch

import httpx
from PIL import Image

from image_api.main import app


class InfiniteTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.task_folder = tempfile.TemporaryDirectory()
        self.task_environment = patch.dict(os.environ, {"TASK_DATA_DIR": self.task_folder.name})
        self.task_environment.start()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        self.task_environment.stop()
        self.task_folder.cleanup()

    async def test_catalog_never_exposes_keys_and_filters_unconfigured_providers(self):
        with patch("image_api.api.infinite.settings") as config:
            config.openai_api_key = "private-openai-key"
            config.packy_api_key = None
            config.minimax_api_key = None
            response = await self.client.get("/api/v1/infinite/config")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("private-openai-key", response.text)
        self.assertEqual(response.json()["provider_models"], [])
        models = response.json()["models"]
        self.assertIn("gpt-image-2.6-flare", [item["name"] for item in models])
        self.assertIn("gpt-image-2.5-flare", [item["name"] for item in models])
        self.assertNotIn("image-01", [item["name"] for item in models])
        self.assertTrue(all(item["capability"] == "image" for item in models))

    async def test_env_text_models_are_advertised_without_leaking_keys(self):
        with patch("image_api.api.infinite.settings") as config:
            config.openai_api_key = "image-secret"
            config.packy_api_key = None
            config.minimax_api_key = None
            config.text_api_key = "text-secret"
            config.text_model = "gpt-5.4, gpt-5.4-mini"
            response = await self.client.get("/api/v1/infinite/config")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("text-secret", response.text)
        self.assertNotIn("image-secret", response.text)
        self.assertEqual(response.json()["provider_models"], [
            {"name": "gpt-5.4", "label": "gpt-5.4", "capability": "text"},
            {"name": "gpt-5.4-mini", "label": "gpt-5.4-mini", "capability": "text"},
        ])
        self.assertEqual(response.json()["text_api_format"], "chat-completions")

    async def test_image_key_alone_does_not_advertise_text_models(self):
        with patch("image_api.api.infinite.settings") as config:
            config.openai_api_key = "image-secret"
            config.packy_api_key = None
            config.minimax_api_key = None
            config.text_api_key = None
            config.text_model = "gpt-5.4"
            self.assertEqual((await self.client.get("/api/v1/infinite/config")).json()["provider_models"], [])

    async def test_provider_resolution_keeps_references_and_request_identity(self):
        for model, provider in [("gpt-image-2.5-flare", "auto"), ("gemini-3.1-flash-image-preview", "gemini"), ("image-01", "minimax")]:
            with self.subTest(model=model), patch("image_api.api.infinite.generate", new_callable=AsyncMock) as generate:
                generate.return_value = {"task_id": "existing-task", "images": []}
                response = await self.client.post("/api/v1/infinite/generate", json={
                    "sub_model": model, "prompt": "test", "n": 2, "size": "1536x1024",
                    "image_base64s": ["first", "second"], "client_request_id": "same-submission",
                })
                self.assertEqual(response.status_code, 200)
                request = generate.call_args.args[0]
                self.assertEqual(request.model, provider)
                self.assertEqual(request.sub_model, model)
                self.assertEqual(request.image_base64s, ["first", "second"])
                self.assertEqual(request.client_request_id, "same-submission")
                self.assertEqual(request.n, 2)

    async def test_unknown_model_is_rejected_before_any_paid_submission(self):
        with patch("image_api.api.infinite.generate", new_callable=AsyncMock) as generate:
            response = await self.client.post("/api/v1/infinite/generate", json={"sub_model": "missing", "prompt": "test"})
            self.assertEqual(response.status_code, 422)
            generate.assert_not_awaited()

    async def test_offline_browser_validation_cannot_start_paid_requests(self):
        from image_api.config import settings
        with patch.object(settings, "infinite_offline_validation", True), patch("image_api.api.router.reserve_task") as reserve, patch("image_api.api.infinite_provider.httpx.AsyncClient") as provider:
            self.assertTrue((await self.client.get("/api/v1/infinite/config")).json()["offline_validation"])
            response = await self.client.post("/api/v1/infinite/generate", json={"sub_model": "gpt-image-2.5-flare", "prompt": "test"})
            self.assertEqual(response.status_code, 503)
            self.assertEqual((await self.client.post("/api/v1/generate", json={"prompt": "test"})).status_code, 503)
            self.assertEqual((await self.client.post("/api/v1/infinite/openai/v1/chat/completions", json={"model": "text"})).status_code, 503)
            reserve.assert_not_called()
            provider.assert_not_called()

    async def test_transparent_background_is_forwarded_and_not_silently_dropped(self):
        with patch("image_api.api.infinite.generate", new_callable=AsyncMock) as generate:
            generate.return_value = {"task_id": "transparent", "images": []}
            response = await self.client.post("/api/v1/infinite/generate", json={"sub_model": "gpt-image-2.5-flare", "prompt": "test", "background": "transparent"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(generate.call_args.args[0].background, "transparent")
            unsupported = await self.client.post("/api/v1/infinite/generate", json={"sub_model": "image-01", "prompt": "test", "background": "transparent"})
            self.assertEqual(unsupported.status_code, 422)

    async def test_mask_and_exact_preservation_reach_existing_task_api(self):
        out = io.BytesIO()
        Image.new("RGBA", (10, 10), (255, 255, 255, 0)).save(out, "PNG")
        image = base64.b64encode(out.getvalue()).decode()
        with patch("image_api.api.infinite.generate", new_callable=AsyncMock) as generate:
            generate.return_value = {"task_id": "mask-task", "images": []}
            response = await self.client.post("/api/v1/infinite/generate", json={
                "sub_model": "gpt-image-2.5-flare", "prompt": "edit", "image_base64s": [image],
                "mask_base64": image, "preserve_outside_mask": True,
            })
            self.assertEqual(response.status_code, 200)
            self.assertEqual(generate.call_args.args[0].mask_base64, image)
            self.assertTrue(generate.call_args.args[0].preserve_outside_mask)

    async def test_native_mask_edit_preserves_protected_pixels_through_task_pipeline(self):
        api = importlib.import_module("image_api.api.router")
        def encode(image):
            output = io.BytesIO()
            image.save(output, "PNG")
            return base64.b64encode(output.getvalue()).decode()
        source = Image.new("RGBA", (16, 16), (20, 40, 60, 127))
        mask = Image.new("RGBA", (16, 16), (255, 255, 255, 255))
        mask.putpixel((8, 8), (255, 255, 255, 0))
        generated = Image.new("RGBA", (16, 16), (200, 10, 20, 255))
        with patch.object(api, "generate_openai_image", new_callable=AsyncMock) as provider, patch.object(api, "save_image", new_callable=AsyncMock), patch.object(api, "save_generation_inputs", new_callable=AsyncMock):
            provider.return_value = [{"base64": encode(generated)}]
            result = await self.client.post("/api/v1/infinite/generate", json={"sub_model": "gpt-image-2.5-flare", "prompt": "edit", "size": "16x16", "image_base64s": [encode(source)], "mask_base64": encode(mask), "preserve_outside_mask": True})
            self.assertEqual(result.status_code, 200)
            task_id = result.json()["task_id"]
            for _ in range(30):
                task = (await self.client.get("/api/v1/tasks/" + task_id)).json()
                if task["status"] in ("completed", "failed"):
                    break
                await asyncio.sleep(0)
            self.assertEqual(task["status"], "completed", task.get("error"))
            image = Image.open(io.BytesIO(base64.b64decode(task["images"][0]["base64"])))
            for y in range(16):
                for x in range(16):
                    self.assertEqual(image.getpixel((x, y)), generated.getpixel((x, y)) if (x, y) == (8, 8) else source.getpixel((x, y)))
            self.assertEqual(provider.call_args.kwargs["mask_base64"], encode(mask))

    async def test_spa_deep_link_and_missing_asset(self):
        import tempfile
        from pathlib import Path
        from fastapi import FastAPI
        from image_api.main import InfiniteStaticFiles
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "index.html").write_text("infinite-test")
            Path(folder, "build-info.json").write_text('{"revision":"test"}')
            Path(folder, "config.js").write_text("window.CONFIG = {}")
            mounted = FastAPI()
            mounted.mount("/infinite", InfiniteStaticFiles(directory=folder, html=True))
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=mounted), base_url="http://test") as client:
                for path in ["/infinite/", "/infinite/canvas/project-id", "/infinite/config"]:
                    response = await client.get(path)
                    self.assertEqual(response.text, "infinite-test")
                    self.assertEqual(response.headers["cache-control"], "no-store")
                    cached = await client.get(path, headers={"If-None-Match": response.headers["etag"]})
                    self.assertEqual(cached.status_code, 304)
                    self.assertEqual(cached.headers["cache-control"], "no-store")
                for path in ["/infinite/build-info.json", "/infinite/config.js"]:
                    self.assertEqual((await client.get(path)).headers["cache-control"], "no-store")
                self.assertEqual((await client.get("/infinite/assets/missing.js")).status_code, 404)

    async def test_sync_files_roundtrip_and_path_isolation(self):
        import os
        import tempfile
        from pathlib import Path
        base = "/api/v1/infinite/storage"
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {"INFINITE_DATA_DIR": folder}):
            self.assertEqual((await self.client.request("PROPFIND", base)).status_code, 207)
            self.assertEqual((await self.client.request("MKCOL", base + "/canvas")).status_code, 201)
            self.assertEqual((await self.client.request("MKCOL", base + "/canvas")).status_code, 405)
            self.assertEqual((await self.client.request("MKCOL", base + "/missing/child")).status_code, 409)
            file = base + "/canvas/manifest.json"
            self.assertEqual((await self.client.put(file, content=b'{"projects":[]}')).status_code, 201)
            self.assertEqual((await self.client.get(file)).content, b'{"projects":[]}')
            self.assertEqual((await self.client.get(file)).headers["content-type"], "application/json")
            self.assertIn("attachment", (await self.client.get(file)).headers["content-disposition"])
            self.assertEqual((await self.client.put(file, content=b'{"projects":[1]}')).status_code, 204)
            self.assertEqual((await self.client.get(file)).content, b'{"projects":[1]}')
            self.assertEqual(list(Path(folder).rglob(".upload-*")), [])
            self.assertEqual((await self.client.get(base + "/missing.json")).status_code, 404)
            self.assertEqual((await self.client.get(base + "/%2e%2e/secret")).status_code, 422)
            Path(folder, "outside").symlink_to("/tmp", target_is_directory=True)
            self.assertEqual((await self.client.put(base + "/outside/escaped", content=b"bad")).status_code, 422)

    async def test_fixed_provider_stream_and_server_credentials(self):
        seen = []

        async def upstream(request):
            seen.append(request)
            return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=b'data: {"text":"hello"}\n\ndata: [DONE]\n\n')

        proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch("image_api.api.infinite_provider.settings") as config:
            config.openai_api_key = "server-only-secret"
            config.openai_base_url = "https://provider.test/v1"
            response = await self.client.post("/api/v1/infinite/openai/v1/chat/completions", json={"model": "text", "stream": True}, headers={"Authorization": "Bearer browser-value"})
        self.assertEqual(response.status_code, 200)
        self.assertIn('data: [DONE]', response.text)
        self.assertEqual(str(seen[0].url), "https://provider.test/v1/chat/completions")
        self.assertEqual(seen[0].headers["authorization"], "Bearer server-only-secret")
        self.assertNotIn("server-only-secret", response.text)
        self.assertTrue(proxy.is_closed)

    async def test_text_env_credentials_override_image_openai_key(self):
        seen = []

        async def upstream(request):
            seen.append(request)
            return httpx.Response(200, headers={"Content-Type": "application/json"}, content=b"{}")

        proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch("image_api.api.infinite_provider.settings") as config:
            config.openai_api_key = "image-secret"
            config.openai_base_url = "https://image.test/v1"
            config.text_api_key = "text-secret"
            config.text_base_url = "https://text.test/v1"
            response = await self.client.post("/api/v1/infinite/openai/v1/chat/completions", json={"model": "gpt-5.4"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(seen[0].url), "https://text.test/v1/chat/completions")
        self.assertEqual(seen[0].headers["authorization"], "Bearer text-secret")
        self.assertNotIn("text-secret", response.text)
        self.assertTrue(proxy.is_closed)

    async def test_text_base_without_v1_is_prefixed(self):
        seen = []

        async def upstream(request):
            seen.append(request)
            return httpx.Response(200, headers={"Content-Type": "application/json"}, content=b"{}")

        proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch("image_api.api.infinite_provider.settings") as config:
            config.openai_api_key = "image-secret"
            config.openai_base_url = "https://image.test/v1"
            config.text_api_key = "text-secret"
            config.text_base_url = "https://cf.api.fan"
            response = await self.client.post("/api/v1/infinite/openai/v1/chat/completions", json={"model": "deepseek-flash"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(str(seen[0].url), "https://cf.api.fan/v1/chat/completions")
        self.assertTrue(proxy.is_closed)

    async def test_proxy_rejects_arbitrary_endpoints_and_missing_credentials(self):
        self.assertEqual((await self.client.post("/api/v1/infinite/openai/v1/arbitrary-host")).status_code, 404)
        with patch("image_api.api.infinite_provider.settings") as config:
            config.openai_api_key = None
            self.assertEqual((await self.client.get("/api/v1/infinite/openai/v1/models")).status_code, 503)
