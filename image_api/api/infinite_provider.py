"""Fixed-provider proxy for infinite's text, audio and native model clients."""
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from image_api.config import settings
from image_api.services.log_helper import log_info, log_warn

router = APIRouter(prefix="/infinite", tags=["Infinite provider"])


def openai_compat_url(base_url: str, path: str) -> str:
    """Join an OpenAI-compatible base with /v1/<path> exactly once."""
    base = (base_url or "").strip().rstrip("/")
    if not base.lower().endswith("/v1"):
        base += "/v1"
    return base + "/" + path.lstrip("/")


@router.api_route("/openai/v1/{path:path}", methods=["GET", "POST"])
async def provider_request(path: str, request: Request):
    if request.method == "POST" and settings.infinite_offline_validation is True:
        raise HTTPException(503, "测试服务已隔离供应商请求")
    allowed = (
        request.method == "GET" and (path == "models" or re.fullmatch(r"videos/[a-zA-Z0-9_-]+(?:/content)?", path))
        or request.method == "POST" and path in ("chat/completions", "responses", "audio/speech", "images/generations", "images/edits", "videos")
    )
    if not allowed:
        raise HTTPException(404, "未提供此供应商接口")
    api_key = (settings.text_api_key if isinstance(settings.text_api_key, str) and settings.text_api_key.strip() else None) or settings.openai_api_key
    base_url = (settings.text_base_url if isinstance(settings.text_base_url, str) and settings.text_base_url.strip() else None) or settings.openai_base_url
    if not api_key:
        raise HTTPException(503, "服务端尚未配置供应商凭据")
    headers = {"Authorization": f"Bearer {api_key}"}
    url = openai_compat_url(base_url, path)
    log_info(f"转发文本请求 {request.method} {url}", ctx={"path": path})
    return await forward_request(url, request, headers)


MIMO_HOSTS = {
    "api": "https://api.xiaomimimo.com",
    "token-plan-cn": "https://token-plan-cn.xiaomimimo.com",
    "token-plan-sgp": "https://token-plan-sgp.xiaomimimo.com",
    "token-plan-ams": "https://token-plan-ams.xiaomimimo.com",
}


@router.api_route("/mimo/{cluster}/{path:path}", methods=["GET", "POST"])
async def mimo_request(cluster: str, path: str, request: Request):
    if request.method == "POST" and settings.infinite_offline_validation is True:
        raise HTTPException(503, "测试服务已隔离供应商请求")
    allowed = request.method == "GET" and path == "v1/models" or request.method == "POST" and path in ("v1/chat/completions", "v1/responses")
    if cluster not in MIMO_HOSTS or not allowed:
        raise HTTPException(404, "未提供此小米接口")
    authorization = request.headers.get("authorization", "")
    if not authorization.startswith("Bearer ") or not authorization[7:].strip():
        raise HTTPException(401, "请在小米渠道中配置 API Key")
    # Only fixed official hosts/paths are accepted. Credentials are forwarded, never stored.
    return await forward_request(MIMO_HOSTS[cluster] + "/" + path, request, {"Authorization": authorization})


async def forward_request(url: str, request: Request, headers: dict[str, str]):
    client = httpx.AsyncClient(trust_env=False, timeout=None)
    if request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    try:
        outgoing = client.build_request(request.method, url, params=request.query_params, content=request.stream(), headers=headers)
        response = await client.send(outgoing, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        log_warn(f"供应商连接失败: {type(exc).__name__}", ctx={"url": url})
        raise HTTPException(502, "供应商连接失败，请稍后重试")
    except BaseException:
        await client.aclose()
        raise
    log_info(f"供应商响应 HTTP {response.status_code}", ctx={"url": url, "status": response.status_code})

    async def stream():
        try:
            async for chunk in response.aiter_bytes():
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(stream(), status_code=response.status_code, media_type=response.headers.get("content-type", "application/json"), headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
