// plan-659 scaling spike — orchestrator.
//
// Spawns N worker PROCESSES, holds them at a barrier until every one of them
// has loaded, warmed up and restored the fixed start state, then releases them
// all at once and measures ONE wall-clock window with ONE clock (the parent's).
//
// Why processes and not worker_threads:
//   1. `onnxruntime-node` is a native addon with process-global state and its
//      own thread pool; `@mujoco/mujoco` is a single-threaded WASM build with
//      its own linear memory per instance. Neither gains anything from sharing
//      an address space.
//   2. It is the topology a real rollout farm uses (gym `SubprocVecEnv`), so
//      the number transfers to the question being asked.
//   3. A thread that blocks in a native call blocks nothing else here, so a
//      straggler is visible as a straggler instead of as jitter.
//
// Aggregate throughput = (sum of simulated seconds over all instances)
//                      / (wall clock from barrier release to the LAST instance
//                         finishing)
// Stragglers therefore count against the result, which is the honest reading of
// "aggregated throughput".

import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(HERE, 'worker.cjs');

function arg(k, d) {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
}

const NS = arg('ns', '1,2,4,8,16,24,32').split(',').map(Number);
const REPS = Number(arg('reps', '3'));
const EPISODES = Number(arg('episodes', '32'));
const STEPS = Number(arg('steps', '1500'));
const PIN = arg('pin', '1');
const LATENCY = arg('latency', '0');
const LOAD_SECONDS = Number(arg('loadSeconds', '13'));
const OUT = resolve(HERE, arg('out', 'scaling-results.json'));

/**
 * Mean/min/max host CPU load over `seconds`, sampled once per second.
 *
 * Deliberately long: language servers spike to 20-35 % for a second or two and
 * then fall away, so a 5 s sample cannot tell a burst from sustained load. The
 * counter is read through the CIM perf class, NOT `Get-Counter` — the latter
 * takes ENGLISH counter paths and fails on this German-locale host.
 */
function sampleLoad(seconds) {
  const ps = [
    '$s=@();',
    `for ($i=0; $i -lt ${seconds}; $i++) {`,
    "$v=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime;",
    '$s+=[double]$v; Start-Sleep -Seconds 1 };',
    '$st=$s | Measure-Object -Average -Minimum -Maximum;',
    '"{0:N2};{1:N2};{2:N2};{3}" -f $st.Average,$st.Minimum,$st.Maximum,($s -join ",")',
  ].join(' ');
  const r = spawnSyncCapture('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  const line = r.trim().split('\n').filter(Boolean).pop() ?? '';
  const [mean, min, max, samples] = line.split(';');
  const num = (x) => Number(String(x).replace(',', '.'));
  return {
    meanPct: num(mean),
    minPct: num(min),
    maxPct: num(max),
    samples: (samples ?? '').split(',').map(Number),
    seconds,
  };
}

function spawnSyncCapture(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24 });
  return r.stdout ?? '';
}

