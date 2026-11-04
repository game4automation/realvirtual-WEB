"""Independent line-by-line PractRand sfc32 reference (unsigned arithmetic)."""
import hashlib
import json
from pathlib import Path

MASK = (1 << 32) - 1


class SFC32:
    def __init__(self, seed):
        self.a = 0
        self.b = seed & MASK
        self.c = (seed >> 32) & MASK
        self.counter = 1
        for _ in range(12):
            self.raw32()

    def raw32(self):
        tmp = (self.a + self.b + self.counter) & MASK
        self.counter = (self.counter + 1) & MASK
        self.a = (self.b ^ (self.b >> 9)) & MASK
        self.b = (self.c + (self.c << 3)) & MASK
        self.c = (((self.c << 21) | (self.c >> 11)) + tmp) & MASK
        return tmp


# Read comparison with Contiki-NG sfc32-prng.c: identical 32-bit step and seed.
# Its rand() exposes low/high 16-bit halves on alternating calls, so its 24
# warm-up calls perform exactly PractRand's 12 raw32 steps.
if __name__ == '__main__':
    check = SFC32(12345)
    expected = [235160590, 2967261163, 116171463, 2882324903, 362604721,
                4227106926, 1933307004, 1608300071, 2256615412, 2701957640]
    actual = [check.raw32() for _ in expected]
    assert actual == expected, f'STOP: simblob mismatch: {actual}'
    print('seed(12345): all 10 simblob reference outputs match')
    root = Path(__file__).resolve().parent
    vectors = []
    for seed in [0, 1, 42, 12345, 2**32 + 7, 2**63 - 1]:
        rng = SFC32(seed)
        state = vars(rng).copy()
        vectors.append(dict(seed=str(seed), state=state,
                            outputs=[rng.raw32() for _ in range(32)]))
    data = dict(provenance=dict(
        source='PractRand src/RNGs/sfc.cpp lines 78-91 (master download)',
        sha256=hashlib.sha256((root / 'ref/practrand-sfc.cpp').read_bytes()).hexdigest(),
        crossCheck='simblob compiled PractRand seed(12345): 10 outputs match; Contiki-NG step and warmup agree',
        command='python vectors/sfc32_practrand.py'), vectors=vectors)
    target = root.parent / 'realvirtual-WebViewer~/tests/des/fixtures/rng-v2'
    target.mkdir(parents=True, exist_ok=True)
    (target / 'sfc32-practrand-vectors.json').write_text(json.dumps(data, indent=2) + '\n')
