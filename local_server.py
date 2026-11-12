"""Run travel-admin and its folder-based workflow on the local PC."""

import ctypes
from datetime import datetime, timezone
from getpass import getpass
from hmac import compare_digest
from io import BytesIO
import logging
import os
from pathlib import Path
import re
from secrets import token_urlsafe
from shutil import copyfileobj
import subprocess
import sys
from tempfile import TemporaryDirectory
from uuid import uuid4

ROOT = Path(__file__).resolve().parent

if __name__ == "__main__":
    venv_python = ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if venv_python.is_file() and Path(sys.prefix).resolve() != (ROOT / ".venv").resolve():
        try:
            raise SystemExit(subprocess.call([str(venv_python), str(Path(__file__).resolve()), *sys.argv[1:]]))
        except KeyboardInterrupt:
            raise SystemExit(130) from None

from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, SecretStr
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.middleware.trustedhost import TrustedHostMiddleware
import uvicorn

from workflow_test import TRIP_COLUMNS, parse_result, run_workflow, save_excel, trip_rows


ADDRESS = "http://127.0.0.1:8000"
COOKIE = "travel_admin_session"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_FILES = 50
MAX_FILE_BYTES = 25 * 1024 * 1024


class Login(BaseModel):
    password: SecretStr


class Folder(BaseModel):
    path: str


class SelectedFile(BaseModel):
    batch_id: str
    file_index: int = Field(ge=0)


class ExcelSelection(BaseModel):
    files: list[SelectedFile] = Field(min_length=1)


def desktop_path():
    if os.name == "nt":
        buffer = ctypes.create_unicode_buffer(260)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 0x10, None, 0, buffer) == 0:
            return Path(buffer.value)
    return Path.home() / "Desktop"


def list_pdfs(folder):
    files = []
    try:
        for path in sorted(folder.iterdir(), key=lambda item: item.name.casefold()):
            if path.suffix.lower() != ".pdf" or path.is_symlink() or not path.is_file():
                continue
            size = path.stat().st_size
            with path.open("rb") as stream:
                valid = b"%PDF-" in stream.read(1024)
            if not valid or size > MAX_FILE_BYTES:
                raise HTTPException(422, f"{path.name}의 PDF 형식 또는 25 MiB 크기 제한을 확인하세요.")
            files.append((path, size))
            if len(files) > MAX_FILES:
                raise HTTPException(422, "폴더에는 PDF를 최대 50개까지 넣을 수 있습니다.")
    except OSError:
        raise HTTPException(422, "폴더 또는 PDF를 읽을 수 없습니다.") from None
    return files


def metadata(files):
    return [{"name": path.name, "size": size} for path, size in files]


def stage_uploads(uploads, directory):
    if not uploads:
        raise HTTPException(422, "검증할 PDF 파일을 등록하세요.")
    files = []
    for index, upload in enumerate(uploads):
        if not isinstance(upload, UploadFile) or not upload.filename:
            raise HTTPException(422, "PDF 파일만 등록할 수 있습니다.")
        name = re.split(r"[/\\]", upload.filename)[-1]
        path = directory / str(index) / name
        if path.suffix.lower() != ".pdf" or path.is_reserved() or re.search(r'[<>:"|?*\x00-\x1f]', name):
            raise HTTPException(422, "PDF 파일 이름을 확인하세요.")
        size = upload.size
        if not size or size > MAX_FILE_BYTES or b"%PDF-" not in upload.file.read(1024):
            raise HTTPException(422, f"{name}의 PDF 형식 또는 25 MiB 크기 제한을 확인하세요.")
        path.parent.mkdir()
        upload.file.seek(0)
        with path.open("wb") as destination:
            copyfileobj(upload.file, destination)
        files.append((path, size))
    return files


def workbook_bytes(records):
    output = BytesIO()
    save_excel(records, output)
    return output.getvalue()


