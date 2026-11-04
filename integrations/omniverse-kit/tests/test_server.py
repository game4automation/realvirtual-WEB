# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""LiveSyncServer without Kit: a real websockets server on an ephemeral
loopback port, a real websockets client, and a fake stage (plan-637 section 9,
test_server.py)."""

import asyncio
import gzip
import json
import os

import pytest

websockets = pytest.importorskip("websockets")
from websockets.asyncio.client import connect  # noqa: E402
from websockets.exceptions import ConnectionClosed  # noqa: E402

from realvirtual.livesync import protocol as P  # noqa: E402
from realvirtual.livesync.server import Limits, LiveSyncServer, origin_allowed  # noqa: E402

TOKEN = "s3cret-token"
ORIGIN = "http://localhost:5173"
IDENT = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]
NODES = ["/Root/Scenes/Scene/Cell", "/Root/Scenes/Scene/Cell/AxisA", "/Root/Scenes/Scene/Cell/AxisB"]
TEMPLATES = ["/Root/Scenes/Scene/Cell/Box"]


def mat(tx, ty=0.0, tz=0.0):
    m = list(IDENT)
    m[12], m[13], m[14] = tx, ty, tz
    return m


class FakeAdapter:
    def __init__(self):
        self.mounts = []
        self.nodes = {}
        self.mus = {}
        self.ops = []
        self.node_batches = []

    def mount(self, path, begin):
        with open(path, "rb") as f:
            self.mounts.append((begin.session, f.read()))
        self.nodes.clear()
        self.mus.clear()

    def set_node_matrices(self, items):
        self.node_batches.append(dict(items))
        self.nodes.update(items)

    def spawn_mu(self, mu_id, template_index, matrix):
        self.ops.append(("spawn", mu_id, template_index))
        self.mus[mu_id] = matrix

    def delete_mu(self, mu_id):
        self.ops.append(("delete", mu_id))
        self.mus.pop(mu_id, None)

    def set_mu_matrices(self, items):
        for k, v in items.items():
            if k in self.mus:
                self.mus[k] = v

    def reset(self):
        self.ops.append(("reset",))
        self.mus.clear()


async def until(cond, timeout=3.0):
    loop = asyncio.get_running_loop()
    end = loop.time() + timeout
    while not cond():
        if loop.time() > end:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


def run(scenario, limits=None, tmp_path=None):
    async def main():
        adapter = FakeAdapter()
        server = LiveSyncServer(lambda: adapter, token=TOKEN, port=0, limits=limits,
                                temp_dir=str(tmp_path) if tmp_path else None)
        await server.start()
        try:
            await scenario(server, adapter, "ws://127.0.0.1:%d" % server.port)
        finally:
            await server.stop()
    asyncio.run(main())


async def close_code(ws):
    try:
        while True:
            await asyncio.wait_for(ws.recv(), 3)
    except ConnectionClosed as exc:
        return exc.rcvd.code if exc.rcvd else None


async def hello(ws, token=TOKEN):
    await ws.send(json.dumps({"v": 1, "token": token, "client": "realvirtual-web", "rateHz": 30}))
    return json.loads(await asyncio.wait_for(ws.recv(), 3))


async def mount(ws, session=1, payload=b"#usda 1.0\n" * 50, encoding="gzip", chunk=64,
                compressed=None, raw=None, chunks=None, expect_ack=True):
    body = gzip.compress(payload) if encoding == "gzip" else payload
    parts = [body[i:i + chunk] for i in range(0, len(body), chunk)] or [b""]
    if chunks is not None:
        parts = chunks
    await ws.send(P.encode_mount_begin(session, len(body) if compressed is None else compressed,
                                       len(payload) if raw is None else raw, len(parts),
                                       encoding, NODES, TEMPLATES, [(7, 2)]))
    for i, part in enumerate(parts):
        await ws.send(P.encode_mount_chunk(session, i, part))
    if expect_ack:
        return json.loads(await asyncio.wait_for(ws.recv(), 3))
    return None


# ── auth ──

def test_wrong_token_is_refused_without_stage_action(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await ws.send(json.dumps({"v": 1, "token": "wrong", "client": "x", "rateHz": 30}))
            assert await close_code(ws) == 4401
        assert adapter.mounts == [] and adapter.node_batches == []
    run(sc, tmp_path=tmp_path)


def test_ready_ack_carries_extension_and_protocol_version(tmp_path):
    from realvirtual.livesync.version import EXTENSION_VERSION, read_extension_version

    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            ack = await hello(ws)
            assert ack == {"type": "ready", "extVersion": EXTENSION_VERSION, "protocol": P.PROTOCOL_VERSION}
    run(sc, tmp_path=tmp_path)
    # the one source: config/extension.toml
    toml = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "exts", "realvirtual.livesync",
                        "config", "extension.toml")
    assert EXTENSION_VERSION == read_extension_version(toml) != "0.0.0"


def test_foreign_origin_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin="https://evil.example.com") as ws:
            assert await close_code(ws) == 4403
    run(sc, tmp_path=tmp_path)


# ── plain-HTTP probe (port collision) ──

async def http_get(port, path, origin="https://evil.example.com"):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    writer.write(("GET %s HTTP/1.1\r\nHost: 127.0.0.1:%d\r\nOrigin: %s\r\nConnection: close\r\n\r\n"
                  % (path, port, origin)).encode("ascii"))
    await writer.drain()
    raw = await asyncio.wait_for(reader.read(), 3)
    writer.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        k, _, v = line.partition(":")
        headers[k.strip().lower()] = v.strip()
    return status, headers, body


def test_probe_answers_json_with_cors_and_no_secret(tmp_path):
    from realvirtual.livesync.version import EXTENSION_VERSION

    async def sc(server, adapter, url):
        status, headers, body = await http_get(server.port, "/realvirtual-livesync")
        assert status == 200
        assert headers.get("access-control-allow-origin") == "*"
        assert headers.get("content-type", "").startswith("application/json")
        data = json.loads(body)
        assert data == {"service": "realvirtual.livesync", "version": EXTENSION_VERSION,
                        "protocol": P.PROTOCOL_VERSION}
        assert TOKEN not in body.decode("utf-8")
        assert adapter.mounts == [] and server.status.client_origin is None
    run(sc, tmp_path=tmp_path)


def test_probe_does_not_open_other_paths_or_weaken_ws_auth(tmp_path):
    async def sc(server, adapter, url):
        status, headers, _ = await http_get(server.port, "/")
        assert status != 200 and "access-control-allow-origin" not in headers
        # The WebSocket rules are unchanged after a probe: origin and token still apply.
        await http_get(server.port, "/realvirtual-livesync")
        async with connect(url, origin="https://evil.example.com") as ws:
            assert await close_code(ws) == 4403
        async with connect(url, origin=ORIGIN) as ws:
            await ws.send(json.dumps({"v": 1, "token": "wrong", "client": "x", "rateHz": 30}))
            assert await close_code(ws) == 4401
        async with connect(url, origin=ORIGIN) as ws:
            assert (await hello(ws))["type"] == "ready"
    run(sc, tmp_path=tmp_path)


def test_second_server_on_a_taken_port_fails_with_address_in_use(tmp_path):
    from realvirtual.livesync.port_owner import bind_error_message, is_address_in_use

    async def sc(server, adapter, url):
        other = LiveSyncServer(lambda: adapter, token=TOKEN, port=server.port)
        with pytest.raises(OSError) as info:
            await other.start()
        assert is_address_in_use(info.value)
        line = bind_error_message(server.port, info.value, finder=lambda port: "python.exe (pid 1)")
        assert line.startswith("Port %d is taken by python.exe (pid 1) - change /exts/realvirtual.livesync/port"
                               % server.port)
    run(sc, tmp_path=tmp_path)


def test_origin_patterns():
    pats = ["http://localhost:*", "https://*.realvirtual.io"]
    assert origin_allowed("http://localhost:5173", pats)
    assert origin_allowed("https://web.realvirtual.io", pats)
    assert not origin_allowed("https://realvirtual.io.evil.com", pats)
    assert not origin_allowed(None, pats)


def test_auth_timeout_closes(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            assert await close_code(ws) == 4408
    run(sc, limits=Limits(auth_timeout=0.2), tmp_path=tmp_path)


def test_second_client_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as first:
            assert (await hello(first))["type"] == "ready"
            async with connect(url, origin=ORIGIN) as second:
                assert await close_code(second) == 4409
            # the first one keeps working
            assert (await mount(first))["type"] == "mounted"
    run(sc, tmp_path=tmp_path)


def test_binary_before_hello_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await ws.send(P.encode_reset(1))
            assert await close_code(ws) == 4402
        assert adapter.ops == []
    run(sc, tmp_path=tmp_path)


# ── mount ──

def test_mount_unpacks_and_acks(tmp_path):
    payload = b"#usda 1.0\n" + b"x" * 5000

    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            ack = await mount(ws, session=5, payload=payload, chunk=100)
            assert ack == {"type": "mounted", "session": 5}
            assert adapter.mounts == [(5, payload)]
    run(sc, tmp_path=tmp_path)


def test_oversized_upload_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            ack = await mount(ws, payload=os.urandom(4000), encoding="identity", chunk=512)
            assert ack["type"] == "error" and "exceeds" in ack["message"]
            assert adapter.mounts == []
    run(sc, limits=Limits(max_compressed_bytes=1000), tmp_path=tmp_path)


def test_oversized_chunk_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            ack = await mount(ws, payload=b"a" * 300, encoding="identity", chunk=300)
            assert ack["type"] == "error" and "chunk" in ack["message"]
    run(sc, limits=Limits(max_chunk_bytes=256), tmp_path=tmp_path)


def test_incomplete_upload_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            ack = await mount(ws, payload=b"a" * 100, encoding="identity", compressed=200, raw=200,
                              chunks=[b"a" * 100])
            assert ack["type"] == "error" and "incomplete" in ack["message"]
            assert adapter.mounts == []
            assert os.listdir(tmp_path) == []
    run(sc, tmp_path=tmp_path)


def test_corrupt_gzip_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            bad = b"\x1f\x8b\x08\x00" + b"garbage!" * 10
            ack = await mount(ws, encoding="gzip", compressed=len(bad), raw=1000, chunks=[bad])
            assert ack["type"] == "error" and "gzip" in ack["message"]
            assert adapter.mounts == []
    run(sc, tmp_path=tmp_path)


def test_unpack_limit_stops_while_unpacking(tmp_path):
    bomb = gzip.compress(b"\0" * 2_000_000)  # ~2 KB on the wire, 2 MB unpacked

    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            # Announces a raw size within the limit but carries more.
            ack = await mount(ws, encoding="gzip", compressed=len(bomb), raw=10_000, chunks=[bomb])
            assert ack["type"] == "error" and "exceeds" in ack["message"]
            assert adapter.mounts == []
            assert os.listdir(tmp_path) == []
    run(sc, limits=Limits(max_raw_bytes=10_000), tmp_path=tmp_path)


# ── frames ──

def test_invalid_index_is_refused_and_dropped(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=2)
            await ws.send(P.encode_frame(2, 0, [(1, mat(1)), (99, mat(2))], []))
            ack = json.loads(await asyncio.wait_for(ws.recv(), 3))
            assert ack["type"] == "error" and "out of range" in ack["message"]
            server.apply_pending()
            assert adapter.node_batches == []
    run(sc, tmp_path=tmp_path)


def test_old_session_is_dropped(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=2)
            await mount(ws, session=3)
            await ws.send(P.encode_frame(2, 0, [(1, mat(5))], []))
            await ws.send(P.encode_frame(3, 0, [(2, mat(6))], []))
            await until(lambda: server.status.frames_received >= 1 and server.status.frames_dropped_stale >= 1)
            server.apply_pending()
            assert list(adapter.nodes) == [2]
    run(sc, tmp_path=tmp_path)


def test_delta_merge_keeps_axis_a(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=4)
            await ws.send(P.encode_frame(4, 0, [(1, mat(1.5))], []))   # axis A
            await ws.send(P.encode_frame(4, 1, [(2, mat(2.5))], []))   # only axis B
            await until(lambda: server.status.frames_received >= 2)
            server.apply_pending()
            assert len(adapter.node_batches) == 1
            assert adapter.nodes[1][12] == pytest.approx(1.5)
            assert adapter.nodes[2][12] == pytest.approx(2.5)
    run(sc, tmp_path=tmp_path)


def test_mu_ops_keep_order_and_reset_clears(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=1)
            await ws.send(P.encode_mu_spawn(1, 10, 0, mat(1)))
            await ws.send(P.encode_frame(1, 0, [], [(10, mat(2))]))
            await ws.send(P.encode_mu_delete(1, 10))
            await ws.send(P.encode_mu_spawn(1, 10, 0, mat(3)))
            await until(lambda: server.status.frames_received >= 1)
            await asyncio.sleep(0.05)
            server.apply_pending()
            assert adapter.ops == [("spawn", 10, 0), ("delete", 10), ("spawn", 10, 0)]
            assert adapter.mus[10][12] == pytest.approx(3)  # the deleted MU's pose was dropped
            await ws.send(P.encode_mu_spawn(1, 11, 0, mat(4)))
            await ws.send(P.encode_reset(1))
            await asyncio.sleep(0.05)
            server.apply_pending()
            assert adapter.ops[-1] == ("reset",)
            assert ("spawn", 11, 0) not in adapter.ops
    run(sc, tmp_path=tmp_path)


def test_unknown_template_is_refused(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=1)
            await ws.send(P.encode_mu_spawn(1, 10, 5, mat(1)))
            ack = json.loads(await asyncio.wait_for(ws.recv(), 3))
            assert ack["type"] == "error" and "template" in ack["message"]
    run(sc, tmp_path=tmp_path)


def test_frame_queue_limit(tmp_path):
    async def sc(server, adapter, url):
        async with connect(url, origin=ORIGIN) as ws:
            await hello(ws)
            await mount(ws, session=1)
            for i in range(3):
                await ws.send(P.encode_frame(1, i, [(1, mat(i))], []))
            ack = json.loads(await asyncio.wait_for(ws.recv(), 3))
            assert ack["type"] == "error" and "queue" in ack["message"]
            server.apply_pending()
            assert adapter.nodes[1][12] == pytest.approx(1)  # frames 0 and 1 merged, 2 dropped
    run(sc, limits=Limits(max_queued_frames=2), tmp_path=tmp_path)


def test_server_refuses_non_loopback_bind():
    with pytest.raises(ValueError):
        LiveSyncServer(lambda: None, token="x", host="0.0.0.0")
