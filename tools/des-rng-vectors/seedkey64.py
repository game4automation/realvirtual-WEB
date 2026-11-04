"""Independent plan-2060 section 2.3 reference; no TypeScript inputs."""
import json
import math
import unicodedata
from pathlib import Path

MASK = (1 << 64) - 1


def seed_key64(seed, identity, purpose):
    if not math.isfinite(seed):
        raise ValueError('non-finite seed')
    data = b'rv-rng-v2\0' + (math.trunc(seed) & MASK).to_bytes(8, 'little')
    for field in (identity, purpose):
        encoded = unicodedata.normalize('NFC', field).encode('utf-8')
        data += len(encoded).to_bytes(4, 'little') + encoded
    z = 0xcbf29ce484222325
    for byte in data:
        z = ((z ^ byte) * 0x100000001b3) & MASK
    z = ((z ^ (z >> 30)) * 0xbf58476d1ce4e5b9) & MASK
    z = ((z ^ (z >> 27)) * 0x94d049bb133111eb) & MASK
    return z ^ (z >> 31)


if __name__ == '__main__':
    inputs = [(0, '', ''), (42, 'Line/StationA', 'default'),
              (42, 'Line/StationA', 'downtime:mtbf'), (43, 'Line/StationA', 'default'),
              (-1, 'A', 'x'), (2**53-1, 'A', 'x'), (7, 'ab', 'c'), (7, 'a', 'bc'),
              (42, 'Linie/\u00c4', 'default'), (42, 'Linie/A\u0308', 'default'),
              (42, 'A', ''), (-1.9, 'A', 'x'), (42.9, 'A', 'x')]
    data = dict(provenance=dict(spec='plan-2060 section 2.3',
        implementation='Independent Python: NFC UTF-8, length framing, FNV-1a64, SplitMix64 finalizer',
        command='python vectors/seedkey64.py'),
        vectors=[dict(masterSeed=s, id=i, purpose=p, expected=str(seed_key64(s, i, p)))
                 for s, i, p in inputs])
    target = Path(__file__).resolve().parent.parent / 'realvirtual-WebViewer~/tests/des/fixtures/rng-v2/seedkey-vectors.json'
    target.write_text(json.dumps(data, indent=2) + '\n')
