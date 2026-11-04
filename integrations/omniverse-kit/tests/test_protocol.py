# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
"""Golden bytes TS <-> Python (plan-637 section 9, test_protocol.py)."""

import json
import os
import struct

import pytest

from realvirtual.livesync import protocol as P

GOLDEN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "golden_v1.json")


def _cases():
    with open(GOLDEN, "r", encoding="utf-8") as f:
        return {c["name"]: c for c in json.load(f)["cases"]}


def _f32(values):
    return tuple(struct.unpack("<16f", struct.pack("<16f", *values)))


def test_golden_mount_begin_decodes():
    c = _cases()["mountBegin"]
    msg = P.decode(bytes.fromhex(c["hex"]))
    i = c["input"]
    assert isinstance(msg, P.MountBegin)
    assert (msg.session, msg.compressed_bytes, msg.raw_bytes, msg.chunk_count) == (
        i["session"], i["compressedBytes"], i["rawBytes"], i["chunkCount"])
    assert msg.encoding == "gzip"
    assert msg.nodes == i["meta"]["nodes"]
    assert msg.templates == i["meta"]["templates"]
    assert msg.preplaced == [(7, 1)]


def test_golden_frame_decodes():
    c = _cases()["frame"]
    msg = P.decode(bytes.fromhex(c["hex"]))
    assert isinstance(msg, P.Frame)
    assert (msg.session, msg.seq) == (3, 42)
    assert msg.nodes == [(1, _f32(c["input"]["nodes"][0]["m"]))]
    assert msg.mus == [(9, _f32(c["input"]["mus"][0]["m"]))]


def test_golden_small_messages_decode():
    cases = _cases()
    spawn = P.decode(bytes.fromhex(cases["muSpawn"]["hex"]))
    assert isinstance(spawn, P.MuSpawn) and (spawn.mu_id, spawn.template_index) == (9, 0)
    assert spawn.matrix == _f32(cases["muSpawn"]["input"]["m"])
    delete = P.decode(bytes.fromhex(cases["muDelete"]["hex"]))
    assert isinstance(delete, P.MuDelete) and delete.mu_id == 9
    reset = P.decode(bytes.fromhex(cases["reset"]["hex"]))
    assert isinstance(reset, P.Reset) and reset.session == 3
    chunk = P.decode(bytes.fromhex(cases["mountChunk"]["hex"]))
    assert isinstance(chunk, P.MountChunk) and chunk.index == 1 and chunk.payload == bytes.fromhex("deadbeef")


def test_python_encoders_reproduce_golden():
    cases = _cases()
    mb = cases["mountBegin"]["input"]
    assert P.encode_mount_begin(
        mb["session"], mb["compressedBytes"], mb["rawBytes"], mb["chunkCount"], mb["meta"]["encoding"],
        mb["meta"]["nodes"], mb["meta"]["templates"],
        [(p["muId"], p["nodeIndex"]) for p in mb["meta"]["preplaced"]],
    ).hex() == cases["mountBegin"]["hex"]
    fr = cases["frame"]["input"]
    assert P.encode_frame(fr["session"], fr["seq"], [(n["index"], n["m"]) for n in fr["nodes"]],
                          [(m["muId"], m["m"]) for m in fr["mus"]]).hex() == cases["frame"]["hex"]


@pytest.mark.parametrize("data", [
    b"",
    bytes([P.FRAME]) + struct.pack("<I", 1),               # header only
    bytes([P.FRAME]) + struct.pack("<IIII", 1, 0, 5, 0),   # claims 5 nodes, has none
    bytes([P.MU_DELETE]) + struct.pack("<I", 1),           # missing muId
    bytes([0x7F]) + struct.pack("<I", 1),                  # unknown type
    bytes([P.MOUNT_BEGIN]) + struct.pack("<IIII", 1, 1, 1, 1) + b"{not json",
])
def test_malformed_messages_raise(data):
    with pytest.raises(P.ProtocolError):
        P.decode(data)


def test_hello_parsing():
    h = P.parse_hello(json.dumps({"v": 1, "token": "abc", "client": "realvirtual-web", "rateHz": 30}))
    assert h is not None and h.token == "abc" and h.rate_hz == 30
    assert P.parse_hello("not json") is None
    assert P.parse_hello(json.dumps({"v": 1})) is None


# ── ready ack (Phase 6) ──

def test_ready_ack_matches_golden_text():
    with open(GOLDEN, "r", encoding="utf-8") as f:
        golden = json.load(f)["readyAck"]["text"]
    assert P.ready_ack("0.2.0") == golden
    assert json.loads(golden) == {"type": "ready", "extVersion": "0.2.0", "protocol": P.PROTOCOL_VERSION}


def test_other_acks_carry_no_version_fields():
    assert json.loads(P.ack("mounted", session=3)) == {"type": "mounted", "session": 3}


def test_version_reader(tmp_path):
    from realvirtual.livesync.version import UNKNOWN_VERSION, read_extension_version

    toml = tmp_path / "extension.toml"
    toml.write_text(
        '[dependencies]\nversion = "9.9.9"\n[package]\ntitle = "x"\nversion = "1.2.3"\n', encoding="utf-8"
    )
    assert read_extension_version(str(toml)) == "1.2.3"
    assert read_extension_version(str(tmp_path / "missing.toml")) == UNKNOWN_VERSION
