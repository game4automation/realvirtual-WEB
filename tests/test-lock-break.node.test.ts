// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * `node scripts/test-lock.mjs break` (scripts/test-lock-break.mjs) — the guarded way to free
 * the machine-wide test lock from a HUNG holder (2026-10-27: a bare `npx vitest run`, PID 7388,
 * held 127.0.0.1:47177 for six hours).
 *
 * The decision is a pure function over process-table snapshots; these tests feed it fake
 * tables modelled on command lines measured on the dev machine (a Claude Code shell is
 * `bash.exe -c "source …shell-snapshots…"` over several lines, Git Bash runs the npx shim as
 * `bash.exe <path>/npx vitest …`, npm runs scripts through `cmd.exe /d /s /c …`). Every
 * refusal has a matching accepted case, so a check that cannot fail would turn this red.
 *
 * The end-to-end part runs the CLI with `--dry-run` only, against a fixture holder on a
 * private port (47200–47999) — never the production lock port, never a real kill.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Proc { pid: number; ppid: number; name: string; commandLine: string; createdMs: number; cpuSeconds: number }
interface Snapshot { takenAt: number; processes: Proc[] }
interface Decision {
  action: 'kill' | 'refuse' | 'sample';
  reasons: string[];
  holder: Proc | null;
  holderKind: string | null;
  target: Proc | null;
  chain: Proc[];
  stop: { pid: number; name: string | null; why: string } | null;
  ageMinutes: number | null;
  cpuDeltaSeconds: number | null;
  sampledSeconds: number | null;
  tree: Proc[];
}
const SCRIPTS_DIR = path.resolve(__dirname, '..', 'scripts');
const brk = (await import(pathToFileURL(path.join(SCRIPTS_DIR, 'test-lock-break.mjs')).href)) as {
  splitCommandLine(line: string): string[];
  classifyCommandLine(line: string): { test: boolean; kind: string | null; why: string };
  parseNetstatListeners(text: string, port: number, host?: string): number[];
  subtreeOf(rootPid: number, processes: Proc[]): Proc[];
  findKillTarget(holderPid: number, processes: Proc[]): { target: Proc; chain: Proc[]; stop: Decision['stop'] } | null;
  decideBreak(input: { holderPid: number; before: Snapshot; after?: Snapshot | null; minAgeMinutes?: number; idleCpuLimitSeconds?: number; selfPid?: number | null }): Decision;
  parseBreakArgs(args: string[], options: { defaultPort: number }): { ok: true; opts: { port: number; dryRun: boolean; minAgeMinutes: number; idleSeconds: number } } | { ok: false; error: string };
  DEFAULT_MIN_AGE_MINUTES: number;
  DEFAULT_IDLE_SECONDS: number;
  MIN_AGE_FLOOR_MINUTES: number;
  IDLE_FLOOR_SECONDS: number;
  REFUSED_EXIT_CODE: number;
};

// ─── measured command-line shapes ───────────────────────────────────────────

const NODE = '"C:\\Program Files\\nodejs\\node.exe"';
const VITEST_MAIN = `${NODE}  "E:\\ws\\app\\node_modules\\.bin\\\\..\\vitest\\vitest.mjs" run tests/a.test.ts`;
const VITEST_FORK = `${NODE} "E:\\ws\\app\\node_modules\\vitest\\dist\\workers\\forks.js"`;
const ESBUILD = '"E:\\ws\\app\\node_modules\\@esbuild\\win32-x64\\esbuild.exe" --service=0.25.12 --ping';
const CMD_VITEST = 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c "vitest run tests/a.test.ts"';
const NPX_CLI = `${NODE} "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" vitest run tests/a.test.ts`;
const BASH_NPX = '"C:\\Program Files\\Git\\usr\\bin\\bash.exe" /c/Program Files/nodejs/npx vitest run tests/a.test.ts';
const CLAUDE_SHELL =
  '"C:\\Program Files\\Git\\bin\\bash.exe" -c "source /c/Users/me/.claude/shell-snapshots/snapshot-bash-1793087136441-nphoiw.sh 2>/dev/null || true && export TEMP=\'C:\\Temp\'\n' +
  "export CLAUDE_PLUGIN_DATA='C:/x'\n" +
  ": && eval 'npx vitest run tests/a.test.ts' && pwd -P >| '/c/Temp/claude-e228-cwd'\"";
