"""Image generation API - FastAPI application entry point."""
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
import os

from image_api.api import router as api_router
from image_api.config import settings

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


@app.get("/", response_class=HTMLResponse)
def root():
    html_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        return f.read()


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
    fpath = f"/vol1/1000/note/memory/AI生成图片/{filename}"
    if not os.path.exists(fpath):
        raise HTTPException(status_code=404, detail="Not found")
    return FileResponse(fpath, media_type="image/png", headers={"Cache-Control": "public, max-age=604800, immutable"})


@app.get("/gallery/thumb/{filename}")
def serve_gallery_thumb(filename: str):
    from starlette.responses import FileResponse
    fpath = f"/vol1/1000/note/memory/AI生成图片/thumbs/{filename}"
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
