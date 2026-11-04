# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Log lines of the live-link server (logger ``realvirtual.livesync``) and the
carb bridge of the Kit extension (plan-637, field test on a laptop).

The server logs connect / auth / mount / stage / reset / disconnect and a
rate line every RATE_LOG_INTERVAL seconds - never one line per frame.
"""

import asyncio
import importlib
import json
import logging
import sys
import types

import pytest

websockets = pytest.importorskip("websockets")
from websockets.asyncio.client import connect  # noqa: E402

from realvirtual.livesync import protocol as P  # noqa: E402
from realvirtual.livesync.server import LOGGER_NAME, RATE_LOG_INTERVAL, LiveSyncServer  # noqa: E402

from test_server import IDENT, ORIGIN, TOKEN, FakeAdapter, hello, mount, run  # noqa: E402


def messages(caplog):
    return [r.getMessage() for r in caplog.records if r.name == LOGGER_NAME]


def test_session_lifecycle_is_logged(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    payload = b"#usda 1.0\n" * 100

    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=3, payload=payload)
            for i in range(20):
                await ws.send(P.encode_frame(3, i, [(1, IDENT)], []))
            await ws.send(P.encode_reset(3))
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.05)

    run(sc, tmp_path=tmp_path)
    text = "\n".join(messages(caplog))
    assert "listening on ws://127.0.0.1:" in text
    assert "client connected (origin %s)" % ORIGIN in text
    assert "auth ok (origin %s" % ORIGIN in text
    assert "mount begin (session 3)" in text and "%d bytes unpacked" % len(payload) in text
    assert "mount received (session 3)" in text and "%d bytes unpacked in" % len(payload) in text
    assert "stage opened (session 3): 3 nodes, 1 templates" in text
    assert "reset (session 3)" in text
    assert "client disconnected (origin %s, close code 1000" % ORIGIN in text
    assert "server stopped" in text
    # No line per frame.
    assert len(messages(caplog)) < 15


def test_refusals_are_logged_with_reason(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await ws.send(json.dumps({"v": 1, "token": "wrong", "client": "x", "rateHz": 30}))
            await asyncio.sleep(0.1)
        async with connect(url, origin="https://evil.example.com"):
            await asyncio.sleep(0.1)

    run(sc, tmp_path=tmp_path)
    warnings = [r.getMessage() for r in caplog.records if r.name == LOGGER_NAME and r.levelno == logging.WARNING]
    assert any("auth refused (origin %s): invalid token" % ORIGIN in m for m in warnings)
    assert any("origin https://evil.example.com is not allowed" in m for m in warnings)
    assert any("close code 4401" in m for m in messages(caplog))


class BrokenAdapter(FakeAdapter):
    def mount(self, path, begin):
        raise RuntimeError("cannot open the layer")


def test_stage_failure_is_logged_with_traceback(tmp_path, caplog):
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)

    async def main():
        server = LiveSyncServer(lambda: BrokenAdapter(), token=TOKEN, port=0, temp_dir=str(tmp_path))
        await server.start()
        try:
            async with connect("ws://127.0.0.1:%d" % server.port, origin=ORIGIN) as ws:
                await hello(ws)
                ack = await mount(ws, session=9)
                assert ack["type"] == "error"
        finally:
            await server.stop()

    asyncio.run(main())
    errors = [r for r in caplog.records if r.name == LOGGER_NAME and r.levelno == logging.ERROR]
    assert len(errors) == 1
    assert "opening the stage failed (session 9" in errors[0].getMessage()
    assert errors[0].exc_info is not None and "cannot open the layer" in caplog.text
    assert "Traceback" in caplog.text


def test_rate_is_logged_every_interval_not_per_apply(caplog):
    caplog.set_level(logging.INFO, logger=LOGGER_NAME)
    now = [0.0]
    adapter = FakeAdapter()
    server = LiveSyncServer(lambda: adapter, token=TOKEN, port=0, clock=lambda: now[0])
    server.status.nodes = 5
    for step in range(300):  # 30 updates/s for 10 s
        now[0] = step / 30.0
        server.status.frames_received += 1
        server._pending_nodes = {step % 2: IDENT}
        server.apply_pending()
    assert [m for m in messages(caplog) if m.startswith("rate")] == []
    now[0] = RATE_LOG_INTERVAL
    server.apply_pending()
    rate = [m for m in messages(caplog) if m.startswith("rate")]
    assert len(rate) == 1
    assert "30.0 frames/s received" in rate[0]
    assert "2 of 5 nodes moved" in rate[0]
    # An idle window logs nothing.
    now[0] = 2 * RATE_LOG_INTERVAL + 1
    server.apply_pending()
    assert len([m for m in messages(caplog) if m.startswith("rate")]) == 1


# ── carb bridge of the Kit extension ──

_ROOTS = ("realvirtual", "omni", "carb")


def _owned(name):
    return any(name == r or name.startswith(r + ".") for r in _ROOTS)


@pytest.fixture
def fake_kit():
    """Fake ``carb`` / ``omni`` modules; the real ones (if any) restored afterwards."""
    pytest.importorskip("pxr")
    saved = {k: v for k, v in sys.modules.items() if _owned(k)}
    for k in list(saved):
        del sys.modules[k]
    logger = logging.getLogger(LOGGER_NAME)
    saved_logger = (list(logger.handlers), logger.propagate, logger.level)
    calls = []

    def mod(name, package=False):
        m = types.ModuleType(name)
        if package:
            m.__path__ = []
        sys.modules[name] = m
        parent, _, child = name.rpartition(".")
        if parent:
            setattr(sys.modules[parent], child, m)
        return m

    carb = mod("carb", True)
    carb.log_info = lambda t: calls.append(("info", t))
    carb.log_warn = lambda t: calls.append(("warn", t))
    carb.log_error = lambda t: calls.append(("error", t))
    mod("carb.settings")
    mod("omni", True)
    mod("omni.ext").IExt = object
    mod("omni.kit", True)
    mod("omni.kit.app")
    mod("omni.usd")
    mod("omni.ui")
    try:
        yield calls
    finally:
        for k in [k for k in sys.modules if _owned(k)]:
            del sys.modules[k]
        sys.modules.update(saved)
        logger.handlers[:] = saved_logger[0]
        logger.propagate = saved_logger[1]
        logger.setLevel(saved_logger[2])


def test_extension_forwards_the_logger_to_carb_once(fake_kit):
    ext = importlib.import_module("realvirtual.livesync.extension")
    ext._attach_log_handler()
    ext._attach_log_handler()  # extension reload: still one handler
    log = logging.getLogger(LOGGER_NAME)
    assert sum(1 for h in log.handlers if h.__class__.__name__ == "CarbLogHandler") == 1
    log.info("client connected (origin x)")
    log.warning("auth refused")
    try:
        raise ValueError("boom")
    except ValueError:
        log.error("opening the stage failed", exc_info=True)
    kinds = [k for k, _t in fake_kit]
    assert kinds == ["info", "warn", "error"]
    assert fake_kit[0][1] == "[realvirtual.livesync] client connected (origin x)"
    assert "Traceback" in fake_kit[2][1] and "ValueError: boom" in fake_kit[2][1]