const CLAUDE_EXE = '"C:\\Users\\me\\.local\\bin\\claude.exe" --resume';
const WRAPPER = `${NODE} scripts/with-test-lock.mjs vitest run --config vitest.node.config.ts`;
const CMD_WRAPPER = 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c node scripts/with-test-lock.mjs vitest run --config vitest.node.config.ts';
const NPM_RUN = `${NODE} "C:\\Program Files\\nodejs/node_modules/npm/bin/npm-cli.js" run test:node`;

describe('classifyCommandLine — structural, never a substring match', () => {
  it.each<[string, string, string]>([
    ['vitest main process', VITEST_MAIN, 'vitest'],
    ['with-test-lock wrapper', WRAPPER, 'with-test-lock'],
    ['run-all-tests', `${NODE} scripts/run-all-tests.mjs`, 'run-all-tests'],
    ['node with an option before the script', `${NODE} --max-old-space-size=8192 -r ./x.cjs node_modules/vitest/vitest.mjs run`, 'vitest'],
    ['npx-cli vitest', NPX_CLI, 'npx vitest'],
    ['npx-cli with --yes and a version', `${NODE} "C:\\npm\\bin\\npx-cli.js" --yes vitest@4.0.18 run`, 'npx vitest'],
    ['cmd /d /s /c "vitest run"', CMD_VITEST, 'cmd /c vitest'],
    ['cmd /c unquoted wrapper (npm run)', CMD_WRAPPER, 'cmd /c with-test-lock'],
    ['cmd /c "npx vitest"', 'cmd.exe /c "npx vitest run"', 'cmd /c npx vitest'],
    ['Git Bash running the npx shim (unquoted path with a space)', BASH_NPX, 'bash npx vitest'],
    ['Git Bash running the npx shim (quoted path)', '"C:\\Git\\usr\\bin\\bash.exe" "/c/Program Files/nodejs/npx" vitest run', 'bash npx vitest'],
    ['the vitest shim', 'vitest.cmd run', 'vitest'],
  ])('%s → test', (_label, line, kind) => {
    expect(brk.classifyCommandLine(line)).toMatchObject({ test: true, kind });
  });

  it.each<[string, string, RegExp]>([
    ['a Claude Code shell whose -c string runs npx vitest', CLAUDE_SHELL, /Claude Code shell/],
    ['a bash -lc string that runs vitest (no snapshot)', 'bash.exe -lc "npx vitest run"', /shell running -c/],
    ['claude.exe', CLAUDE_EXE, /not a test command/],
    ['Unity', '"C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.0f1\\Editor\\Unity.exe" -projectPath E:\\ws', /not a test command/],
    ['the CONNECT exe', '"E:\\ws\\Connect\\realvirtual-CONNECT.exe" --project-root E:\\ws vitest', /not a test command/],
    ['node running another script with vitest among its arguments', `${NODE} "C:\\Users\\me\\npm\\claude-code\\cli.js" --print "run vitest"`, /node running .*cli\.js/],
    ['node -e mentioning vitest', `${NODE} -e "require('vitest/vitest.mjs')"`, /inline code/],
    ['npm run (not climbed — it ends with its child)', NPM_RUN, /npm-cli\.js/],
    ['npx of another package', `${NODE} "C:\\npm\\bin\\npx-cli.js" prettier --write vitest.config.ts`, /not vitest/],
    ['cmd /c npm test', 'cmd.exe /d /s /c "npm test"', /cmd \/c/],
    ['cmd /c a Claude Code shell', 'cmd.exe /c "bash -c \'npx vitest run\'"', /shell running -c/],
    ['Git timeout around the wrapper', '"C:\\Program Files\\Git\\usr\\bin\\timeout.exe" 590 node scripts/with-test-lock.mjs vitest run', /timeout is not a test command/],
    ['a bash script with npx vitest as arguments', 'bash.exe ./deploy.sh npx vitest', /not npx vitest/],
    ['an unreadable command line', '', /no command line/],
  ])('%s → not a test command', (_label, line, why) => {
    const cls = brk.classifyCommandLine(line);
    expect(cls.test).toBe(false);
    expect(cls.why).toMatch(why);
  });

  it('splits Windows command lines: quotes group, newlines separate, \\" is a quote, other backslashes stay', () => {
    expect(brk.splitCommandLine('"C:\\a b\\node.exe"  x\n"y z" \\"q\\" E:\\p\\\\..\\v.mjs')).toEqual([
      'C:\\a b\\node.exe', 'x', 'y z', '"q"', 'E:\\p\\\\..\\v.mjs',
    ]);
  });
});

