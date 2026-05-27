from pydantic_settings import BaseSettings
from typing import Optional
from dotenv import load_dotenv
import os

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
    packy_base_url: str = "https://www.packyapi.com/v1"

    # Prompt Portal (for AI prompt optimization)
    prompt_portal_url: str = "http://127.0.0.1:8768"

    # Server
    host: str = "0.0.0.0"
    port: int = 8000

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

