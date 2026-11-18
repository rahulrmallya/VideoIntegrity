"""FastAPI entry point for FrameSeal."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import crypto
from app.broadcaster import Broadcaster
from app.channel import CATALOG, AttackConflict
from app.config import DATA_DIR, utc_timestamp
from app.models import AttackAck, AttackInfo, AttackRequest, ChainRecord, Device, Incident, Session, StartRequest, Stats
from app.pipeline import Pipeline
from app.vault import FrameCopy

OPENAPI_URL = "/openapi.json"
DOCS_ASSETS_URL = "/docs/assets"
router = APIRouter()

@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Load the device identity and release any active capture on shutdown."""
    data_dir: Path = application.state.data_dir
    key_path = data_dir / "keys" / "device_ed25519.pem"
    sk, pk_raw = crypto.load_or_create_device_key(key_path)
    device = Device(
        device_id=crypto.device_id(pk_raw),
        public_key_hex=pk_raw.hex(),
        algorithm="Ed25519",
        created_at=utc_timestamp(key_path.stat().st_mtime),
    )
    broadcaster = Broadcaster()
    pipeline = Pipeline(asyncio.get_running_loop(), broadcaster, data_dir, device, sk, pk_raw)
    application.state.broadcaster = broadcaster
    application.state.pipeline = pipeline
    try:
        yield
    finally:
        await asyncio.to_thread(pipeline.stop)


