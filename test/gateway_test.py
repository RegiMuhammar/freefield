"""The gateway against a fake proxy: JSON links come back on the gateway's own address, streams pass through.

    pip install aiohttp && python test/gateway_test.py
"""
import asyncio, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "infra"))
os.environ["FREEFIELD_TOKEN"] = "t0k"
os.environ["PROXY_URL"] = "http://127.0.0.1:18189"
os.environ["COMFYUI_URL"] = "http://127.0.0.1:18188"
from aiohttp import web, ClientSession
import gateway  # infra/gateway.py

async def fake_comfy_app(state: dict):
    async def free(request):
        state["frees"] += 1
        return web.json_response({"ok": True})
    async def queue(request):
        return web.json_response({"queue_running": state["running"], "queue_pending": []})
    async def stats(request):
        return web.json_response({"devices": [{"name": "L4", "vram_total": 24 * 2**30, "vram_free": 20 * 2**30}]})
    app = web.Application()
    app.router.add_post("/free", free)
    app.router.add_get("/queue", queue)
    app.router.add_get("/system_stats", stats)
    return app

async def fake_proxy_app():
    async def job(request):
        base = f"{request.scheme}://{request.host}"
        return web.json_response({"id": "j1", "status": "succeeded",
                                  "urls": {"self": f"{base}/api/v2/jobs/j1", "events": f"{base}/api/v2/jobs/j1/events"},
                                  "outputs": [{"id": "o1", "url": f"{base}/api/v2/jobs/j1/outputs/o1"}]})
    async def events(request):
        resp = web.StreamResponse(headers={"Content-Type": "text/event-stream"})
        await resp.prepare(request)
        await resp.write(b"data: {\"url\": \"http://127.0.0.1:18189/x\"}\n\n")
        await resp.write_eof(); return resp
    app = web.Application(); app.router.add_get("/api/v2/jobs/j1", job); app.router.add_get("/api/v2/jobs/j1/events", events)
    return app

async def main():
    comfy_state = {"frees": 0, "running": [["job-1"]]}
    comfy = web.AppRunner(await fake_comfy_app(comfy_state)); await comfy.setup(); await web.TCPSite(comfy, "127.0.0.1", 18188).start()
    proxy = web.AppRunner(await fake_proxy_app()); await proxy.setup(); await web.TCPSite(proxy, "127.0.0.1", 18189).start()
    shutdown_called = asyncio.Event()
    gw_app = gateway.make_app(idle_unload_sec=0.1, idle_shutdown_sec=0.25, on_idle_shutdown=shutdown_called.set)
    gw = web.AppRunner(gw_app); await gw.setup(); await web.TCPSite(gw, "127.0.0.1", 18000).start()
    async with ClientSession() as s:
        h = {"Authorization": "Bearer t0k"}
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1", headers=h) as r:
            body = await r.json(); assert r.status == 200, r.status
        assert body["urls"]["self"] == "http://127.0.0.1:18000/api/v2/jobs/j1", body["urls"]
        assert body["outputs"][0]["url"] == "http://127.0.0.1:18000/api/v2/jobs/j1/outputs/o1"
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1", headers={**h, "X-Forwarded-Proto": "https", "Host": "gw.example.test"}) as r:
            body = await r.json()
        assert body["urls"]["self"] == "https://gw.example.test/api/v2/jobs/j1", body["urls"]
        # a public host with no forwarded header (Modal) is https; a local one keeps http
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1", headers={**h, "Host": "x--serve.us-east.modal.run"}) as r:
            body = await r.json()
        assert body["urls"]["self"] == "https://x--serve.us-east.modal.run/api/v2/jobs/j1", body["urls"]
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1", headers={**h, "Host": "192.168.1.20:8000"}) as r:
            body = await r.json()
        assert body["urls"]["self"] == "http://192.168.1.20:8000/api/v2/jobs/j1", body["urls"]
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1/events", headers=h) as r:
            text = await r.text(); assert r.headers["Content-Type"].startswith("text/event-stream")
        assert "http://127.0.0.1:18189/x" in text, "streams are passed through untouched"
        async with s.get("http://127.0.0.1:18000/api/v2/jobs/j1") as r:
            assert r.status == 401, r.status
        # prepare loads model set; while queue_running is non-empty, idle watchdog must NOT unload or shut down
        async with s.post("http://127.0.0.1:18000/freefield/prepare", json={"app": "create-image", "models": "m1"}, headers=h) as r:
            assert r.status == 200
        await asyncio.sleep(0.3)
        assert not shutdown_called.is_set(), "must not shut down while ComfyUI queue is busy"
        assert comfy_state["frees"] == 0, "must not unload while ComfyUI queue is busy"
        # once ComfyUI queue empties, idle unload fires first, then idle shutdown fires
        comfy_state["running"] = []
        await asyncio.wait_for(shutdown_called.wait(), timeout=2.0)
        assert comfy_state["frees"] == 1, f"expected 1 idle free, got {comfy_state['frees']}"
        async with s.get("http://127.0.0.1:18000/freefield/status", headers=h) as r:
            st = await r.json()
        assert st["app"] is None and st["idle_shutdown_sec"] == 0.25, st
    print("gateway relink + idle watchdog ok")
    await gw.cleanup(); await proxy.cleanup(); await comfy.cleanup()

asyncio.run(main())