describe('parseNetstatListeners — locale-proof', () => {
  // German netstat; the state column arrives in the OEM code page (ABHÖREN → garbage).
  const NETSTAT = [
    '',
    'Aktive Verbindungen',
    '',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    0.0.0.0:47177          0.0.0.0:0              ABH\uFFFDREN         1111',
    '  TCP    127.0.0.1:47177        0.0.0.0:0              ABH\uFFFDREN         7388',
    '  TCP    127.0.0.1:47177        127.0.0.1:49265        WARTEND         0',
    '  TCP    127.0.0.1:49265        127.0.0.1:47177        HERGESTELLT     5555',
    '  TCP    127.0.0.1:471770       0.0.0.0:0              ABH\uFFFDREN         2222',
    '  TCP    [::]:47177             [::]:0                 ABH\uFFFDREN         3333',
  ].join('\r\n');

  it('finds only the 127.0.0.1 listener (foreign address 0.0.0.0:0), whatever the state is called', () => {
    expect(brk.parseNetstatListeners(NETSTAT, 47177)).toEqual([7388]);
  });

  it('NEGATIVE CONTROL: a free port has no listener — TIME_WAIT and client rows do not count', () => {
    expect(brk.parseNetstatListeners(NETSTAT.replace(/.*7388\r\n/, ''), 47177)).toEqual([]);
    expect(brk.parseNetstatListeners(NETSTAT, 49265)).toEqual([]);
  });
});

// ─── the decision over fake process tables ─────────────────────────────────

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);

/** The 2026-10-27 shape: claude.exe → Claude shell → bash npx → npx-cli → cmd /c vitest → vitest (holder) → workers. */
function hungBareRun({ holderAgeMinutes = 360 } = {}): Proc[] {
  const t0 = NOW - (holderAgeMinutes + 1) * MIN;
  const p = (pid: number, ppid: number, name: string, commandLine: string, createdMs: number, cpuSeconds = 0.5): Proc =>
    ({ pid, ppid, name, commandLine, createdMs, cpuSeconds });
  return [
    p(100, 4, 'claude.exe', CLAUDE_EXE, t0 - 600 * MIN, 900),
    p(200, 100, 'bash.exe', CLAUDE_SHELL, t0),
    p(300, 200, 'bash.exe', BASH_NPX, t0 + 100),
    p(400, 300, 'node.exe', NPX_CLI, t0 + 200),
    p(500, 400, 'cmd.exe', CMD_VITEST, t0 + 300),
    p(7388, 500, 'node.exe', VITEST_MAIN, NOW - holderAgeMinutes * MIN, 42),
    p(7400, 7388, 'node.exe', VITEST_FORK, NOW - holderAgeMinutes * MIN + 2000, 17),
    p(7500, 7388, 'esbuild.exe', ESBUILD, NOW - holderAgeMinutes * MIN + 1000, 3),
    p(900, 100, 'node.exe', `${NODE} C:\\Users\\me\\mcp\\server.js`, t0, 50),
  ];
}

const snap = (processes: Proc[], takenAt = NOW): Snapshot => ({ takenAt, processes });
const later = (processes: Proc[], cpu: Record<number, number> = {}, seconds = 60): Snapshot =>
  snap(processes.map((p) => ({ ...p, cpuSeconds: p.cpuSeconds + (cpu[p.pid] ?? 0) })), NOW + seconds * 1000);
const pids = (list: Proc[]) => list.map((p) => p.pid);

