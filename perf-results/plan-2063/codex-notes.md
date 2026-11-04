# Auffaelligkeiten

- The JSON machine metadata records commit 75c4a183 and OS Windows_NT 10.0.26200; origin/main 9a1b2ed7, Windows 11, the power plan and pre-run CPU load are supplied measurement context, not separately recorded JSON fields.
- At n=8, allocated MU slots change from 50 (8 hours) to 51 (80 hours), while live MUs remain 38. The documentation preserves this distinction; MU slots are not cumulative production.
- Doubling n from 8 to 16 does not double processed events: 210,301 versus 290,864 over 8 hours. Size is not a linear work multiplier; do not extrapolate throughput or supported size.
- The warehouse is snapshot-only. Its zero throughput fields do not measure simulation throughput. Warehouse snapshot medians differ between the reports; all three are shown in developer documentation, and the main sizes report is explicitly selected for the user text.
- AGV snapshot and restore are unsupported, not slow. Therefore a claim that all acceptance criteria passed for PalletYard would be misleading: only speed and sampled heap were evaluated there.
- The longer run has only 2 repeats. Its median is their mean; independently aggregated rates need not equal ratios of aggregate medians. Min/max are observed repeat spread, not confidence intervals.
- The debugging guide already has a 4f Journeys section and 4g references. The requested 4f DES section is inserted after 4e with its distinct title/anchor; existing section numbering and references are preserved.
- Stable post-GC heap across these durations supports garbage peaks rather than a retained-heap leak in these runs; it cannot prove universal leak freedom. JIT warm-up is an interpretation of duration-dependent throughput, not a separately profiled metric.
