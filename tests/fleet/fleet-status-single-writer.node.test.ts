// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** plan-559 Phase 6 (9.9): `<vehicle>.Status.*` has exactly one writer - the core's FleetStatusOutput. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOTS = [resolve(__dirname, '../../src'), resolve(__dirname, '../../../realvirtual-WebViewer-Private~/src'),
  resolve(__dirname, '../../../realvirtual-WebViewer-Private~/projects')];

function* sources(dir: string): Generator<string> {
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (/\.tsx?$/.test(n)) yield p;
  }
}

describe('fleet status signals: one writer', () => {
  it('only exec/status-output.ts builds `<vehicle>.Status.*` names', () => {
    const users: string[] = [];
    for (const root of ROOTS) for (const f of sources(root)) {
      const text = readFileSync(f, 'utf8');
      if (/VEHICLE_STATUS_SIGNALS|\.Status\.(Free|Busy|Handling|Charging|Fault|Moving|FaultCode|Soc)\b/.test(text)) {
        users.push(relative(resolve(__dirname, '../..'), f).split('\\').join('/'));
      }
    }
    // The writer, its constants and the read-only status reader (fleet.status).
    expect(users.sort()).toEqual(['src/core/fleet/exec/status-output.ts', 'src/core/fleet/fleet-status.ts']);
  });
});
