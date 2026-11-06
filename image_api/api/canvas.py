from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from image_api.services import canvas_projects as store

router = APIRouter(prefix="/canvas", tags=["Canvas projects"])


class SaveProject(BaseModel):
    title: str = Field(default="未命名画布", min_length=1, max_length=120)
    snapshot: dict
    base_revision: int = Field(default=0, ge=0)


@router.post("/assets")
async def upload_asset(file: UploadFile = File(...)):
    raw = await file.read(40 * 1024 * 1024 + 1)
    try:
        return store.save_asset(raw)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/assets/{digest}")
def read_asset(digest: str):
    try:
        return FileResponse(store.asset_path(digest), media_type="image/png", headers={"Cache-Control": "public, max-age=31536000, immutable"})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.put("/projects/{project_id}")
def save_project(project_id: str, body: SaveProject):
    try:
        return store.save_project(project_id, body.title, body.snapshot, body.base_revision)
    except store.ProjectConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/projects")
def list_projects(limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    return store.list_projects(limit, offset)


@router.get("/projects/{project_id}")
def read_project(project_id: str, revision: int | None = Query(None, ge=1)):
    try:
        return store.get_project(project_id, revision)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/projects/{project_id}/revisions")
def list_revisions(project_id: str, limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0)):
    try:
        return store.list_revisions(project_id, limit, offset)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
