// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2229 Phase 3 — the open USD recording commands in the COMMUNITY view
 * (tier-boundary 6, commands-mcp 4/5/7): the five descriptors are listed
 * without any private code, every call answers kind `unavailable` with the
 * Commercial reason (never "unknown"), only the stub module is loaded, the
 * classes are `file` / `read`, the long ones become jobs. Plus the one option
 * rule the dialog, the command and the MCP shortcut share.
 */

import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry } from '../src/core/hmi/rv-command-registry';
import {
  USD_RECORD_COMMAND_IDS,
  USD_RECORD_UNAVAILABLE,
  createUsdRecordCommandDescriptors,
  ensureUsdRecordCommandsRegistered,
  resolveUsdExportOptions,
  resolveUsdRecordOptions,
  usdExportFileStem,
  type UsdRecordCommandsModule,
} from '../src/core/hmi/commands/usd-record-commands';
import { commandClassOf } from '../src/plugins/mcp-bridge/rv-mcp-tool-class';

const loadStub = vi.fn(() =>
  import('../src/private-stubs/plugins/usd/anim/usd-record-commands') as Promise<UsdRecordCommandsModule>);

function communityRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  for (const d of createUsdRecordCommandDescriptors({ load: loadStub })) reg.register(d);
  return reg;
}

describe('usd.record.* / usd.export.animated — community build', () => {
  it('lists all five descriptors eagerly; registration is idempotent', () => {
    const reg = new CommandRegistry();
    ensureUsdRecordCommandsRegistered(reg);
    for (const id of USD_RECORD_COMMAND_IDS) expect(reg.get(id), id).toBeDefined();
    const n = reg.list().length;
    ensureUsdRecordCommandsRegistered(reg);
    expect(reg.list().length).toBe(n);
  });

  it('every command answers "unavailable" with the Commercial reason, never "unknown"; only the stub loads', async () => {
    loadStub.mockClear();
    const reg = communityRegistry();
    const viewer = { modes: { activeMode: 'hmi' }, selectionManager: { getSnapshot: () => ({ selectedPaths: [] }) } } as never;
    for (const id of USD_RECORD_COMMAND_IDS) {
      const r = await reg.execute(id, { mode: 'deterministic', durationSec: 5 }, { origin: 'mcp', viewer });
      expect(r.ok, id).toBe(false);
      if (r.ok) continue;
      expect(r.kind, id).toBe('unavailable');
      expect(r.reason, id).toBe(USD_RECORD_UNAVAILABLE);
    }
    expect(loadStub).toHaveBeenCalled();
    expect(reg.enabled('usd.record.status', {}, viewer)).toEqual({ reason: USD_RECORD_UNAVAILABLE });
  });

  it('status is read-only (web_query); writes are class file; record + export run as cancellable jobs', () => {
    const reg = communityRegistry();
    const status = reg.get('usd.record.status')!;
    expect(status.readOnly).toBe(true);
    expect(commandClassOf(status)).toBe('read');
    for (const id of ['usd.record.start', 'usd.record.stop', 'usd.record.cancel', 'usd.export.animated']) {
      const d = reg.get(id)!;
      expect(d.readOnly, id).toBe(false);
      expect(commandClassOf(d), id).toBe('file');
      expect(d.macro, id).toBeUndefined();
      expect(d.undoLabel, id).toBeUndefined();
    }
    for (const id of ['usd.record.start', 'usd.export.animated']) {
      expect(reg.get(id)!.timeoutMs!, id).toBeGreaterThan(120_000);
      expect(reg.get(id)!.cancellable, id).toBe(true);
    }
  });
});

describe('resolveUsdRecordOptions — the one option rule (2.4)', () => {
  it('defaults: live, 30 fps, 600 s, reduction 0.1 mm / 0.05 deg, 2000 MUs, Blender compat on', () => {
    expect(resolveUsdRecordOptions({})).toEqual({
      ok: true,
      value: { fps: 30, mode: 'live', durationSec: 600, reduce: true, posMm: 0.1, angleDeg: 0.05, maxMus: 2000, blenderVisibilityCompat: true },
    });
  });

  it('limits: fps 24/30/60, deterministic needs 1-600 s, maxMus 1-2000 integer, tolerances >= 0', () => {
    expect(resolveUsdRecordOptions({ fps: 25 }).ok).toBe(false);
    for (const fps of [24, 30, 60]) expect(resolveUsdRecordOptions({ fps }).ok).toBe(true);
    expect(resolveUsdRecordOptions({ mode: 'deterministic' })).toMatchObject({ ok: false, reason: expect.stringContaining('durationSec is required') });
    expect(resolveUsdRecordOptions({ mode: 'deterministic', durationSec: 0.5 }).ok).toBe(false);
    expect(resolveUsdRecordOptions({ mode: 'deterministic', durationSec: 601 }).ok).toBe(false);
    expect(resolveUsdRecordOptions({ mode: 'deterministic', durationSec: 600 }).ok).toBe(true);
    expect(resolveUsdRecordOptions({ maxMus: 2001 }).ok).toBe(false);
    expect(resolveUsdRecordOptions({ maxMus: 1.5 }).ok).toBe(false);
    expect(resolveUsdRecordOptions({ maxMus: 1 }).ok).toBe(true);
    expect(resolveUsdRecordOptions({ posMm: -1 }).ok).toBe(false);
    expect(resolveUsdRecordOptions({ angleDeg: 0, posMm: 0 }).ok).toBe(true);
    expect(resolveUsdRecordOptions({ mode: 'replay' }).ok).toBe(false);
  });

  it('export options: mode recording | record-and-export, target download | project, safe file stem', () => {
    expect(resolveUsdExportOptions({})).toEqual({ ok: true, value: { mode: 'recording', name: 'usd-animation', target: 'download', writeAddresses: true } });
    expect(resolveUsdExportOptions({ mode: 'record-and-export', target: 'project', name: 'Line 1.usdz', writeAddresses: false }))
      .toEqual({ ok: true, value: { mode: 'record-and-export', name: 'Line_1', target: 'project', writeAddresses: false } });
    expect(resolveUsdExportOptions({ target: 'cloud' }).ok).toBe(false);
    expect(resolveUsdExportOptions({ mode: 'live' }).ok).toBe(false);
    expect(usdExportFileStem('../a b.usd')).toBe('a_b');
  });
});
