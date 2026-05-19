import httpx
import base64
import io
from typing import Optional, List
from PIL import Image

from image_api.config import settings
from image_api.services.log_helper import log_info, log_warn, log_error


# ── aiohttp chunked-streaming helpers ───────────────────────────────────────

def _is_packy(base_url: str) -> bool:
    """Check if base_url belongs to PackyAPI."""
    return "packyapi.com" in (base_url or "")


async def _read_response_chunks(resp, file_path: str) -> int:
    """Stream response body to file in chunks. Avoids body-read hangs."""
    import os
    total = 0
    with open(file_path, "wb") as f:
        async for chunk in resp.content.iter_chunked(65536):
            f.write(chunk)
            total += len(chunk)
    return total


async def _aiohttp_post(url: str, headers: dict, files: list = None,
                        data: dict = None, timeout: int = 600) -> dict:
    """
    Chunked-streaming POST via aiohttp. Works for both JSON and multipart.
    files=None → JSON body; files!=None → multipart form.
    """
    import aiohttp, io as io_mod, json as _json, tempfile, os

    if files is None:
        # JSON body
        body_bytes = _json.dumps(data).encode("utf-8") if data else None
        hdrs = {**headers, "Content-Type": "application/json"}
        timeout_obj = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=timeout_obj) as session:
            async with session.post(url, headers=hdrs, data=body_bytes) as resp:
                buf = io_mod.BytesIO()
                async for chunk in resp.content.iter_chunked(65536):
                    buf.write(chunk)
                resp_bytes = buf.getvalue()
        log_info(f"aiohttp JSON 响应: {resp.status} {len(resp_bytes)} 字节")
        return _json.loads(resp_bytes.decode("utf-8"))
    else:
        # Multipart form
        form = aiohttp.FormData()
        for field_name, (filename, file_bytes, content_type) in files:
            form.add_field(field_name, file_bytes, filename=filename, content_type=content_type)
        for k, v in (data or {}).items():
            if v is not None:
                form.add_field(k, str(v) if not isinstance(v, str) else v)

        tmp = tempfile.NamedTemporaryFile(delete=False)
        tmp_path = tmp.name
        tmp.close()

        try:
            timeout_obj = aiohttp.ClientTimeout(total=timeout)
            async with aiohttp.ClientSession(timeout=timeout_obj) as session:
                async with session.post(url, headers=headers, data=form) as resp:
                    log_info(f"aiohttp multipart 响应: {resp.status}")
                    total_bytes = await _read_response_chunks(resp, tmp_path)
                    log_info(f"aiohttp multipart 响应体: {total_bytes} 字节")
            with open(tmp_path, "r", encoding="utf-8") as f:
                result = _json.load(f)
            return result
        finally:
            os.unlink(tmp_path)


