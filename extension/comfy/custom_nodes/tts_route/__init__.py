"""Routes-only TTS proxy for ComfyUI (H20 scale-out edition).

The CosyVoice2 narration service on the H20 host listens on a **local Unix
socket** (``/root/comfy/log/tts.sock``) and is never remotely reachable (see
``deployment/H20/comfy/README.md`` §"TTS API" and §"Remote access"). The
DSH-Movie gateway runs on a different machine and can only speak HTTP over the
ZeroTier overlay, so it cannot open the Unix socket directly.

This node bridges that gap: it registers two HTTP routes on ComfyUI's existing
aiohttp server (port 8188) that **proxy** the Unix socket, exactly like the
sibling ``model_catalog`` routes-only node registers ``/model_catalog``:

    GET  /tts_health -> proxies GET  /health on the socket  -> JSON
    POST /tts_http   -> proxies POST /tts    on the socket  -> WAV bytes

Request schema for ``POST /tts_http`` (JSON body, mirrors the socket's ``/tts``):

    {"text": "...", "speaker_id": "female_zh" | "female_zh_alt"}

The upstream returns 24 kHz mono WAV bytes; they are streamed back verbatim
with ``Content-Type: audio/wav``. The first request after an idle period pays
the ~90 s cold model-load, so the proxy uses a generous 300 s upstream timeout
and reports an honest 503 (never a silent hang) when the socket is absent.

The node NEVER loads weights and defines NO executable graph nodes — it is a
pure HTTP surface addition, activated on ComfyUI startup.
"""

from __future__ import annotations

import os

from server import PromptServer

NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}

# The CosyVoice2 Unix socket. Overridable so a worker on a non-default host can
# point elsewhere without editing the file.
TTS_SOCK = os.environ.get("DSH_TTS_SOCK", "/root/comfy/log/tts.sock")

# Cold load is ~90 s (observed); warm requests are ~2-4 s. 300 s covers the cold
# path plus headroom so a first narration line never trips the proxy timeout.
_UPSTREAM_TOTAL_S = float(os.environ.get("DSH_TTS_TIMEOUT_S", "300"))
_UPSTREAM_CONNECT_S = 10.0

routes = PromptServer.instance.routes


async def _proxy(method: str, path: str, json_body: dict | None = None):  # noqa: ANN001, ANN201
    """Open the Unix socket and forward one request, returning an aiohttp reply."""
    import aiohttp
    from aiohttp import web

    if not os.path.exists(TTS_SOCK):
        return web.json_response(
            {"status": "error", "error": "tts-socket-missing", "socket": TTS_SOCK},
            status=503,
        )
    timeout = aiohttp.ClientTimeout(total=_UPSTREAM_TOTAL_S, sock_connect=_UPSTREAM_CONNECT_S)
    connector = aiohttp.UnixConnector(path=TTS_SOCK)
    try:
        async with aiohttp.ClientSession(connector=connector, timeout=timeout) as session:
            # With a UnixConnector the URL host is cosmetic; the path is what matters.
            request = session.request(method, f"http://localhost{path}", json=json_body)
            async with request as upstream:
                body = await upstream.read()
                content_type = upstream.headers.get("Content-Type")
                if content_type is None:
                    content_type = "application/json" if path == "/health" else "audio/wav"
                return web.Response(body=body, status=upstream.status, content_type=content_type)
    except Exception as exc:  # noqa: BLE001 - surface an honest error, never hang
        return web.json_response(
            {"status": "error", "error": "tts-proxy-failed", "detail": str(exc), "socket": TTS_SOCK},
            status=502,
        )


@routes.get("/tts_health")
async def tts_health(request):  # noqa: ANN001, ANN201
    return await _proxy("GET", "/health")


@routes.post("/tts_http")
async def tts_http(request):  # noqa: ANN001, ANN201
    from aiohttp import web

    try:
        payload = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"status": "error", "error": "invalid-json-body"}, status=400)
    if not isinstance(payload, dict) or not str(payload.get("text", "")).strip():
        return web.json_response(
            {"status": "error", "error": "missing-text", "hint": '{"text": "...", "speaker_id": "female_zh"}'},
            status=400,
        )
    body = {
        "text": str(payload.get("text", "")),
        "speaker_id": str(payload.get("speaker_id", "female_zh")),
    }
    return await _proxy("POST", "/tts", json_body=body)
