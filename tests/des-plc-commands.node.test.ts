// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryCommand } from './helpers/query-command';
import type { RVViewer } from '../src/core/rv-viewer';
import { commandRegistry, CommandRegistry, type CommandContext } from '../src/core/hmi/rv-command-registry';
import { ensureDesPlcCommandsRegistered } from '../src/core/hmi/des-plc-commands';
import {
  registerPlcControl, registerPlcPersistence, registerPlcRuntime,
  type PlcControl, type PlcDiagnostic, type PlcPersistence, type PlcRunState, type PlcRuntime,
} from '../src/core/plc-control';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';

vi.mock('../src/core/hmi/rv-command-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/hmi/rv-command-registry')>();
  return { ...actual, commandRegistry: new actual.CommandRegistry() };
});
vi.mock('../src/plugins/mcp-bridge/rv-mcp-dialog-policy', () => ({
  installMcpDialogPolicy: vi.fn(async () => () => []),
}));

const viewer = { modes: { activeMode: 'hmi' } } as RVViewer;
const read = async (p: Promise<string>) => JSON.parse(await p);
beforeEach(() => ensureDesPlcCommandsRegistered());
afterEach(() => {
  registerPlcControl(null);
  registerPlcRuntime(null);
  registerPlcPersistence(null);
  commandRegistry.attachViewer(undefined);
});

