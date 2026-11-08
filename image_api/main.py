"""Image generation API - FastAPI application entry point."""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, RedirectResponse
import os
import json
from starlette.exceptions import HTTPException as StarletteHTTPException

from image_api.api import router as api_router
from image_api.config import settings
from image_api.api.prompt_library import router as prompt_library_router
from image_api.api.canvas import router as canvas_router
from image_api.api.infinite import router as infinite_router
from image_api.api.infinite_storage import router as infinite_storage_router
from image_api.api.infinite_provider import router as infinite_provider_router

app = FastAPI(
    title="Image Generation API",
    description="Unified API for multiple image generation services",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api/v1")
app.include_router(canvas_router, prefix="/api/v1")
app.include_router(prompt_library_router, prefix="/api/v1")
app.include_router(infinite_router, prefix="/api/v1")
app.include_router(infinite_storage_router, prefix="/api/v1")
app.include_router(infinite_provider_router, prefix="/api/v1")

# Build once with `cd canvas && npm ci && npm run build`; no Node production process.
_FRONTEND = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
_INFINITE_FRONTEND = os.environ.get("INFINITE_FRONTEND_DIR", os.path.join(_FRONTEND, "infinite"))


@app.get("/infinite", include_in_schema=False)
def infinite_redirect():
    return RedirectResponse("/infinite/")


class InfiniteStaticFiles(StaticFiles):
    """History fallback only for frontend navigation, never missing assets."""

    async def get_response(self, path, scope):
        try:
            response = await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code != 404 or "." in os.path.basename(path):
                raise
            response = await super().get_response("index.html", scope)
        if response.headers.get("content-type", "").startswith("text/html") or not os.path.splitext(os.path.basename(path))[1] or path.endswith(".html") or os.path.basename(path) in ("build-info.json", "config.js"):
            response.headers["Cache-Control"] = "no-store"
        return response


app.mount("/infinite", InfiniteStaticFiles(directory=_INFINITE_FRONTEND, html=True, check_dir=False), name="infinite")

@app.get("/canvas", include_in_schema=False)
def canvas_redirect():
    return RedirectResponse("/canvas/")


@app.get("/canvas/", include_in_schema=False)
def canvas_page():
    index = os.path.join(_FRONTEND, "canvas", "index.html")
    if not os.path.isfile(index):
        return HTMLResponse("<html lang='zh-CN'><meta charset='utf-8'><p>画布资源尚未构建。请在仓库中执行：cd canvas &amp;&amp; npm ci &amp;&amp; npm run build，然后刷新。</p></html>", status_code=503)
    return FileResponse(index)


app.mount("/workspace-assets", StaticFiles(directory=_FRONTEND), name="workspace-assets")
app.mount("/canvas", StaticFiles(directory=os.path.join(_FRONTEND, "canvas"), html=True, check_dir=False), name="canvas")


@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse("/infinite/canvas", headers={"Cache-Control": "no-store"})


@app.get("/legacy", response_class=HTMLResponse)
def legacy_page():
    html_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html = f.read()
    with open(os.path.join(_FRONTEND, "model-config.json"), encoding="utf-8") as config:
        html = html.replace("__MODEL_CONFIG_JSON__", json.dumps(json.load(config), ensure_ascii=False))
    try:
        with open(os.path.join(_INFINITE_FRONTEND, "build-info.json"), encoding="utf-8") as info:
            revision = json.load(info)["revision"]
    except (OSError, ValueError, KeyError):
        revision = "development"
    html = html.replace("__INFINITE_REVISION__", revision)
    # Inject prompt_portal_url from config so frontend doesn't need a hardcoded port
    html = html.replace(
        '<script>',
        f'<script>\nwindow.__INFINITE_REVISION__ = {json.dumps(revision)};\nwindow.__PROMPT_PORTAL_URL__ = "{settings.prompt_portal_url}";'
    )
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})


@app.get("/gallery", response_class=HTMLResponse)
def gallery_page():
    html_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "gallery.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()


@app.get("/logs", response_class=HTMLResponse)
def logs_page():
    html_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "logs.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()


@app.get("/gallery/{filename}")
def serve_gallery_image(filename: str):
    from starlette.responses import FileResponse
    import os.path
    from image_api.services.gallery import GALLERY_DIR
    fpath = GALLERY_DIR / filename
    if not os.path.exists(fpath):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(fpath, media_type="image/png", headers={"Cache-Control": "public, max-age=604800, immutable"})


@app.get("/gallery/thumb/{filename}")
def serve_gallery_thumb(filename: str):
    from starlette.responses import FileResponse
    from image_api.services.gallery import THUMB_DIR
    fpath = THUMB_DIR / filename
    if not os.path.exists(fpath):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(fpath, media_type="image/png", headers={"Cache-Control": "public, max-age=604800, immutable"})


@app.get("/favicon.svg")
def favicon():
    fpath = os.path.join(os.path.dirname(__file__), "..", "frontend", "favicon.svg")
    return FileResponse(fpath, media_type="image/svg+xml")


@app.get("/health")
def health_check():
    return {"status": "healthy"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("image_api.main:app", host="0.0.0.0", port=8000, reload=True)
