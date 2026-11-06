"""Single-worker task journal. Results and submission identities survive restart."""
import uuid
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from enum import Enum
from dataclasses import asdict, dataclass, field
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
_session = str(uuid.uuid4())


@contextmanager
def database():
    folder = Path(os.environ.get("TASK_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "tasks"))
    folder.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(folder / "tasks.sqlite3") as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, snapshot TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL);
        """)
        yield connection


def get_submission(request_id):
    with database() as connection:
        return connection.execute("SELECT fingerprint, task_id FROM submissions WHERE id = ?", (request_id,)).fetchone()


def _save(connection, task):
    connection.execute("INSERT OR REPLACE INTO tasks VALUES (?, ?, ?)", (task.id, _session, json.dumps(asdict(task), ensure_ascii=False)))


def reserve_task(*, client_request_id=None, fingerprint=None, **parameters):
    """Reserve identity and task in one transaction, before any upstream request."""
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        if client_request_id:
            previous = connection.execute("SELECT fingerprint, task_id FROM submissions WHERE id = ?", (client_request_id,)).fetchone()
            if previous:
                if previous[0] != fingerprint:
                    raise ValueError("提交 ID 已用于其他输入，请创建新请求")
                return previous[1], False
        task = Task(id=str(uuid.uuid4()), **parameters)
        _save(connection, task)
        if client_request_id:
            connection.execute("INSERT INTO submissions VALUES (?, ?, ?)", (client_request_id, fingerprint, task.id))
    _tasks[task.id] = task
    return task.id, True


def create_task(
    model: str,
    sub_model: str,
    prompt: str,
    size: str,
    quality: Optional[str],
    n: int,
) -> str:
    """Create a new task and return its ID."""
    task_id, _ = reserve_task(
        model=model,
        sub_model=sub_model,
        prompt=prompt,
        size=size,
        quality=quality,
        n=n,
    )
    return task_id


def get_task(task_id: str) -> Optional[Task]:
    if task_id in _tasks:
        return _tasks[task_id]
    with database() as connection:
        row = connection.execute("SELECT owner, snapshot FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        values = json.loads(row[1])
        values["status"] = TaskStatus(values["status"])
        task = Task(**values)
        if row[0] != _session and task.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
            task.status = TaskStatus.FAILED
            task.error = "服务重启中断了任务，未自动重新提交。请先检查供应商和图库结果，再决定是否重新生成。"
            task.completed_at = datetime.now().isoformat()
            _save(connection, task)
    _tasks[task_id] = task
    return task


def update_task(task_id: str, **kwargs):
    task = get_task(task_id)
    if task:
        for k, v in kwargs.items():
            if hasattr(task, k):
                setattr(task, k, v)
        with database() as connection:
            _save(connection, task)
