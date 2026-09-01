// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-455 §9.9 — the binding inventory is a frozen contract.
 *
 * Widening discovery from "placement roots" to "every payload-carrying node"
 * changes which nodes bind across EVERY shipped GLB, not just the one the plan
 * was written for. The Phase-0 survey of that blast radius is therefore not a
 * one-off note: it is an ALLOWLIST, checked here against the real files.
 *
 * Any `rv_extras` payload of a registered material-flow type that is not listed
 * below fails this test. Adding one is then a visible, reviewed edit to the
 * allowlist in the same commit as the GLB — never a silent side effect of
 * dropping an asset into the tree.
 *
 * Node, not browser: it reads the actual `.glb` files off disk.
 */

import { describe, it, expect } from 'vitest';
import { openSync, readSync, closeSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

/** Registered material-flow types (the `type:` of every `defineLibraryComponent`). */
const FLOW_TYPES = new Set([
  'Agv', 'ChainTransfer', 'Conveyor', 'OverheadConveyor', 'Sink', 'Source', 'Turntable',
]);

/**
 * Types owned by an ENGINE component factory. The scene loader already builds
 * the real driver (`RVSource`, `RVSink`) for these, so the CONTINUOUS payload
 * dispatch steps aside for them; the DES kernel — which has no such driver —
 * binds them. The split is why the two columns below differ.
 */
const ENGINE_OWNED = new Set(['Source', 'Sink']);

const ROOT = resolve(__dirname, '..');
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');

interface Hit { glb: string; node: string; type: string; placed: boolean }

function walkGlbs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkGlbs(p, out);
    else if (e.name.toLowerCase().endsWith('.glb')) out.push(p);
  }
  return out;
}

/**
 * Parse ONLY the JSON chunk of a .glb. Reads the 20-byte header, then exactly
 * the chunk it declares — never the binary payload, which in this tree runs to
 * hundreds of megabytes and would make the survey unusably slow.
 */
function glbJson(file: string): { nodes?: Array<Record<string, unknown>> } | null {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(20);
    if (readSync(fd, head, 0, 20, 0) < 20) return null;
    if (head.readUInt32LE(0) !== 0x46546c67) return null;   // 'glTF'
    const chunkLen = head.readUInt32LE(12);
    // Generous: a customer delivery model in this tree carries a 70 MB JSON
    // chunk on its own. The cap is only a guard against a corrupt header.
    if (chunkLen <= 0 || chunkLen > 512 * 1024 * 1024) return null;
    const chunk = Buffer.alloc(chunkLen);
    readSync(fd, chunk, 0, chunkLen, 20);
    return JSON.parse(chunk.toString('utf8'));
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

function scan(roots: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const dir of roots) {
    for (const file of walkGlbs(dir)) {
      const json = glbJson(file);
      const nodes = (json?.nodes ?? []) as Array<{
        name?: string; children?: number[]; extras?: { realvirtual?: Record<string, unknown> };
      }>;
      const parent = new Map<number, number>();
      nodes.forEach((n, i) => (n.children ?? []).forEach(c => parent.set(c, i)));
      const pathOf = (i: number): string => {
        const seg: string[] = []; let cur: number | undefined = i; let guard = 0;
        while (cur !== undefined && guard++ < 200) { seg.unshift(nodes[cur]?.name ?? `#${cur}`); cur = parent.get(cur); }
        return seg.join('/');
      };
      nodes.forEach((n, i) => {
        const rv = n.extras?.realvirtual;
        if (!rv || typeof rv !== 'object') return;
        for (const key of Object.keys(rv)) {
          if (!FLOW_TYPES.has(key)) continue;
          hits.push({
            // Repo-relative and separator-normalised, so the allowlist keys are
            // identical on every machine and both platforms.
            glb: relative(ROOT, file).split(/[\\/]/).join('/'),
            node: pathOf(i),
            type: key,
            placed: !!(rv as Record<string, unknown>).LayoutObject,
          });
        }
      });
    }
  }
  return hits;
}

const key = (h: Hit): string => `${h.glb} :: ${h.node} :: ${h.type}`;