describe('decideBreak', () => {
  it('idle hung bare vitest → kill the topmost test ancestor (bash npx), stopping below the Claude shell', () => {
    const table = hungBareRun();
    const first = brk.decideBreak({ holderPid: 7388, before: snap(table) });
    expect(first.action).toBe('sample');
    expect(first.holderKind).toBe('vitest');

    const d = brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 7400: 0.2, 7500: 0.1 }) });
    expect(d.reasons).toEqual([]);
    expect(d.action).toBe('kill');
    expect(d.target?.pid).toBe(300);
    expect(pids(d.chain)).toEqual([7388, 500, 400, 300]);
    expect(d.stop).toMatchObject({ pid: 200 });
    expect(d.stop?.why).toMatch(/Claude Code shell/);
    expect(pids(d.tree).sort((a, b) => a - b)).toEqual([300, 400, 500, 7388, 7400, 7500]);
    expect(d.cpuDeltaSeconds).toBeCloseTo(0.3, 6);
    expect(d.ageMinutes).toBe(360);
  });

  it('the climb never reaches the Claude shell, claude.exe or an unrelated node — even when they are the only parents left', () => {
    const table = hungBareRun();
    const found = brk.findKillTarget(7388, table)!;
    expect(pids(found.chain)).not.toContain(200);
    expect(pids(found.chain)).not.toContain(100);
    expect(pids(brk.subtreeOf(found.target.pid, table))).not.toContain(900);
    // A Claude shell directly above the cmd (no npx shim in between): stop at the cmd.
    const direct = table.filter((p) => p.pid !== 300 && p.pid !== 400).map((p) => (p.pid === 500 ? { ...p, ppid: 200 } : p));
    expect(brk.findKillTarget(7388, direct)?.target.pid).toBe(500);
  });

  it('npm run test:node → wrapper holder, target is the cmd /c below npm (npm itself is not climbed)', () => {
    const t = NOW - 120 * MIN;
    const table: Proc[] = [
      { pid: 10, ppid: 1, name: 'bash.exe', commandLine: CLAUDE_SHELL, createdMs: t - 1000, cpuSeconds: 1 },
      { pid: 11, ppid: 10, name: 'node.exe', commandLine: NPM_RUN, createdMs: t - 500, cpuSeconds: 1 },
      { pid: 12, ppid: 11, name: 'cmd.exe', commandLine: CMD_WRAPPER, createdMs: t - 200, cpuSeconds: 0 },
      { pid: 13, ppid: 12, name: 'node.exe', commandLine: WRAPPER, createdMs: t, cpuSeconds: 0.4 },
      { pid: 14, ppid: 13, name: 'node.exe', commandLine: VITEST_MAIN, createdMs: t + 100, cpuSeconds: 9 },
    ];
    const d = brk.decideBreak({ holderPid: 13, before: snap(table), after: later(table) });
    expect(d.action).toBe('kill');
    expect(d.target?.pid).toBe(12);
    expect(d.stop?.why).toMatch(/npm-cli\.js/);
    expect(pids(d.tree).sort((a, b) => a - b)).toEqual([12, 13, 14]);
  });

  it('busy run (≥ 1 s CPU in the window) → refuse; just under 1 s → kill (the boundary is exclusive)', () => {
    const table = hungBareRun();
    const busy = brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 7400: 5 }) });
    expect(busy.action).toBe('refuse');
    expect(busy.reasons.join('\n')).toMatch(/\(c\) the run is busy: 5\.00 s CPU in 60 s/);
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 7400: 1 }) }).action).toBe('refuse');
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 7400: 0.99 }) }).action).toBe('kill');
  });

  it('CPU of the test ancestors counts too: a busy npx above an idle holder → refuse', () => {
    const table = hungBareRun();
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 400: 2 }) }).action).toBe('refuse');
    // …while CPU of processes outside the target tree (claude.exe, the unrelated node) does not.
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table, { 100: 30, 900: 30 }) }).action).toBe('kill');
  });

  it('young run → refuse at once, without sampling; old enough with the same table → sample', () => {
    const young = hungBareRun({ holderAgeMinutes: 12 });
    const d = brk.decideBreak({ holderPid: 7388, before: snap(young) });
    expect(d.action).toBe('refuse');
    expect(d.reasons).toEqual(['(b) the holder is only 12.0 min old (--min-age-minutes 30)']);
    expect(brk.decideBreak({ holderPid: 7388, before: snap(young), minAgeMinutes: 10 }).action).toBe('sample');
    // A young run that is ALSO idle stays refused.
    expect(brk.decideBreak({ holderPid: 7388, before: snap(young), after: later(young) }).action).toBe('refuse');
  });

  it('non-test holder → refuse with (a), no target', () => {
    const table = hungBareRun();
    const foreign = table.map((p) => (p.pid === 7388 ? { ...p, commandLine: `${NODE} tests/fixtures/test-lock/holder.mjs lock 47177 C:\\tmp` } : p));
    const d = brk.decideBreak({ holderPid: 7388, before: snap(foreign), after: later(foreign) });
    expect(d.action).toBe('refuse');
    expect(d.reasons[0]).toMatch(/^\(a\) the holder is not a test process: node running .*holder\.mjs/);
    expect(d.target).toBeNull();
    // The holder of another program — e.g. CONNECT on the port — likewise.
    const connect = table.map((p) => (p.pid === 7388 ? { ...p, name: 'realvirtual-CONNECT.exe', commandLine: '"E:\\c\\realvirtual-CONNECT.exe"' } : p));
    expect(brk.decideBreak({ holderPid: 7388, before: snap(connect) }).action).toBe('refuse');
  });

  it('the process tree changing between the samples (a child came or went) → refuse', () => {
    const table = hungBareRun();
    const spawned = [...table, { pid: 7600, ppid: 7388, name: 'node.exe', commandLine: VITEST_FORK, createdMs: NOW + 30_000, cpuSeconds: 0 }];
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(spawned) }).reasons.join()).toMatch(/process tree changed/);
    const gone = table.filter((p) => p.pid !== 7400);
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(gone) }).action).toBe('refuse');
  });

  it('a holder that ended or was replaced by a reused PID between the samples → refuse', () => {
    const table = hungBareRun();
    const reused = table.map((p) => (p.pid === 7388 ? { ...p, createdMs: NOW + 10_000 } : p));
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(reused) }).reasons).toEqual(['(c) the holder ended or changed between the two samples']);
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table), after: later(table.filter((p) => p.pid !== 7388)) }).action).toBe('refuse');
  });

  it('a parent PID that was reused by a younger process is not climbed to', () => {
    const table = hungBareRun().map((p) => (p.pid === 500 ? { ...p, createdMs: NOW } : p)); // "parent" 500 is younger than the holder
    const found = brk.findKillTarget(7388, table)!;
    expect(found.target.pid).toBe(7388);
    expect(found.stop?.why).toMatch(/reused/);
  });

  it('a kill target above the breaker itself → refuse', () => {
    const table = [...hungBareRun(), { pid: 8000, ppid: 7400, name: 'node.exe', commandLine: `${NODE} scripts/test-lock.mjs break`, createdMs: NOW - 1000, cpuSeconds: 0.1 }];
    const d = brk.decideBreak({ holderPid: 7388, before: snap(table), selfPid: 8000 });
    expect(d.action).toBe('refuse');
    expect(d.reasons.join()).toMatch(/ancestor of this process/);
  });

  it('an unknown creation time does not pass the age check', () => {
    const table = hungBareRun().map((p) => (p.pid === 7388 ? { ...p, createdMs: 0 } : p));
    expect(brk.decideBreak({ holderPid: 7388, before: snap(table) }).reasons).toEqual(['(b) the holder\'s creation time is unknown']);
  });

  it('a holder PID missing from the table → refuse', () => {
    expect(brk.decideBreak({ holderPid: 4242, before: snap(hungBareRun()) }).action).toBe('refuse');
  });
});

