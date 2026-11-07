"""MiMo relay uses fixed targets, transient caller credentials, and no paid calls."""
import unittest
from unittest.mock import patch

import httpx

from image_api.main import app
from image_api.config import settings


class MimoRelayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_stream_preserves_payload_and_uses_only_callers_bearer(self):
        seen = []

        async def upstream(request):
            seen.append(request)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, content='data: {"choices":[{"delta":{"content":"成功"}}]}\n\ndata: [DONE]\n\n'.encode())

        proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch.object(settings, "infinite_offline_validation", False):
            response = await self.client.post("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions", json={"model": "mimo", "messages": [{"role": "user", "content": "hi"}], "stream": True}, headers={"Authorization": "Bearer transient-user-key", "Cookie": "private-cookie=1", "X-Other-Secret": "not-forwarded"})
        self.assertEqual(response.status_code, 200)
        self.assertIn("成功", response.text)
        self.assertEqual(str(seen[0].url), "https://token-plan-cn.xiaomimimo.com/v1/chat/completions")
        self.assertEqual(seen[0].headers["authorization"], "Bearer transient-user-key")
        self.assertNotIn("cookie", seen[0].headers)
        self.assertNotIn("x-other-secret", seen[0].headers)
        self.assertIn(b'"model":"mimo"', seen[0].content)
        self.assertNotIn("transient-user-key", response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertTrue(proxy.is_closed)

    async def test_error_status_and_models_are_forwarded_once(self):
        for cluster, method, path, status in [("api", "GET", "v1/models", 200), ("token-plan-sgp", "POST", "v1/responses", 403)]:
            with self.subTest(cluster=cluster):
                seen = []

                async def upstream(request):
                    seen.append(request)
                    return httpx.Response(status, json={"error": {"message": "model denied"}} if status == 403 else {"data": []})

                proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
                with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch.object(settings, "infinite_offline_validation", False):
                    response = await self.client.request(method, f"/api/v1/infinite/mimo/{cluster}/{path}", headers={"Authorization": "Bearer caller-key"})
                self.assertEqual(response.status_code, status)
                self.assertEqual(len(seen), 1)
                self.assertEqual(str(seen[0].url), f"https://{cluster}.xiaomimimo.com/{path}")
                self.assertTrue(proxy.is_closed)

    async def test_rejects_arbitrary_targets_paths_and_missing_credentials(self):
        with patch("image_api.api.infinite_provider.httpx.AsyncClient") as factory, patch.object(settings, "infinite_offline_validation", False):
            for url in ["localhost/v1/chat/completions", "token-plan-cn/v1/images/generations", "token-plan-cn/v1/audio/speech", "token-plan-cn/https://example.com"]:
                self.assertEqual((await self.client.post("/api/v1/infinite/mimo/" + url, headers={"Authorization": "Bearer placeholder"})).status_code, 404)
            self.assertEqual((await self.client.post("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions")).status_code, 401)
            factory.assert_not_called()

    async def test_offline_mode_cannot_submit_provider_requests(self):
        with patch("image_api.api.infinite_provider.httpx.AsyncClient") as factory, patch.object(settings, "infinite_offline_validation", True):
            response = await self.client.post("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions", headers={"Authorization": "Bearer placeholder"})
            self.assertEqual(response.status_code, 503)
            factory.assert_not_called()

    async def test_connection_error_is_readable_and_closes_client(self):
        async def upstream(request):
            raise httpx.ConnectError("connection error", request=request)

        proxy = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        with patch("image_api.api.infinite_provider.httpx.AsyncClient", return_value=proxy), patch.object(settings, "infinite_offline_validation", False):
            response = await self.client.post("/api/v1/infinite/mimo/token-plan-cn/v1/chat/completions", headers={"Authorization": "Bearer hidden-key"})
        self.assertEqual(response.status_code, 502)
        self.assertIn("供应商连接失败", response.json()["detail"])
        self.assertNotIn("hidden-key", response.text)
        self.assertTrue(proxy.is_closed)
