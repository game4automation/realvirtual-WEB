# DES RNG v2 reference vectors (plan-2060)

Provenance for the fixtures in `tests/des/fixtures/rng-v2/`. These are the exact scripts that produced and
cross-checked them on 2026-10-31. They are kept **unchanged** as evidence, not as maintained tooling.

**Layout they ran in:** a folder `vectors/` next to the WebViewer repo (`<root>/vectors/` beside
`<root>/realvirtual-WebViewer~/`). Relative paths inside the scripts (`../realvirtual-WebViewer~/...`) assume that
layout. To rerun, copy this folder to a sibling of the repo.

| Script | Produces / checks |
|---|---|
| `sfc32_practrand.py` | Line-by-line port of PractRand `src/RNGs/sfc.cpp` L78-91 (`raw32`, `seed(Uint64)`); self-check against simblob's compiled-PractRand outputs for `seed(12345)`; writes `sfc32-practrand-vectors.json` |
| `bryc-crosscheck.mjs` | Independent check: bryc's `sfc32` (shown output-identical to compiled PractRand by simblob 2022-05), seeded `(0, lo32, hi32, 1)` + 12 discards — all 192 fixture outputs match. Run: `node bryc-crosscheck.mjs <path to sfc32-practrand-vectors.json>` |
| `seedkey64.py` | Independent Python reference of `seedKey64` (plan-2060 § 2.3); writes `seedkey-vectors.json` |
| `legacy-sequences.ts`, `run-legacy-node.mjs` | Recorded `legacy-sequences.json` on the unchanged code before the rename (raw `SFC32`, stochastic Downtime) |
| `legacy-takt.ts` | Takt section of `legacy-sequences.json` through `deriveFleetRng('PlantA', …)`, masterSeed 7; run with imports resolved against the unchanged base 7dccdc0e |
| `check-legacy.ts`, `verify.ts` | Executor-side checks (legacy bit-identity, version validation) run outside vitest. The batch-host half of `verify.ts` (`DesBatchRunner`, commercial since plan-2211) lives in `realvirtual-WebViewer-Private~/tools/des-rng-vectors/verify-batch.ts` |

The downloaded third-party references (PractRand `sfc.cpp`, Contiki-NG `sfc32-prng.c`, the simblob article) are
not stored here; the PractRand file's SHA-256 is recorded in the fixture provenance.

Not done (no C compiler on the generating machine): a run of compiled PractRand itself against the fixture.
Optional on another machine: build `sfc.cpp`'s `sfc32` with any C++ compiler, print 32 outputs per fixture seed,
compare.