describe('parseBreakArgs', () => {
  it('defaults: the lock port, 30 min, 60 s, no dry run', () => {
    expect(brk.parseBreakArgs([], { defaultPort: 47177 })).toEqual({ ok: true, opts: { port: 47177, dryRun: false, minAgeMinutes: 30, idleSeconds: 60 } });
    expect([brk.DEFAULT_MIN_AGE_MINUTES, brk.DEFAULT_IDLE_SECONDS]).toEqual([30, 60]);
  });

  it('accepts --key value and --key=value', () => {
    expect(brk.parseBreakArgs(['--port', '47300', '--dry-run', '--min-age-minutes=45', '--idle-seconds', '20'], { defaultPort: 47177 }))
      .toEqual({ ok: true, opts: { port: 47300, dryRun: true, minAgeMinutes: 45, idleSeconds: 20 } });
  });

  it('refuses values below the floors, bad ports and unknown arguments', () => {
    expect(brk.parseBreakArgs(['--min-age-minutes', String(brk.MIN_AGE_FLOOR_MINUTES - 1)], { defaultPort: 1 }).ok).toBe(false);
    expect(brk.parseBreakArgs(['--idle-seconds', String(brk.IDLE_FLOOR_SECONDS - 1)], { defaultPort: 1 }).ok).toBe(false);
    expect(brk.parseBreakArgs(['--min-age-minutes', String(brk.MIN_AGE_FLOOR_MINUTES)], { defaultPort: 1 }).ok).toBe(true);
    expect(brk.parseBreakArgs(['--port', '70000'], { defaultPort: 1 }).ok).toBe(false);
    expect(brk.parseBreakArgs(['--port'], { defaultPort: 1 }).ok).toBe(false);
    expect(brk.parseBreakArgs(['--force'], { defaultPort: 1 }).ok).toBe(false);
  });
});

