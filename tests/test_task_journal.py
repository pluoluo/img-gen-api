import os
import tempfile
import unittest
import subprocess
import sys
import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from image_api.services import tasks


class TaskJournalTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.environment = patch.dict(os.environ, {"TASK_DATA_DIR": self.folder.name})
        self.environment.start()
        self.previous = tasks._tasks.copy()
        tasks._tasks.clear()
        self.parameters = {"model": "auto", "sub_model": "gpt-image-2.5-flare", "prompt": "test", "size": "1024x1024", "quality": "low", "n": 1}

    def tearDown(self):
        tasks._tasks.clear()
        tasks._tasks.update(self.previous)
        self.environment.stop()
        self.folder.cleanup()

    def test_completed_result_and_submission_survive_process_restart(self):
        task_id, created = tasks.reserve_task(**self.parameters, client_request_id="request", fingerprint="original")
        self.assertTrue(created)
        tasks.update_task(task_id, status=tasks.TaskStatus.COMPLETED, images=[{"base64": "immutable-result"}], progress=100)
        tasks._tasks.clear()
        with patch.object(tasks, "_session", "new-process"):
            restored = tasks.get_task(task_id)
            self.assertEqual(restored.status, tasks.TaskStatus.COMPLETED)
            self.assertEqual(restored.images, [{"base64": "immutable-result"}])
            self.assertEqual(tasks.get_submission("request"), ("original", task_id))
            self.assertEqual(tasks.reserve_task(**self.parameters, client_request_id="request", fingerprint="original"), (task_id, False))

    def test_interrupted_task_is_explicitly_failed_and_not_resubmitted(self):
        task_id, _ = tasks.reserve_task(**self.parameters, client_request_id="interrupted", fingerprint="original")
        tasks.update_task(task_id, status=tasks.TaskStatus.RUNNING)
        tasks._tasks.clear()
        with patch.object(tasks, "_session", "new-process"):
            restored = tasks.get_task(task_id)
            self.assertEqual(restored.status, tasks.TaskStatus.FAILED)
            self.assertIn("未自动重新提交", restored.error)
            self.assertEqual(tasks.reserve_task(**self.parameters, client_request_id="interrupted", fingerprint="original"), (task_id, False))

    def test_result_is_readable_in_a_separate_python_process(self):
        task_id, _ = tasks.reserve_task(**self.parameters)
        tasks.update_task(task_id, status=tasks.TaskStatus.COMPLETED, images=[{"base64": "persisted-by-parent"}])
        program = "from image_api.services.tasks import get_task; import json,sys; t=get_task(sys.argv[1]); print(json.dumps({'status':t.status.value,'images':t.images}))"
        restored = json.loads(subprocess.check_output([sys.executable, "-c", program, task_id], text=True))
        self.assertEqual(restored, {"status": "completed", "images": [{"base64": "persisted-by-parent"}]})

    def test_same_identity_with_different_input_is_rejected(self):
        tasks.reserve_task(**self.parameters, client_request_id="request", fingerprint="original")
        with self.assertRaises(ValueError):
            tasks.reserve_task(**self.parameters, client_request_id="request", fingerprint="different")

    def test_concurrent_reservations_create_one_upstream_job(self):
        def reserve(_):
            return tasks.reserve_task(**self.parameters, client_request_id="racing", fingerprint="original")
        with ThreadPoolExecutor(max_workers=4) as pool:
            reserved = list(pool.map(reserve, range(4)))
        self.assertEqual(len({task_id for task_id, _ in reserved}), 1)
        self.assertEqual(sum(created for _, created in reserved), 1)
