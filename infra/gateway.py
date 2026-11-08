"""The pass: the only door into the backend container.

    client (SDK) ──▶ gateway :8000 ──▶ comfy-api-proxy :8189 ──▶ ComfyUI :8188

- Every request needs `Authorization: Bearer $FREEFIELD_TOKEN` (the Comfy SDK sends its
  apiKey that way). The header is stripped before forwarding; the proxy has no auth.
- POST /freefield/prepare {"app", "models"} is the pantry manager: when the requested
  app needs a different set of models than the one that ran last, it asks ComfyUI to
  unload everything (POST /free) so nothing from the previous app stays in VRAM.
- GET /freefield/status shows the current app and ComfyUI's device stats.
- GET /health is open, for Modal's startup probe.
- The proxy writes absolute links (a job's `urls.self`, `.events`, `.cancel`, an output's
  `url`) from the host *it* sees, http://127.0.0.1:8189; the SDK follows those links
  verbatim, so from outside they went nowhere ("fetch failed", 23 oct). JSON answers are
  rewritten to the address the client reached the gateway on.

Run: python gateway.py  (env: FREEFIELD_TOKEN, COMFYUI_URL, PROXY_URL, GATEWAY_PORT)
"""
from __future__ import annotations

import asyncio
import hmac
import logging
import os
import signal
import time
from collections.abc import Callable
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, web

COMFYUI_URL = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
PROXY_URL = os.environ.get("PROXY_URL", "http://127.0.0.1:8189")
TOKEN = os.environ.get("FREEFIELD_TOKEN", "")
ALLOW_OPEN = os.environ.get("FREEFIELD_ALLOW_OPEN") == "1"
IDLE_UNLOAD_SEC = float(os.environ.get("FREEFIELD_IDLE_UNLOAD_SEC") or 0)
IDLE_SHUTDOWN_SEC = float(os.environ.get("FREEFIELD_IDLE_SHUTDOWN_SEC") or 0)
IDLE_MARKER = os.environ.get("FREEFIELD_IDLE_MARKER", "")
HOP_HEADERS = {"host", "authorization", "content-length", "transfer-encoding", "connection", "keep-alive"}

log = logging.getLogger("gateway")


class Pantry:
    """Remembers which models are on the GPU and clears it when an app needs others."""

    def __init__(self, session: ClientSession):
        self.session = session
        self.models: str | None = None
        self.app: str | None = None
        self.lock = asyncio.Lock()
        self.frees = 0
        self.last_activity = time.time()

    def touch(self) -> None:
        self.last_activity = time.time()

    async def prepare(self, app: str, models: str) -> dict:
        self.touch()
        async with self.lock:
            freed = False
            previous = self.app
            if self.models is not None and models != self.models:
                async with self.session.post(f"{COMFYUI_URL}/free", json={"unload_models": True, "free_memory": True}) as r:
                    r.raise_for_status()
                freed = True
                self.frees += 1
            self.models, self.app = models, app
            return {"freed": freed, "previous": previous, "current": app}

    async def unload(self) -> bool:
        """Unload models and free VRAM without changing the active app until the next prepare."""
        async with self.lock:
            if self.models is None:
                return False
            try:
                async with self.session.post(f"{COMFYUI_URL}/free", json={"unload_models": True, "free_memory": True}) as r:
                    r.raise_for_status()
            except Exception as e:
                log.warning("idle unload failed: %s", e)
                return False
            self.models, self.app = None, None
            self.frees += 1
            return True


def authorized(request: web.Request) -> bool:
    if ALLOW_OPEN:
        return True
    header = request.headers.get("Authorization", "")
    return bool(TOKEN) and hmac.compare_digest(header, f"Bearer {TOKEN}")


@web.middleware
async def auth_mw(request: web.Request, handler):
    if request.path == "/health" or authorized(request):
        return await handler(request)
    return web.json_response({"error": "missing or wrong token"}, status=401)


async def health(request: web.Request) -> web.Response:
    if request.query.get("wake") == "1":
        request.app["pantry"].touch()
    return web.json_response({"ok": True})


async def prepare(request: web.Request) -> web.Response:
    body = await request.json()
    if not isinstance(body.get("models"), str) or not isinstance(body.get("app"), str):
        return web.json_response({"error": "expected {app, models}"}, status=400)
    result = await request.app["pantry"].prepare(body["app"], body["models"])
    log.info("prepare %s → %s", body["app"], result)
    return web.json_response(result)


async def status(request: web.Request) -> web.Response:
    pantry: Pantry = request.app["pantry"]
    stats = None
    try:
        async with pantry.session.get(f"{COMFYUI_URL}/system_stats") as r:
            stats = await r.json()
    except Exception as e:  # ComfyUI may still be starting
        stats = {"error": str(e)}
    idle_sec = round(max(0.0, time.time() - pantry.last_activity), 1)
    shutdown_sec = request.app["idle_shutdown_sec"]
    return web.json_response({
        "app": pantry.app,
        "models": pantry.models,
        "frees": pantry.frees,
        "idle_sec": idle_sec,
        "idle_shutdown_sec": shutdown_sec if shutdown_sec > 0 else None,
        "comfyui": stats,
    })


LOCAL_HOSTS = ("127.0.0.1", "localhost", "0.0.0.0", "[::1]")


def external_base(request: web.Request) -> str:
    """Where the client reached us. Modal terminates TLS and talks plain http to the container
    without an X-Forwarded-Proto header (first deploy, 23 oct: links came out as http://…modal.run,
    the SDK saw another origin and sent no token, 401), so a public host is https unless a proxy
    says otherwise; only a local or private address keeps the scheme it was reached on."""
    forwarded = request.headers.get("X-Forwarded-Proto", "").split(",")[0].strip()
    host = request.host
    name = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
    private = name in LOCAL_HOSTS or name.startswith(("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.", "172.2", "172.30.", "172.31."))
    scheme = forwarded or (request.scheme if private else "https")
    return f"{scheme}://{host}"


