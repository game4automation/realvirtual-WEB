=== reliability.md: replacement for the sentence "No measured performance limits are published on this page yet." ===

Headless FastForward measurements reached a yard with 24 vehicles and 96 stations without finding a computation performance limit. These results describe the reference machine and do not predict interactive animation speed.

| Measured yard | Vehicles | Stations | Events/s | Sim-h/wall-h |
|---|---|---|---|---|
| n=1, 8 Sim-h | 2 | 6 | 91,894 | 113,879 |
| n=16, 8 Sim-h | 24 | 96 | 168,091 | 16,644 |
| n=8, 80 Sim-h | 12 | 48 | 161,242 | 22,349 |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Rounded medians; 8-hour runs have 3 repeats, the 80-hour run has 2.

Vehicle installations cannot currently be snapshotted or restored from a full snapshot. There are no snapshot timing or size measurements for these vehicle models. A separate vehicle-free warehouse snapshot is not representative of vehicle installations. See *Model size and limits* on the Overview page (`overview.md#model-size-and-limits`) for the full measured range, criteria and memory results.

=== overview.md: new section "## Model size and limits" ===

## Model size and limits

The following yard models were measured in FastForward with rendering disabled. Sim-h/wall-h means simulated hours completed per hour of real elapsed computation time; Events/s measures simulation events, not vehicle deliveries.

| n | Sim-h | Vehicles | Stations | Events/s | Sim-h/wall-h | Heap peak / after GC MB |
|---|---|---|---|---|---|---|
| 1 | 8 | 2 | 6 | 91,894 | 113,879 | 170.86 / 65.49 |
| 2 | 8 | 3 | 12 | 109,436 | 70,658 | 175.11 / 66.84 |
| 4 | 8 | 6 | 24 | 129,160 | 38,606 | 178.99 / 69.32 |
| 8 | 8 | 12 | 48 | 138,520 | 18,970 | 239.63 / 73.07 |
| 16 | 8 | 24 | 96 | 168,091 | 16,644 | 276.02 / 79.95 |
| 8 | 80 | 12 | 48 | 161,242 | 22,349 | 427.83 / 73.10 |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Values are rounded medians; 8 Sim-h = 28,800 Sim-s (3 repeats), 80 Sim-h = 288,000 Sim-s (2 repeats). MB is decimal. Heap peak is sampled; after GC is retained heap.

The acceptance criterion is FastForward >= 100 Sim-h per wall-clock hour, snapshot < 1 s and < 50 MB, and heap < 1 GB. No measured value breaches these thresholds, including the repeat maxima for heap and snapshot and minima for speed. Snapshot thresholds apply only to the vehicle-free warehouse: they cannot be evaluated for PalletYard. Measurements reach n=16 (24 vehicles, 96 stations), the maximum of the measured yard generator; no performance limit was found within that range. This does not establish support for larger models. These are pure headless DES computation measurements without rendering. Browser rendering and Animated mode were not measured.

Events/s rises from 91,894 at n=1 to 168,091 at n=16. The short 8-hour runs take less than 2 wall-clock seconds and are affected by JIT warm-up; the longer n=8 run reaches a steadier 161,242 Events/s versus 138,520 for 8 hours. This is not evidence that larger models inherently cost less per event. At n=8 the sampled heap peak grows from 239.63 MB (8 hours) to 427.83 MB (80 hours), while heap after GC stays nearly flat: 73,073,608 versus 73,104,408 bytes (73.07 versus 73.10 MB). These runs show garbage peaks without evidence of a retained-heap leak; they do not prove absence of leaks in all workloads.

Vehicle installations cannot currently be snapshotted or restored from a full snapshot. There are no snapshot timing or size measurements for these vehicle models. A separate vehicle-free warehouse snapshot is not representative of vehicle installations. The separate warehouse contained 300 Storage components, 3,000 MUs and 2,000 open events, with no vehicles. In the reference run with 3 repeats, median snapshot time was 7.9 ms (7.7 to 8.0 ms), size 2,077,366 bytes (unchanged across repeats), and restore time 18.3 ms (18.2 to 18.7 ms). These warehouse measurements meet the snapshot criterion only for that vehicle-free model.