// ─── end to end: the CLI, dry run only, on a private port ──────────────────

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'test-lock.mjs');
const HOLDER = path.join(ROOT, 'tests', 'fixtures', 'test-lock', 'holder.mjs');
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host }, () => server.close(() => resolve(true)));
  });
}

async function allocPort(): Promise<number> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const port = 47200 + Math.floor(Math.random() * 800);
    if (await canBind(port, '127.0.0.1') && await canBind(port, '0.0.0.0')) return port;
  }
  throw new Error('no free test port in 47200–47999');
}

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(e)) if (key.startsWith('RV_TEST_LOCK') || key.startsWith('VITEST')) delete e[key];
  delete e.NODE_OPTIONS;
  return e;
}

function run(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: options.env ?? env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => resolve({ code, out }));
  });
}

describe('test-lock.mjs break (CLI, dry run)', { timeout: 60_000 }, () => {
  it('a free port → "free", exit 0', async () => {
    const port = await allocPort();
    const r = await run([CLI, 'break', '--port', String(port), '--dry-run']);
    if (process.platform !== 'win32') {
      expect(r.code).toBe(brk.REFUSED_EXIT_CODE);
      expect(r.out).toMatch(/Windows only/);
      return;
    }
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`127.0.0.1:${port} is free`);
  });

  it.runIf(process.platform === 'win32')('a non-test holder (the lock fixture) → REFUSED with (a), exit 2, the holder lives on', async () => {
    const port = await allocPort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-test-lock-break-'));
    const holder = spawn(process.execPath, [HOLDER, 'lock', String(port), dir, '127.0.0.1', 'break-fixture'], { cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: true });
    const exited = new Promise((resolve) => holder.once('exit', resolve));
    cleanup.push(() => {
      try { fs.writeFileSync(path.join(dir, 'release'), ''); } catch { /* gone */ }
      try { holder.kill(); } catch { /* gone */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    });
    const ready = path.join(dir, 'ready.json');
    for (const end = Date.now() + 20_000; !fs.existsSync(ready);) {
      if (Date.now() > end) throw new Error('holder not ready');
      await new Promise((r) => setTimeout(r, 25));
    }
    const r = await run([CLI, 'break', '--port', String(port), '--dry-run']);
    expect(r.code, r.out).toBe(brk.REFUSED_EXIT_CODE);
    expect(r.out).toContain(`is held by PID ${holder.pid}`);
    expect(r.out).toContain('lock answer: break-fixture');
    expect(r.out).toMatch(/\(a\) the holder is not a test process: node running .*holder\.mjs/);
    expect(holder.exitCode).toBeNull();
    fs.writeFileSync(path.join(dir, 'release'), '');
    await exited;
  });

  it('bad arguments → usage, exit 2', async () => {
    const r = await run([CLI, 'break', '--min-age-minutes', '1']);
    expect(r.code).toBe(brk.REFUSED_EXIT_CODE);
    expect(r.out).toMatch(/--min-age-minutes must be a number ≥ 10/);
    expect(r.out).toContain('Usage: node scripts/test-lock.mjs break');
  });
});