def relink(body: bytes, request: web.Request) -> bytes:
    """The proxy's own address in a JSON answer becomes the gateway's external one."""
    return body.replace(PROXY_URL.encode(), external_base(request).encode())


async def forward(request: web.Request) -> web.StreamResponse:
    pantry: Pantry = request.app["pantry"]
    pantry.touch()
    session: ClientSession = request.app["session"]
    headers = {k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS}

    async def body():
        async for chunk in request.content.iter_chunked(1 << 16):
            pantry.touch()
            yield chunk

    data = body() if request.can_read_body else None
    async with session.request(request.method, f"{PROXY_URL}{request.rel_url}", headers=headers, data=data,
                               allow_redirects=False) as upstream:
        passthrough = {k: v for k, v in upstream.headers.items() if k.lower() not in HOP_HEADERS | {"content-encoding"}}
        if upstream.content_type == "application/json":   # job and asset answers carry links: fix them up whole
            raw = relink(await upstream.read(), request)
            pantry.touch()
            passthrough.pop("Content-Length", None)
            return web.Response(status=upstream.status, body=raw, headers=passthrough)
        resp = web.StreamResponse(status=upstream.status)
        for k, v in passthrough.items():
            resp.headers[k] = v
        await resp.prepare(request)
        async for chunk in upstream.content.iter_any():   # streams SSE events and big files as they come
            pantry.touch()
            await resp.write(chunk)
        await resp.write_eof()
        return resp


async def comfy_busy(session: ClientSession) -> bool:
    """True while ComfyUI has any job running or queued."""
    try:
        async with session.get(f"{COMFYUI_URL}/queue", timeout=ClientTimeout(total=5)) as r:
            if r.status != 200:
                return False
            q = await r.json()
            return bool(q.get("queue_running") or q.get("queue_pending"))
    except Exception:
        return False


def _default_shutdown() -> None:
    if IDLE_MARKER:
        try:
            Path(IDLE_MARKER).write_text(str(int(time.time())), encoding="utf-8")
        except Exception as e:
            log.warning("could not write IDLE_MARKER %s: %s", IDLE_MARKER, e)
    try:
        from google.colab import runtime  # type: ignore
        log.warning("calling google.colab.runtime.unassign() to release Colab GPU...")
        runtime.unassign()
    except Exception:
        pass
    os.kill(os.getpid(), signal.SIGTERM)


async def idle_watchdog(app: web.Application) -> None:
    pantry: Pantry = app["pantry"]
    unload_sec: float = app["idle_unload_sec"]
    shutdown_sec: float = app["idle_shutdown_sec"]
    positive = [x for x in (unload_sec, shutdown_sec) if x > 0]
    interval = max(0.05, min(5.0, min(positive) / 4)) if positive else 5.0
    while True:
        await asyncio.sleep(interval)
        if await comfy_busy(pantry.session):
            pantry.touch()
            continue
        idle = time.time() - pantry.last_activity
        if unload_sec > 0 and idle >= unload_sec and pantry.models is not None:
            if await pantry.unload():
                log.info("idle %.1fs >= %.1fs: unloaded models from VRAM", idle, unload_sec)
        if shutdown_sec > 0 and idle >= shutdown_sec:
            log.warning("idle %.1fs >= %.1fs: triggering auto-shutdown", idle, shutdown_sec)
            app["on_idle_shutdown"]()
            return


async def on_startup(app: web.Application) -> None:
    app["session"] = ClientSession(timeout=ClientTimeout(total=None, sock_connect=30), auto_decompress=False)
    app["pantry"] = Pantry(app["session"])
    if app["idle_unload_sec"] > 0 or app["idle_shutdown_sec"] > 0:
        app["watchdog_task"] = asyncio.create_task(idle_watchdog(app))


async def on_cleanup(app: web.Application) -> None:
    task: asyncio.Task | None = app.get("watchdog_task")
    if task and not task.done():
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await app["session"].close()


def make_app(
    *,
    idle_unload_sec: float | None = None,
    idle_shutdown_sec: float | None = None,
    on_idle_shutdown: Callable[[], None] | None = None,
) -> web.Application:
    if not TOKEN and not ALLOW_OPEN:
        raise SystemExit("FREEFIELD_TOKEN is not set; refusing to start an open gateway")
    app = web.Application(middlewares=[auth_mw], client_max_size=1024 ** 3)
    app["idle_unload_sec"] = IDLE_UNLOAD_SEC if idle_unload_sec is None else idle_unload_sec
    app["idle_shutdown_sec"] = IDLE_SHUTDOWN_SEC if idle_shutdown_sec is None else idle_shutdown_sec
    app["on_idle_shutdown"] = on_idle_shutdown or _default_shutdown
    app.router.add_get("/health", health)
    app.router.add_post("/freefield/prepare", prepare)
    app.router.add_get("/freefield/status", status)
    app.router.add_route("*", "/{tail:.*}", forward)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


async def wait_for(url: str, timeout_s: float = 600) -> None:
    """Block until url answers 200, so Modal only routes traffic once ComfyUI is up."""
    deadline = time.time() + timeout_s
    async with ClientSession() as s:
        while time.time() < deadline:
            try:
                async with s.get(url) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            await asyncio.sleep(1)
    raise TimeoutError(f"{url} did not come up in {timeout_s:.0f}s")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    web.run_app(make_app(), host="0.0.0.0", port=int(os.environ.get("GATEWAY_PORT", "8000")))
