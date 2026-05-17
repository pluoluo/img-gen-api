import httpx
import base64
from typing import Optional, List

from image_api.config import settings


async def generate_gemini_image(
    prompt: str,
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
) -> List[dict]:
    api_key = settings.gemini_api_key
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key={api_key}"

    headers = {"Content-Type": "application/json"}

    parts = [{"text": prompt}]

    if image_url:
        parts.append({"image": {"source": {"imageUrl": image_url}}})
    elif image_base64:
        parts.append({
            "image": {
                "source": {
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": image_base64,
                    }
                }
            }
        })

    body = {
        "contents": [{"parts": parts}]
    }

    async with httpx.AsyncClient() as client:
        response = await client.post(url, headers=headers, json=body, timeout=180)
        response.raise_for_status()
        data = response.json()

    images = []
    candidates = data.get("candidates", [])
    if candidates:
        parts = candidates[0].get("content", {}).get("parts", [])
        for part in parts:
            if "inlineData" in part:
                images.append({
                    "url": None,
                    "base64": part["inlineData"].get("data"),
                })
            elif "image" in part:
                images.append({
                    "url": part["image"].get("source", {}).get("imageUrl"),
                    "base64": None,
                })

    return images
