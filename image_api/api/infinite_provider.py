"""Fixed-provider proxy for infinite's text, audio and native model clients."""
import re

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from image_api.config import settings

router = APIRouter(prefix="/infinite", tags=["Infinite provider"])


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
    if not settings.openai_api_key:
        raise HTTPException(503, "服务端尚未配置供应商凭据")
    headers = {"Authorization": f"Bearer {settings.openai_api_key}"}
    return await forward_request(settings.openai_base_url.rstrip("/") + "/" + path, request, headers)


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
