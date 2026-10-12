#!/usr/bin/env bash
# plan-469 Phase 0d realistic-scene campaign. Driven against ONE warm Vite
# (--base), so no cell pays a cold module-graph transform.
set -u
cd "$(dirname "$0")/.."
BASE="--base http://localhost:5469 --mu 2400 --duration 120"
LOG=.perf-logs/campaign.log

S0="--geometry primitive --muasset primitive --robots 0  --robotmotion static  --shadows on"
S1="--geometry library   --muasset cartonbox --robots 0  --robotmotion static  --shadows on"
S2="--geometry library   --muasset cartonbox --robots 100 --robotmotion static  --shadows on"
S3="--geometry library   --muasset cartonbox --robots 100 --robotmotion erratic --shadows off"
S4="--geometry library   --muasset cartonbox --robots 100 --robotmotion erratic --shadows on"

run() {  # run <name> <runs> <hooks> <args...>
  local name="$1"; shift
  local runs="$1"; shift
  local hooks="$1"; shift
  echo "=== $(date +%H:%M:%S) START $name" >> "$LOG"
  node scripts/perf-scale-matrix.mjs $BASE --runs "$runs" --hooks "$hooks" "$@" \
    --out "2026-09-08-plan469-realistic-$name" >> "$LOG" 2>&1
  echo "=== $(date +%H:%M:%S) END $name exit=$?" >> "$LOG"
}

# Pass A - ascending ladder, hooks on, 3 runs (the +-5 % occupancy check needs
# at least three).
run A-S0 3 on $S0
run A-S1 3 on $S1
run A-S2 3 on $S2
run A-S3 3 on $S3
run A-S4 3 on $S4

# Pass B - the SAME ladder in reverse, one run each. Its only job is the drift
# reference: the machine moved 50 % over three hours the evening before, so every
# stage needs a measurement taken at a DIFFERENT time in the session.
run B-S4 1 on $S4
run B-S3 1 on $S3
run B-S2 1 on $S2
run B-S1 1 on $S1
run B-S0 1 on $S0

# Per-robot cost: S3 configuration, robots as the only axis.
run robotscale 2 on --geometry library --muasset cartonbox --robotmotion erratic --shadows off --robots 0,25,50,100

# Instrumentation price at both ends of the ladder.
run OFF-S0 1 off $S0
run OFF-S4 1 off $S4

echo "=== $(date +%H:%M:%S) CAMPAIGN DONE" >> "$LOG"
echo "CAMPAIGN_EXIT=0" >> "$LOG"
