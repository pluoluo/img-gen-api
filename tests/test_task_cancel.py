import asyncio
import unittest

from image_api.services import tasks as task_store


class TaskCancelTests(unittest.TestCase):
    """取消必须真的中断 worker（从而断开上游 HTTP 连接）。"""

    def setUp(self):
        task_store._tasks.clear()

    def _new(self, **kwargs):
        tid = task_store.create_task(
            model="auto", sub_model="gpt-image-2.5-flare", prompt="p",
            size="1024x1024", quality=None, n=1,
        )
        if kwargs:
            task_store.update_task(tid, **kwargs)
        return tid

    def test_cancel_running_task_aborts_handle(self):
        async def scenario():
            started = asyncio.Event()

            async def slow_worker():
                started.set()
                await asyncio.sleep(30)

            tid = self._new()
            handle = asyncio.create_task(slow_worker())
            task_store.attach_handle(tid, handle)
            await started.wait()

            self.assertTrue(task_store.cancel_task(tid))
            with self.assertRaises(asyncio.CancelledError):
                await handle
            self.assertTrue(handle.cancelled())

        asyncio.run(scenario())

    def test_cancel_marks_orphan_task_cancelled(self):
        tid = self._new()
        self.assertTrue(task_store.cancel_task(tid))
        task = task_store.get_task(tid)
        self.assertEqual(task.status, task_store.TaskStatus.CANCELLED)
        self.assertEqual(task.error, "已取消")

    def test_cancel_finished_task_is_noop(self):
        for status in (
            task_store.TaskStatus.COMPLETED,
            task_store.TaskStatus.FAILED,
            task_store.TaskStatus.CANCELLED,
        ):
            with self.subTest(status=status):
                tid = self._new(status=status)
                self.assertFalse(task_store.cancel_task(tid))
                self.assertEqual(task_store.get_task(tid).status, status)

    def test_attach_handle_keeps_strong_reference(self):
        async def scenario():
            tid = self._new()
            handle = asyncio.create_task(asyncio.sleep(0))
            task_store.attach_handle(tid, handle)
            self.assertIs(task_store.get_task(tid).handle, handle)
            await handle

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
