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
