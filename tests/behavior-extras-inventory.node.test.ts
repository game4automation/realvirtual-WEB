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
import { openSync, readSync, closeSync, readdirSync, existsSync, readFileSync } from 'node:fs';
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
  'public/demo-realvirtual/AGVDemo.glb :: AGV_1 :: Agv',
  'public/demo-realvirtual/AGVDemo.glb :: AGV_2 :: Agv',
  'public/demo-realvirtual/AGVDemo.glb :: AGV_3 :: Agv',
  // Reviewed 2026-10-07: the plan-903/558 AGV DES demo scene - eight
  // path-following vehicles, intended `Agv` payloads on the continuous path.
  'public/demo-realvirtual/AGVFactory.glb :: AGV_1 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_2 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_3 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_4 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_5 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_6 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_7 :: Agv',
  'public/demo-realvirtual/AGVFactory.glb :: AGV_8 :: Agv',
  // Reviewed 2026-10-17: plan-612 PalletYard - the forklift pallet DES demo scene: three
  // forklifts (`Agv`) on the continuous path, plus two pallet sources and two sinks
  // (engine-owned, visible to the DES kernel only). Since plan-612 CP1d-b (2026-10-20) the
  // conveyors are AssetReference placements: their `Conveyor` component lives in the library
  // asset (RollConveyor), no longer in this scene file, so the scene carries no Conveyor rows.
  // The forklifts are placements too, but their Agv config stays on the reference node.
  'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_1 :: Agv',
  'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_2 :: Agv',
  'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_3 :: Agv',
  // 2026-10-26: plan-680 - the same PalletYard scene ships publicly in the demo project
  // (public/demo-realvirtual/PalletYard.glb, library paths made relative); same three Agvs.
  // 2026-10-26: plan-681 phase 2 (private e55b294) made every PalletYard instance a placement -
  // the pallet Sources and the two Sinks now live inside placed assets (AssetReference), so
  // their four rows left the scene file and the allowlist. The three Stapler Agvs stay.

  // ── embedded self-spawning pallets / cell sources + sinks (engine-owned) ──
  'public/library/PalletHandling/CartonBox.glb :: CartonBox :: Source',
  'public/library/PalletHandling/Europallet.glb :: Europallet :: Source',
  'public/library/PalletHandling/EuropalletLoaded.glb :: EuropalletLoaded :: Source',
  'public/library/PalletHandling/PalletSink.glb :: PalletSink :: Sink',
  'public/demo-realvirtual/DemoRealvirtualWeb.glb :: DemoCell/Sink :: Sink',
  'public/demo-realvirtual/DemoRealvirtualWeb.glb :: DemoCell/Turbine :: Source',
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
  // aXite (2026-10-31): six Source carriers, one per vehicle body. They are template holders for
  // the external entity stream (the SPI host spawns the vehicles, the plugin draws them through
  // EntityPool); the Sources never generate MUs themselves.
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_delivery :: Source',
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_hatchback :: Source',
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_sedan :: Source',
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_suv :: Source',
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_truck :: Source',
  '../realvirtual-WebViewer-Private~/projects/aXite/n201-junction-vri201234.glb :: VehicleSource_van :: Source',
  // plan-569 (2026-10-09): the laser welding demo's FG05 cap feed (a Source driven by a
  // plant pulse, SourceGenerate) and the cap sink on the return conveyor (DeleteOnlyTag
  // "Cap") — engine-owned continuous path, same pattern as the cell sources above.
  // 2026-10-16 (plan-610 Phase 5): the station hierarchy was restructured
  // (top level -> Simulation/<station>/...) — unchanged pattern, path only. Phase 5b renamed the
  // groups file-unique (Simulation -> Plant, FG05 -> FG05_Plant).
  'public/demo-realvirtual/LaserWeldingAssemblyStation.glb :: Plant/CapRemoval/CapRemoval_Sink :: Sink',
  'public/demo-realvirtual/LaserWeldingAssemblyStation.glb :: Plant/FG05_Plant/FG05_CapSource :: Source',
  '../realvirtual-WebViewer-Private~/projects/LaserWeldingAssemblyStation/LaserWeldingAssemblyStation-570.glb :: Plant/CapRemoval/CapRemoval_Sink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/LaserWeldingAssemblyStation/LaserWeldingAssemblyStation-570.glb :: Plant/FG05_Plant/FG05_CapSource :: Source',
  // plan-569 Teil 4: the valve body circulates the same way - a source at the entry stopper
  // (plant pulse, SourceGenerate) and a sink on the return conveyor (DeleteOnlyTag "Valve").
  'public/demo-realvirtual/LaserWeldingAssemblyStation.glb :: Plant/PartFeed/PartFeed_Source :: Source',
  'public/demo-realvirtual/LaserWeldingAssemblyStation.glb :: Plant/ValveRemoval/ValveRemoval_Sink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/LaserWeldingAssemblyStation/LaserWeldingAssemblyStation-570.glb :: Plant/PartFeed/PartFeed_Source :: Source',
  '../realvirtual-WebViewer-Private~/projects/LaserWeldingAssemblyStation/LaserWeldingAssemblyStation-570.glb :: Plant/ValveRemoval/ValveRemoval_Sink :: Sink',
  // Reviewed 2026-09-13: the Festo cell's two boxes are the same embedded
  // self-spawning pattern as the pallets above - a `Source` on a hidden inner
  // node (AutomaticGeneration, PlaceOnTransportSurface), engine-owned, so
  // nothing changes on the continuous path.
  // 2026-10-07: same two boxes, re-parented in the Festo hierarchy rework
  // (e06801631_asm/... -> Machine/Assembly/Boxen/...) — unchanged pattern, path only.
  // 2026-10-26: the three boxes lost their Source (private 5d5d04e, "boxes are pre-placed MUs,
  // no sources", Thomas 24.10.) - entries removed, the boxes are plain MUs now.
  // Reviewed 2026-10-15: a third box in the same self-spawning pattern (private 99e093f,
  // "third box in the material flow") - unchanged case, one more instance. Cloned from
  // Box-Front and started on the front belt since the filling fix (no queue at the funnel).
  // Reviewed 2026-09-27: the Festo logo demo (private b760563, "authored MU
  // physics for the Festo logo demo") spawns and removes its logo MUs through
  // an engine-owned Source/Sink pair - same case as the boxes above.
  '../realvirtual-WebViewer-Private~/projects/festo/Festo.glb :: LogoSource :: Source',
  '../realvirtual-WebViewer-Private~/projects/festo/Festo.glb :: LogoUnload :: Sink',
  // Reviewed 2026-10-07: CPTC META_201 material flow (private 8eafd47, "META_201 material
  // flow + physics chute") — an authored part Source feeding the physics chute and a Sink
  // at its end, engine-owned like the Festo pairs above.
  '../realvirtual-WebViewer-Private~/projects/CloverParkTechnicalCollege/META_201.glb :: ChuteSink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/CloverParkTechnicalCollege/META_201.glb :: PartSource :: Source',
  // Reviewed 2026-10-26: plan-661 Box2D jam-zone demos in the Development project (private
  // 45280dd "Test Box2D Stau", f56a588 "Getränkelinie Stau"; bottles restyled 93b3ba2/889699e).
  // Bottle Sources and end-of-line Sinks, engine-owned like the Festo logo pair above.
  '../realvirtual-WebViewer-Private~/projects/Development/Getränkelinie Stau.glb :: getraenkelinie-base_glb/Getraenkelinie/Infeed/BottleSource1 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Getränkelinie Stau.glb :: getraenkelinie-base_glb/Getraenkelinie/Infeed/BottleSource2 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Getränkelinie Stau.glb :: getraenkelinie-base_glb/Getraenkelinie/Infeed/BottleSource3 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Getränkelinie Stau.glb :: getraenkelinie-base_glb/Getraenkelinie/Outlet/Sink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/A_Box2D/BottleSource1 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/A_Box2D/BottleSource2 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/A_Box2D/Sink :: Sink',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/B_Referenz_ohne_Zone/BottleSource1 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/B_Referenz_ohne_Zone/BottleSource2 :: Source',
  '../realvirtual-WebViewer-Private~/projects/Development/Test Box2D Stau.glb :: Stautest/B_Referenz_ohne_Zone/Sink :: Sink',
];

