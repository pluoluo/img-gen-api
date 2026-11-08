from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Literal
import asyncio
import hashlib
import base64
from datetime import date

from image_api.services.openai_img import generate_openai_image
from image_api.services.gpt_route import (
    resolve_gpt_route, note_openai_output, route_status, is_retryable_sub,
)
from image_api.services.gemini_img import generate_gemini_image
from image_api.services.minimax_img import generate_minimax_image
from image_api.services.gallery import save_image, get_images, get_image, delete_image, delete_batch, count_images, save_generation_inputs, reference_path
from image_api.services.tasks import (
    reserve_task, get_task, update_task, get_submission, TaskStatus
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
    background: Optional[Literal["transparent"]] = None
    mask_base64: Optional[str] = None
    mask_reference_index: int = 0
    preserve_outside_mask: bool = False
    preserve_source_base64: Optional[str] = None
    client_request_id: Optional[str] = Field(default=None, min_length=1, max_length=128)

    @model_validator(mode="after")
    def validate_edit(self):
        if self.background and (self.model not in ("auto", "openai", "packy") or not self.sub_model.startswith("gpt-image")):
            raise ValueError("当前服务仅支持 GPT Image 透明背景生成")
        if self.mask_base64:
            if self.model not in ("auto", "openai", "packy") or not self.sub_model.startswith("gpt-image-2"):
                raise ValueError("所选模型不支持 PNG mask 局部编辑，请使用 GPT Image")
            if self.mask_reference_index != 0:
                raise ValueError("mask 仅关联第一张主参考图，请先调整参考图顺序")
            if not (self.image_base64s or self.image_base64 or self.image_urls or self.image_url):
                raise ValueError("mask 必须关联主参考图")
        elif self.preserve_outside_mask or self.preserve_source_base64:
            raise ValueError("区域外保留需要 PNG mask")
        return self


class ImageResult(BaseModel):
    url: Optional[str] = None
    base64: Optional[str] = None
    adjusted_size: Optional[str] = None
    upstream_size: Optional[str] = None


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


_submissions: dict[str, tuple[str, str]] = {}


@router.get("/submissions/{client_request_id}")
def find_submission(client_request_id: str):
    submission = _submissions.get(client_request_id) or get_submission(client_request_id)
    if not submission:
        raise HTTPException(status_code=404, detail="提交记录不存在，服务可能已重启")
    return {"task_id": submission[1]}


@router.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest):
    """Start an async generation task and return task_id immediately."""
    if settings.infinite_offline_validation is True:
        raise HTTPException(503, "测试服务已隔离真实生成请求，请使用模拟结果进行验收")
    fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
    previous = (_submissions.get(request.client_request_id) or get_submission(request.client_request_id)) if request.client_request_id else None
    if previous:
        previous_fingerprint, previous_task = previous
        if previous_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="提交 ID 已用于其他输入，请创建新请求")
        return GenerateResponse(task_id=previous_task, images=[])
    if request.mask_base64:
        from image_api.services.masking import validate_mask
        try:
            first = (request.image_base64s or [request.image_base64])[0]
            if not first:
                from image_api.services.openai_img import _download_image
                urls = request.image_urls or [request.image_url]
                first = base64.b64encode(await _download_image(urls[0])).decode()
                request.image_base64s = [first]
                request.image_urls = urls[1:]
                request.image_url = None
            validate_mask(request.mask_base64, first, request.preserve_source_base64)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
    # Check again after URL resolution (an awaited download may race a duplicate).
    if request.client_request_id and request.client_request_id in _submissions:
        previous_fingerprint, previous_task = _submissions[request.client_request_id]
        if previous_fingerprint != fingerprint:
            raise HTTPException(status_code=409, detail="提交 ID 已用于其他输入")
        return GenerateResponse(task_id=previous_task, images=[])
    try:
        task_id, created = reserve_task(
            client_request_id=request.client_request_id,
            fingerprint=fingerprint,
            model=request.model,
            sub_model=request.sub_model,
            prompt=request.prompt,
            size=request.size,
            quality=request.quality,
            n=request.n,
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    if not created:
        return GenerateResponse(task_id=task_id, images=[])

    log_info("生成任务已创建", ctx={
        "task_id": task_id,
        "model": request.model,
        "sub_model": request.sub_model,
        "size": request.size,
        "quality": request.quality,
        "n": request.n,
        "has_ref": bool(request.image_url or request.image_base64 or request.image_urls or request.image_base64s),
    })

    if request.client_request_id:
        _submissions[request.client_request_id] = (fingerprint, task_id)
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
            mask_base64=request.mask_base64,
            background=request.background,
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
        mask_base64=request.mask_base64,
        background=request.background,
    )


