"""File transport for infinite's existing WebDAV synchronization client.

This is a single-user, same-origin store, matching the existing image-api service.
It deliberately supports only the methods used by the bundled synchronization UI.
"""
import os
import mimetypes
from pathlib import Path
import tempfile
from xml.etree.ElementTree import Element, SubElement, tostring

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse

router = APIRouter(prefix="/infinite/storage", tags=["Infinite storage"])


def storage_root():
    root = Path(os.environ.get("INFINITE_DATA_DIR", Path(__file__).resolve().parents[2] / "data" / "infinite"))
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def resolve_path(path):
    root = storage_root()
    parts = path.split("/")
    if any(part in (".", "..") or "\\" in part or "\x00" in part for part in parts):
        raise HTTPException(422, "存储路径不正确")
    target = root.joinpath(*parts).resolve()
    if not target.is_relative_to(root):
        raise HTTPException(422, "存储路径超出工作区")
    return target


@router.api_route("", methods=["PROPFIND", "OPTIONS"])
@router.api_route("/{path:path}", methods=["GET", "PUT", "MKCOL", "PROPFIND", "OPTIONS"])
async def storage(request: Request, path: str = ""):
    target = resolve_path(path)
    if request.method == "OPTIONS":
        return Response(headers={"Allow": "GET, PUT, MKCOL, PROPFIND, OPTIONS", "DAV": "1"})
    if request.method == "MKCOL":
        if target.exists():
            return Response(status_code=405)
        if not target.parent.is_dir():
            raise HTTPException(409, "父目录不存在")
        target.mkdir(exist_ok=True)
        return Response(status_code=201)
    if request.method == "PROPFIND":
        if not target.exists():
            raise HTTPException(404, "存储路径不存在")
        tree = Element("{DAV:}multistatus")
        item = SubElement(tree, "{DAV:}response")
        SubElement(item, "{DAV:}href").text = request.url.path
        propstat = SubElement(item, "{DAV:}propstat")
        resource = SubElement(SubElement(propstat, "{DAV:}prop"), "{DAV:}resourcetype")
        if target.is_dir():
            SubElement(resource, "{DAV:}collection")
        SubElement(propstat, "{DAV:}status").text = "HTTP/1.1 200 OK"
        return Response(tostring(tree, encoding="utf-8", xml_declaration=True), status_code=207, media_type="application/xml")
    if request.method == "GET":
        if not target.is_file():
            raise HTTPException(404, "存储文件不存在")
        media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        return FileResponse(target, media_type=media_type, filename=target.name, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    if not target.parent.is_dir() or target.is_dir():
        raise HTTPException(409, "上传目标或父目录不正确")
    existed = target.exists()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".upload-", delete=False) as file:
            temporary = Path(file.name)
            async for chunk in request.stream():
                file.write(chunk)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return Response(status_code=204 if existed else 201)
