"""GPT 2.5 flare/sunburst routing + openai-hk undersize monitor.

Default mode (size_split):
  long edge ≤ 1920 → openai-hk; larger → packy.
  size=auto with no reference image → openai-hk (text-to-image
  falls back to ~1024; smaller returned size is accepted).
  openai-hk 4K is a false 1.57MP cap (confirmed 2026-09-23).

Optional mode (openai_first): openai-hk first, Packy on API failure.
Reverts to size_split after 5 consecutive undersize >1K results
(returned pixels ≤ ~1.7MP, not just long edge — ultrawide 1.57MP
can still have long edge > 1920).
"""
from __future__ import annotations

import base64
import io
import json
import os
import threading
from datetime import datetime, timezone, timedelta
from typing import Optional

from PIL import Image

from image_api.services.log_helper import log_info, log_warn

CST = timezone(timedelta(hours=8))

_1K_MAX_LONG_EDGE = 1920
# openai-hk 实测上限约 1.57MP；超宽图长边仍可能 >1920，所以不能只看长边。
_UNDERSUZE_MAX_PIXELS = 1_700_000
UNDERSUZE_STREAK_LIMIT = 5
MODE_OPENAI_FIRST = "openai_first"
MODE_SIZE_SPLIT = "size_split"

RETRYABLE_SUBS = ("gpt-image-2.5-flare", "gpt-image-2.5-sunburst")
_PACKY_DEFAULT_MODEL = "gpt-image-2.5-flare"
_OPENAI_DEFAULT_MODEL = "gpt-image-2.5-flare"

HINT_OPENAI_FIRST = (
    "<b>Flare 主打速度</b>　·　大小同价　·　约 0.08 元/张　　"
    "<b>Sunburst 主打高精度</b>　·　大小同价　·　约 0.08 元/张"
)
HINT_SIZE_SPLIT = (
    "<b>Flare 主打速度</b>　·　1K 及以下 0.08 元/张　·　1K 以上 Packy 按量计费　　"
    "<b>Sunburst 主打高精度</b>　·　1K 及以下 0.08 元/张　·　1K 以上 Packy 按量计费"
)

_lock = threading.Lock()
_DEFAULT_STATE = {
    "mode": MODE_SIZE_SPLIT,
    "undersize_streak": 0,
    "reverted_at": None,
}


def _state_path() -> str:
    override = os.environ.get("GPT_ROUTE_STATE_PATH")
    if override:
        return override
    return os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", "data", "gpt_route_state.json",
    ))


def _empty_state() -> dict:
    return dict(_DEFAULT_STATE)


def load_state() -> dict:
    path = _state_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return _empty_state()
        mode = data.get("mode") or MODE_SIZE_SPLIT
        if mode not in (MODE_OPENAI_FIRST, MODE_SIZE_SPLIT):
            mode = MODE_SIZE_SPLIT
        try:
            streak = int(data.get("undersize_streak") or 0)
        except (TypeError, ValueError):
            streak = 0
        return {
            "mode": mode,
            "undersize_streak": max(0, streak),
            "reverted_at": data.get("reverted_at"),
        }
    except FileNotFoundError:
        return _empty_state()
    except Exception as e:
        log_warn(f"gpt_route 状态文件损坏，使用默认: {e}")
        return _empty_state()


def save_state(state: dict) -> None:
    path = _state_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def current_mode() -> str:
    return load_state()["mode"]


def is_retryable_sub(sub_model: str) -> bool:
    return normalize_sub(sub_model) in RETRYABLE_SUBS


def normalize_sub(sub_model: str, *, for_packy: bool = False) -> str:
    sub = (sub_model or _OPENAI_DEFAULT_MODEL).strip() or _OPENAI_DEFAULT_MODEL
    if sub in ("auto", "gpt-image-2"):
        sub = _OPENAI_DEFAULT_MODEL
    if for_packy and sub == "gpt-image-2.5":
        log_info("packy 无 gpt-image-2.5，改用 gpt-image-2.5-flare")
        sub = _PACKY_DEFAULT_MODEL
    return sub


def _size_is_auto(size: str) -> bool:
    return (size or "").strip().lower() == "auto"


def _has_reference(image_base64: Optional[str],
                   has_reference: Optional[bool]) -> bool:
    if has_reference is not None:
        return bool(has_reference)
    return bool(image_base64)


def estimate_output_wh(size: str, image_base64: Optional[str] = None) -> tuple:
    """Estimate output WxH for provider routing (does not apply API constraints)."""
    raw = (size or "").strip().lower().replace("*", "x")
    if raw and raw != "auto":
        try:
            parts = raw.split("x")
            w, h = int(parts[0]), int(parts[1])
            if w > 0 and h > 0:
                return w, h
        except (ValueError, IndexError):
            pass
    if image_base64:
        wh = image_wh_from_b64(image_base64)
        if wh:
            return wh
        log_warn("estimate_output_wh: 无法读取参考图")
    return 1024, 1024


