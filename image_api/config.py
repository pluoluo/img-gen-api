from pydantic_settings import BaseSettings
from typing import Optional
from dotenv import load_dotenv
import os, time, threading

# 确保 .env 文件在模块导入时就被加载
env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '.env')
load_dotenv(env_path)


class Settings(BaseSettings):
    # OpenAI-HK (uses hk- prefixed key from config.yaml)
    openai_api_key: Optional[str] = None
    openai_base_url: str = "https://api.openai-hk.com/v1"

    # Google Gemini (via open-hk Dall-E compatible endpoint)
    gemini_api_key: Optional[str] = None
    gemini_base_url: str = "https://generativelanguage.googleapis.com/v2"

    # MiniMax (API key needs to be set manually - not in hermes .env)
    minimax_api_key: Optional[str] = None
    minimax_base_url: str = "https://api.minimaxi.com"

    # PackyAPI (gpt-image-2 via packyapi.com)
    packy_api_key: Optional[str] = None
    packy_base_url: str = "https://api-slb.packyapi.com/v1"

    # Prompt Portal (for AI prompt optimization)
    prompt_portal_url: str = "http://127.0.0.1:8768"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()


# ── PackyAPI IP 缓存（每6小时自动刷新）─────────────────────────────────────
_packy_ip_cache = {"ip": "89.208.240.138", "timestamp": float("inf")}  # timestamp=inf 表示永不过期
_IP_REFRESH_INTERVAL = 6 * 3600  # 6小时


def _resolve_packyapi_ip_impl() -> Optional[str]:
    """ping api-slb.packyapi.com 获取 IP，若失败则 fallback 到 api.packyapi.com。"""
    import subprocess, re
    for host in ("api-slb.packyapi.com", "api.packyapi.com"):
        try:
            result = subprocess.run(
                ["ping", "-c", "1", "-W", "2", host],
                capture_output=True, text=True, timeout=4
            )
            if result.returncode == 0:
                m = re.search(r'(\d+\.\d+\.\d+\.\d+)', result.stdout)
                if m:
                    ip = m.group(1)
                    print(f"[image-api] PackyAPI ping resolved {host} -> {ip}")
                    return ip
        except Exception:
            pass
    return None


def _refresh_packyapi_ip() -> None:
    """后台线程：刷新 PackyAPI IP 缓存（永不过期时不刷新）。"""
    # timestamp=inf 表示永不过期，跳过刷新
    if _packy_ip_cache["timestamp"] == float("inf"):
        return
    ip = _resolve_packyapi_ip_impl()
    _packy_ip_cache["ip"] = ip
    _packy_ip_cache["timestamp"] = time.time()
    print(f"[image-api] PackyAPI IP 已刷新: {ip or 'None'}")


def _get_cached_packyapi_ip() -> Optional[str]:
    """返回缓存的 PackyAPI IP，未过期则直接返回，过期则后台刷新。"""
    now = time.time()
    if _packy_ip_cache["ip"] is None or (now - _packy_ip_cache["timestamp"]) > _IP_REFRESH_INTERVAL:
        _refresh_packyapi_ip()
    return _packy_ip_cache["ip"]


def get_packyapi_ip() -> Optional[str]:
    """返回 PackyAPI IP：固定为 89.208.240.138。"""
    return "89.208.240.138"


def resolve_packyapi_ip() -> Optional[str]:
    """返回固定 IP。"""
    return "89.208.240.138"