def excel_response(content, filename):
    return Response(
        content, media_type=XLSX,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def process_batch(batch, files, api_key, exports):
    batch["status"] = "processing"
    records, rows, issues = [], [], []
    try:
        for path, _ in files:
            record = {"file": path.name}
            try:
                record["result"] = parse_result(run_workflow(api_key, path))
            except Exception as error:
                message = str(error).replace(api_key, "[REDACTED]")
                logging.getLogger(__name__).warning("Upstage 처리 실패: %s", message)
                record["error"] = "Upstage 처리에 실패했습니다. 서버 터미널에서 원인을 확인하세요."
                issues.append({"field": path.name, "message": record["error"]})
            else:
                file_rows, reviews = trip_rows(record["result"])
                rows.extend(dict(zip(TRIP_COLUMNS, values)) for _, *values in file_rows)
                issues.extend({"field": path.name, "message": reason} for _, reason in reviews)
                if any(isinstance(values[TRIP_COLUMNS.index("금액")], str) for _, *values in file_rows) and not reviews:
                    issues.append({"field": path.name, "message": "엑셀의 금액 정밀도 범위를 초과했습니다."})
            records.append(record)

        exports[batch["id"]] = (workbook_bytes(records), records)
        batch.update(
            status="completed",
            excel_available=True,
            result={
                "decision": "검토 필요" if issues else "정산 완료",
                "reason": f"PDF {len(records)}건 처리 · 확인사항 {len(issues)}건",
                "confirmed_settlement_total": None if issues else sum(row["금액"] for row in rows),
                "settlement_rows": rows,
                "issues": issues,
            },
        )
    except Exception:
        logging.getLogger(__name__).error("엑셀 생성 실패 (처리번호 %s)", batch["id"])
        batch["status"] = "error"


def create_app(password, api_key, desktop=None):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1"])
    desktop = (desktop if desktop is not None else desktop_path()).resolve()
    sessions, batches, exports = {}, {}, {}
    active_batch = None
    receiving_upload = False

    @app.middleware("http")
    async def local_requests(request, call_next):
        if request.method not in {"GET", "HEAD"} and request.headers.get("origin") != ADDRESS:
            return Response(status_code=403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    def session(request):
        token = request.cookies.get(COOKIE)
        if token not in sessions:
            raise HTTPException(401, "로컬 로그인이 필요합니다.")
        return sessions[token]

    def resolve_folder(relative):
        try:
            path = (desktop / relative).resolve(strict=True)
            if path.is_relative_to(desktop) and path.is_dir():
                return path
        except (OSError, RuntimeError, ValueError):
            pass
        raise HTTPException(422, "바탕화면에서 접근할 수 있는 폴더를 선택하세요.")

    def folder_data(path):
        relative = path.relative_to(desktop)
        return {"path": relative.as_posix(), "display_path": str(path)}

    @app.post("/api/auth/login")
    async def login(body: Login, response: Response):
        if not compare_digest(body.password.get_secret_value().encode(), password.encode()):
            raise HTTPException(401, "로컬 접속 비밀번호가 올바르지 않습니다.")
        token = token_urlsafe(32)
        sessions[token] = {"folder": None}
        response.set_cookie(COOKIE, token, httponly=True, samesite="strict")
        return {"authenticated": True}

    @app.post("/api/auth/logout", status_code=204)
    async def logout(request: Request):
        sessions.pop(request.cookies.get(COOKIE), None)
        response = Response(status_code=204)
        response.delete_cookie(COOKIE)
        return response

    @app.get("/api/settings/pdf-folder")
    async def get_folder(request: Request):
        current = session(request)["folder"]
        return {"folder": current, "upstage_configured": bool(api_key)}

    @app.get("/api/settings/pdf-folders")
    async def browse_folders(request: Request, path: str = "."):
        session(request)
        folder = resolve_folder(path)
        children = []
        try:
            for item in sorted(folder.iterdir(), key=lambda entry: entry.name.casefold()):
                if item.is_dir() and item.resolve().is_relative_to(desktop):
                    children.append({**folder_data(item), "name": item.name})
        except OSError:
            raise HTTPException(422, "선택한 폴더를 열 수 없습니다.") from None
        return {
            **folder_data(folder),
            "parent": folder_data(folder.parent)["path"] if folder != desktop else None,
            "children": children,
        }

    @app.put("/api/settings/pdf-folder")
    async def set_folder(body: Folder, request: Request):
        current = session(request)
        folder = resolve_folder(body.path)
        saved = {**folder_data(folder), "files": metadata(list_pdfs(folder))}
        current["folder"] = saved
        return saved

    @app.post("/api/verification/batches", status_code=202)
    async def create_batch(request: Request, tasks: BackgroundTasks):
        nonlocal active_batch, receiving_upload
        current = session(request)
        if not api_key:
            raise HTTPException(503, "Upstage API 키를 설정한 뒤 서버를 다시 실행하세요.")
        if receiving_upload or (active_batch and active_batch["status"] in {"queued", "processing"}):
            raise HTTPException(409, "이미 처리 중인 작업이 있습니다.")
        staging = None
        media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if media_type == "multipart/form-data":
            staging = TemporaryDirectory(prefix="travel-admin-")
            receiving_upload = True
            try:
                async with request.form(max_files=MAX_FILES, max_fields=0) as form:
                    files = await run_in_threadpool(stage_uploads, form.getlist("files"), Path(staging.name))
            except BaseException:
                staging.cleanup()
                raise
            finally:
                receiving_upload = False
        else:
            if not current["folder"]:
                raise HTTPException(422, "먼저 PDF 폴더를 선택하세요.")
            files = list_pdfs(resolve_folder(current["folder"]["path"]))
            if not files:
                raise HTTPException(422, "선택한 폴더에 PDF가 없습니다.")
        batch = {
            "id": uuid4().hex, "created_at": datetime.now(timezone.utc).isoformat(),
            "file_count": len(files), "files": metadata(files), "status": "queued",
            "excel_available": False,
        }
        batches[batch["id"]] = (current, batch)
        active_batch = batch
        tasks.add_task(process_batch, batch, files, api_key, exports)
        if staging is not None:
            tasks.add_task(staging.cleanup)
        return dict(batch)

    def find_batch(request, batch_id):
        current = session(request)
        entry = batches.get(batch_id)
        if not entry or entry[0] is not current:
            raise HTTPException(404, "처리내역을 찾을 수 없습니다.")
        return entry[1]

    @app.get("/api/verification/batches")
    async def list_batches(request: Request):
        current = session(request)
        return [dict(batch) for owner, batch in reversed(batches.values()) if owner is current]

    @app.post("/api/verification/selected-excel")
    async def selected_excel(body: ExcelSelection, request: Request):
        session(request)
        selected = []
        seen = set()
        for item in body.files:
            batch = find_batch(request, item.batch_id)
            if not batch["excel_available"]:
                raise HTTPException(409, "완료된 PDF 결과만 내려받을 수 있습니다.")
            _, records = exports[item.batch_id]
            if item.file_index >= len(records):
                raise HTTPException(422, "선택한 PDF가 처리내역에 없습니다.")
            key = (item.batch_id, item.file_index)
            if key not in seen:
                selected.append(records[item.file_index])
                seen.add(key)
        return excel_response(await run_in_threadpool(workbook_bytes, selected), "travel-selected.xlsx")

    @app.get("/api/verification/batches/{batch_id}")
    async def get_batch(request: Request, batch_id: str):
        return dict(find_batch(request, batch_id))

    @app.get("/api/verification/batches/{batch_id}/excel")
    async def excel(request: Request, batch_id: str):
        batch = find_batch(request, batch_id)
        if not batch["excel_available"]:
            raise HTTPException(404, "엑셀이 아직 준비되지 않았습니다.")
        workbook, _ = exports[batch_id]
        return excel_response(workbook, f"travel-{batch_id[:8]}.xlsx")

    @app.get("/js/config.js")
    async def local_config():
        source = (ROOT / "js/config.js").read_text(encoding="utf-8")
        return Response(
            source + "\nObject.assign(window.TravelConfig, { mode: 'api', localWorkflow: true });\n",
            media_type="text/javascript",
        )

    @app.get("/")
    async def index():
        return FileResponse(ROOT / "index.html")

    app.mount("/js", StaticFiles(directory=ROOT / "js"), name="js")
    app.mount("/css", StaticFiles(directory=ROOT / "css"), name="css")
    return app


if __name__ == "__main__":
    local_password = os.environ.get("TRAVEL_ADMIN_PASSWORD") or token_urlsafe(12)
    key = os.environ.get("UPSTAGE_API_KEY", "").strip()
    if not key and os.isatty(0):
        key = getpass("Upstage API key (press Enter to configure later): ").strip()
    print(f"Travel Admin: {ADDRESS}\nLocal login password: {local_password}", flush=True)
    uvicorn.run(create_app(local_password, key), host="127.0.0.1", port=8000)
