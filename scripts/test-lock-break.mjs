// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `node scripts/test-lock.mjs break` — frees the machine-wide test lock from a HUNG holder.
 *
 *   node scripts/test-lock.mjs break [--port N] [--dry-run] [--min-age-minutes 30] [--idle-seconds 60]
 *
 * The OS frees the lock port when the holding process dies — but a holder that hangs without
 * dying keeps it (2026-10-27: a bare `npx vitest run`, PID 7388, held 127.0.0.1:47177 for six
 * hours and blocked five agents). This command ends such a holder, and nothing else:
 *
 * 1. the PID LISTENING on `127.0.0.1:<port>` comes from `netstat -ano -p TCP` (a listener is
 *    the row whose foreign address is `0.0.0.0:0` — the state column is localised); nobody
 *    listening → "free", exit 0;
 * 2. command line, creation time, parent and CPU time of every process come from
 *    `Get-CimInstance Win32_Process` (PowerShell via `execFile`, a constant `-EncodedCommand`);
 * 3. it REFUSES (exit 2, printing why) unless ALL hold:
 *    (a) the holder's command line is a test process (vitest, with-test-lock.mjs, run-all-tests);
 *    (b) the holder is at least `--min-age-minutes` old (default 30, floor 10);
 *    (c) the run is IDLE: the summed CPU time (user + kernel) of the kill target's whole tree —
 *        the holder, all its descendants and the test ancestors above it — grows by less than
 *        1 s between two samples `--idle-seconds` apart (default 60, floor 10), and that tree
 *        neither gains nor loses a process in between;
 * 4. the kill target is the TOPMOST ancestor whose command line still belongs to the same test
 *    invocation (`npx vitest`, `cmd.exe /c vitest …`, `bash …/npx vitest`, `with-test-lock`,
 *    `run-all-tests`), so the whole npx → cmd → node tree goes. The climb stops below anything
 *    else — a Claude Code shell (`bash -c "source …shell-snapshots…"`), claude.exe, node running
 *    any other script, `npm`, `timeout`, Unity, CONNECT;
 * 5. `taskkill /PID <target> /T /F` (execFile with an argument array — Git Bash would mangle
 *    `/PID` in a shell string);
 * 6. the port is checked again and everything that was ended is printed. `--dry-run` prints the
 *    decision and the target without killing (exit 0 when it would kill, 2 when it refuses).
 *
 * The decision (`decideBreak`) is a pure function over process-table snapshots, unit-tested in
 * `tests/test-lock-break.node.test.ts` with fake tables. Windows only (the dev machines); on any
 * other platform it refuses with exit 2 instead of guessing.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const LOCK_HOST = '127.0.0.1';
export const DEFAULT_MIN_AGE_MINUTES = 30;
export const DEFAULT_IDLE_SECONDS = 60;
export const MIN_AGE_FLOOR_MINUTES = 10;
export const IDLE_FLOOR_SECONDS = 10;
/** CPU seconds the whole tree may use during the idle window (exclusive). */
export const IDLE_CPU_LIMIT_SECONDS = 1;
export const REFUSED_EXIT_CODE = 2;
const MAX_CHAIN = 12;
const FREE_WAIT_MS = 10_000;
const PRINT_MAX = 240;

const execFileP = promisify(execFile);

// ─── command-line classification (pure) ─────────────────────────────────────

/**
 * Splits a Windows command line into arguments: whitespace (newlines included) separates,
 * double quotes group, `\"` is a literal quote, every other backslash is literal.
 */
export function splitCommandLine(line) {
  const out = [];
  const s = String(line ?? '');
  let cur = '';
  let has = false;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '"') { cur += '"'; i++; has = true; continue; }
    if (c === '"') { quoted = !quoted; has = true; continue; }
    if (!quoted && /\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/** Lower-case file name of a path (either slash), without `.exe` / `.cmd` / `.bat`. */
function baseName(p) {
  return String(p ?? '').split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

const yes = (kind) => ({ test: true, kind, why: kind });
const no = (why) => ({ test: false, kind: null, why });

// node options that take their value as the NEXT argument; -e/-p carry inline code, never a test.
const NODE_VALUE_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--title', '--env-file']);
const NODE_EVAL_OPTIONS = new Set(['-e', '--eval', '-p', '--print']);
const NPX_VALUE_OPTIONS = new Set(['-p', '--package', '-c', '--call', '--cache', '--userconfig', '--prefix']);
const TEST_SCRIPTS = new Map([
  ['vitest.mjs', 'vitest'],
  ['with-test-lock.mjs', 'with-test-lock'],
  ['run-all-tests.mjs', 'run-all-tests'],
]);

/** Index and value of the first non-option argument (`--` ends the options). */
function firstPositional(args, valueOptions) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return { index: i + 1, value: args[i + 1] };
    if (a.startsWith('-')) {
      if (valueOptions.has(a)) i++;
      continue;
    }
    return { index: i, value: a };
  }
  return { index: -1, value: undefined };
}

