# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Wire format v1 of the realvirtual USD live link (plan-637 section 2.3).

Python twin of ``src/plugins/usd-live-link/livesync-protocol.ts`` in
realvirtual WEB. Both are pinned to the same golden bytes
(``integrations/omniverse-kit/tests/golden_v1.json``).

Binary frames are little endian; byte 0 is the message type, followed by
``u32 session``. ``hello`` and ``ack`` are JSON text frames.

Pure Python (``struct`` + ``json``) - importable without Kit.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

PROTOCOL_VERSION = 1
#: Default TCP port (8765 before 2026-10-21; it collided with other local services).
DEFAULT_PORT = 8775

MOUNT_BEGIN = 0x01
MOUNT_CHUNK = 0x02
FRAME = 0x03
MU_SPAWN = 0x04
MU_DELETE = 0x05
RESET = 0x06

MATRIX_FLOATS = 16
ENTRY_BYTES = 4 + MATRIX_FLOATS * 4

_HDR = struct.Struct("<BI")
_U32 = struct.Struct("<I")
_MAT = struct.Struct("<16f")


class ProtocolError(ValueError):
    """A malformed message."""


Matrix = Tuple[float, ...]


@dataclass
class MountBegin:
    session: int
    compressed_bytes: int
    raw_bytes: int
    chunk_count: int
    encoding: str
    nodes: List[str]
    templates: List[str]
    preplaced: List[Tuple[int, int]]  # (muId, nodeIndex)


@dataclass
class MountChunk:
    session: int
    index: int
    payload: bytes


@dataclass
class Frame:
    session: int
    seq: int
    nodes: List[Tuple[int, Matrix]] = field(default_factory=list)
    mus: List[Tuple[int, Matrix]] = field(default_factory=list)


@dataclass
class MuSpawn:
    session: int
    mu_id: int
    template_index: int
    matrix: Matrix


@dataclass
class MuDelete:
    session: int
    mu_id: int


@dataclass
class Reset:
    session: int


Message = object  # one of the dataclasses above