/** One measurement: N workers, barrier, one window. */
async function runOnce(n, tag) {
  const procs = [];
  const ready = new Map();
  const done = new Map();

  const readyAll = [];
  const doneAll = [];

  for (let i = 0; i < n; i++) {
    let resolveReady, resolveDone;
    readyAll.push(new Promise((r) => (resolveReady = r)));
    doneAll.push(new Promise((r) => (resolveDone = r)));

    const p = spawn(
      process.execPath,
      [
        WORKER,
        `--episodes=${EPISODES}`,
        `--steps=${STEPS}`,
        `--pin=${PIN}`,
        `--latency=${LATENCY}`,
        `--id=${i}`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Belt and braces alongside intraOpNumThreads=1: some ORT builds read
          // OpenMP's env instead of the session option.
          OMP_NUM_THREADS: PIN === '1' ? '1' : process.env.OMP_NUM_THREADS ?? '',
        },
      },
    );

    let buf = '';
    p.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          process.stderr.write(`[w${i}] ${line}\n`);
          continue;
        }
        if (msg.ev === 'ready') {
          ready.set(i, msg);
          resolveReady();
        } else if (msg.ev === 'done') {
          msg._tDoneParent = process.hrtime.bigint();
          done.set(i, msg);
          resolveDone();
        } else if (msg.ev === 'error') {
          process.stderr.write(`[w${i}] ERROR ${msg.message}\n`);
          resolveReady();
          resolveDone();
        }
      }
    });
    p.stderr.on('data', (c) => {
      const s = c.toString().trim();
      if (s) process.stderr.write(`[w${i}:err] ${s}\n`);
    });
    p.on('exit', (code) => {
      if (code !== 0 && !done.has(i)) {
        process.stderr.write(`[w${i}] exited ${code}\n`);
        resolveReady();
        resolveDone();
      }
    });
    procs.push(p);
  }

  await Promise.all(readyAll);
  if (ready.size !== n) throw new Error(`${tag}: only ${ready.size}/${n} workers became ready`);

  // Barrier release. One clock from here on.
  const tGo = process.hrtime.bigint();
  for (const p of procs) p.stdin.write('go\n');

  await Promise.all(doneAll);
  const tLast = process.hrtime.bigint();

  if (done.size !== n) throw new Error(`${tag}: only ${done.size}/${n} workers finished`);

  const windowS = Number(tLast - tGo) / 1e9;
  const results = [...done.values()].sort((a, b) => a.id - b.id);
  const simTotal = results.reduce((s, r) => s + r.simSeconds, 0);

  // Per-worker self-measured windows: their spread is the straggler measure.
  const selfWindows = results.map((r) => r.windowS);
  const selfThr = results.map((r) => r.selfThroughput);

  for (const p of procs) {
    try {
      p.stdin.end();
    } catch {}
  }

  return {
    n,
    windowS,
    simSecondsTotal: simTotal,
    aggregateThroughput: simTotal / windowS,
    perWorkerThroughputMean: selfThr.reduce((a, b) => a + b, 0) / selfThr.length,
    workerWindowMinS: Math.min(...selfWindows),
    workerWindowMaxS: Math.max(...selfWindows),
    stragglerSpreadPct: (Math.max(...selfWindows) / Math.min(...selfWindows) - 1) * 100,
    falls: results.reduce((s, r) => s + r.falls, 0),
    // Determinism guard: identical work means identical displacement. If this
    // is false the instances did NOT do the same work and the number is void.
    allWorkersSameDisplacement:
      results.every((r) => r.displacementXAllEqual) &&
      results.every((r) => r.displacementXFirst === results[0].displacementXFirst),
    displacementXFirst: results[0].displacementXFirst,
    loadMsMax: Math.max(...[...ready.values()].map((r) => r.loadMs)),
    warmMsMax: Math.max(...[...ready.values()].map((r) => r.warmMs)),
    latencyMedianMs: results[0].latencyMedianMs,
    latencyP95Ms: results[0].latencyP95Ms,
  };
}

const out = {
  plan: 659,
  what: 'parallel Microduck scaling (processes)',
  generatedAt: new Date().toISOString(),
  config: { ns: NS, reps: REPS, episodes: EPISODES, steps: STEPS, pin: PIN, latency: LATENCY },
  node: process.version,
  runs: [],
};

mkdirSync(HERE, { recursive: true });

for (const n of NS) {
  for (let rep = 0; rep < REPS; rep++) {
    const tag = `N=${n} rep=${rep + 1}`;
    process.stderr.write(`\n=== ${tag}: sampling host load (${LOAD_SECONDS}s) ===\n`);
    const load = sampleLoad(LOAD_SECONDS);
    process.stderr.write(
      `    load mean=${load.meanPct}% min=${load.minPct}% max=${load.maxPct}%\n`,
    );
    const r = await runOnce(n, tag);
    r.rep = rep + 1;
    r.baselineLoad = load;
    out.runs.push(r);
    process.stderr.write(
      `    => aggregate ${r.aggregateThroughput.toFixed(1)} sim-s/wall-s ` +
        `(window ${r.windowS.toFixed(2)}s, straggler spread ${r.stragglerSpreadPct.toFixed(1)}%, ` +
        `falls ${r.falls}, same-work ${r.allWorkersSameDisplacement})\n`,
    );
    writeFileSync(OUT, JSON.stringify(out, null, 2));
  }
}

// Summary table
process.stderr.write('\n==== SUMMARY ====\n');
process.stderr.write('N\tmedian\tmin\tmax\tspread%\tloadMean%\n');
for (const n of NS) {
  const rs = out.runs.filter((r) => r.n === n).map((r) => r.aggregateThroughput).sort((a, b) => a - b);
  if (!rs.length) continue;
  const med = rs[Math.floor(rs.length / 2)];
  const loads = out.runs.filter((r) => r.n === n).map((r) => r.baselineLoad.meanPct);
  process.stderr.write(
    `${n}\t${med.toFixed(1)}\t${rs[0].toFixed(1)}\t${rs[rs.length - 1].toFixed(1)}\t` +
      `${(((rs[rs.length - 1] - rs[0]) / med) * 100).toFixed(1)}\t` +
      `${(loads.reduce((a, b) => a + b, 0) / loads.length).toFixed(1)}\n`,
  );
}
writeFileSync(OUT, JSON.stringify(out, null, 2));
process.stderr.write(`\nwrote ${OUT}\n`);
