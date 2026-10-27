from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List
import asyncio

from image_api.services.openai_img import (
    generate_openai_image, APIResponseError, UserFacingError, user_facing_message,
)
from image_api.services.gpt_route import (
    resolve_gpt_route, note_openai_output, route_status, is_retryable_sub,
)
from image_api.services.gemini_img import generate_gemini_image
from image_api.services.minimax_img import generate_minimax_image
from image_api.services.gallery import save_image, get_images, get_image, delete_image, delete_batch
from image_api.services.tasks import (
    create_task, get_task, update_task, TaskStatus
)
from image_api.services.log_helper import log_info, log_warn, log_error, read_logs, clear_logs
from image_api.config import settings

router = APIRouter()


class GenerateRequest(BaseModel):
    model: str = "auto"
    sub_model: str = "gpt-image-2.5-flare"
    prompt: str
    image_url: Optional[str] = None
    image_base64: Optional[str] = None
    image_urls: Optional[List[str]] = None
    image_base64s: Optional[List[str]] = None
    size: str = "1024x1024"
    n: int = 1
    quality: Optional[str] = None


class ImageResult(BaseModel):
    url: Optional[str] = None
    base64: Optional[str] = None
    adjusted_size: Optional[str] = None


class GenerateResponse(BaseModel):
    task_id: str
    images: List[ImageResult] = []


class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    progress: int
    images: List[ImageResult]
    error: Optional[str] = None
    raw_response: Optional[str] = None


@router.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest):
    """Start an async generation task and return task_id immediately."""
    task_id = create_task(
        model=request.model,
        sub_model=request.sub_model,
        prompt=request.prompt,
        size=request.size,
        quality=request.quality,
        n=request.n,
    )

    log_info("生成任务已创建", ctx={
        "task_id": task_id,
        "model": request.model,
        "sub_model": request.sub_model,
        "size": request.size,
        "quality": request.quality,
        "n": request.n,
        "has_ref": bool(request.image_url or request.image_base64 or request.image_urls or request.image_base64s),
    })

    # Kick off background generation — fire and forget
    asyncio.create_task(_run_generation(task_id, request))

    return GenerateResponse(task_id=task_id, images=[])


async def _call_gpt_provider(request: GenerateRequest, provider: str, task_id: str):
    """Call openai-hk or Packy via the shared OpenAI-compatible client."""
    if provider == "packy":
        log_info("调用 PackyAPI", ctx={"task_id": task_id, "sub_model": request.sub_model})
        return await generate_openai_image(
            prompt=request.prompt,
            model=request.sub_model,
            image_url=request.image_url,
            image_base64=request.image_base64,
            image_urls=request.image_urls,
            image_base64s=request.image_base64s,
            size=request.size,
            n=request.n,
            quality=request.quality,
            base_url=settings.packy_base_url,
            api_key=settings.packy_api_key,
        )
    log_info("调用 open-hk GPT Image", ctx={"task_id": task_id, "sub_model": request.sub_model})
    return await generate_openai_image(
        prompt=request.prompt,
        model=request.sub_model,
        image_url=request.image_url,
        image_base64=request.image_base64,
        image_urls=request.image_urls,
        image_base64s=request.image_base64s,
        size=request.size,
        n=request.n,
        quality=request.quality,
    )