def decode(data: bytes) -> Message:
    """Decode one binary message; raises ProtocolError on malformed input."""
    n = len(data)
    if n < _HDR.size:
        raise ProtocolError("message too short")
    mtype, session = _HDR.unpack_from(data, 0)
    try:
        if mtype == MOUNT_BEGIN:
            if n < 17:
                raise ProtocolError("mountBegin too short")
            compressed, raw, count = struct.unpack_from("<III", data, 5)
            meta = json.loads(bytes(data[17:]).decode("utf-8"))
            if not isinstance(meta, dict):
                raise ProtocolError("mountBegin meta is not an object")
            encoding = meta.get("encoding", "identity")
            if encoding not in ("gzip", "identity"):
                raise ProtocolError("unknown encoding %r" % (encoding,))
            nodes = meta.get("nodes", [])
            templates = meta.get("templates", [])
            if not all(isinstance(p, str) for p in nodes) or not all(isinstance(p, str) for p in templates):
                raise ProtocolError("prim paths must be strings")
            preplaced = []
            for item in meta.get("preplaced", []):
                preplaced.append((int(item["muId"]), int(item["nodeIndex"])))
            return MountBegin(session, compressed, raw, count, encoding, nodes, templates, preplaced)
        if mtype == MOUNT_CHUNK:
            if n < 9:
                raise ProtocolError("mountChunk too short")
            (index,) = _U32.unpack_from(data, 5)
            return MountChunk(session, index, bytes(data[9:]))
        if mtype == FRAME:
            if n < 17:
                raise ProtocolError("frame too short")
            seq, count = struct.unpack_from("<II", data, 5)
            off = 13
            if off + count * ENTRY_BYTES + 4 > n:
                raise ProtocolError("frame truncated")
            nodes = []
            for _ in range(count):
                (idx,) = _U32.unpack_from(data, off)
                nodes.append((idx, _MAT.unpack_from(data, off + 4)))
                off += ENTRY_BYTES
            (mcount,) = _U32.unpack_from(data, off)
            off += 4
            if off + mcount * ENTRY_BYTES != n:
                raise ProtocolError("frame length mismatch")
            mus = []
            for _ in range(mcount):
                (mid,) = _U32.unpack_from(data, off)
                mus.append((mid, _MAT.unpack_from(data, off + 4)))
                off += ENTRY_BYTES
            return Frame(session, seq, nodes, mus)
        if mtype == MU_SPAWN:
            if n != 13 + 64:
                raise ProtocolError("muSpawn has wrong length")
            mu_id, tpl = struct.unpack_from("<II", data, 5)
            return MuSpawn(session, mu_id, tpl, _MAT.unpack_from(data, 13))
        if mtype == MU_DELETE:
            if n != 9:
                raise ProtocolError("muDelete has wrong length")
            (mu_id,) = _U32.unpack_from(data, 5)
            return MuDelete(session, mu_id)
        if mtype == RESET:
            if n != 5:
                raise ProtocolError("reset has wrong length")
            return Reset(session)
    except (struct.error, KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(str(exc)) from exc
    raise ProtocolError("unknown message type %d" % mtype)


# ── encoders (tests, other clients) ──────────────────────────────────────

def _header(mtype: int, session: int) -> bytes:
    return _HDR.pack(mtype, session & 0xFFFFFFFF)


def encode_mount_begin(session, compressed_bytes, raw_bytes, chunk_count, encoding, nodes, templates, preplaced) -> bytes:
    meta = {
        "encoding": encoding,
        "nodes": list(nodes),
        "templates": list(templates),
        "preplaced": [{"muId": m, "nodeIndex": i} for m, i in preplaced],
    }
    body = json.dumps(meta, separators=(",", ":")).encode("utf-8")
    return _header(MOUNT_BEGIN, session) + struct.pack("<III", compressed_bytes, raw_bytes, chunk_count) + body


def encode_mount_chunk(session: int, index: int, payload: bytes) -> bytes:
    return _header(MOUNT_CHUNK, session) + _U32.pack(index) + bytes(payload)


def encode_frame(session: int, seq: int, nodes, mus) -> bytes:
    parts = [_header(FRAME, session), struct.pack("<II", seq, len(nodes))]
    for idx, m in nodes:
        parts.append(_U32.pack(idx) + _MAT.pack(*m))
    parts.append(_U32.pack(len(mus)))
    for mid, m in mus:
        parts.append(_U32.pack(mid) + _MAT.pack(*m))
    return b"".join(parts)


def encode_mu_spawn(session: int, mu_id: int, template_index: int, matrix) -> bytes:
    return _header(MU_SPAWN, session) + struct.pack("<II", mu_id, template_index) + _MAT.pack(*matrix)


def encode_mu_delete(session: int, mu_id: int) -> bytes:
    return _header(MU_DELETE, session) + _U32.pack(mu_id)


def encode_reset(session: int) -> bytes:
    return _header(RESET, session)


# ── text frames ──────────────────────────────────────────────────────────

@dataclass
class Hello:
    v: int
    token: str
    client: str
    rate_hz: float


def parse_hello(text: str) -> Optional[Hello]:
    """Parse a hello text frame; None when it is not a valid hello."""
    try:
        obj = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    token = obj.get("token")
    if not isinstance(token, str) or not isinstance(obj.get("v"), int):
        return None
    rate = obj.get("rateHz", 30)
    return Hello(obj["v"], token, str(obj.get("client", "")), float(rate) if isinstance(rate, (int, float)) else 30.0)


def ack(
    kind: str,
    session: Optional[int] = None,
    message: Optional[str] = None,
    applied_hz: Optional[float] = None,
    ext_version: Optional[str] = None,
    protocol: Optional[int] = None,
) -> str:
    """Encode an ack text frame (``ready`` / ``mounted`` / ``error``).

    ``ready`` carries ``extVersion`` and ``protocol`` (extension >= 0.2.0): the
    viewer hints at a newer download when the version is too old and refuses
    to mount when the protocol differs.
    """
    obj = {"type": kind}
    if session is not None:
        obj["session"] = session
    if message is not None:
        obj["message"] = message
    if applied_hz is not None:
        obj["appliedHz"] = round(applied_hz, 1)
    if ext_version is not None:
        obj["extVersion"] = ext_version
    if protocol is not None:
        obj["protocol"] = protocol
    return json.dumps(obj)


def ready_ack(ext_version: str) -> str:
    """The ``ready`` ack after a valid hello: extension version + protocol version."""
    return ack("ready", ext_version=ext_version, protocol=PROTOCOL_VERSION)