describe('Phase 1 DES / PLC command parity', () => {
  it('registers eagerly and idempotently with original schemas and policy classes', () => {
    const registry = new CommandRegistry();
    ensureDesPlcCommandsRegistered(registry);
    ensureDesPlcCommandsRegistered(registry);
    expect(registry.list()).toHaveLength(9);
    for (const [id, schema, readOnly, cls] of [
      ['des.step', { count: 'number' }, false, 'sim'],
      ['des.setMode', { subMode: 'string', multiplier: 'number' }, false, 'sim'],
      ['plc.deploy', { code: 'string', program: 'string' }, false, 'signal'],
      ['plc.run', { program: 'string' }, false, 'signal'],
      ['plc.stop', { program: 'string' }, false, 'signal'],
      ['plc.status', { program: 'string' }, true, 'read'],
    ] as const) {
      const d = registry.get(id)!;
      expect(d).toMatchObject({ argsSchema: schema, readOnly, scope: 'none', available: true });
      expect(commandClassOf(d)).toBe(cls);
      expect(d.eagerImpl).toBeDefined();
      expect(d.macro).not.toBe(true);
      expect(d.undoLabel).toBeUndefined();
      expect(d.mcp).toBeUndefined();
    }
  });

  it('refuses absent DES and PLC with the old precondition texts', async () => {
    for (const id of ['des.step', 'des.setMode']) {
      expect(commandRegistry.enabled(id, {}, viewer)).toEqual({ reason: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' });
      expect(commandRegistry.get(id)!.eagerImpl!.enabled({ viewer: undefined } as unknown as CommandContext, {}))
        .toEqual({ reason: 'DES not active — call web_execute("workspace.setMode", {"mode":"des"}) first.' });
    }
    for (const id of ['plc.deploy', 'plc.run', 'plc.stop']) {
      expect(commandRegistry.enabled(id, {}, viewer)).toEqual({ reason: 'PLC not available in this build' });
      expect(commandRegistry.enabled(id, { program: 'missing' }, viewer)).toEqual({ reason: "unknown PLC program 'missing'", details: { programs: [] } });
    }
    const tools = new McpCommandTools(() => viewer);
    expect(await read(tools.webExecute('des.step'))).toMatchObject({ ok: false, kind: 'disabled' });
  });

  it('steps the requested events with the old default and stops at an empty queue', async () => {
    let processed = 0;
    const ctl = {
      step: () => processed < 3 ? (++processed, true) : false,
      eventStats: () => ({ currentTime: processed * 2, processed, pending: 3 - processed, nextEventTime: null }),
    };
    const tools = new McpCommandTools(() => ({ ...viewer, simulationKernel: { desControl: () => ctl } }) as unknown as RVViewer);
    expect((await read(tools.webExecute('des.step'))).value).toEqual({
      stepped: 1, events: { currentTime: 2, processed: 1, pending: 2, nextEventTime: null },
    });
    expect((await read(tools.webExecute('des.step', '{"count":10}'))).value).toEqual({
      stepped: 2, events: { currentTime: 6, processed: 3, pending: 0, nextEventTime: null },
    });
  });

  it('sets DES mode and optional multiplier and preserves invalid-mode payload', async () => {
    const ctl = {
      subMode: 'animated', multiplier: 1,
      setSubMode: (mode: string) => { ctl.subMode = mode; },
      setMultiplier: (multiplier: number) => { ctl.multiplier = multiplier; },
    };
    const tools = new McpCommandTools(() => ({ ...viewer, simulationKernel: { desControl: () => ctl } }) as unknown as RVViewer);
    expect((await read(tools.webExecute('des.setMode', '{"subMode":"hybrid","multiplier":12}'))).value)
      .toEqual({ subMode: 'hybrid', multiplier: 12 });
    expect((await read(tools.webExecute('des.setMode', '{"subMode":"step"}'))).value)
      .toEqual({ subMode: 'step', multiplier: 12 });
    // plan: an invalid subMode is a real command failure (ok:false + reason), never ok:true with an {error} payload.
    const bad = await read(tools.webExecute('des.setMode', '{"subMode":"bogus"}'));
    expect(bad).toMatchObject({
      status: 'failed', ok: false, kind: 'threw', error: "Invalid subMode 'bogus'",
      details: { valid: ['animated', 'hybrid', 'fastforward', 'step'] },
    });
    expect(bad.value).toBeUndefined();
    expect(ctl.subMode).toBe('step'); // the refused call changed nothing
    const viaRegistry = await commandRegistry.execute('des.setMode', { subMode: 'bogus' }, {
      origin: 'mcp', viewer: { ...viewer, simulationKernel: { desControl: () => ctl } } as unknown as RVViewer,
    });
    expect(viaRegistry).toMatchObject({ ok: false, kind: 'threw', reason: "Invalid subMode 'bogus'" });
  });

  it('deploys, runs, stops, and reports the selected or named PLC with unchanged payloads', async () => {
    let state: PlcRunState = 'stopped';
    const diagnostics: PlcDiagnostic[] = [{ severity: 'warning', message: 'Unused variable', line: 2, column: 1 }];
    const plc: PlcControl = {
      deploy: vi.fn(async () => diagnostics), run: vi.fn(async () => { state = 'running'; }),
      stop: vi.fn(() => { state = 'stopped'; }), step: vi.fn(), reset: vi.fn(async () => {}),
      get state() { return state; }, scanTimeMs: 1.23456, lastError: null,
      watch: () => new Map([['Counter', 7]]),
    };
    registerPlcControl(plc);
    const runtime: PlcRuntime = {
      program: (name) => name === 'Main' ? plc : null,
      programs: () => [{ name: 'Main', path: 'Machine/Main', order: 1, selected: true, state, scanTimeMs: plc.scanTimeMs, lastError: null }],
      conflicts: () => [{ signal: 'Q', programs: ['Main', 'Other'] }],
    };
    registerPlcRuntime(runtime);
    const tools = new McpCommandTools(() => viewer);
    expect((await read(tools.webExecute('plc.deploy', JSON.stringify({ code: 'PROGRAM Main END_PROGRAM', program: 'Main' })))).value)
      .toEqual({ state: 'stopped', errorCount: 0, warningCount: 1, diagnostics, persisted: false });
    expect(plc.deploy).toHaveBeenCalledWith('PROGRAM Main END_PROGRAM');
    expect(plc.run).not.toHaveBeenCalled();
    expect((await read(tools.webExecute('plc.run'))).value).toEqual({ state: 'running', lastError: null });
    const status = (await read(tools.webQuery('plc.status', '{"program":"Main"}'))).value;
    expect(status).toEqual({
      state: 'running', scanTimeMs: 1.235, lastError: null, watch: { Counter: 7 },
      programs: [{ name: 'Main', path: 'Machine/Main', order: 1, selected: true, state: 'running', scanTimeMs: 1.235, lastError: null }],
      conflicts: [{ signal: 'Q', programs: ['Main', 'Other'] }],
    });
    expect(await queryCommand(viewer, 'plc.status', { program: 'Main' })).toEqual(status);
    expect((await read(tools.webExecute('plc.stop', '{"program":"Main"}'))).value).toEqual({ state: 'stopped' });
    expect(await queryCommand(viewer, 'plc.status', { program: 'missing' }))
      .toEqual({ error: "unknown PLC program 'missing'", programs: ['Main'] });

    diagnostics.push({ severity: 'error', message: 'Syntax error', line: 3, column: 2 });
    state = 'error';
    expect((await read(tools.webExecute('plc.deploy', '{"code":"invalid"}'))).value)
      .toEqual({
        state: 'error', errorCount: 1, warningCount: 1, diagnostics,
        persisted: false, persistSkipped: 'compile errors — the saved program is unchanged',
      });
  });
});

describe('plc.deploy persistence (PlcPersistence seam)', () => {
  function fakePlc(diagnostics: PlcDiagnostic[] = []): PlcControl {
    return {
      deploy: vi.fn(async () => diagnostics), run: vi.fn(async () => {}), stop: vi.fn(), step: vi.fn(),
      reset: vi.fn(async () => {}), state: 'stopped', scanTimeMs: 0, lastError: null, watch: () => new Map(),
    };
  }

  it('awaits the persistence and reports where the code was saved', async () => {
    const plc = fakePlc();
    registerPlcControl(plc);
    registerPlcRuntime({ program: (n) => n === 'Main' ? plc : null, programs: () => [], conflicts: () => [] });
    const persistence: PlcPersistence = {
      persistCode: vi.fn(async () => ({ persisted: true, nodePath: 'Cell/PLC', document: 'scene-doc' as const, created: true })),
    };
    registerPlcPersistence(persistence);
    const tools = new McpCommandTools(() => viewer);

    const res = await read(tools.webExecute('plc.deploy', JSON.stringify({ code: 'PROGRAM Main END_PROGRAM', program: 'Main' })));
    expect(res.value).toEqual({
      state: 'stopped', errorCount: 0, warningCount: 0, diagnostics: [],
      persisted: true, persistedTo: 'Cell/PLC', document: 'scene-doc', created: true,
    });
    expect(persistence.persistCode).toHaveBeenCalledWith('PROGRAM Main END_PROGRAM', 'Main');

    await read(tools.webExecute('plc.deploy', '{"code":"PROGRAM Main END_PROGRAM"}'));
    expect(persistence.persistCode).toHaveBeenLastCalledWith('PROGRAM Main END_PROGRAM', undefined);
  });

  it('saves into the program deployed to, even when the selection changes during the compile', async () => {
    let selected = 'Cell/A';
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const plc = fakePlc();
    plc.deploy = vi.fn(async () => { await gate; return []; });
    registerPlcControl(plc);
    registerPlcRuntime({
      program: () => plc, conflicts: () => [],
      programs: () => ['Cell/A', 'Cell/B'].map((path, order) => ({
        name: path.slice(5), path, order, selected: path === selected, state: 'stopped' as const, scanTimeMs: 0, lastError: null,
      })),
    });
    const persistence: PlcPersistence = { persistCode: vi.fn(async (_c, p) => ({ persisted: true, nodePath: p })) };
    registerPlcPersistence(persistence);
    const tools = new McpCommandTools(() => viewer);

    const pending = read(tools.webExecute('plc.deploy', '{"code":"PROGRAM Main END_PROGRAM"}'));
    await vi.waitFor(() => expect(plc.deploy).toHaveBeenCalled());
    selected = 'Cell/B'; // the user picks another program while A compiles
    release();
    expect((await pending).value).toMatchObject({ persisted: true, persistedTo: 'Cell/A' });
    expect(persistence.persistCode).toHaveBeenCalledWith('PROGRAM Main END_PROGRAM', 'Cell/A');

    // A named program is pinned to its path too.
    await read(tools.webExecute('plc.deploy', '{"code":"X","program":"a"}'));
    expect(persistence.persistCode).toHaveBeenLastCalledWith('X', 'Cell/A');
  });

  it('fails the command with a clear error when the code could not be saved', async () => {
    registerPlcControl(fakePlc());
    registerPlcPersistence({ persistCode: async () => ({ persisted: false, error: 'no scene document to write into' }) });
    const tools = new McpCommandTools(() => viewer);

    const res = await read(tools.webExecute('plc.deploy', '{"code":"PROGRAM Main END_PROGRAM"}'));
    expect(res.status).toBe('failed');
    expect(res.value).toMatchObject({ state: 'stopped', errorCount: 0, persisted: false });
    expect(res.value.error).toContain('NOT saved');
    expect(res.value.error).toContain('no scene document to write into');
  });

  it('a throwing persistence is reported, never swallowed', async () => {
    registerPlcControl(fakePlc());
    registerPlcPersistence({ persistCode: async () => { throw new Error('op refused'); } });
    const tools = new McpCommandTools(() => viewer);

    const res = await read(tools.webExecute('plc.deploy', '{"code":"PROGRAM Main END_PROGRAM"}'));
    expect(res.status).toBe('failed');
    expect(res.value.error).toContain('op refused');
  });

  it('does not overwrite the saved program with code that does not compile', async () => {
    registerPlcControl(fakePlc([{ severity: 'error', message: 'Syntax error', line: 1, column: 1 }]));
    const persistence: PlcPersistence = { persistCode: vi.fn(async () => ({ persisted: true })) };
    registerPlcPersistence(persistence);
    const tools = new McpCommandTools(() => viewer);

    const res = await read(tools.webExecute('plc.deploy', '{"code":"broken"}'));
    expect(res.value).toMatchObject({ errorCount: 1, persisted: false });
    expect(persistence.persistCode).not.toHaveBeenCalled();
  });
});
