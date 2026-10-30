"""In-memory task storage for async generation tracking."""
import asyncio
import uuid
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, List
from datetime import datetime


class TaskStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Task:
    id: str
    status: TaskStatus = TaskStatus.PENDING
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    started_at: Optional[str] = None
    completed_at: Optional[str] = None
    model: str = ""
    sub_model: str = ""
    prompt: str = ""
    size: str = ""
    quality: Optional[str] = None
    n: int = 1
    progress: int = 0  # 0-100
    images: List[dict] = field(default_factory=list)  # final results
    error: Optional[str] = None
    raw_response: Optional[str] = None  # raw API response on failure
    handle: Optional[asyncio.Task] = field(default=None, repr=False, compare=False)


_tasks: dict[str, Task] = {}
_lock = asyncio.Lock()


def create_task(
    model: str,
    sub_model: str,
    prompt: str,
    size: str,
    quality: Optional[str],
    n: int,
) -> str:
    """Create a new task and return its ID."""
    task_id = str(uuid.uuid4())[:8]
    _tasks[task_id] = Task(
        id=task_id,
        model=model,
        sub_model=sub_model,
        prompt=prompt,
        size=size,
        quality=quality,
        n=n,
    )
    return task_id


def get_task(task_id: str) -> Optional[Task]:
    return _tasks.get(task_id)


def update_task(task_id: str, **kwargs):
    if task_id in _tasks:
        for k, v in kwargs.items():
            if hasattr(_tasks[task_id], k):
                setattr(_tasks[task_id], k, v)


def attach_handle(task_id: str, handle: asyncio.Task):
    """Keep a strong reference to the worker task.

    Two reasons: (1) fire-and-forget asyncio tasks can be garbage collected
    mid-flight, (2) 取消需要持有句柄才能真的中断上游 HTTP 请求。
    """
    task = _tasks.get(task_id)
    if task:
        task.handle = handle


def cancel_task(task_id: str) -> bool:
    """Request cancellation of a running task. Returns False if already finished."""
    task = _tasks.get(task_id)
    if not task:
        return False
    if task.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
        return False
    handle = task.handle
    if handle and not handle.done():
        handle.cancel()
        return True
    # No live handle — just mark it cancelled so pollers stop waiting.
    task.status = TaskStatus.CANCELLED
    task.error = "已取消"
    return True