def image_wh_from_b64(image_base64: Optional[str]) -> Optional[tuple]:
    if not image_base64:
        return None
    try:
        img = Image.open(io.BytesIO(base64.b64decode(image_base64)))
        return img.size
    except Exception:
        return None


def resolve_gpt_route(size: str, sub_model: str,
                      image_base64: Optional[str] = None,
                      has_reference: Optional[bool] = None) -> tuple:
    """Pick provider. Returns (provider, actual_sub_model)."""
    mode = current_mode()
    no_ref = not _has_reference(image_base64, has_reference)
    # 文生图选「自动」：固定 openai-hk。不要走参考图尺寸估算，也不要
    # 依赖 1024 回落——默认尺寸以后若变大，这条仍应进 openai-hk。
    if mode == MODE_SIZE_SPLIT and _size_is_auto(size) and no_ref:
        provider = "openai"
        sub = normalize_sub(sub_model, for_packy=False)
        log_info(f"GPT 自动路由: size=auto 无参考图 mode={mode} → {provider}/{sub}")
        return provider, sub

    w, h = estimate_output_wh(size, image_base64)
    use_openai = True
    if mode == MODE_SIZE_SPLIT:
        use_openai = max(w, h) <= _1K_MAX_LONG_EDGE
    provider = "openai" if use_openai else "packy"
    sub = normalize_sub(sub_model, for_packy=not use_openai)
    log_info(f"GPT 自动路由: {w}x{h} mode={mode} → {provider}/{sub}")
    return provider, sub


def note_openai_output(size: str, result: list,
                       image_base64: Optional[str] = None,
                       sub_model: str = "") -> dict:
    """If request is >1K and openai-hk returned ≤1K, count a consecutive miss.

    5 consecutive misses flip auto routing back to size_split.
    Adequate >1K output resets the streak. ≤1K requests are ignored.
    """
    if sub_model and not is_retryable_sub(sub_model):
        return load_state()

    req_w, req_h = estimate_output_wh(size, image_base64)
    if max(req_w, req_h) <= _1K_MAX_LONG_EDGE:
        return load_state()

    got = None
    for item in result or []:
        got = image_wh_from_b64(item.get("base64") if isinstance(item, dict) else None)
        if got:
            break
    if not got:
        log_warn("openai-hk 大图监测：有请求但无法读取返回图尺寸，跳过计数", ctx={
            "requested": f"{req_w}x{req_h}",
        })
        return load_state()

    got_w, got_h = got
    got_px = got_w * got_h
    undersize = (
        max(got_w, got_h) <= _1K_MAX_LONG_EDGE
        or got_px <= _UNDERSUZE_MAX_PIXELS
    )

    with _lock:
        state = load_state()
        if state["mode"] != MODE_OPENAI_FIRST:
            return state
        if undersize:
            state["undersize_streak"] = int(state.get("undersize_streak") or 0) + 1
            log_warn(
                f"openai-hk 大图输出不足1K: 请求 {req_w}x{req_h} 实得 {got_w}x{got_h}，"
                f"连续 {state['undersize_streak']}/{UNDERSUZE_STREAK_LIMIT}",
                ctx={
                    "requested": f"{req_w}x{req_h}",
                    "got": f"{got_w}x{got_h}",
                    "streak": state["undersize_streak"],
                },
            )
            if state["undersize_streak"] >= UNDERSUZE_STREAK_LIMIT:
                state["mode"] = MODE_SIZE_SPLIT
                state["reverted_at"] = datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")
                log_warn(
                    "openai-hk 大图连续 5 次不足 1K，自动路由切回 "
                    "1K→openai-hk / 以上→packy",
                    ctx={"reverted_at": state["reverted_at"]},
                )
        else:
            if state.get("undersize_streak"):
                log_info(
                    f"openai-hk 大图输出达标: {got_w}x{got_h}，连续不足计数清零",
                    ctx={"requested": f"{req_w}x{req_h}", "got": f"{got_w}x{got_h}"},
                )
            state["undersize_streak"] = 0
        save_state(state)
        return state


def route_status() -> dict:
    state = load_state()
    mode = state["mode"]
    return {
        "mode": mode,
        "undersize_streak": state.get("undersize_streak") or 0,
        "streak_limit": UNDERSUZE_STREAK_LIMIT,
        "reverted_at": state.get("reverted_at"),
        "hint": HINT_SIZE_SPLIT if mode == MODE_SIZE_SPLIT else HINT_OPENAI_FIRST,
        "rule": (
            "1K（长边≤1920）→ openai-hk；以上 → packy"
            if mode == MODE_SIZE_SPLIT
            else "flare/sunburst 优先 openai-hk，失败再 packy"
        ),
    }