async def _run_generation(task_id: str, request: GenerateRequest):
    """Background worker that runs the actual image generation."""
    import traceback
    from datetime import datetime

    try:
        log_info("生成任务开始执行", ctx={"task_id": task_id, "model": request.model})

        update_task(task_id, status=TaskStatus.RUNNING, started_at=datetime.now().isoformat())

        await save_generation_inputs(task_id, request)

        # Simulate early progress
        update_task(task_id, progress=10)

        original_model = request.model
        first_b64 = None
        if request.image_base64s:
            first_b64 = request.image_base64s[0]
        elif request.image_base64:
            first_b64 = request.image_base64

        # GPT 自动路由：默认按请求总像素分流；可选 openai_first 保留输出不足监测。
        # 显式 openai/packy 仍可强制指定。
        if request.model == "auto":
            provider, sub = resolve_gpt_route(request.size, request.sub_model, first_b64)
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
                if not allow_packy_retry:
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

        if request.preserve_outside_mask:
            from image_api.services.masking import composite_outside
            for item in result:
                if not item.get("base64"):
                    raise ValueError("精确保留需要可下载的生成结果，请重试结果查询")
                data, final_size, upstream_size = composite_outside(
                    request.preserve_source_base64 or first_b64,
                    request.mask_base64,
                    item["base64"],
                )
                item.update(base64=data, url=None, adjusted_size=final_size, upstream_size=upstream_size)

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
                task_id=task_id,
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
        from image_api.services.openai_img import APIResponseError
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
            error=f"{tb_summary}\n{full_tb}",
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
        raise HTTPException(status_code=404, detail="Task not found")

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
    inputs: Optional[dict] = None


class GalleryListResponse(BaseModel):
    items: List[GalleryItem]
    total: int


@router.get("/gallery", response_model=GalleryListResponse)
async def list_gallery(
    limit: int = Query(default=50, le=200),
    offset: int = Query(default=0, ge=0),
    keyword: str = "",
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
):
    if start_date and end_date and start_date > end_date:
        raise HTTPException(422, "开始日期不能晚于结束日期")
    items = get_images(limit=limit, offset=offset, keyword=keyword.strip(), start_date=start_date, end_date=end_date)
    return GalleryListResponse(items=items, total=count_images(keyword.strip(), start_date=start_date, end_date=end_date))


@router.get("/gallery/references/{filename}")
def get_gallery_reference(filename: str):
    from starlette.responses import FileResponse
    try:
        path = reference_path(filename)
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    from PIL import Image
    with Image.open(path) as image:
        media_type = Image.MIME.get(image.format, "application/octet-stream")
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "private, max-age=604800, immutable", "X-Content-Type-Options": "nosniff"})


@router.get("/gallery/{record_id}")
async def get_gallery_image(record_id: str):
    rec = get_image(record_id)
    if not rec:
        raise HTTPException(status_code=404, detail="Image not found")
    return rec


@router.delete("/gallery/{record_id}")
async def delete_gallery_image(record_id: str):
    deleted = delete_image(record_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Image not found")
    return {"ok": True}


class BatchDeleteRequest(BaseModel):
    ids: List[str]


@router.post("/gallery/batch-delete")
async def batch_delete_gallery_images(request: BatchDeleteRequest):
    """Delete multiple gallery images at once."""
    deleted = delete_batch(request.ids)
    return {"ok": True, "deleted": deleted}


class GalleryCleanupPreviewRequest(BaseModel):
    months: Optional[Literal[1, 3, 6]] = None
    before: Optional[date] = None


class GalleryCleanupRequest(BaseModel):
    before: date
    fingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")


@router.post("/gallery/cleanup/preview")
async def preview_old_gallery_images(request: GalleryCleanupPreviewRequest):
    from image_api.services.gallery import cleanup_before_date, preview_gallery_cleanup
    try:
        before = cleanup_before_date(months=request.months, before=request.before)
        return preview_gallery_cleanup(before)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/gallery/cleanup")
async def delete_old_gallery_images(request: GalleryCleanupRequest):
    from image_api.services.gallery import GalleryCleanupChanged, delete_gallery_before
    try:
        return delete_gallery_before(request.before, request.fingerprint)
    except GalleryCleanupChanged as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


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
        raise HTTPException(status_code=502, detail=f"Prompt optimization unavailable: {e}")


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