/**
 * THE ALLOWLIST — surveyed 2026-08-28, every entry reviewed as intended.
 *
 * `AGVDemo.glb` is the plan's target: three saved vehicles whose configs
 * persisted perfectly and drove nothing. Everything else is a `Source`/`Sink`
 * payload on an inner node — the `EuropalletLoaded`-style embedded component
 * that Plan 194 §2.6 documents as the reason dual discovery exists. Those are
 * engine-owned types, so they change nothing on the continuous path; they
 * become visible to the DES kernel only.
 */
const ALLOWLIST: readonly string[] = [
  // ── plan-455's target: the DES course's three vehicles ────────────────────
  '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_1 :: Agv',
  '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_2 :: Agv',
  '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_3 :: Agv',

  // ── embedded self-spawning pallets / cell sources + sinks (engine-owned) ──
  'public/library/PalletHandling/CartonBox.glb :: CartonBox :: Source',
  'public/library/PalletHandling/Europallet.glb :: Europallet :: Source',
  'public/library/PalletHandling/EuropalletLoaded.glb :: EuropalletLoaded :: Source',
  'public/library/PalletHandling/PalletSink.glb :: PalletSink :: Sink',
  'public/DemoRealvirtualWeb.glb :: DemoCell/Sink :: Sink',
  'public/DemoRealvirtualWeb.glb :: DemoCell/Turbine :: Source',
  // The embed vignette is cut from the demo model above — same DemoCell
  // payloads, same review; it entered the scan when ROOTS widened to public/.
  'public/embed/vignettes/conveyor-sensor.glb :: DemoCell/Sink :: Sink',
  'public/embed/vignettes/conveyor-sensor.glb :: DemoCell/Turbine :: Source',
  // plan-395 moved these four out of public/models/ and into the internal
  // Development project. Same payloads, same review - only the location
  // changed, so the keys are repointed rather than removed: dropping them
  // would make the very files whose bindings were reviewed unreviewed again,
  // and they are still scanned (projects/ is a ROOT).
  '../realvirtual-WebViewer-Private~/projects/Development/models/EuropalletEmpty.glb :: EuropalletEmpty :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/fixtures/physics-zone-test.glb :: PartSource :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/fixtures/tests.glb :: DemoCell/Sink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/Development/fixtures/tests.glb :: DemoCell/Turbine :: Source',
  // The four projects/demo-realvirtual/library/PalletHandling entries that used
  // to stand here were removed on 2026-08-30: that project folder no longer
  // exists, so they were stale and the "no stale entries" case reported them.
  // The public copies under public/library/PalletHandling above are the same
  // assets and still cover the case.
  '../realvirtual-WebViewer-Private~/projects/mauser3dhmi/models/MauserCageline30.glb :: UsedWhenOperatingTwinWithoutPLC_Connection/Tube :: Source',
];

const ROOTS = [
  // All of public/ — the demo model lives at its root since 2026-08-31, and the
  // subtrees this used to name (models/, library/) are inside it anyway.
  join(ROOT, 'public'),
  join(PRIVATE, 'projects'),
];

/** Surveyed once — every case below reads the same snapshot. */
const HITS = scan(ROOTS);

describe('plan-455 §9.9 — the binding inventory is a frozen contract', () => {
  it('no GLB carries a material-flow payload outside the reviewed allowlist', () => {
    // Placements already bound today via the asset-name glob — not new.
    const fresh = HITS.filter(h => !h.placed).map(key).sort();
    const allowed = new Set(ALLOWLIST);
    const unexpected = fresh.filter(k => !allowed.has(k));

    expect(unexpected,
      'A GLB gained an rv_extras material-flow payload that nobody reviewed.\n' +
      'If it is intended, add it to ALLOWLIST in this file in the SAME commit as the asset.\n' +
      `Unexpected:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the continuous kernel newly binds ONLY the three AGVs', () => {
    const continuous = HITS
      .filter(h => !h.placed && !ENGINE_OWNED.has(h.type))
      .map(key).sort();

    expect(continuous).toEqual([
      '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_1 :: Agv',
      '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_2 :: Agv',
      '../realvirtual-WebViewer-Private~/projects/DiscreteEventSimulation/scenes/AGVDemo.glb :: AGV_3 :: Agv',
    ]);
  });

  it('the allowlist has no stale entries', () => {
    const present = new Set(HITS.filter(h => !h.placed).map(key));
    // Only meaningful with the private sibling checked out.
    if (!existsSync(PRIVATE)) return;
    expect(ALLOWLIST.filter(k => !present.has(k))).toEqual([]);
  });
});