const isVitestPackage = (arg) => {
  const a = String(arg ?? '').toLowerCase();
  return a === 'vitest' || a.startsWith('vitest@');
};

function classifyNpxArgs(args) {
  const pkg = firstPositional(args, NPX_VALUE_OPTIONS).value;
  return isVitestPackage(pkg) ? yes('npx vitest') : no(`npx ${pkg ?? '(no package)'} — not vitest`);
}

function classifyArgv(argv) {
  const [exe, ...args] = argv;
  const name = baseName(exe);
  if (name === 'node' || name === 'nodejs') {
    const { index, value } = firstPositional(args, NODE_VALUE_OPTIONS);
    const nodeOptions = index < 0 ? args : args.slice(0, index);
    if (nodeOptions.some((a) => NODE_EVAL_OPTIONS.has(a) || /^--(eval|print)=/.test(a))) return no('node running inline code (-e / -p)');
    if (!value) return no('node without a script');
    const script = baseName(value);
    if (TEST_SCRIPTS.has(script)) return yes(TEST_SCRIPTS.get(script));
    if (script === 'npx-cli.js') return classifyNpxArgs(args.slice(index + 1));
    return no(`node running ${value} — not a test script`);
  }
  if (name === 'vitest') return yes('vitest');
  if (name === 'npx') return classifyNpxArgs(args);
  if (name === 'bash' || name === 'sh') {
    // `bash -c …` / `-lc` / `-ic`: a shell running a command string (a Claude Code shell, a hook,
    // a user script) — never part of one test invocation, whatever the string contains.
    if (args.some((a) => /^-[a-z]*c[a-z]*$/i.test(a))) return no('a shell running -c (e.g. a Claude Code shell) — never a kill target');
    // Git Bash interpreting the `npx` shim: `bash.exe /c/Program Files/nodejs/npx vitest …`. An
    // unquoted MSYS path with spaces splits into several arguments — rejoin up to four of them.
    const positional = args.filter((a) => !a.startsWith('-'));
    for (let n = 1; n <= Math.min(4, positional.length - 1); n++) {
      if (baseName(positional.slice(0, n).join(' ')) === 'npx') {
        return isVitestPackage(positional[n]) ? yes('bash npx vitest') : no(`bash npx ${positional[n]} — not vitest`);
      }
    }
    return no(`${name} running ${positional[0] ?? '(nothing)'} — not npx vitest`);
  }
  return no(`${exe ? baseName(exe) : '(empty)'} is not a test command`);
}

/** Raw end offset of the first argument (the executable) in a command line. */
function firstTokenEnd(text) {
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    return close < 0 ? text.length : close + 1;
  }
  const m = /\s/.exec(text);
  return m ? m.index : text.length;
}

/**
 * Is this command line part of a test invocation? → `{ test, kind, why }`.
 *
 * Structural, never a substring match: the executable decides how the rest is read, so a
 * Claude Code shell whose `-c` string mentions vitest, or a node process running some other
 * script with `vitest` among its arguments, is NOT a test command.
 */
