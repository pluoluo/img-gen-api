"""
Structured logging for image-api.
Writes to /tmp/image-api.log with timestamps, levels, and context.
Use log_info, log_warn, log_error instead of print().
"""

import os
import json
from datetime import datetime, timezone, timedelta
from typing import Optional

LOG_FILE = "/tmp/image-api.log"
# Keep max 10000 lines
MAX_LINES = 10000
# Asia/Shanghai
CST = timezone(timedelta(hours=8))


def _ts() -> str:
    return datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")


def _write(level: str, msg: str, ctx: Optional[dict] = None):
    line = {
        "ts": _ts(),
        "level": level,
        "msg": msg,
    }
    if ctx:
        line["ctx"] = ctx
    try:
        with open(LOG_FILE, "a") as f:
            f.write(json.dumps(line, ensure_ascii=False) + "\n")
        # Trim on first write of each hour
        _trim_if_needed()
    except Exception:
        pass  # logging should never crash the app


def _trim_if_needed():
    try:
        if os.path.getsize(LOG_FILE) > 512 * 1024:  # 512KB
            with open(LOG_FILE) as f:
                lines = f.readlines()
            if len(lines) > MAX_LINES:
                with open(LOG_FILE, "w") as f:
                    f.writelines(lines[-MAX_LINES:])
    except Exception:
        pass


def log_info(msg: str, ctx: Optional[dict] = None):
    _write("INFO", msg, ctx)


def log_warn(msg: str, ctx: Optional[dict] = None):
    _write("WARN", msg, ctx)


def log_error(msg: str, ctx: Optional[dict] = None):
    _write("ERROR", msg, ctx)


def read_logs(limit: int = 200, offset: int = 0, level: Optional[str] = None) -> list:
    """
    Read log entries. Returns list of parsed dicts, newest first.
    Supports pagination (offset/limit) and optional level filtering.
    """
    try:
        if not os.path.exists(LOG_FILE):
            return []
        with open(LOG_FILE) as f:
            raw = f.readlines()

        entries = []
        for line in reversed(raw):
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                entry = {"ts": "", "level": "RAW", "msg": line}
            if level and entry.get("level") != level:
                continue
            entries.append(entry)

        return entries[offset:offset + limit]
    except Exception as e:
        return [{"ts": _ts(), "level": "ERROR", "msg": f"Failed to read logs: {e}"}]


def clear_logs():
    """Clear the log file."""
    try:
        with open(LOG_FILE, "w") as f:
            pass
        return True
    except Exception:
        return False