def _round_to_multiple_of_16(n: int) -> int:
    """Round to nearest multiple of 16 (up or down, whichever is closer)."""
    lower = (n // 16) * 16
    upper = lower + 16
    return lower if (n - lower) <= (upper - n) else upper


def preprocess_reference_image(image_base64: str, target_size: str) -> tuple[bytes, str]:
    """
    Resize reference image based on user's selected target_size, preserving
    original aspect ratio (no cropping).

    Constraints (open-hk gpt-image-2):
      - Max long edge ≤ 3840px
      - Both edges must be multiples of 16
      - Total pixels: 655,360 ~ 8,294,400

    Scaling logic:
      - "auto": keep original dimensions, apply 16x alignment + pixel constraints
      - Specific size: scale ref image to match that WIDTH (proportionally),
        then apply 16x alignment + pixel constraints
    """
    try:
        MAX_LONG = 3840
        MIN_PIXELS = 655360
        MAX_PIXELS = 8294400

        # ── Step 1: decode reference image ──────────────────────────────────────
        img_data = base64.b64decode(image_base64)
        img = Image.open(io.BytesIO(img_data))
        if img.mode != "RGB":
            img = img.convert("RGB")

        orig_w, orig_h = img.size
        orig_ratio = orig_w / orig_h

        log_info(f"参考图：{orig_w}x{orig_h} (ratio {orig_ratio:.3f})")

        # ── Step 2: parse target_size ───────────────────────────────────────────
        target_lower = target_size.lower().strip() if target_size else "auto"
        is_auto = (target_lower == "auto")

        if is_auto:
            raw_w, raw_h = orig_w, orig_h
            log_info(f"Target: auto → preserve original {raw_w}x{raw_h}")
        else:
            try:
                t_parts = target_lower.split("x")
                t_w = int(t_parts[0])
                t_h = int(t_parts[1]) if len(t_parts) == 2 else None
            except (ValueError, IndexError, AttributeError):
                raw_w, raw_h = orig_w, orig_h
                log_warn(f"Target parse failed → auto fallback to {raw_w}x{raw_h}")
            else:
                # Scale ref image so its WIDTH matches the target width
                raw_w = t_w
                raw_h = int(round(t_w / orig_ratio)) if orig_ratio > 0 else t_w
                log_info(f"Target: {target_size} → scale ref to W={raw_w}, H={raw_h}")

        # ── Step 3: enforce pixel range (BOTH auto and specific size) ──────────
        pixel_count = raw_w * raw_h
        if pixel_count > MAX_PIXELS:
            scale = (MAX_PIXELS / pixel_count) ** 0.5
            raw_w = int(raw_w * scale)
            raw_h = int(raw_h * scale)
            log_info(f"Pixel cap applied: → {raw_w}x{raw_h}")
        elif pixel_count < MIN_PIXELS:
            scale = (MIN_PIXELS / pixel_count) ** 0.5
            raw_w = int(raw_w * scale)
            raw_h = int(raw_h * scale)
            log_info(f"Pixel floor applied: → {raw_w}x{raw_h}")

        # ── Step 4: align to nearest multiple of 16 ────────────────────────────
        actual_w = _round_to_multiple_of_16(raw_w)
        actual_h = _round_to_multiple_of_16(raw_h)

        # ── Step 5: clamp per-edge limits ───────────────────────────────────────
        actual_w = max(actual_w, 512)
        actual_h = max(actual_h, 512)
        actual_w = min(actual_w, MAX_LONG)
        actual_h = min(actual_h, MAX_LONG)

        actual_w = _round_to_multiple_of_16(actual_w)
        actual_h = _round_to_multiple_of_16(actual_h)

        log_info(f"Processed size: {actual_w}x{actual_h}")

        resample = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
        img_resized = img.resize((actual_w, actual_h), resample=resample)

        output = io.BytesIO()
        img_resized.save(output, format="PNG")
        actual_size = f"{actual_w}x{actual_h}"
        log_info(f"Final: {actual_w}x{actual_h} (ratio {actual_w/actual_h:.3f}, {actual_w*actual_h} pixels)")
        return output.getvalue(), actual_size

    except Exception as e:
        log_error(f"preprocess_reference_image failed: {e}")
        import traceback
        traceback.print_exc()
        raise


def validate_image_pixels(image_base64: str) -> dict:
    """
    Validate reference image dimensions against gpt-image-2 constraints.
    Does NOT resize — only checks and logs warnings.
    """
    MAX_LONG = 3840
    MIN_PIXELS = 655360
    MAX_PIXELS = 8294400

    try:
        img_data = base64.b64decode(image_base64)
        img = Image.open(io.BytesIO(img_data))
        w, h = img.size
        pixel_count = w * h

        issues = []
        if w > MAX_LONG or h > MAX_LONG:
            issues.append(f"edge exceeds {MAX_LONG}px ({w}x{h})")
        if w % 16 != 0 or h % 16 != 0:
            issues.append(f"not multiple of 16 ({w}x{h})")
        if pixel_count < MIN_PIXELS:
            issues.append(f"pixels below minimum ({pixel_count} < {MIN_PIXELS})")
        elif pixel_count > MAX_PIXELS:
            issues.append(f"pixels above maximum ({pixel_count} > {MAX_PIXELS})")

        valid = len(issues) == 0
        if issues:
            log_warn(f"Reference image validation: {'; '.join(issues)}")
        else:
            log_info(f"Reference image validation passed: {w}x{h}, {pixel_count} px")

        return {"width": w, "height": h, "valid": valid}
    except Exception as e:
        log_error(f"validate_image_pixels failed: {e}")
        return {"width": 0, "height": 0, "valid": False}


async def generate_openai_image(
    prompt: str,
    model: str = "gpt-image-2",
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
    image_urls: Optional[List[str]] = None,
    image_base64s: Optional[List[str]] = None,
    size: str = "1024x1024",
    n: int = 1,
    quality: Optional[str] = None,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> List[dict]:
    """
    Generate images using OpenAI-compatible API (OpenAI-HK).
    For text-to-image: uses /v1/images/generations (JSON body).
    For image-to-image: uses /v1/images/edits (multipart), because open-hk's
    generations endpoint 'image' param has a bug (returns code 1001).
    Reference image is preprocessed to match target aspect ratio.
    """
    import traceback

    try:
        # Use overridden base_url/api_key if provided, otherwise fall back to default settings
        effective_base_url = base_url or settings.openai_base_url
        effective_api_key = api_key or settings.openai_api_key

        headers = {
            "Authorization": f"Bearer {effective_api_key}",
        }

        # Collect all reference images (list params take priority; singular are fallback)
        all_urls = []
        all_base64s = []
        if image_urls:
            all_urls.extend(image_urls)
        elif image_url:
            all_urls.append(image_url)
        if image_base64s:
            all_base64s.extend(image_base64s)
        elif image_base64:
            all_base64s.append(image_base64)

        has_ref_image = bool(all_urls or all_base64s)

        if not has_ref_image:
            # Pure text-to-image via /v1/images/generations
            url = f"{effective_base_url}/images/generations"
            body = {
                "model": model,
                "prompt": prompt,
                "n": n,
                "size": size,
            }
            if quality:
                body["quality"] = quality



            log_info(f"调用 API：POST {url}", ctx={
                "model": model,
                "size": size,
                "has_ref": False,
            })

            # Timeout based on resolution:
            # 4K: long edge > 2048 (up to 3840)
            # 2K: long edge == 2048
            # 1K: long edge < 2048
            long_edge = max(int(s) for s in size.split("x"))
            if long_edge >= 2048:
                timeout = 1200  # 2K/4K（支持中转排队）
            else:
                timeout = 600   # 1K

            # PackyAPI: use aiohttp chunked streaming
            if _is_packy(effective_base_url):
                data = await _aiohttp_post(
                    url=url,
                    headers=headers,
                    data=body,
                    timeout=timeout,
                )
            else:
                proxies = None
                async with httpx.AsyncClient(proxies=proxies, timeout=httpx.Timeout(1200.0)) as client:
                    try:
                        response = await client.post(url, headers=headers, json=body, timeout=timeout)
                        raw_text = response.text
                        log_info(f"API 响应 {response.status_code}，body {len(raw_text)} 字节", ctx={
                            "status": response.status_code,
                            "body_preview": raw_text[:300],
                        })
                    except Exception as e:
                        log_error(f"HTTP 请求失败：{type(e).__name__}: {e}")
                        raise
                    response.raise_for_status()
                    data = response.json()

        else:
            # Image-to-image via /v1/images/edits (multipart)
            # Open-hk's generations endpoint 'image' param is broken (code 1001)
            url = f"{effective_base_url}/images/edits"
            log_info(f"Image-to-image: POST {url} (refs: {len(all_base64s)} base64 + {len(all_urls)} urls)")

            # Download URL references and convert to base64
            for u in all_urls:
                async with httpx.AsyncClient() as client:
                    img_resp = await client.get(u, timeout=60)
                    img_resp.raise_for_status()
                    img = Image.open(io.BytesIO(img_resp.content))
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    all_base64s.append(base64.b64encode(buf.getvalue()).decode())

            # First image: full preprocessing (determines output size)
            first_b64 = all_base64s[0]
            processed_bytes, actual_size = preprocess_reference_image(first_b64, size)
            log_info(f"参考图[0] 预处理完成：{len(processed_bytes)} 字节，尺寸 {actual_size}")

            # Determine multipart field name per provider
            is_packy = _is_packy(effective_base_url)
            field_name = "image" if is_packy else "image[]"

            # Build files list: first image + additional refs (validate-only, no resize)
            files = [(field_name, ("reference.png", processed_bytes, "image/png"))]
            for i, b64 in enumerate(all_base64s[1:], start=1):
                validate_image_pixels(b64)
                img_data = base64.b64decode(b64)
                other_bytes = img_data  # send original bytes, no resize
                files.append((field_name, (f"reference_{i}.png", other_bytes, "image/png")))
                log_info(f"参考图[{i}] 像素验证完成，已加入请求")

            data = {
                "model": model,
                "prompt": prompt,
                "n": n,
                "size": actual_size,
            }
            if quality:
                data["quality"] = quality

            log_info(f"提交编辑请求：POST {url}", ctx={
                "quality": quality,
                "size": actual_size,
                "field": field_name,
                "image_count": len(files),
            })

            long_edge = max(int(s) for s in (actual_size or size).split("x"))
            if long_edge >= 2048:
                timeout = 1200  # 2K/4K（支持中转排队）
            else:
                timeout = 600   # 1K

            # PackyAPI: use aiohttp chunked streaming (multipart)
            if is_packy:
                data = await _aiohttp_post(
                    url=url,
                    headers=headers,
                    files=files,
                    data=data,
                    timeout=timeout,
                )
                log_info(f"编辑 API 返回：{str(data)[:500]}")
            else:
                proxies = None
                async with httpx.AsyncClient(proxies=proxies, timeout=httpx.Timeout(1200.0)) as client:
                    try:
                        response = await client.post(url, headers=headers, files=files, data=data, timeout=timeout)
                        log_info(f"编辑响应 {response.status_code}", ctx={"status": response.status_code})
                        response.raise_for_status()
                        data = response.json()
                        log_info(f"编辑 API 返回：{str(data)[:300]}")
                    except httpx.HTTPStatusError as e:
                        log_error(f"编辑请求失败 {e.response.status_code}：{e.response.text[:500]}")
                        raise

        # Parse response
        images = []
        items = data.get("data")

        for item in items:
            # OpenAI API returns 'url', some providers return 'b64_json'
            b64_data = item.get("b64_json")
            url_data = item.get("url")

            if b64_data:
                # Provider returned base64 directly
                log_info("API 返回 base64 图片数据")
                images.append({
                    "url": None,
                    "base64": b64_data,
                })
            elif url_data:
                # Provider returned URL, download and convert to base64 for frontend
                try:
                    # external-resources.packyapi.com: curl/httpx systematically fail
                    # with SSL_ERROR_SYSCALL on this network, wget works reliably.
                    if "external-resources.packyapi.com" in url_data:
                        import asyncio, tempfile, os
                        log_info(f"开始下载图片(wget)：{url_data}")
                        tmp = tempfile.NamedTemporaryFile(delete=False)
                        tmp_path = tmp.name
                        tmp.close()
                        proc = await asyncio.create_subprocess_exec(
                            "wget", "-q", "-O", tmp_path, url_data,
                            stdout=asyncio.subprocess.DEVNULL,
                            stderr=asyncio.subprocess.DEVNULL,
                        )
                        try:
                            await asyncio.wait_for(proc.wait(), timeout=180)
                        except asyncio.TimeoutError:
                            proc.kill()
                            await proc.wait()
                            os.unlink(tmp_path)
                            raise TimeoutError("wget 下载超时")
                        if proc.returncode != 0:
                            os.unlink(tmp_path)
                            raise RuntimeError(f"wget 退出码 {proc.returncode}")
                        with open(tmp_path, "rb") as f:
                            img_bytes = f.read()
                        os.unlink(tmp_path)
                        b64_from_url = base64.b64encode(img_bytes).decode()
                        log_info(f"图片下载完成(wget)：{len(img_bytes)} 字节", ctx={"url": url_data})
                    else:
                        proxies_dl = None
                        log_info(f"开始下载图片(httpx)：{url_data}", ctx={"proxies": bool(proxies_dl)})
                        async with httpx.AsyncClient(proxies=proxies_dl) as dl_client:
                            img_resp = await dl_client.get(url_data, timeout=180)
                            img_resp.raise_for_status()
                            img_bytes = img_resp.content
                            b64_from_url = base64.b64encode(img_bytes).decode()
                            log_info(f"图片下载完成(httpx)：{len(img_bytes)} 字节", ctx={"url": url_data})
                    images.append({
                        "url": url_data,
                        "base64": b64_from_url,
                    })
                except Exception as e:
                    log_warn(f"下载图片失败：{e}", ctx={"url": url_data})
                    # Still return the URL even if download fails
                    images.append({
                        "url": url_data,
                        "base64": None,
                    })
            else:
                log_warn(f"返回项缺少 url 和 b64_json", ctx={"item": item})

        return images

    except Exception as e:
        log_error(f"generate_openai_image 失败：{e}")
        traceback.print_exc()
        raise
