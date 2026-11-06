"""Same-origin configuration and task adapter for the infinite-canvas fork."""
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from image_api.api.router import GenerateRequest, generate
from image_api.config import settings

router = APIRouter(prefix="/infinite", tags=["Infinite canvas"])
CATALOG = Path(__file__).resolve().parents[2] / "frontend" / "model-config.json"
PROVIDERS = {"gpt": "auto", "gemini": "gemini", "minimax": "minimax"}


def model_catalog():
    return json.loads(CATALOG.read_text(encoding="utf-8"))["MODELS"]


@router.get("/config")
def configuration():
    # Only capability metadata crosses this boundary, never provider credentials.
    available = {
        "gpt": bool(settings.openai_api_key or settings.packy_api_key),
        "gemini": bool(settings.openai_api_key),
        "minimax": bool(settings.minimax_api_key),
    }
    return {
        "app": "image-api",
        "models": [
            {"name": item["value"], "label": item["label"], "capability": "image"}
            for item in model_catalog() if available.get(item["kind"])
        ],
        "storage": "browser",
        "offline_validation": settings.infinite_offline_validation is True,
        "provider_models": [
            {"name": "gpt-4.1-mini", "capability": "text"},
            {"name": "gpt-4o-mini", "capability": "text"},
            {"name": "tts-1", "capability": "audio"},
        ] if settings.openai_api_key else [],
    }


@router.post("/generate")
async def generate_image(body: GenerateRequest):
    model = next((item for item in model_catalog() if item["value"] == body.sub_model), None)
    if model is None:
        raise HTTPException(422, "模型不在当前服务的模型目录中，请刷新配置")
    # Revalidate after resolving the provider so mask support cannot be bypassed.
    values = body.model_dump()
    values["model"] = PROVIDERS[model["kind"]]
    try:
        request = GenerateRequest.model_validate(values)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    return await generate(request)