export function classifyCommandLine(line, depth = 0) {
  const text = String(line ?? '').trim();
  if (!text) return no('no command line (a process of another user, a protected process, or gone)');
  if (/shell-snapshots/i.test(text)) return no('a Claude Code shell — never a kill target');
  if (depth > 3) return no('command nested too deep');
  const exeEnd = firstTokenEnd(text);
  if (baseName(text.slice(0, exeEnd).replace(/"/g, '')) === 'cmd') {
    const rest = text.slice(exeEnd);
    const m = /(?:^|\s)\/c(?:\s+|(?="))/i.exec(rest);
    if (!m) return no('cmd.exe without /c');
    let inner = rest.slice(m.index + m[0].length).trim();
    if (inner.length >= 2 && inner.startsWith('"') && inner.endsWith('"')) inner = inner.slice(1, -1); // the /s rule
    const cls = classifyCommandLine(inner, depth + 1);
    return cls.test ? yes(`cmd /c ${cls.kind}`) : no(`cmd /c: ${cls.why}`);
  }
  return classifyArgv(splitCommandLine(text));
}

// ─── process tree (pure) ────────────────────────────────────────────────────

/**
 * A snapshot is `{ takenAt: ms, processes: [{ pid, ppid, name, commandLine, createdMs, cpuSeconds }] }`.
 */
function indexProcesses(processes) {
  const byPid = new Map();
  for (const p of processes) byPid.set(p.pid, p);
  return byPid;
}

/** The real parent, or null: a ParentProcessId whose process is YOUNGER than the child is a recycled pid. */
function parentOf(proc, byPid) {
  const parent = byPid.get(proc.ppid);
  if (!parent || parent.pid === proc.pid) return null;
  if (Number(parent.createdMs) > Number(proc.createdMs)) return null;
  return parent;
}

/** `rootPid` and all its descendants (root first), by parent links. */
export function subtreeOf(rootPid, processes) {
  const byPid = indexProcesses(processes);
  const root = byPid.get(rootPid);
  if (!root) return [];
  const children = new Map();
  for (const p of processes) {
    const parent = parentOf(p, byPid);
    if (!parent) continue;
    if (!children.has(parent.pid)) children.set(parent.pid, []);
    children.get(parent.pid).push(p);
  }
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push(p);
    stack.push(...(children.get(p.pid) ?? []));
  }
  return out;
}

/**
 * Climbs from the holder while the parent is still a test command. → `{ target, chain, stop }`:
 * `chain` runs holder → target, `stop` names the first process NOT climbed to and why.
 */
export function findKillTarget(holderPid, processes) {
  const byPid = indexProcesses(processes);
  const holder = byPid.get(holderPid);
  if (!holder) return null;
  const chain = [holder];
  const seen = new Set([holder.pid]);
  let stop = null;
  for (let cur = holder; ;) {
    const parent = parentOf(cur, byPid);
    if (!parent || seen.has(parent.pid)) {
      stop = { pid: cur.ppid, name: null, why: byPid.has(cur.ppid) && !seen.has(cur.ppid) ? 'parent PID reused by a younger process' : 'parent is gone' };
      break;
    }
    const cls = classifyCommandLine(parent.commandLine);
    if (!cls.test) {
      stop = { pid: parent.pid, name: parent.name ?? null, why: cls.why };
      break;
    }
    if (chain.length >= MAX_CHAIN) {
      stop = { pid: parent.pid, name: parent.name ?? null, why: `chain limit of ${MAX_CHAIN}` };
      break;
    }
    chain.push(parent);
    seen.add(parent.pid);
    cur = parent;
  }
  return { target: chain[chain.length - 1], chain, stop };
}

const treeKey = (tree) => tree.map((p) => `${p.pid}@${p.createdMs}`).sort().join(',');
const treeCpu = (tree) => tree.reduce((sum, p) => sum + (Number(p.cpuSeconds) || 0), 0);

/**
 * The break decision (pure). `before` / `after` are process snapshots `idle-seconds` apart.
 * Without `after` only (a) and (b) are judged: `action` is then `'sample'` (passes so far — take
 * the second sample) or `'refuse'`. With `after`: `'kill'` or `'refuse'`.
 *
 * → `{ action, reasons, holder, holderKind, target, chain, stop, ageMinutes, cpuDeltaSeconds, sampledSeconds, tree }`
 */
export function decideBreak({
  holderPid,
  before,
  after = null,
  minAgeMinutes = DEFAULT_MIN_AGE_MINUTES,
  idleCpuLimitSeconds = IDLE_CPU_LIMIT_SECONDS,
  selfPid = null,
}) {
  const reasons = [];
  const result = {
    action: 'refuse', reasons, holder: null, holderKind: null, target: null, chain: [], stop: null,
    ageMinutes: null, cpuDeltaSeconds: null, sampledSeconds: null, tree: [],
  };
  const holder = indexProcesses(before.processes).get(holderPid) ?? null;
  result.holder = holder;
  if (!holder) {
    reasons.push(`the holder PID ${holderPid} is not in the process table`);
    return result;
  }

  const cls = classifyCommandLine(holder.commandLine);
  result.holderKind = cls.kind;
  if (!cls.test) reasons.push(`(a) the holder is not a test process: ${cls.why}`);
  result.ageMinutes = Number(holder.createdMs) > 0 ? (before.takenAt - Number(holder.createdMs)) / 60_000 : NaN;
  if (!Number.isFinite(result.ageMinutes)) {
    reasons.push('(b) the holder\'s creation time is unknown');
  } else if (!(result.ageMinutes >= minAgeMinutes)) {
    reasons.push(`(b) the holder is only ${result.ageMinutes.toFixed(1)} min old (--min-age-minutes ${minAgeMinutes})`);
  }
  if (!cls.test) return result;

  const found = findKillTarget(holderPid, before.processes);
  Object.assign(result, { target: found.target, chain: found.chain, stop: found.stop });
  result.tree = subtreeOf(found.target.pid, before.processes);
  if (selfPid !== null && result.tree.some((p) => p.pid === selfPid)) {
    reasons.push(`the kill target PID ${found.target.pid} is an ancestor of this process (PID ${selfPid})`);
  }
  if (reasons.length) return result;
  if (!after) {
    result.action = 'sample';
    return result;
  }

  // (c) idle — judged on the target's whole tree, the processes the kill would end.
  result.sampledSeconds = (after.takenAt - before.takenAt) / 1000;
  const holderAfter = indexProcesses(after.processes).get(holderPid);
  if (!holderAfter || holderAfter.createdMs !== holder.createdMs) {
    reasons.push('(c) the holder ended or changed between the two samples');
    return result;
  }
  const again = findKillTarget(holderPid, after.processes);
  if (again.target.pid !== found.target.pid) {
    reasons.push(`(c) the kill target changed between the samples (PID ${found.target.pid} → ${again.target.pid})`);
    return result;
  }
  const treeAfter = subtreeOf(found.target.pid, after.processes);
  result.cpuDeltaSeconds = treeCpu(treeAfter) - treeCpu(result.tree);
  if (treeKey(treeAfter) !== treeKey(result.tree)) {
    reasons.push(`(c) the process tree changed between the samples (${result.tree.length} → ${treeAfter.length} processes) — not idle`);
  }
  if (!(result.cpuDeltaSeconds < idleCpuLimitSeconds)) {
    reasons.push(`(c) the run is busy: ${result.cpuDeltaSeconds.toFixed(2)} s CPU in ${result.sampledSeconds.toFixed(0)} s (idle means < ${idleCpuLimitSeconds} s)`);
  }
  result.tree = treeAfter;
  if (!reasons.length) result.action = 'kill';
  return result;
}

// ─── CLI arguments (pure) ───────────────────────────────────────────────────

export const BREAK_USAGE =
  'Usage: node scripts/test-lock.mjs break [--port N] [--dry-run] ' +
  `[--min-age-minutes ${DEFAULT_MIN_AGE_MINUTES}] [--idle-seconds ${DEFAULT_IDLE_SECONDS}]`;

/** → `{ ok: true, opts }` or `{ ok: false, error }`. `--key value` and `--key=value` both work. */
export function parseBreakArgs(args, { defaultPort }) {
  const opts = { port: defaultPort, dryRun: false, minAgeMinutes: DEFAULT_MIN_AGE_MINUTES, idleSeconds: DEFAULT_IDLE_SECONDS };
  for (let i = 0; i < args.length; i++) {
    const [key, inline] = args[i].includes('=') ? [args[i].slice(0, args[i].indexOf('=')), args[i].slice(args[i].indexOf('=') + 1)] : [args[i], undefined];
    if (key === '--dry-run' && inline === undefined) { opts.dryRun = true; continue; }
    if (!['--port', '--min-age-minutes', '--idle-seconds'].includes(key)) return { ok: false, error: `unknown argument ${args[i]}` };
    const raw = inline ?? args[++i];
    const value = raw === undefined || raw === '' ? NaN : Number(raw);
    if (key === '--port') {
      if (!Number.isInteger(value) || value <= 0 || value >= 65536) return { ok: false, error: `--port needs a port number, got ${raw}` };
      opts.port = value;
    } else if (key === '--min-age-minutes') {
      if (!Number.isFinite(value) || value < MIN_AGE_FLOOR_MINUTES) return { ok: false, error: `--min-age-minutes must be a number ≥ ${MIN_AGE_FLOOR_MINUTES}, got ${raw}` };
      opts.minAgeMinutes = value;
    } else {
      if (!Number.isFinite(value) || value < IDLE_FLOOR_SECONDS) return { ok: false, error: `--idle-seconds must be a number ≥ ${IDLE_FLOOR_SECONDS}, got ${raw}` };
      opts.idleSeconds = value;
    }
  }
  return { ok: true, opts };
}

/** PIDs LISTENING on `host:port` in `netstat -ano` output (locale-proof: a listener's foreign address is `0.0.0.0:0`). */
export function parseNetstatListeners(text, port, host = LOCK_HOST) {
  const pids = new Set();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue;
    if (cols[1] !== `${host}:${port}` || cols[2] !== '0.0.0.0:0') continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

// ─── Windows I/O ────────────────────────────────────────────────────────────

const PS_PROCESS_TABLE = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$rows = foreach ($p in Get-CimInstance -ClassName Win32_Process) {',
  '  [pscustomobject]@{',
  '    pid = [int]$p.ProcessId',
  '    ppid = [int]$p.ParentProcessId',
  '    name = [string]$p.Name',
  '    commandLine = $p.CommandLine',
  '    createdMs = $(if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 })',
  '    cpu100ns = [double]$p.UserModeTime + [double]$p.KernelModeTime',
  '  }',
  '}',
  'ConvertTo-Json -InputObject @($rows) -Compress -Depth 2',
].join('\n');

/** Every process with command line, creation time and CPU time → a snapshot. */
async function readProcessTable() {
  const encoded = Buffer.from(PS_PROCESS_TABLE, 'utf16le').toString('base64');
  const { stdout } = await execFileP(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const takenAt = Date.now();
  const rows = JSON.parse(String(stdout).replace(/^﻿/, '').trim() || '[]');
  const processes = (Array.isArray(rows) ? rows : [rows]).map((r) => ({
    pid: Number(r.pid),
    ppid: Number(r.ppid),
    name: String(r.name ?? ''),
    commandLine: r.commandLine == null ? '' : String(r.commandLine),
    createdMs: Number(r.createdMs) || 0,
    cpuSeconds: (Number(r.cpu100ns) || 0) / 1e7,
  }));
  return { takenAt, processes };
}

async function listeningPids(port) {
  const { stdout } = await execFileP('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  return parseNetstatListeners(stdout, port);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const short = (text) => {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  return one.length > PRINT_MAX ? `${one.slice(0, PRINT_MAX)} …` : one;
};
const describeProc = (p) => `PID ${p.pid} ${p.name || '?'}  ${short(p.commandLine) || '(no command line)'}`;

/**
 * The CLI behind `node scripts/test-lock.mjs break`. Returns the exit code: 0 free / freed /
 * dry-run would kill, 1 the kill did not free the port, 2 refused (or bad arguments, or not Windows).
 */
export async function breakCli(argv, {
  defaultPort,
  describeHolder = async () => null,
  out = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const parsed = parseBreakArgs(argv, { defaultPort });
  if (!parsed.ok) {
    out(`[test-lock] ${parsed.error}\n${BREAK_USAGE}`);
    return REFUSED_EXIT_CODE;
  }
  const { port, dryRun, minAgeMinutes, idleSeconds } = parsed.opts;
  const where = `${LOCK_HOST}:${port}`;
  if (process.platform !== 'win32') {
    out(`[test-lock] REFUSED: break is implemented for Windows only (netstat, Win32_Process, taskkill). ` +
      `On this platform find the holder with \`node scripts/test-lock.mjs status\` and end it by hand.`);
    return REFUSED_EXIT_CODE;
  }

  const pids = await listeningPids(port);
  if (pids.length === 0) {
    out(`[test-lock] ${where} is free`);
    return 0;
  }
  if (pids.length > 1) {
    out(`[test-lock] REFUSED: several processes listen on ${where} (PIDs ${pids.join(', ')}) — not a test lock state this command understands`);
    return REFUSED_EXIT_CODE;
  }
  const holderPid = pids[0];
  out(`[test-lock] ${where} is held by PID ${holderPid}${dryRun ? ' (dry run — nothing will be killed)' : ''}`);
  const answer = await describeHolder({ port });
  if (answer) {
    out(`  lock answer: ${(answer.argv ?? []).join(' ')} (PID ${answer.pid}, since ${answer.startedAt}, cwd ${answer.cwd})`);
  } else {
    out('  lock answer: none (the holder does not answer GET / — hung, or not a test lock)');
  }

  const before = await readProcessTable();
  let decision = decideBreak({ holderPid, before, minAgeMinutes, selfPid: process.pid });
  const printHolder = (d) => {
    if (!d.holder) return;
    out(`  holder: ${describeProc(d.holder)}`);
    if (Number.isFinite(d.ageMinutes)) {
      out(`          started ${new Date(Number(d.holder.createdMs)).toISOString()} — ${d.ageMinutes.toFixed(1)} min ago`);
    }
    if (d.target) {
      out(`  chain:  ${d.chain.map((p) => `${p.pid} ${p.name}`).join(' ← ')}${d.stop ? `  (stops below PID ${d.stop.pid}${d.stop.name ? ` ${d.stop.name}` : ''}: ${d.stop.why})` : ''}`);
      out(`  target: ${describeProc(d.target)} — tree of ${d.tree.length} process(es)`);
    }
  };
  printHolder(decision);
  if (decision.action === 'sample') {
    out(`[test-lock] (a) test process: ${decision.holderKind}; (b) age ok — sampling the CPU time of the ${decision.tree.length} process(es) under PID ${decision.target.pid} for ${idleSeconds} s …`);
    await sleep(idleSeconds * 1000);
    const after = await readProcessTable();
    decision = decideBreak({ holderPid, before, after, minAgeMinutes, selfPid: process.pid });
  }
  if (decision.action !== 'kill') {
    out(`[test-lock] REFUSED (exit ${REFUSED_EXIT_CODE}):`);
    for (const reason of decision.reasons) out(`  - ${reason}`);
    if (decision.cpuDeltaSeconds !== null) {
      out(`  measured: ${decision.cpuDeltaSeconds.toFixed(2)} s CPU in ${decision.sampledSeconds.toFixed(0)} s over the target's tree`);
    }
    return REFUSED_EXIT_CODE;
  }

  out(`[test-lock] DECISION: kill PID ${decision.target.pid} (${decision.target.name}) with its tree — ` +
    `${decision.holderKind}, ${decision.ageMinutes.toFixed(1)} min old, idle (${decision.cpuDeltaSeconds.toFixed(2)} s CPU in ${decision.sampledSeconds.toFixed(0)} s)`);
  for (const p of decision.tree) out(`    ${describeProc(p)}`);
  if (dryRun) {
    out('[test-lock] dry run — nothing killed');
    return 0;
  }

  // Last look right before the kill: the same target, the same process (no reused pid).
  const now = await readProcessTable();
  const targetNow = now.processes.find((p) => p.pid === decision.target.pid);
  if (!targetNow || targetNow.createdMs !== decision.target.createdMs) {
    out(`[test-lock] REFUSED: PID ${decision.target.pid} ended or changed before the kill — check again`);
    return REFUSED_EXIT_CODE;
  }
  const kill = await execFileP('taskkill', ['/PID', String(decision.target.pid), '/T', '/F'], { windowsHide: true, timeout: 60_000 })
    .then((r) => ({ ok: true, text: `${r.stdout}${r.stderr}` }), (e) => ({ ok: false, text: `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}` }));
  out(`[test-lock] taskkill /PID ${decision.target.pid} /T /F → ${kill.ok ? 'ok' : 'error'}`);
  for (const line of kill.text.split(/\r?\n/).filter((l) => l.trim())) out(`    ${line.trim()}`);

  const deadline = Date.now() + FREE_WAIT_MS;
  for (;;) {
    const now2 = await listeningPids(port);
    if (!now2.includes(holderPid)) {
      out(now2.length
        ? `[test-lock] killed — ${where} is now held by PID ${now2.join(', ')} (a waiting run took it)`
        : `[test-lock] killed — ${where} is free`);
      out(`[test-lock] ended: ${decision.tree.map((p) => `${p.pid} ${p.name}`).join(', ')}`);
      return 0;
    }
    if (Date.now() > deadline) {
      out(`[test-lock] FAILED: PID ${holderPid} still listens on ${where} ${FREE_WAIT_MS / 1000} s after the kill`);
      return 1;
    }
    await sleep(500);
  }
}
