"""FastAPI entry point for FrameSeal."""

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, FastAPI, HTTPException, Query, Request, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StaticHTTPException

from app import crypto
from app.broadcaster import Broadcaster, ClientLimitReached
from app.channel import CATALOG, AttackConflict
from app.config import DATA_DIR, FRONTEND_DIST, utc_timestamp
from app.evidence import EvidenceConflict, EvidenceStore, diff_png
from app.models import (
    AttackAck, AttackInfo, AttackRequest, ChainRecord, Device, ExportResult, Incident, Session,
    StartRequest, Stats, TamperRequest, VerificationReport,
)
from app.package_verifier import InvalidPackage
from app.pipeline import Pipeline
from app.vault import FrameCopy, prune_sessions

OPENAPI_URL = "/openapi.json"
DOCS_ASSETS_URL = "/docs/assets"
router = APIRouter()
logger = logging.getLogger(__name__)


async def log_capture_metrics(pipeline: Pipeline, broadcaster: Broadcaster) -> None:
    """Log capture timings and WebSocket queue sizes every ten seconds."""
    while True:
        await asyncio.sleep(10)
        stats = await asyncio.to_thread(pipeline.stats)
        if stats.integrity != "IDLE":
            pending, clients = broadcaster.queue_sizes()
            logger.info(
                "fps_actual=%.2f avg_hash_ms=%.3f avg_sign_ms=%.3f avg_verify_ms=%.3f "
                "handoff_queue=%d client_queues=%s",
                stats.fps_actual, stats.avg_hash_ms, stats.avg_sign_ms, stats.avg_verify_ms,
                pending, clients,
            )


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Load the device identity and release any active capture on shutdown."""
    logging.basicConfig(level=logging.INFO)
    data_dir: Path = application.state.data_dir
    await asyncio.to_thread(prune_sessions, data_dir / "sessions")
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
    application.state.evidence = EvidenceStore(data_dir / "exports")
    telemetry = asyncio.create_task(log_capture_metrics(pipeline, broadcaster))
    try:
        yield
    finally:
        telemetry.cancel()
        await asyncio.gather(telemetry, return_exceptions=True)
        await asyncio.to_thread(pipeline.stop)


def create_app(data_dir: Path = DATA_DIR, *, frontend_dir: Path | None = None) -> FastAPI:
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
    if frontend_dir is not None:
        _serve_frontend(application, frontend_dir)
    return application


def _serve_frontend(application: FastAPI, directory: Path) -> None:
    """Add static serving and SPA routes after the REST and WebSocket routes."""
    if not (directory / "index.html").is_file():
        raise RuntimeError(f"Frontend build missing at {directory}. Run npm run build in frontend.")
    static = StaticFiles(directory=directory, html=True)

    @application.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def frontend(path: str, request: Request) -> Response:
        """Serve built files and fall back to index.html for client-side routes."""
        prefix = path.split("/", 1)[0]
        if prefix in {"api", "ws", "docs", "openapi.json"}:
            raise HTTPException(404, "Not Found")
        try:
            return await static.get_response(path or ".", request.scope)
        except StaticHTTPException as error:
            if error.status_code != 404 or prefix == "assets" or Path(path).suffix:
                raise
            return await static.get_response("index.html", request.scope)


def create_demo_app() -> FastAPI:
    """Create the one-port demo with the compiled frontend."""
    return create_app(frontend_dir=FRONTEND_DIST)


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


@router.post("/api/evidence/export", response_model_exclude_none=True)
def evidence_export(request: Request) -> ExportResult:
    """Package the committed camera recording without stopping capture."""
    pipeline: Pipeline = request.app.state.pipeline
    snapshot = pipeline.evidence_snapshot()
    if snapshot is None:
        raise HTTPException(409, "No recorded session to export")
    evidence: EvidenceStore = request.app.state.evidence
    return evidence.export(snapshot, pipeline.device)


@router.get("/api/evidence/download/{filename}")
def evidence_download(filename: str, request: Request) -> FileResponse:
    """Download a published evidence ZIP."""
    path = request.app.state.evidence.download(filename)
    if path is None:
        raise HTTPException(404, "Evidence package not found")
    return FileResponse(path, media_type="application/zip", filename=filename)


@router.post("/api/evidence/verify")
def evidence_verify(file: UploadFile, request: Request) -> VerificationReport:
    """Verify the uploaded archive against its packaged public key."""
    evidence: EvidenceStore = request.app.state.evidence
    try:
        return evidence.verify(file.file, file.filename)
    except InvalidPackage as error:
        raise HTTPException(400, str(error)) from error


@router.post("/api/evidence/tamper-sample")
def tamper_sample(settings: TamperRequest, request: Request) -> ExportResult:
    """Create a deliberately altered copy of the latest export."""
    evidence: EvidenceStore = request.app.state.evidence
    try:
        return evidence.tamper_sample(settings.mode)
    except EvidenceConflict as error:
        raise HTTPException(409, str(error)) from error


@router.get("/api/reports/{report_id}")
def report(report_id: str, request: Request) -> VerificationReport:
    """Look up a verification report retained by the server."""
    evidence: EvidenceStore = request.app.state.evidence
    result = evidence.report(report_id)
    if result is None:
        raise HTTPException(404, "Verification report not found")
    return result


@router.get("/api/frames/{seq}/diff.png")
def diff_frame(seq: int, request: Request) -> Response:
    """Return the PNG overlay comparing the original and received JPEGs."""
    pipeline: Pipeline = request.app.state.pipeline
    paths = pipeline.frame_pair(seq)
    if paths is None:
        raise HTTPException(404, "Original or received frame not found")
    try:
        return Response(diff_png(*paths), media_type="image/png")
    except FileNotFoundError as error:
        raise HTTPException(404, "Original or received frame not found") from error
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


async def _wait_for_disconnect(websocket: WebSocket) -> None:
    """Wait for the peer to disconnect without expecting client messages."""
    while (await websocket.receive())["type"] != "websocket.disconnect":
        pass


@router.websocket("/ws/live")
async def live(websocket: WebSocket) -> None:
    """Send the current state, then stream live messages to this client."""
    broadcaster: Broadcaster = websocket.app.state.broadcaster
    pipeline: Pipeline = websocket.app.state.pipeline
    try:
        queue = broadcaster.register()
    except ClientLimitReached:
        await websocket.close(code=1013)
        return
    tasks: list[asyncio.Task[None]] = []
    try:
        await websocket.accept()
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
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    finally:
        broadcaster.unregister(queue)
        for task in tasks:
            task.cancel()
        if tasks:
            with suppress(asyncio.CancelledError):
                await asyncio.gather(*tasks, return_exceptions=True)


app = create_app()
