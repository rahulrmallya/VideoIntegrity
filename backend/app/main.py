"""FastAPI entry point for FrameSeal."""

from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from app.models import Device, Session, StartRequest

OPENAPI_URL = "/openapi.json"
DOCS_ASSETS_URL = "/docs/assets"

app = FastAPI(
    title="FrameSeal",
    version="1.0",
    openapi_url=OPENAPI_URL,
    docs_url=None,
    redoc_url=None,
)
app.mount(
    DOCS_ASSETS_URL,
    StaticFiles(directory=Path(__file__).with_name("swagger_ui")),
    name="swagger-ui-assets",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PLACEHOLDER_DEVICE = Device(
    device_id="0" * 16,
    public_key_hex="0" * 64,
    algorithm="Ed25519",
    created_at="1970-01-01T00:00:00Z",
)
CAPTURE_DEFAULTS = StartRequest(source="webcam")
IDLE_SESSION = Session(
    session_id=None,
    status="idle",
    source=None,
    source_label=None,
    fps=CAPTURE_DEFAULTS.fps,
    width=CAPTURE_DEFAULTS.width,
    height=CAPTURE_DEFAULTS.height,
    checkpoint_interval=CAPTURE_DEFAULTS.checkpoint_interval,
    started_at=None,
    stopped_at=None,
    device_id=PLACEHOLDER_DEVICE.device_id,
    seal=None,
)


@app.get("/docs", include_in_schema=False)
def docs() -> HTMLResponse:
    """Serve Swagger UI using only local assets."""
    return get_swagger_ui_html(
        openapi_url=OPENAPI_URL,
        title=f"{app.title} - Swagger UI",
        swagger_js_url=f"{DOCS_ASSETS_URL}/swagger-ui-bundle.js",
        swagger_css_url=f"{DOCS_ASSETS_URL}/swagger-ui.css",
        swagger_favicon_url=f"{DOCS_ASSETS_URL}/favicon-32x32.png",
        swagger_ui_parameters={"validatorUrl": None},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    """Return the backend health and contract version."""
    return {"status": "ok", "version": "1.0"}


@app.websocket("/ws/live")
async def live(websocket: WebSocket) -> None:
    """Send the idle snapshot once, then wait for disconnect."""
    await websocket.accept()
    try:
        await websocket.send_json(
            {
                "type": "hello",
                "session": IDLE_SESSION.model_dump(mode="json"),
                "device": PLACEHOLDER_DEVICE.model_dump(mode="json"),
                "catalog": [],
            }
        )
        while (await websocket.receive())["type"] != "websocket.disconnect":
            pass
    except WebSocketDisconnect:
        return