/**
 * Reviewed entries for private customer projects whose names must not appear in the
 * public tree: they live in the private sibling (`tests/fixtures/behavior-extras-allowlist.json`,
 * `{ "entries": [...] }`, reasons in its `_comment`) and are merged here when it is present.
 */
const PRIVATE_ALLOWLIST_FILE = join(PRIVATE, 'tests/fixtures/behavior-extras-allowlist.json');
const FULL_ALLOWLIST: readonly string[] = [
  ...ALLOWLIST,
  ...(existsSync(PRIVATE_ALLOWLIST_FILE)
    ? (JSON.parse(readFileSync(PRIVATE_ALLOWLIST_FILE, 'utf8')) as { entries: string[] }).entries
    : []),
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
    const allowed = new Set(FULL_ALLOWLIST);
    const unexpected = fresh.filter(k => !allowed.has(k));

    expect(unexpected,
      'A GLB gained an rv_extras material-flow payload that nobody reviewed.\n' +
      'If it is intended, add it to ALLOWLIST in this file in the SAME commit as the asset.\n' +
      `Unexpected:\n  ${unexpected.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the continuous kernel newly binds ONLY the AGVDemo three, the AGVFactory eight and the PalletYard three', () => {
    const continuous = HITS
      .filter(h => !h.placed && !ENGINE_OWNED.has(h.type))
      .map(key).sort();

    // Strict frozen list: AGVDemo.glb (plan-455) + AGVFactory.glb (plan-903/558)
    // + PalletYard.glb (plan-612). PalletYard binds three here: its two pallet Sources
    // and two Sinks are ENGINE_OWNED and reach the DES kernel only, and since plan-612
    // CP1d-b (2026-10-20) its conveyors are AssetReference placements whose Conveyor
    // component lives in the library asset, not in this scene file — so only the three
    // Stapler Agvs (config on the reference node) remain in the scene inventory.
    expect(continuous).toEqual([
      'public/demo-realvirtual/AGVDemo.glb :: AGV_1 :: Agv',
      'public/demo-realvirtual/AGVDemo.glb :: AGV_2 :: Agv',
      'public/demo-realvirtual/AGVDemo.glb :: AGV_3 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_1 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_2 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_3 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_4 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_5 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_6 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_7 :: Agv',
      'public/demo-realvirtual/AGVFactory.glb :: AGV_8 :: Agv',
      'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_1 :: Agv',
      'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_2 :: Agv',
      'public/demo-realvirtual/PalletYard.glb :: PalletYardRoot/Stapler_3 :: Agv',
    ]);
  });

  it('the allowlist has no stale entries', () => {
    const present = new Set(HITS.filter(h => !h.placed).map(key));
    // Only meaningful with the private sibling checked out.
    if (!existsSync(PRIVATE)) return;
    expect(FULL_ALLOWLIST.filter(k => !present.has(k))).toEqual([]);
  });
});