async def _run_generation(task_id: str, request: GenerateRequest):
    """Background worker that runs the actual image generation."""
    import traceback
    from datetime import datetime

    try:
        log_info("生成任务开始执行", ctx={"task_id": task_id, "model": request.model})

        update_task(task_id, status=TaskStatus.RUNNING, started_at=datetime.now().isoformat())

        # Simulate early progress
        update_task(task_id, progress=10)

        original_model = request.model
        first_b64 = None
        if request.image_base64s:
            first_b64 = request.image_base64s[0]
        elif request.image_base64:
            first_b64 = request.image_base64
        has_reference = bool(
            first_b64 or request.image_url or request.image_urls
        )

        # GPT 自动路由：size_split 下 1K→openai-hk / 以上→packy。
        # 无参考图 + size=auto 固定 openai-hk。显式 openai/packy 仍可强制指定。
        if request.model == "auto":
            provider, sub = resolve_gpt_route(
                request.size, request.sub_model, first_b64,
                has_reference=has_reference,
            )
            request.model = provider
            request.sub_model = sub
            update_task(task_id, model=provider, sub_model=sub)
            log_info("自动路由完成", ctx={"task_id": task_id, "model": provider, "sub_model": sub, "size": request.size})
        elif request.sub_model == "gpt-image-2":
            # gpt-image-2 已下线
            request.sub_model = "gpt-image-2.5-flare"
            update_task(task_id, sub_model=request.sub_model)

        if request.model in ("openai", "packy"):
            allow_packy_retry = (
                original_model == "auto"
                and request.model == "openai"
                and is_retryable_sub(request.sub_model)
            )
            try:
                result = await _call_gpt_provider(request, request.model, task_id)
            except Exception as e:
                if not allow_packy_retry or isinstance(e, UserFacingError):
                    raise
                log_warn(f"openai-hk 失败，改走 packy 重试: {e}", ctx={
                    "task_id": task_id,
                    "sub_model": request.sub_model,
                    "size": request.size,
                })
                request.model = "packy"
                update_task(task_id, model="packy", sub_model=request.sub_model)
                result = await _call_gpt_provider(request, "packy", task_id)
            else:
                if request.model == "openai":
                    note_openai_output(
                        request.size, result,
                        image_base64=first_b64,
                        sub_model=request.sub_model,
                    )
        elif request.model == "gemini":
            sub = request.sub_model
            if sub == "gemini-3.1-flash-lite-preview":
                log_info("调用 Gemini Lite", ctx={"task_id": task_id})
                # Extract first image from lists (Gemini native endpoint takes single ref)
                gemini_url = request.image_url or (request.image_urls[0] if request.image_urls else None)
                gemini_b64 = request.image_base64 or (request.image_base64s[0] if request.image_base64s else None)
                result = await generate_gemini_image(
                    prompt=request.prompt,
                    image_url=gemini_url,
                    image_base64=gemini_b64,
                )
            else:
                log_info("调用 Gemini（OpenAI 兼容）", ctx={"task_id": task_id, "sub_model": sub})
                result = await generate_openai_image(
                    prompt=request.prompt,
                    model=sub,
                    image_url=request.image_url,
                    image_base64=request.image_base64,
                    image_urls=request.image_urls,
                    image_base64s=request.image_base64s,
                    size=request.size,
                    n=request.n,
                    quality=request.quality,
                )
        elif request.model == "minimax":
            log_info("调用 MiniMax", ctx={"task_id": task_id})
            # Extract first image from lists (MiniMax takes single ref)
            mm_url = request.image_url or (request.image_urls[0] if request.image_urls else None)
            mm_b64 = request.image_base64 or (request.image_base64s[0] if request.image_base64s else None)
            result = await generate_minimax_image(
                prompt=request.prompt,
                image_url=mm_url,
                image_base64=mm_b64,
                size=request.size,
                n=request.n,
            )
        else:
            raise ValueError(f"Unknown model: {request.model}")

        img_count = len(result) if result else 0
        has_url = False
        has_base64 = False
        if result and len(result) > 0:
            has_url = bool(result[0].get("url"))
            has_base64 = bool(result[0].get("base64"))
            if has_url and not has_base64:
                log_warn("API 返回了 URL 但未下载为 base64", ctx={
                    "task_id": task_id,
                    "url": result[0].get("url"),
                })

        log_info(f"生成完成：{img_count} 张图片", ctx={
            "task_id": task_id,
            "count": img_count,
            "has_url": has_url,
            "has_base64": has_base64,
        })

        update_task(task_id, progress=90)

        # Save to gallery
        if result:
            await save_image(
                model=request.model,
                sub_model=request.sub_model,
                prompt=request.prompt,
                size=request.size,
                quality=request.quality,
                n=request.n,
                image_results=result,
            )
            log_info("已保存到图库", ctx={"task_id": task_id})

        update_task(
            task_id,
            status=TaskStatus.COMPLETED,
            progress=100,
            images=result,
            completed_at=datetime.now().isoformat(),
        )

    except Exception as e:
        import traceback
        raw = None
        if isinstance(e, APIResponseError):
            raw = e.raw_body
        full_tb = traceback.format_exc()
        tb_summary = full_tb.strip().split("\n")[-1]
        log_error(f"生成失败：{tb_summary}", ctx={
            "task_id": task_id,
            "model": request.model,
            "sub_model": request.sub_model,
        })
        update_task(
            task_id,
            status=TaskStatus.FAILED,
            error=user_facing_message(e),
            raw_response=raw,
            completed_at=datetime.now().isoformat(),
        )


