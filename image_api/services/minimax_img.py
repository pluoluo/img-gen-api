import httpx
import base64
from typing import Optional, List

from image_api.config import settings


async def generate_minimax_image(
    prompt: str,
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
    size: str = "1024x1024",
    n: int = 1,
) -> List[dict]:
    """
    MiniMax Image-01 via OpenAI-compatible endpoint.
    Endpoint: POST https://api.minimaxi.com/v1/image_generation

    Size mapping:
      1024x1024 -> 1:1
      1024x1792 -> 9:16
      1792x1024 -> 16:9
      (also supports: 4:3, 3:2, 2:3, 3:4, 21:9)
    """
    # Map size string to aspect ratio
    size_to_ratio = {
        "1024x1024": "1:1",
        "1024x1792": "9:16",
        "1792x1024": "16:9",
        "1536x1536": "1:1",  # closest match
        "1024x1536": "2:3",
        "1536x1024": "3:2",
    }
    aspect_ratio = size_to_ratio.get(size, "1:1")

    url = f"{settings.minimax_base_url}/v1/image_generation"

    headers = {
        "Authorization": f"Bearer {settings.minimax_api_key}",
        "Content-Type": "application/json",
    }

    body = {
        "model": "image-01",
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "response_format": "url",
        "n": n,
    }

    # Reference image support for image-to-image
    if image_url:
        body["subject_reference"] = [{
            "type": "character",
            "image_file": image_url,
        }]
    elif image_base64:
        body["subject_reference"] = [{
            "type": "character",
            "image_file": f"data:image/png;base64,{image_base64}",
        }]

    async with httpx.AsyncClient() as client:
        response = await client.post(url, headers=headers, json=body, timeout=180)
        response.raise_for_status()
        data = response.json()

    images = []
    results = data.get("data", {}).get("image_urls", [])
    for item in results:
        images.append({
            "url": item if isinstance(item, str) else item.get("url"),
            "base64": None,
        })

    return images
