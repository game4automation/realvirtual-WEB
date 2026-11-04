# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""WebSocket server of the realvirtual USD live link (plan-637 F8, section 2.8).

Runs inside Kit's asyncio loop (``omni.kit.async_engine``) but imports nothing
from ``omni`` - the stage is reached through a :class:`StageAdapter`, so this
module runs (and is tested) without Kit.

Security (F8):

* binds ``127.0.0.1`` only;
* exactly ONE client; a second one is closed with 4409;
* no stage action before a valid ``hello``: the origin must match the
  allowlist (else 4403), the first frame must be ``hello`` within the auth
  timeout (else 4408) and carry the token (else 4401);
* limits: compressed mount <= 256 MB, unpacked <= 1 GB (checked WHILE
  unpacking, never inflated past the limit), chunk <= 512 KB, <= 256 frames
  between two app updates; invalid indices / frames are answered with an
  ``error`` ack and dropped. Frames of an older session are dropped.

Applying: incoming frames are MERGED per index (latest matrix per node and
per MU), spawn / delete / reset are kept as an ordered list; ``apply_pending``
(once per Kit app update) applies the ordered list first, then the merged
matrices. No delta is lost when several frames arrive between two updates
(R1 #6).

Logging: everything goes to the Python logger ``realvirtual.livesync``
(``LOGGER_NAME``) - connect / auth / disconnect, mount begin and end, stage
opened or failed (with traceback), reset, and every ``RATE_LOG_INTERVAL``
seconds the applied rate. Nothing is logged per frame. Inside Kit the
extension forwards this logger to ``carb.log_*``.
"""

from __future__ import annotations

import asyncio
import fnmatch
import hmac
import itertools
import json
import logging
import os
import tempfile
import time
import zlib
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Protocol, Tuple

from . import protocol as P
from .version import EXTENSION_VERSION

LOGGER_NAME = "realvirtual.livesync"
log = logging.getLogger(LOGGER_NAME)

#: Seconds between two rate log lines.
RATE_LOG_INTERVAL = 10.0

CLOSE_AUTH = 4401
CLOSE_PROTOCOL = 4402
CLOSE_ORIGIN = 4403
CLOSE_AUTH_TIMEOUT = 4408
CLOSE_BUSY = 4409

DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:*",
    "http://127.0.0.1:*",
    "https://localhost:*",
    "https://127.0.0.1:*",
    "https://*.realvirtual.io",
)


@dataclass
class Limits:
    max_chunk_bytes: int = 512 * 1024
    max_compressed_bytes: int = 256 * 1024 * 1024
    max_raw_bytes: int = 1024 * 1024 * 1024
    max_queued_frames: int = 256
    auth_timeout: float = 10.0
    #: Largest single WebSocket message (the mountBegin node table can be big).
    max_message_bytes: int = 64 * 1024 * 1024


class StageAdapter(Protocol):
    """What the server needs from the USD stage (see ``stage_usd.UsdStageAdapter``)."""

    def mount(self, usd_path: str, begin: P.MountBegin) -> None: ...
    def set_node_matrices(self, items: Dict[int, P.Matrix]) -> None: ...
    def spawn_mu(self, mu_id: int, template_index: int, matrix: P.Matrix) -> None: ...
    def delete_mu(self, mu_id: int) -> None: ...
    def set_mu_matrices(self, items: Dict[int, P.Matrix]) -> None: ...
    def reset(self) -> None: ...


def origin_allowed(origin: Optional[str], patterns) -> bool:
    """True when ``origin`` matches one of the glob patterns (``*`` = wildcard)."""
    if not origin:
        return False
    origin = origin.rstrip("/").lower()
    return any(fnmatch.fnmatchcase(origin, p.rstrip("/").lower()) for p in patterns)


def _origin_of(ws) -> Optional[str]:
    req = getattr(ws, "request", None)  # websockets >= 13 (asyncio API)
    headers = getattr(req, "headers", None) if req is not None else None
    if headers is None:
        headers = getattr(ws, "request_headers", None)  # legacy API
    if headers is None:
        return None
    return headers.get("Origin")


#: Plain-HTTP path answered on the WebSocket port, so the viewer can tell this
#: extension from another program that holds the port (plan-637 port collision).
PROBE_PATH = "/realvirtual-livesync"
PROBE_SERVICE = "realvirtual.livesync"


def probe_payload() -> Dict[str, object]:
    """Body of the probe answer. Public information only - never the token."""
    return {"service": PROBE_SERVICE, "version": EXTENSION_VERSION, "protocol": P.PROTOCOL_VERSION}


def _probe_headers() -> List[Tuple[str, str]]:
    return [
        ("Content-Type", "application/json"),
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Private-Network", "true"),
        ("Cache-Control", "no-store"),
    ]


def is_probe_request(path: Optional[str], headers) -> bool:
    """A plain ``GET /realvirtual-livesync`` (not a WebSocket upgrade)."""
    if not path or path.split("?", 1)[0].rstrip("/") != PROBE_PATH:
        return False
    upgrade = headers.get("Upgrade") if headers is not None else None
    return not (upgrade and "websocket" in str(upgrade).lower())


def _process_request(connection, request):
    """websockets >= 13 hook: answer the probe, let everything else through.

    Returning None hands the request to the normal WebSocket handshake, so
    origin, token and the single-client rule apply exactly as before.
    """
    if not is_probe_request(getattr(request, "path", None), getattr(request, "headers", None)):
        return None
    response = connection.respond(200, json.dumps(probe_payload()))
    for name, value in _probe_headers():
        try:
            del response.headers[name]
        except KeyError:
            pass
        response.headers[name] = value
    return response


def _process_request_legacy(path, request_headers):
    """Legacy websockets API (``websockets.server.serve``): same as :func:`_process_request`."""
    if not is_probe_request(path, request_headers):
        return None
    return 200, _probe_headers(), json.dumps(probe_payload()).encode("utf-8")


class UploadError(Exception):
    pass


class _Upload:
    """One mount upload: chunks in order, unpacked to a temp file with limits."""

    def __init__(self, begin: P.MountBegin, limits: Limits, path: str, started: float = 0.0):
        self.begin = begin
        self.limits = limits
        self.path = path
        self.started = started
        self.next_index = 0
        self.received = 0
        self.raw_total = 0
        self.raw_limit = min(begin.raw_bytes, limits.max_raw_bytes)
        self.decomp = zlib.decompressobj(wbits=31) if begin.encoding == "gzip" else None
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.file = open(path, "wb")

    def add(self, chunk: P.MountChunk) -> bool:
        """Consume a chunk; True when the upload is complete."""
        if chunk.index != self.next_index:
            raise UploadError("mount chunk %d out of order (expected %d)" % (chunk.index, self.next_index))
        if len(chunk.payload) > self.limits.max_chunk_bytes:
            raise UploadError("mount chunk larger than %d bytes" % self.limits.max_chunk_bytes)
        self.received += len(chunk.payload)
        if self.received > self.begin.compressed_bytes:
            raise UploadError("upload larger than announced")
        self.next_index += 1
        self._write(chunk.payload)
        if self.next_index < self.begin.chunk_count:
            return False
        if self.received != self.begin.compressed_bytes:
            raise UploadError("incomplete upload (%d of %d bytes)" % (self.received, self.begin.compressed_bytes))
        if self.decomp is not None:
            if not self.decomp.eof or self.decomp.unused_data:
                raise UploadError("gzip stream is incomplete or has trailing data")
        if self.raw_total != self.begin.raw_bytes:
            raise UploadError("unpacked size %d differs from the announced %d" % (self.raw_total, self.begin.raw_bytes))
        self.file.close()
        return True

    def _write(self, data: bytes) -> None:
        if self.decomp is None:
            self._emit(data)
            return
        buf = data
        while buf:
            allowed = self.raw_limit - self.raw_total
            try:
                out = self.decomp.decompress(buf, allowed + 1)
            except zlib.error as exc:
                raise UploadError("corrupt gzip stream: %s" % exc) from exc
            self._emit(out)
            buf = self.decomp.unconsumed_tail
            if self.decomp.eof:
                if buf or self.decomp.unused_data:
                    raise UploadError("gzip stream has trailing data")
                break
            if buf and not out:
                raise UploadError("gzip stream stalled")

    def _emit(self, out: bytes) -> None:
        if not out:
            return
        self.raw_total += len(out)
        if self.raw_total > self.raw_limit:
            raise UploadError("unpacked scene exceeds the limit")
        self.file.write(out)

    def abort(self) -> None:
        try:
            self.file.close()
        except OSError:
            pass
        try:
            os.remove(self.path)
        except OSError:
            pass


@dataclass
class ServerStatus:
    listening: bool = False
    port: int = 0
    client_origin: Optional[str] = None
    session: Optional[int] = None
    nodes: int = 0
    templates: int = 0
    applied_hz: float = 0.0
    frames_received: int = 0
    frames_dropped_stale: int = 0
    last_error: Optional[str] = None


class LiveSyncServer:
    """The live-link server. Call :meth:`apply_pending` once per app update."""

    def __init__(
        self,
        adapter_provider: Callable[[], StageAdapter],
        token: str,
        allowed_origins=DEFAULT_ALLOWED_ORIGINS,
        host: str = "127.0.0.1",
        port: int = P.DEFAULT_PORT,
        limits: Optional[Limits] = None,
        temp_dir: Optional[str] = None,
        clock: Callable[[], float] = time.monotonic,
    ):
        if host not in ("127.0.0.1", "::1", "localhost"):
            raise ValueError("the live-link server binds to loopback only")
        self._adapter_provider = adapter_provider
        self._token = token
        self.allowed_origins = tuple(allowed_origins)
        self._host = host
        self._port = port
        self.limits = limits or Limits()
        self._temp_dir = temp_dir or os.path.join(tempfile.gettempdir(), "realvirtual-livesync")
        self._clock = clock
        self._server = None
        self._active = None
        self._upload: Optional[_Upload] = None
        self._mounted_session: Optional[int] = None
        self._begin: Optional[P.MountBegin] = None
        self._mount_counter = itertools.count(1)
        self._mounted_files: List[str] = []
        self._pending_nodes: Dict[int, P.Matrix] = {}
        self._pending_mus: Dict[int, P.Matrix] = {}
        self._pending_ops: List[Tuple] = []
        self._pending_frames = 0
        self._apply_count = 0
        self._apply_window = clock()
        # Rate log window (RATE_LOG_INTERVAL): applies, frames, updated nodes / MUs.
        self._log_window = clock()
        self._log_applies = 0
        self._log_frames_at = 0
        self._log_nodes: set = set()
        self._log_mu_updates = 0
        self.status = ServerStatus(port=port)

    # ── lifecycle ──

    async def start(self) -> None:
        try:
            from websockets.asyncio.server import serve  # websockets >= 13
            hook = _process_request
        except ImportError:  # pragma: no cover - older websockets in some Kit builds
            from websockets.server import serve  # type: ignore
            hook = _process_request_legacy
        self._server = await serve(
            self.handle, self._host, self._port,
            max_size=self.limits.max_message_bytes,
            compression=None,
            process_request=hook,
        )
        sockets = getattr(self._server, "sockets", None) or []
        if sockets:
            self._port = sockets[0].getsockname()[1]
        self.status.port = self._port
        self.status.listening = True
        log.info("listening on ws://%s:%d", self._host, self._port)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None
            log.info("server stopped")
        self.status.listening = False
        self._drop_connection_state()

    @property
    def port(self) -> int:
        return self._port

    def set_token(self, token: str) -> None:
        self._token = token

    # ── connection ──

    async def handle(self, ws, *_unused) -> None:
        origin = _origin_of(ws)
        if self._active is not None:
            log.warning("client refused (origin %s): another client is connected", origin)
            await ws.close(CLOSE_BUSY, "another client is connected")
            return
        if not origin_allowed(origin, self.allowed_origins):
            log.warning("client refused: origin %s is not allowed", origin)
            await ws.close(CLOSE_ORIGIN, "origin not allowed")
            return
        log.info("client connected (origin %s)", origin)
        self._active = ws
        try:
            try:
                first = await asyncio.wait_for(ws.recv(), timeout=self.limits.auth_timeout)
            except asyncio.TimeoutError:
                log.warning("auth refused (origin %s): no hello within %.1f s", origin, self.limits.auth_timeout)
                await ws.close(CLOSE_AUTH_TIMEOUT, "no hello")
                return
            hello = P.parse_hello(first) if isinstance(first, str) else None
            if hello is None or hello.v != P.PROTOCOL_VERSION:
                log.warning("auth refused (origin %s): expected hello v%d", origin, P.PROTOCOL_VERSION)
                await ws.close(CLOSE_PROTOCOL, "expected hello v%d" % P.PROTOCOL_VERSION)
                return
            if not hmac.compare_digest(hello.token.encode("utf-8"), self._token.encode("utf-8")):
                log.warning("auth refused (origin %s): invalid token", origin)
                await ws.close(CLOSE_AUTH, "invalid token")
                return
            log.info(
                "auth ok (origin %s, client %s, %g Hz, extension %s)",
                origin, hello.client or "?", hello.rate_hz, EXTENSION_VERSION,
            )
            self.status.client_origin = origin
            await ws.send(P.ready_ack(EXTENSION_VERSION))
            async for message in ws:
                if isinstance(message, str):
                    continue  # nothing but hello is text
                await self._on_binary(ws, message)
        except Exception as exc:  # noqa: BLE001 - connection errors end the session
            if exc.__class__.__name__ not in ("ConnectionClosedOK", "ConnectionClosedError", "ConnectionClosed"):
                self.status.last_error = str(exc)
                log.warning("connection error (origin %s): %s", origin, exc)
        finally:
            log.info(
                "client disconnected (origin %s, close code %s, reason %r)",
                origin, getattr(ws, "close_code", None), getattr(ws, "close_reason", None) or "",
            )
            if self._active is ws:
                self._active = None
                self._drop_connection_state()

    def _drop_connection_state(self) -> None:
        if self._upload is not None:
            self._upload.abort()
            self._upload = None
        self._pending_nodes.clear()
        self._pending_mus.clear()
        self._pending_ops.clear()
        self._pending_frames = 0
        self.status.client_origin = None

    async def _error(self, ws, message: str, session: Optional[int] = None) -> None:
        self.status.last_error = message
        log.warning("error (session %s): %s", session, message)
        try:
            await ws.send(P.ack("error", session=session, message=message))
        except Exception:  # noqa: BLE001
            pass

    # ── messages ──

    async def _on_binary(self, ws, data: bytes) -> None:
        try:
            msg = P.decode(data)
        except P.ProtocolError as exc:
            await self._error(ws, "malformed message: %s" % exc)
            return

        if isinstance(msg, P.MountBegin):
            await self._on_mount_begin(ws, msg)
            return
        if isinstance(msg, P.MountChunk):
            await self._on_mount_chunk(ws, msg)
            return

        # Everything else needs the mounted session.
        if self._mounted_session is None or msg.session != self._mounted_session:
            self.status.frames_dropped_stale += 1
            return
        begin = self._begin
        if isinstance(msg, P.Frame):
            self.status.frames_received += 1
            if self._pending_frames >= self.limits.max_queued_frames:
                await self._error(ws, "frame queue full - frame dropped", msg.session)
                return
            n_nodes = len(begin.nodes)
            for idx, _m in msg.nodes:
                if idx >= n_nodes:
                    await self._error(ws, "frame %d: node index %d out of range" % (msg.seq, idx), msg.session)
                    return
            for idx, m in msg.nodes:
                self._pending_nodes[idx] = m
            for mid, m in msg.mus:
                self._pending_mus[mid] = m
            self._pending_frames += 1
        elif isinstance(msg, P.MuSpawn):
            if msg.template_index >= len(begin.templates) or not begin.templates[msg.template_index]:
                await self._error(ws, "muSpawn %d: unknown template %d" % (msg.mu_id, msg.template_index), msg.session)
                return
            self._pending_ops.append(("spawn", msg.mu_id, msg.template_index, msg.matrix))
        elif isinstance(msg, P.MuDelete):
            self._pending_mus.pop(msg.mu_id, None)
            self._pending_ops.append(("delete", msg.mu_id))
        elif isinstance(msg, P.Reset):
            log.info("reset (session %d)", msg.session)
            self._pending_nodes.clear()
            self._pending_mus.clear()
            self._pending_ops = [("reset",)]
            self._pending_frames = 0

    async def _on_mount_begin(self, ws, begin: P.MountBegin) -> None:
        if self._upload is not None:
            self._upload.abort()
            self._upload = None
        # A new mount makes the old session stale right away.
        self._mounted_session = None
        self._pending_nodes.clear()
        self._pending_mus.clear()
        self._pending_ops.clear()
        self._pending_frames = 0
        lim = self.limits
        problem = None
        if begin.compressed_bytes > lim.max_compressed_bytes:
            problem = "scene upload of %d bytes exceeds the limit" % begin.compressed_bytes
        elif begin.raw_bytes > lim.max_raw_bytes:
            problem = "unpacked scene of %d bytes exceeds the limit" % begin.raw_bytes
        elif begin.chunk_count == 0 or begin.chunk_count * lim.max_chunk_bytes < begin.compressed_bytes:
            problem = "invalid chunk count"
        elif begin.encoding == "identity" and begin.compressed_bytes != begin.raw_bytes:
            problem = "identity upload with differing sizes"
        elif any(i >= len(begin.nodes) for _m, i in begin.preplaced):
            problem = "pre-placed MU refers to an unknown node"
        if problem:
            await self._error(ws, problem, begin.session)
            return
        log.info(
            "mount begin (session %d): %d bytes %s, %d bytes unpacked, %d chunks, %d nodes, %d templates",
            begin.session, begin.compressed_bytes, begin.encoding, begin.raw_bytes,
            begin.chunk_count, len(begin.nodes), len(begin.templates),
        )
        path = os.path.join(self._temp_dir, "%d-%d.usdz" % (begin.session, next(self._mount_counter)))
        try:
            self._upload = _Upload(begin, lim, path, started=self._clock())
        except OSError as exc:
            await self._error(ws, "cannot write the scene: %s" % exc, begin.session)

    async def _on_mount_chunk(self, ws, chunk: P.MountChunk) -> None:
        up = self._upload
        if up is None or chunk.session != up.begin.session:
            self.status.frames_dropped_stale += 1
            return
        try:
            done = up.add(chunk)
        except UploadError as exc:
            up.abort()
            self._upload = None
            await self._error(ws, str(exc), chunk.session)
            return
        if not done:
            return
        self._upload = None
        received = self._clock()
        log.info(
            "mount received (session %d): %d bytes compressed, %d bytes unpacked in %.2f s -> %s",
            up.begin.session, up.received, up.raw_total, received - up.started, up.path,
        )
        try:
            self._adapter_provider().mount(up.path, up.begin)
        except Exception as exc:  # noqa: BLE001 - a broken file must not kill the server
            log.error("opening the stage failed (session %d, %s)", up.begin.session, up.path, exc_info=True)
            up.abort()
            await self._error(ws, "mount failed: %s" % exc, up.begin.session)
            return
        done_at = self._clock()
        log.info(
            "stage opened (session %d): %d nodes, %d templates in %.2f s (%.2f s total) - %s",
            up.begin.session, len(up.begin.nodes), len(up.begin.templates),
            done_at - received, done_at - up.started, up.path,
        )
        self._forget_old_files(keep=up.path)
        self._begin = up.begin
        self._mounted_session = up.begin.session
        self.status.session = up.begin.session
        self.status.nodes = len(up.begin.nodes)
        self.status.templates = len(up.begin.templates)
        await ws.send(P.ack("mounted", session=up.begin.session))

    def _forget_old_files(self, keep: str) -> None:
        for old in self._mounted_files:
            try:
                os.remove(old)
            except OSError:
                pass  # still referenced by the stage on Windows - removed later
        self._mounted_files = [p for p in self._mounted_files if os.path.exists(p)] + [keep]

    # ── apply (Kit update) ──

    def apply_pending(self) -> int:
        """Apply what arrived since the last call. Returns the number of changes."""
        if not (self._pending_ops or self._pending_nodes or self._pending_mus):
            self._tick_rate(False)
            return 0
        adapter = self._adapter_provider()
        ops, nodes, mus = self._pending_ops, self._pending_nodes, self._pending_mus
        self._pending_ops, self._pending_nodes, self._pending_mus = [], {}, {}
        self._pending_frames = 0
        count = 0
        for op in ops:
            if op[0] == "spawn":
                adapter.spawn_mu(op[1], op[2], op[3])
            elif op[0] == "delete":
                adapter.delete_mu(op[1])
            elif op[0] == "reset":
                adapter.reset()
            count += 1
        if nodes:
            adapter.set_node_matrices(nodes)
            count += len(nodes)
            self._log_nodes.update(nodes.keys())
        if mus:
            adapter.set_mu_matrices(mus)
            count += len(mus)
            self._log_mu_updates += len(mus)
        self._tick_rate(True)
        return count

    def _tick_rate(self, applied: bool) -> None:
        if applied:
            self._apply_count += 1
            self._log_applies += 1
        now = self._clock()
        elapsed = now - self._apply_window
        if elapsed >= 1.0:
            self.status.applied_hz = self._apply_count / elapsed
            self._apply_count = 0
            self._apply_window = now
        window = now - self._log_window
        if window >= RATE_LOG_INTERVAL:
            frames = self.status.frames_received - self._log_frames_at
            if self._log_applies or frames:
                log.info(
                    "rate over %.0f s: %.1f frames/s received, %.1f updates/s applied, "
                    "%d of %d nodes moved, %d MU updates",
                    window, frames / window, self._log_applies / window,
                    len(self._log_nodes), self.status.nodes, self._log_mu_updates,
                )
            self._log_window = now
            self._log_applies = 0
            self._log_frames_at = self.status.frames_received
            self._log_nodes.clear()
            self._log_mu_updates = 0
