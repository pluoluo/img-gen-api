"""Client-owned results: no archive, durable delivery, authenticated release."""
import importlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from image_api.main import app
from image_api.services import tasks

api = importlib.import_module("image_api.api.router")


class ClientDeliveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.environment = patch.dict(os.environ, {"TASK_DATA_DIR": str(self.root)})
        self.environment.start()
        self.previous = tasks._tasks.copy()
        tasks._tasks.clear()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.parameters = dict(model="openai", sub_model="gpt-image-2.5-flare", prompt="delivery", size="1024x1024", quality="low", n=2)

    async def asyncTearDown(self):
        await self.client.aclose()
        tasks._tasks.clear()
        tasks._tasks.update(self.previous)
        self.environment.stop()
        self.folder.cleanup()

    def reserve(self, **extra):
        parameters = {**self.parameters, "save_to_gallery": False, **extra}
        task_id, _ = tasks.reserve_task(**parameters, client_request_id="client", fingerprint="original")
        return task_id

    def complete(self, task_id):
        tasks.update_task(task_id, status=tasks.TaskStatus.COMPLETED, images=[{"base64": "first-result"}, {"base64": "second-result"}], progress=100)

    async def ack(self, task_id, client="client"):
        return await self.client.post(f"/api/v1/tasks/{task_id}/acknowledge", json={"client_request_id": client})

    async def test_worker_skips_gallery_and_reference_archive(self):
        task_id = self.reserve()
        request = api.GenerateRequest(**self.parameters, save_to_gallery=False, image_base64s=["reference"], client_request_id="client")
        with patch.object(api, "generate_openai_image", new=AsyncMock(return_value=[{"base64": "first-result"}, {"base64": "second-result"}])), patch.object(api, "save_image", new_callable=AsyncMock) as archive, patch.object(api, "save_generation_inputs", new_callable=AsyncMock) as inputs:
            await api._run_generation(task_id, request)
            archive.assert_not_awaited()
            inputs.assert_not_awaited()
        self.assertEqual(tasks.get_task(task_id).status, tasks.TaskStatus.COMPLETED)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["results", "tasks.sqlite3"])

    async def test_delivery_survives_restart_without_embedding_images_in_database(self):
        task_id = self.reserve()
        self.complete(task_id)
        with tasks.database() as connection:
            snapshot = connection.execute("SELECT snapshot FROM tasks WHERE id = ?", (task_id,)).fetchone()[0]
        self.assertNotIn("first-result", snapshot)
        self.assertEqual(json.loads(snapshot)["images"], [])
        tasks._tasks.clear()
        with patch.object(tasks, "_session", "new-worker"):
            response = await self.client.get(f"/api/v1/tasks/{task_id}")
        self.assertEqual([image["base64"] for image in response.json()["images"]], ["first-result", "second-result"])
        self.assertTrue(response.json()["client_storage"])
        self.assertIsNone(response.json()["result_released_at"])

    async def test_acknowledgement_releases_payload_and_remains_idempotent_after_restart(self):
        task_id = self.reserve()
        self.complete(task_id)
        first = await self.ack(task_id)
        self.assertEqual(first.status_code, 200)
        self.assertFalse(tasks._result_path(task_id).exists())
        self.assertEqual(tasks.get_task(task_id).images, [])
        tasks._tasks.clear()
        second = await self.ack(task_id)
        self.assertEqual(second.json(), first.json())
        response = (await self.client.get(f"/api/v1/tasks/{task_id}")).json()
        self.assertEqual(response["status"], "completed")
        self.assertTrue(response["result_released_at"])
        self.assertEqual(response["images"], [])
        self.assertEqual(tasks.reserve_task(**self.parameters, save_to_gallery=False, client_request_id="client", fingerprint="original"), (task_id, False))

    async def test_wrong_identity_cannot_release_another_clients_result(self):
        task_id = self.reserve()
        self.complete(task_id)
        response = await self.ack(task_id, "another-client")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(tasks.get_task(task_id).images), 2)
        self.assertTrue(tasks._result_path(task_id).exists())

    async def test_pending_and_legacy_gallery_results_cannot_be_released(self):
        task_id = self.reserve()
        self.assertEqual((await self.ack(task_id)).status_code, 409)
        tasks.update_task(task_id, save_to_gallery=True)
        self.complete(task_id)
        self.assertEqual((await self.ack(task_id)).status_code, 409)
        self.assertEqual(len(tasks.get_task(task_id).images), 2)

    async def test_failed_file_removal_is_retried_without_reexposing_payload(self):
        task_id = self.reserve()
        self.complete(task_id)
        with patch.object(Path, "unlink", side_effect=OSError("busy")):
            with self.assertRaises(OSError):
                tasks.acknowledge_result(task_id, "client")
        tasks._tasks.clear()
        self.assertEqual(tasks.get_task(task_id).images, [])
        self.assertEqual((await self.ack(task_id)).status_code, 200)
        self.assertFalse(tasks._result_path(task_id).exists())