@router.get("/gpt-route")
async def gpt_route_status():
    """Current GPT auto-routing mode (openai_first vs size_split) and hint copy."""
    return route_status()


@router.get("/tasks/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str):
    """Poll task status and return results when ready."""
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")

    return TaskStatusResponse(
        task_id=task.id,
        status=task.status.value,
        progress=task.progress,
        images=[ImageResult(**img) for img in task.images],
        error=task.error,
        raw_response=task.raw_response,
    )


# ─── Gallery endpoints ────────────────────────────────────────────────

class GalleryItem(BaseModel):
    id: str
    created_at: str
    model: str
    sub_model: str
    prompt: str
    size: Optional[str]
    quality: Optional[str]
    n: int
    image_url: Optional[str]
    filename: str
    thumb_filename: Optional[str] = None


class GalleryListResponse(BaseModel):
    items: List[GalleryItem]
    total: int


@router.get("/gallery", response_model=GalleryListResponse)
async def list_gallery(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
):
    items = get_images(limit=limit, offset=offset)
    return GalleryListResponse(items=items, total=len(items))


@router.get("/gallery/{record_id}")
async def get_gallery_image(record_id: str):
    rec = get_image(record_id)
    if not rec:
        raise HTTPException(status_code=404, detail="图片不存在")
    return rec


@router.delete("/gallery/{record_id}")
async def delete_gallery_image(record_id: str):
    deleted = delete_image(record_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="图片不存在")
    return {"ok": True}


class BatchDeleteRequest(BaseModel):
    ids: List[str]


@router.post("/gallery/batch-delete")
async def batch_delete_gallery_images(request: BatchDeleteRequest):
    """Delete multiple gallery images at once."""
    deleted = delete_batch(request.ids)
    return {"ok": True, "deleted": deleted}


# ─── Prompt optimization proxy ──────────────────────────────────────────

class OptimizePromptRequest(BaseModel):
    prompt: str


@router.post("/optimize-prompt")
async def optimize_prompt(request: OptimizePromptRequest):
    """Proxy to prompt-portal for AI prompt optimization."""
    import httpx

    try:
        async with httpx.AsyncClient(trust_env=False, timeout=60.0) as client:
            resp = await client.post(
                f"{settings.prompt_portal_url}/api/match",
                json={"user_input": request.prompt},
            )
            resp.raise_for_status()
            data = resp.json()
            return {"optimized_prompt": data.get("optimized_prompt", request.prompt)}
    except Exception as e:
        log_warn(f"Prompt优化代理失败: {e}")
        raise HTTPException(status_code=502, detail="提示词优化暂时不可用，请稍后重试。")


# ─── Logs endpoints ────────────────────────────────────────────────────


@router.get("/logs")
async def api_logs(
    limit: int = Query(default=200, le=1000),
    offset: int = Query(default=0, ge=0),
    level: Optional[str] = Query(default=None),
):
    """Read application logs. Newest first. Optional level filter (INFO/WARN/ERROR)."""
    entries = read_logs(limit=limit, offset=offset, level=level)
    # Strip JSON formatting for plain text
    return {"total": len(entries), "entries": entries}


@router.post("/logs/clear")
async def api_clear_logs():
    """Clear all logs."""
    ok = clear_logs()
    return {"ok": ok}