def create_app(data_dir: Path = DATA_DIR) -> FastAPI:
    """Create the backend with a configurable local data directory."""
    application = FastAPI(
        title="FrameSeal",
        version="1.0",
        openapi_url=OPENAPI_URL,
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )
    application.state.data_dir = data_dir
    application.mount(
        DOCS_ASSETS_URL,
        StaticFiles(directory=Path(__file__).with_name("swagger_ui")),
        name="swagger-ui-assets",
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.add_exception_handler(RequestValidationError, validation_error)
    application.include_router(router)
    return application


async def validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
    """Return a human-readable validation error using the contract shape."""
    issue = error.errors()[0]
    field = ".".join(str(part) for part in issue["loc"])
    return JSONResponse(status_code=422, content={"detail": f"{field}: {issue['msg']}"})


@router.get("/docs", include_in_schema=False)
def docs(request: Request) -> HTMLResponse:
    """Serve Swagger UI using only local assets."""
    return get_swagger_ui_html(
        openapi_url=OPENAPI_URL,
        title=f"{request.app.title} - Swagger UI",
        swagger_js_url=f"{DOCS_ASSETS_URL}/swagger-ui-bundle.js",
        swagger_css_url=f"{DOCS_ASSETS_URL}/swagger-ui.css",
        swagger_favicon_url=f"{DOCS_ASSETS_URL}/favicon-32x32.png",
        swagger_ui_parameters={"validatorUrl": None},
    )


@router.get("/api/health")
def health() -> dict[str, str]:
    """Return the backend health and contract version."""
    return {"status": "ok", "version": "1.0"}


@router.get("/api/device")
def device(request: Request) -> Device:
    """Return the persistent signing device's public identity."""
    return request.app.state.pipeline.device


@router.get("/api/session")
def session(request: Request) -> Session:
    """Return the current session, including its seal once stopped."""
    return request.app.state.pipeline.session()


@router.post("/api/session/start")
def start_session(settings: StartRequest, request: Request) -> Session:
    """Start a new capture session using the resolved source."""
    try:
        return request.app.state.pipeline.start(settings)
    except RuntimeError as error:
        raise HTTPException(500, str(error)) from error


@router.post("/api/session/stop")
def stop_session(request: Request) -> Session:
    """Stop capture and return the signed session state."""
    try:
        return request.app.state.pipeline.stop()
    except RuntimeError as error:
        raise HTTPException(500, str(error)) from error


@router.get("/api/stats")
def stats(request: Request) -> Stats:
    """Return the live stream's current statistics."""
    return request.app.state.pipeline.stats()


@router.get("/api/attacks/catalog")
def attack_catalog() -> tuple[AttackInfo, ...]:
    """Return the demonstration attack catalog."""
    return CATALOG


@router.post("/api/attacks")
def start_attack(settings: AttackRequest, request: Request) -> AttackAck:
    """Acknowledge a demo attack on the running session."""
    try:
        return request.app.state.pipeline.start_attack(settings)
    except AttackConflict as error:
        raise HTTPException(409, str(error)) from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get("/api/incidents")
def incidents(request: Request) -> list[Incident]:
    """Return recent incidents, newest first."""
    return request.app.state.pipeline.incidents()


@router.post("/api/incidents/{id}/ack")
def acknowledge_incident(id: str, request: Request) -> Incident:
    """Acknowledge an incident by ID."""
    incident = request.app.state.pipeline.acknowledge(id)
    if incident is None:
        raise HTTPException(404, "Incident not found")
    return incident


@router.get("/api/chain")
def chain(request: Request, limit: Annotated[int, Query(ge=0)] = 50) -> list[ChainRecord]:
    """Return recent chain records, newest first."""
    return request.app.state.pipeline.chain(limit)


def _frame(request: Request, seq: int, copy: FrameCopy) -> FileResponse:
    """Return a stored frame or a contract-shaped 404."""
    path = request.app.state.pipeline.frame_path(seq, copy)
    if path is None:
        raise HTTPException(404, "Frame not found")
    return FileResponse(path, media_type="image/jpeg")


@router.get("/api/frames/{seq}/original.jpg")
def original_frame(seq: int, request: Request) -> FileResponse:
    """Return the exact JPEG saved by the camera producer."""
    return _frame(request, seq, "original")


@router.get("/api/frames/{seq}/received.jpg")
def received_frame(seq: int, request: Request) -> FileResponse:
    """Return the JPEG saved for a tampered delivery."""
    return _frame(request, seq, "received")


@router.post("/api/evidence/export", status_code=501)
@router.post("/api/evidence/verify", status_code=501)
@router.post("/api/evidence/tamper-sample", status_code=501)
def deferred_post() -> None:
    """Return 501 for features deferred beyond live capture."""
    raise HTTPException(501, "This endpoint is not implemented yet")


@router.get("/api/evidence/download/{filename}", status_code=501)
def evidence_download(filename: str) -> None:
    """Return 501 for evidence downloads."""
    raise HTTPException(501, "This endpoint is not implemented yet")


@router.get("/api/reports/{report_id}", status_code=501)
def report(report_id: str) -> None:
    """Return 501 for verification reports."""
    raise HTTPException(501, "This endpoint is not implemented yet")


@router.get("/api/frames/{seq}/diff.png", status_code=501)
def diff_frame(seq: int) -> None:
    """Return 501 for frame difference images."""
    raise HTTPException(501, "This endpoint is not implemented yet")


async def _wait_for_disconnect(websocket: WebSocket) -> None:
    """Wait for the peer to disconnect without expecting client messages."""
    while (await websocket.receive())["type"] != "websocket.disconnect":
        pass


@router.websocket("/ws/live")
async def live(websocket: WebSocket) -> None:
    """Send the current state, then stream live messages to this client."""
    await websocket.accept()
    broadcaster: Broadcaster = websocket.app.state.broadcaster
    pipeline: Pipeline = websocket.app.state.pipeline
    queue = broadcaster.register()
    tasks: list[asyncio.Task[None]] = []
    try:
        await websocket.send_json({
            "type": "hello",
            "session": pipeline.session().model_dump(mode="json"),
            "device": pipeline.device.model_dump(mode="json"),
            "catalog": [attack.model_dump(mode="json") for attack in CATALOG],
        })
        tasks = [
            asyncio.create_task(broadcaster.send(websocket, queue)),
            asyncio.create_task(_wait_for_disconnect(websocket)),
        ]
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        broadcaster.unregister(queue)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


app = create_app()
