import asyncio
import httpx
import base64
import io
import os
import socket
import tempfile
from typing import Optional, List
from PIL import Image

from image_api.config import settings
from image_api.services.log_helper import log_info, log_warn, log_error


# ── HTTP POST helpers (httpx) ─────────────────────────────────────────────

# TCP keepalive config: send keepalive after 60s idle, probe every 15s,
# drop after 3 failed probes. This keeps long-lived connections alive through
# NAT/firewall idle timeouts while waiting for slow API responses (e.g. 4K images).
_KEEPALIVE_OPTS = [
    (socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1),
    (socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 60),
    (socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 15),
    (socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3),
]


def _is_packy(base_url: str) -> bool:
    """Check if base_url belongs to PackyAPI."""
    if not base_url:
        return False
    return "packyapi.com" in base_url or "packyapi.ai" in base_url


def _make_transport(proxy: str = None):
    """Create an AsyncHTTPTransport with TCP keepalive and optional proxy."""
    extra = {}
    if proxy:
        extra["proxy"] = proxy
    return httpx.AsyncHTTPTransport(retries=1, http2=False,
                                     socket_options=_KEEPALIVE_OPTS, **extra)


_PROXY_DOMAINS = [
    "pro.filesystem.site",
    "external-resources.packyapi.com",
]


def _needs_proxy(url: str) -> Optional[str]:
    """Return proxy URL if the download target requires one, else None."""
    for domain in _PROXY_DOMAINS:
        if domain in url:
            return settings.packy_proxy
    return None


