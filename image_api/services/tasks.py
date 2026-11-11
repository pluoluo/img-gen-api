"""Single-worker task journal. Results and submission identities survive restart."""
import asyncio
import uuid
import json
import os
import sqlite3
import tempfile
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
    save_to_gallery: bool = True
    result_released_at: Optional[str] = None
    handle: Optional[asyncio.Task] = field(default=None, repr=False, compare=False)


_tasks: dict[str, Task] = {}
_session = str(uuid.uuid4())


def _task_folder():
    return Path(os.environ.get("TASK_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "tasks"))


def _result_path(task_id):
    return _task_folder() / "results" / f"{uuid.UUID(task_id)}.json"


@contextmanager
def database():
    folder = _task_folder()
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
    handle = task.handle
    task.handle = None
    try:
        snapshot = asdict(task)
    finally:
        task.handle = handle
    snapshot.pop("handle", None)
    if not task.save_to_gallery:
        # Large delivery payloads live outside SQLite so acknowledgement releases
        # disk space immediately instead of leaving a large database high-water mark.
        snapshot["images"] = []
        if task.images and not task.result_released_at:
            path = _result_path(task.id)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as stream:
                    temporary = Path(stream.name)
                    json.dump(task.images, stream)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
    connection.execute("INSERT OR REPLACE INTO tasks VALUES (?, ?, ?)", (task.id, _session, json.dumps(snapshot, ensure_ascii=False)))


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
        values.pop("handle", None)
        task = Task(**values)
        if not task.save_to_gallery and task.status == TaskStatus.COMPLETED and not task.result_released_at:
            path = _result_path(task.id)
            if path.is_file():
                task.images = json.loads(path.read_text(encoding="utf-8"))
        if row[0] != _session and task.status in (TaskStatus.PENDING, TaskStatus.RUNNING):
            task.status = TaskStatus.FAILED
            task.error = "服务重启中断了任务，未自动重新提交。请先检查供应商和图库结果，再决定是否重新生成。"
            task.completed_at = datetime.now().isoformat()
            _save(connection, task)
    _tasks[task_id] = task
    return task


def acknowledge_result(task_id: str, client_request_id: str):
    """Release only an Infinite result durably saved by its original requester."""
    with database() as connection:
        connection.execute("BEGIN IMMEDIATE")
        submission = connection.execute("SELECT task_id FROM submissions WHERE id = ?", (client_request_id,)).fetchone()
        if not submission or submission[0] != task_id:
            raise ValueError("领取凭据与任务不匹配")
        row = connection.execute("SELECT snapshot FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            raise LookupError("任务不存在")
        values = json.loads(row[0])
        if values.get("save_to_gallery", True):
            raise ValueError("图库归档任务不支持释放结果")
        if values["status"] != TaskStatus.COMPLETED:
            raise ValueError("任务尚未生成完成")
        values["result_released_at"] = values.get("result_released_at") or datetime.now().isoformat()
        values["images"] = []
        values["raw_response"] = None
        connection.execute("UPDATE tasks SET snapshot = ? WHERE id = ?", (json.dumps(values, ensure_ascii=False), task_id))
    cached = _tasks.get(task_id)
    if cached:
        cached.images = []
        cached.raw_response = None
        cached.result_released_at = values["result_released_at"]
    # Commit the tombstone first: a restart must never make an acknowledged
    # result available again. Repeated acknowledgements also retry file deletion.
    _result_path(task_id).unlink(missing_ok=True)
    return values["result_released_at"]


def update_task(task_id: str, **kwargs):
    task = get_task(task_id)
    if task:
        for k, v in kwargs.items():
            if hasattr(task, k):
                setattr(task, k, v)
        with database() as connection:
            _save(connection, task)


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
    task = get_task(task_id)
    if not task:
        return False
    if task.status in (TaskStatus.COMPLETED, TaskStatus.FAILED, TaskStatus.CANCELLED):
        return False
    handle = task.handle
    if handle and not handle.done():
        handle.cancel()
        return True
    # No live handle — persist cancelled so pollers stop waiting.
    task.status = TaskStatus.CANCELLED
    task.error = "已取消"
    task.completed_at = datetime.now().isoformat()
    with database() as connection:
        _save(connection, task)
    return True
