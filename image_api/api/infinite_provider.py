"""Fixed-provider proxy for infinite's text, audio and native model clients."""
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from image_api.config import settings

router = APIRouter(prefix="/infinite/openai/v1", tags=["Infinite provider"])


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def provider_request(path: str, request: Request):
    if request.method == "POST" and settings.infinite_offline_validation is True:
        raise HTTPException(503, "测试服务已隔离供应商请求")
    allowed = (
        request.method == "GET" and (path == "models" or re.fullmatch(r"videos/[a-zA-Z0-9_-]+(?:/content)?", path))
        or request.method == "POST" and path in ("chat/completions", "responses", "audio/speech", "images/generations", "images/edits", "videos")
    )
    if not allowed:
        raise HTTPException(404, "未提供此供应商接口")
    if not settings.openai_api_key:
        raise HTTPException(503, "服务端尚未配置供应商凭据")
    client = httpx.AsyncClient(trust_env=False, timeout=None)
    headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    try:
        outgoing = client.build_request(request.method, settings.openai_base_url.rstrip("/") + "/" + path, params=request.query_params, content=request.stream(), headers=headers)
        response = await client.send(outgoing, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, "供应商连接失败，请稍后重试")
    except BaseException:
        await client.aclose()
        raise

    async def stream():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(stream(), status_code=response.status_code, media_type=response.headers.get("content-type", "application/json"), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