async def _download_image(url: str) -> bytes:
    """
    Download image bytes with fallback strategy:
    1. httpx (with proxy if needed, short timeout)
    2. wget via subprocess (with proxy env if needed)
    Raises on total failure.
    """
    proxy = _needs_proxy(url)

    # Attempt 1: httpx
    try:
        timeout_cfg = httpx.Timeout(connect=15.0, read=60.0, write=15.0, pool=10.0)
        log_info(f"下载图片(httpx, proxy={'yes' if proxy else 'no'}): {url}")
        async with httpx.AsyncClient(trust_env=False, proxy=proxy,
                                      timeout=timeout_cfg) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            log_info(f"下载完成(httpx): {len(resp.content)} 字节", ctx={"url": url})
            return resp.content
    except Exception as e:
        log_warn(f"httpx下载失败({type(e).__name__}), 尝试wget: {url}")

    # Attempt 2: wget (honours https_proxy env or explicit -e)
    tmp = tempfile.NamedTemporaryFile(delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        env = os.environ.copy()
        if proxy:
            env["https_proxy"] = proxy
            env["http_proxy"] = proxy
        proc = await asyncio.create_subprocess_exec(
            "wget", "-q", "--no-check-certificate", "-O", tmp_path, url,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env=env,
        )
        await asyncio.wait_for(proc.wait(), timeout=120)
        if proc.returncode != 0:
            raise RuntimeError(f"wget exit {proc.returncode}")
        with open(tmp_path, "rb") as f:
            data = f.read()
        if not data:
            raise RuntimeError("wget downloaded 0 bytes")
        log_info(f"下载完成(wget): {len(data)} 字节", ctx={"url": url})
        return data
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
        raise RuntimeError(f"wget timeout downloading {url}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


async def _httpx_post(url: str, headers: dict, files: list = None,
                        data: dict = None, timeout: int = 900, proxy: str = None) -> dict:
    """
    POST via httpx (HTTP/1.1, IPv4/IPv6 dual-stack).
    files=None → JSON body; files!=None → multipart form.
    """
    import json as _json

    timeout_cfg = httpx.Timeout(connect=30.0, read=float(timeout), write=60.0, pool=30.0)

    if files is None:
        # JSON body — use httpx. Force HTTP/1.1 (no HTTP/2 multiplexing that
        # can cause connection confusion with some reverse proxies).
        log_info(f"httpx POST {url} timeout={timeout}s body={_json.dumps(data, ensure_ascii=False)[:200]}")

        transport = _make_transport(proxy=proxy)
        async with httpx.AsyncClient(transport=transport, trust_env=False,
                                      timeout=timeout_cfg) as client:
            resp = await client.post(url, headers=headers, json=data)
        resp_bytes = resp.content
        log_info(f"httpx JSON 响应: {resp.status_code} {len(resp_bytes)} 字节")
        if resp.status_code != 200:
            raw = resp_bytes.decode("utf-8", errors="replace")
            log_error(f"PackyAPI 非200响应: HTTP {resp.status_code} | {raw[:500]}")
            raise APIResponseError(resp.status_code, raw)
        try:
            result = _json.loads(resp_bytes.decode("utf-8"))
        except Exception as e:
            log_error(f"JSON 解析失败，原始响应内容:\n{resp_bytes.decode('utf-8', errors='replace')}")
            raise
        log_info(f"PackyAPI 完整响应: {resp_bytes.decode('utf-8', errors='replace')[:2000]}")
        return result
    else:
        # Multipart form via httpx
        # Pass files as a list of (field_name, file_tuple) pairs so httpx 0.23.3
        # creates a FileField per tuple. Grouping into a dict with list values
        # would break because httpx 0.23.3 treats the list as a file object.
        file_items = [(fn, ft) for fn, ft in files]

        # Text form fields
        form_data = {}
        for k, v in (data or {}).items():
            if v is not None:
                form_data[k] = str(v) if not isinstance(v, str) else v

        tmp = tempfile.NamedTemporaryFile(delete=False)
        tmp_path = tmp.name
        tmp.close()
        try:
            transport = _make_transport(proxy=proxy)
            async with httpx.AsyncClient(transport=transport, trust_env=False,
                                          timeout=timeout_cfg) as client:
                async with client.stream("POST", url, headers=headers,
                                          files=file_items, data=form_data) as resp:
                    log_info(f"httpx multipart 响应: {resp.status_code}")
                    total_bytes = 0
                    with open(tmp_path, "wb") as f:
                        async for chunk in resp.aiter_bytes(65536):
                            f.write(chunk)
                            total_bytes += len(chunk)
                    log_info(f"httpx multipart 响应体: {total_bytes} 字节")
            with open(tmp_path, "r", encoding="utf-8") as f:
                result = _json.load(f)
            result_str = _json.dumps(result, ensure_ascii=False)
            log_info(f"PackyAPI multipart 完整响应: {result_str[:2000]}")
            return result
        finally:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)


class APIResponseError(Exception):
    """Raised when the API returns a non-200 response with its raw body."""
    def __init__(self, status: int, raw_body: str):
        self.status = status
        self.raw_body = raw_body
        super().__init__(f"PackyAPI 返回 HTTP {status}")


def _round_to_multiple_of_16(n: int) -> int:
    """Round to nearest multiple of 16 (up or down, whichever is closer)."""
    lower = (n // 16) * 16
    upper = lower + 16
    return lower if (n - lower) <= (upper - n) else upper


# API constraints (open-hk gpt-image-2 / PackyAPI)
_SIZE_MIN_LONG = 512
_SIZE_MAX_LONG = 3840
_SIZE_MIN_PIXELS = 655360
_SIZE_MAX_PIXELS = 8294400
_SIZE_MAX_ASPECT_RATIO = 3.0  # long edge : short edge, e.g. 3840x1280 is right at the limit


def _clamp_aspect_ratio(w: int, h: int) -> tuple[int, int]:
    """Shrink the longer edge so long:short never exceeds _SIZE_MAX_ASPECT_RATIO."""
    if w > h and w > h * _SIZE_MAX_ASPECT_RATIO:
        new_w = round(h * _SIZE_MAX_ASPECT_RATIO)
        log_info(f"[size] aspect ratio cap applied: {w}x{h} → {new_w}x{h} "
                 f"(max {_SIZE_MAX_ASPECT_RATIO}:1)")
        return new_w, h
    if h > w and h > w * _SIZE_MAX_ASPECT_RATIO:
        new_h = round(w * _SIZE_MAX_ASPECT_RATIO)
        log_info(f"[size] aspect ratio cap applied: {w}x{h} → {w}x{new_h} "
                 f"(max {_SIZE_MAX_ASPECT_RATIO}:1)")
        return w, new_h
    return w, h


def _constrain_pixel_dims(raw_w: int, raw_h: int) -> tuple[int, int]:
    """Apply API pixel-count, edge-limit, and aspect-ratio constraints to raw dimensions."""
    MIN_LONG = _SIZE_MIN_LONG
    MAX_LONG = _SIZE_MAX_LONG
    MIN_PIXELS = _SIZE_MIN_PIXELS
    MAX_PIXELS = _SIZE_MAX_PIXELS

    raw_w, raw_h = _clamp_aspect_ratio(raw_w, raw_h)

    pixel_count = raw_w * raw_h
    if pixel_count > MAX_PIXELS:
        scale = (MAX_PIXELS / pixel_count) ** 0.5
        raw_w = int(raw_w * scale)
        raw_h = int(raw_h * scale)
        log_info(f"[size] pixel cap applied: → {raw_w}x{raw_h}")
    elif pixel_count < MIN_PIXELS:
        scale = (MIN_PIXELS / pixel_count) ** 0.5
        raw_w = int(raw_w * scale)
        raw_h = int(raw_h * scale)
        log_info(f"[size] pixel floor applied: → {raw_w}x{raw_h}")

    actual_w = _round_to_multiple_of_16(raw_w)
    actual_h = _round_to_multiple_of_16(raw_h)

    actual_w = max(actual_w, MIN_LONG)
    actual_h = max(actual_h, MIN_LONG)
    actual_w = min(actual_w, MAX_LONG)
    actual_h = min(actual_h, MAX_LONG)

    actual_w = _round_to_multiple_of_16(actual_w)
    actual_h = _round_to_multiple_of_16(actual_h)

    # 16-multiple rounding may have undone the pixel-floor scaling.
    # Bump the smaller dimension up one notch at a time until the budget is met.
    while actual_w * actual_h < MIN_PIXELS:
        if actual_w <= actual_h and actual_w < MAX_LONG:
            actual_w = _round_to_multiple_of_16(actual_w + 16)
        elif actual_h < MAX_LONG:
            actual_h = _round_to_multiple_of_16(actual_h + 16)
        else:
            break  # both edges at max, can't go higher

    return actual_w, actual_h


def validate_text_to_image_size(size: str) -> str:
    """
    Validate and adjust a user-provided pixel size for text-to-image (no reference).
    Parses WxH, rounds to multiple of 16, clamps to valid API range.
    Returns adjusted size string like "1024x1024".
    """
    if not size or size.strip().lower() == "auto":
        return "1024x1024"

    raw = size.strip().lower().replace("*", "x")
    try:
        parts = raw.split("x")
        w = int(parts[0])
        h = int(parts[1])
    except (ValueError, IndexError):
        log_warn(f"[size] cannot parse '{size}', falling back to 1024x1024")
        return "1024x1024"

    if w <= 0 or h <= 0:
        log_warn(f"[size] non-positive dimension in '{size}', falling back to 1024x1024")
        return "1024x1024"

    actual_w, actual_h = _constrain_pixel_dims(w, h)
    actual_size = f"{actual_w}x{actual_h}"

    if actual_w != w or actual_h != h:
        log_info(f"[size] text-to-image adjusted {w}x{h} → {actual_size}")

    log_info(f"[size] text-to-image final: {actual_size} ({actual_w*actual_h} pixels)")
    return actual_size


def validate_and_adjust_size(target_size: str, orig_w: int, orig_h: int) -> tuple[int, int, str]:
    """
    Validate and adjust user-provided pixel dimensions for image-to-image.
    Preserves the reference image's aspect ratio — scales proportionally
    so WIDTH matches the target width (ignores target height).
    Returns (adjusted_w, adjusted_h, adjusted_size_str).

    API constraints (open-hk gpt-image-2 / PackyAPI):
      - Max long edge ≤ 3840px
      - Min long edge ≥ 512px (enforced after all other steps)
      - Both edges must be multiples of 16
      - Total pixels: 655,360 ~ 8,294,400
      - Aspect ratio (long:short) ≤ 3:1
    """
    orig_ratio = orig_w / orig_h

    target_lower = target_size.lower().strip() if target_size else "auto"
    is_auto = (target_lower == "auto")

    if is_auto:
        raw_w, raw_h = orig_w, orig_h
        log_info(f"[size] auto → preserve original {raw_w}x{raw_h}")
    else:
        try:
            t_parts = target_lower.split("x")
            t_w = int(t_parts[0])
        except (ValueError, IndexError, AttributeError):
            raw_w, raw_h = orig_w, orig_h
            log_warn(f"[size] parse failed → auto fallback to {raw_w}x{raw_h}")
        else:
            raw_w = t_w
            raw_h = int(round(t_w / orig_ratio)) if orig_ratio > 0 else t_w
            log_info(f"[size] target={target_size} → scale ref to W={raw_w}, H={raw_h}")

    actual_w, actual_h = _constrain_pixel_dims(raw_w, raw_h)
    actual_size = f"{actual_w}x{actual_h}"

    if not is_auto:
        try:
            t_parts = target_lower.split("x")
            t_w_orig = int(t_parts[0])
            t_h_orig = int(t_parts[1]) if len(t_parts) == 2 else int(round(t_w_orig / orig_ratio))
            if t_w_orig != actual_w or t_h_orig != actual_h:
                log_info(f"[size] adjusted {t_w_orig}x{t_h_orig} → {actual_w}x{actual_h} "
                         f"(ratio preserved, API constraints applied)")
        except (ValueError, IndexError, AttributeError):
            pass

    log_info(f"[size] final: {actual_w}x{actual_h} ({actual_w*actual_h} pixels, ratio {actual_w/actual_h:.3f})")
    return actual_w, actual_h, actual_size


def preprocess_reference_image(image_base64: str, target_size: str) -> tuple[bytes, str, str]:
    """
    Resize reference image based on user's selected target_size, preserving
    original aspect ratio (no cropping).

    Returns: (resized_bytes, actual_size_for_api, adjusted_size_str)

    adjusted_size_str is the human-readable size after applying API constraints,
    suitable for returning to the caller so they know what size was actually used.

    Constraints (open-hk gpt-image-2):
      - Max long edge ≤ 3840px
      - Both edges must be multiples of 16
      - Total pixels: 655,360 ~ 8,294,400
      - Aspect ratio (long:short) ≤ 3:1

    Scaling logic:
      - "auto": keep original dimensions, apply 16x alignment + pixel constraints
      - Specific size: scale ref image to match that WIDTH (proportionally),
        then apply 16x alignment + pixel constraints
    """
    try:
        # ── Step 1: decode reference image ──────────────────────────────────────
        img_data = base64.b64decode(image_base64)
        with Image.open(io.BytesIO(img_data)) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")

            orig_w, orig_h = img.size
            log_info(f"参考图：{orig_w}x{orig_h} (ratio {orig_w/orig_h:.3f})")

            # ── Step 2: validate and adjust dimensions ─────────────────────────────
            actual_w, actual_h, adjusted_size = validate_and_adjust_size(
                target_size, orig_w, orig_h
            )

            log_info(f"Processed size: {actual_w}x{actual_h}")

            resample = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
            img_resized = img.resize((actual_w, actual_h), resample=resample)
            try:
                output = io.BytesIO()
                img_resized.save(output, format="PNG")
                actual_size_str = f"{actual_w}x{actual_h}"
                log_info(f"Final: {actual_w}x{actual_h} (ratio {actual_w/actual_h:.3f}, {actual_w*actual_h} pixels)")
                # Return: (resized_bytes, actual_size_for_api, adjusted_size_str)
                return output.getvalue(), actual_size_str, adjusted_size
            finally:
                img_resized.close()

    except Exception as e:
        log_error(f"preprocess_reference_image failed: {e}")
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

        # Determine proxy: use per-call base_url to detect PackyAPI
        is_packy = _is_packy(effective_base_url)
        proxy = settings.packy_proxy if is_packy else None
        if proxy:
            log_info(f"PackyAPI 使用代理: {proxy}")

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
        adjusted_size = None  # default: no reference image means no size adjustment needed

        if not has_ref_image:
            # Pure text-to-image via /v1/images/generations
            adjusted_size = validate_text_to_image_size(size)
            url = f"{effective_base_url}/images/generations"
            body = {
                "model": model,
                "prompt": prompt,
                "n": n,
                "size": adjusted_size,
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
            timeout = 900

            data = await _httpx_post(
                url=url,
                headers=headers,
                data=body,
                timeout=timeout,
                proxy=proxy,
            )

        else:
            # Download URL references and convert to base64 (both providers need this)
            for u in all_urls:
                img_bytes = await _download_image(u)
                img = Image.open(io.BytesIO(img_bytes))
                if img.mode != "RGB":
                    img = img.convert("RGB")
                buf = io.BytesIO()
                img.save(buf, format="PNG")
                all_base64s.append(base64.b64encode(buf.getvalue()).decode())

            # First image: full preprocessing (determines output size)
            first_b64 = all_base64s[0]
            processed_bytes, actual_size, adjusted_size = preprocess_reference_image(first_b64, size)
            log_info(f"参考图[0] 预处理完成：{len(processed_bytes)} 字节，API尺寸={actual_size}，用户尺寸={adjusted_size}")

            # Image-to-image via /v1/images/edits (multipart)
            # PackyAPI uses field name "image", open-hk uses "image[]"
            url = f"{effective_base_url}/images/edits"
            log_info(f"Image-to-image: POST {url} (refs: {len(all_base64s)} base64 + {len(all_urls)} urls)")

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

            timeout = 900

            data = await _httpx_post(
                url=url,
                headers=headers,
                files=files,
                data=data,
                timeout=timeout,
                proxy=proxy,
            )
            log_info(f"编辑 API 返回：{str(data)[:500]}")

        # Parse response
        images = []
        items = data.get("data")

        if items is None:
            api_error = data.get("error", {})
            msg = api_error.get("message", "") if isinstance(api_error, dict) else str(api_error)
            log_error(f"API 返回错误: {msg}", ctx={"response": str(data)[:1000]})
            raise ValueError(msg or f"API 返回格式异常，缺少 'data' 字段: {str(data)[:500]}")

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
                try:
                    img_bytes = await _download_image(url_data)
                    b64_from_url = base64.b64encode(img_bytes).decode()
                    images.append({
                        "url": url_data,
                        "base64": b64_from_url,
                    })
                except Exception as e:
                    log_warn(f"下载图片失败({type(e).__name__}): {e}", ctx={"url": url_data})
                    images.append({
                        "url": url_data,
                        "base64": None,
                    })
            else:
                log_warn(f"返回项缺少 url 和 b64_json", ctx={"item": item})

        # Attach adjusted_size to each image so the caller knows what size was used
        for img in images:
            img["adjusted_size"] = adjusted_size

        return images

    except Exception as e:
        tb_lines = traceback.format_exc().strip().split("\n")
        tb_summary = tb_lines[-1] if tb_lines else str(e)
        log_error(f"generate_openai_image 失败：{tb_summary}")
        raise
