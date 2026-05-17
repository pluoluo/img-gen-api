import httpx
import base64
import io
from typing import Optional, List
from PIL import Image

from image_api.config import settings, get_packyapi_ip
from image_api.services.log_helper import log_info, log_warn, log_error


# ── PackyAPI curl-based request helper ──────────────────────────────────────

def _is_packy(base_url: str) -> bool:
    """Check if base_url belongs to PackyAPI."""
    return "packyapi.com" in (base_url or "")


async def _packy_curl_request(
    url: str,
    api_key: str,
    body: dict,
    files: dict = None,
    timeout: int = 1200,
) -> dict:
    """
    Issue HTTP request to PackyAPI using curl with --resolve to bypass CDN DNS timeout.
    Uses the resolved IP from ping instead of going through Cloudflare CDN.
    """
    import asyncio, json, subprocess, tempfile, os, shlex

    ip = get_packyapi_ip()
    if not ip:
        raise RuntimeError("PackyAPI IP 未找到，无法绕过 CDN")

    # Extract host:port from URL for --resolve
    # e.g. "https://api.packyapi.com/v1/images/generations"
    #        → host=api.packyapi.com, port=443
    from urllib.parse import urlparse
    parsed = urlparse(url)
    host = parsed.netloc
    port = parsed.port or 443

    headers = f"-H 'Authorization: Bearer {api_key}'"
    if files:
        # multipart: use -F for each field, -F for file
        form_parts = []
        file_field_name = list(files.keys())[0]
        fname, fcontent, ftype = files[file_field_name]
        # Write file content to a temp file for curl -F @path
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
        tmp.write(fcontent)
        tmp.close()
        form_parts.append(f"-F '{file_field_name}=@{tmp.path};type={ftype}'")
        for k, v in body.items():
            form_parts.append(f"-F '{k}={v}'")
        curl_cmd = (
            f"curl -s -X POST "
            f"--resolve '{host}:{port}:{ip}' "
            f"-k "  # -k: skip TLS verification against IP (cert is for hostname)
            f"{' '.join(form_parts)} "
            f"https://{host}{parsed.path}"
        )
    else:
        # JSON body
        body_json = json.dumps(body).replace("'", "'\\''")
        curl_cmd = (
            f"curl -s -X POST "
            f"--resolve '{host}:{port}:{ip}' "
            f"-k "
            f"-H 'Content-Type: application/json' "
f"-H 'Host: {host}' "
            f"-H 'Authorization: Bearer {api_key}' "
            f"-d '{body_json}' "
            f"https://{host}{parsed.path}"
        )

    log_info(f"PackyAPI curl请求: {curl_cmd[:120]}...")

    proc = await asyncio.create_subprocess_shell(
        curl_cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise TimeoutError(f"PackyAPI curl 请求超时 ({timeout}s)")

    if proc.returncode != 0:
        raise RuntimeError(f"PackyAPI curl 失败，退出码 {proc.returncode}: {stderr.decode()[:300]}")

    text = stdout.decode()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError(f"PackyAPI 返回非 JSON: {text[:300]}")


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


async def generate_openai_image(
    prompt: str,
    model: str = "gpt-image-2",
    image_url: Optional[str] = None,
    image_base64: Optional[str] = None,
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

        has_ref_image = bool(image_url or image_base64)

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
                "has_ref": bool(image_url or image_base64),
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

            # PackyAPI: use curl --resolve to bypass CDN DNS timeout
            if _is_packy(effective_base_url):
                data = await _packy_curl_request(
                    url=url,
                    api_key=effective_api_key,
                    body=body,
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
            log_info(f"Image-to-image: POST {url}")

            # Prepare reference image bytes
            if image_base64:
                processed_bytes, actual_size = preprocess_reference_image(image_base64, size)
            elif image_url:
                # Download and preprocess
                async with httpx.AsyncClient() as client:
                    img_resp = await client.get(image_url, timeout=60)
                    img_resp.raise_for_status()
                    img = Image.open(io.BytesIO(img_resp.content))
                    if img.mode != "RGB":
                        img = img.convert("RGB")
                    # Convert to base64 and preprocess (same logic as image_base64)
                    buf = io.BytesIO()
                    img.save(buf, format="PNG")
                    img_base64 = base64.b64encode(buf.getvalue()).decode()
                    processed_bytes, actual_size = preprocess_reference_image(img_base64, size)

            log_info(f"参考图处理完成：{len(processed_bytes)} 字节，尺寸 {actual_size}")

            # multipart/form-data
            files = {
                "image": ("reference.png", processed_bytes, "image/png")
            }
            data = {
                "model": model,
                "prompt": prompt,
                "n": n,
                "size": actual_size,
            }
            if quality:
                data["quality"] = quality

            log_info(f"提交编辑请求：POST {url}", ctx={"quality": quality, "size": actual_size})

            long_edge = max(int(s) for s in (actual_size or size).split("x"))
            if long_edge >= 2048:
                timeout = 1200  # 2K/4K（支持中转排队）
            else:
                timeout = 600   # 1K

            # PackyAPI: use curl --resolve to bypass CDN DNS timeout
            if _is_packy(effective_base_url):
                data = await _packy_curl_request(
                    url=url,
                    api_key=effective_api_key,
                    body=data,
                    files=files,
                    timeout=timeout,
                )
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
        if not items:
            log_error(f"API 响应缺少 'data' 字段", ctx={"response_preview": str(data)[:300]})
            return []

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
