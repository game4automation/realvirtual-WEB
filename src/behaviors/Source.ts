// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source — material-flow GENERATOR definition (Plan 194 §2.2, P3).
 *
 * Authored as a `defineLibraryComponent` (`kind:'source'`, `inert:true`) so the
 * unified-simulation surface (registry + DES hooks) covers MU generation. ONE
 * definition, but only TWO layers carry effect here:
 *
 *   - `des.onGenerate(self)` — the EVENT-DRIVEN path (private DESRunner, P5):
 *     mint a fresh MU and transfer it to the first free output, then schedule the
 *     next generation from the spawn schedule (Interval / Distance / OnSignal).
 *   - `continuous` — a thin, INERT pass-through marker.
 *
 * ── Why the component is inert (the double-spawn guard) ─────────────────────
 *
 * The CONTINUOUS spawn driver is the engine component `RVSource`
 * (`src/core/engine/rv-source.ts`), constructed from `rv_extras['Source']` by the
 * scene loader and ticked by the transport manager. It owns template resolution,
 * ghost/preview rendering, placement gating, and the actual clone/instanced
 * spawn. This behavior MUST NOT re-implement any of that: if its `continuous`
 * block spawned, every Source asset would spawn TWICE (engine + behavior) on the
 * default path — a regression. So `inert:true` runs setup but registers NO
 * fixedUpdate. The definition exists for the material-flow registry (dual
 * discovery, §2.6) and for the `des` adapter; it does NOT drive the continuous
 * simulation.
 *
 * The behavior binds only when a placed asset's name matches `*Source*` (the
 * BehaviorManager matches `models[]` against the GLB filename / LayoutObject
 * asset name, never against inner node names), so it never collides with an
 * arbitrary `Source` rv_extras entry on some inner node.
 *
 * Schema is mode-agnostic and read straight from `rv_extras['Source']` — the
 * same fields the engine `RVSource` consumes (Interval / GenerateIfDistance /
 * AutomaticGeneration / ThisObjectAsMU). No values are duplicated; the schema is
 * registered for inspector visibility and consumed by the DES generator.
 */

import { defineLibraryComponent, type RV } from './_shared/behavior-kit';

/** Seconds between generations, derived from the mode-agnostic schema. */
function generationInterval(self: RV.Self<SourceLocal>): number {
  const interval = Number(self.prop['Interval'] ?? 0);
  // Default cadence mirrors the engine RVSource (3 s) when no interval is set.
  return interval > 0 ? interval : 3;
}

/** Per-instance DES state. `pending` is the at-most-one MU generated but held
 *  because the downstream is full (ZPA pull, plan-225 B2) — null when idle. */
interface SourceLocal {
  pending: RV.MU | null;
}

/**
 * Emit ONE part downstream IFF the successor can take it right now: flush a held MU
 * (ZPA) or mint a fresh one, and transfer; if the successor is still full, hold it
 * (at most one) and wait. Shared by `onGenerate` (heartbeat safety net) and
 * `onDownstreamReady` (the ASAP demand pull) so both follow identical, no-flood
 * semantics — the source only ever spawns when nothing is pending.
 *
 * With `AutomaticGeneration` (the default) the DES source has NO production rate: it
 * is purely demand-driven and emits the instant the successor frees, throttled only
 * by the line itself. `AutomaticGeneration=false` disables automatic spawning.
 */
function emitIfDownstreamFree(self: RV.Self<SourceLocal>): void {
  if (self.prop['AutomaticGeneration'] === false) return;
  const out = self.outputs()[0];
  const mu: RV.MU = self.local.pending ?? self.spawn();
  if (self.downstreamCanAccept(mu, out)) {
    self.local.pending = null;
    self.transfer(mu, out);
  } else {
    self.local.pending = mu;
  }
}

const def = {
  // Any placed asset whose name contains "Source": Source, PartSource, …
  type: 'Source' as const,
  kind: 'source' as const,
  description: 'Source that spawns parts (MUs) and feeds them into the line.',
  mcpDocs:
    'Start of a material-flow line: spawns MUs (pallets/boxes) at an interval and pushes them ' +
    'onto the connected conveyor. Place it at the head of a run (snap it to a conveyor input). ' +
    'Spawn rate / part template / automatic generation are config fields.',
  models: ['*Source*'],
  // Spawn config — the SAME field names the engine RVSource consumes. This
  // behavior is inert:true (no continuous fixedUpdate) and only the `des` block
  // reads them (generationInterval → self.prop['Interval']); the LIVE spawn driver
  // is the engine RVSource component (its own editable "Source" inspector section).
  // Editing these on the SourceBehavior marker has NO live effect and would
  // duplicate/contradict the real Source section, so all are scope:'des'
  // (read-only, "(DES)" tag) — edit the live values in the Source section instead.
  schema: {
    AutomaticGeneration: { type: 'boolean' as const, default: true, scope: 'des' as const },
    Interval:            { type: 'number' as const,  default: 0, aliases: ['SpawnInterval'], scope: 'des' as const },
    GenerateIfDistance:  { type: 'number' as const,  default: 300, aliases: ['SpawnDistance'], scope: 'des' as const },
    ThisObjectAsMU:      { type: 'string' as const,  default: '', scope: 'des' as const },
  },

  // Per-instance DES state slot (pending MU for ZPA back-pressure).
  state: (): SourceLocal => ({ pending: null }),

  // Mode-agnostic init: clear the held MU so a Reset-on-Switch / DESRunner.start
  // begins fresh (self.local persists across start, only setup re-runs).
  setup(self: RV.Self<SourceLocal>): void {
    self.local.pending = null;
  },

  // ── Continuous adapter — INERT. The engine RVSource owns continuous spawning. ──
  // No fixedUpdate (no double-spawn on the default path) — guaranteed by
  // `inert:true`. See the file header "double-spawn guard".
  continuous: {},

  // ── DES adapter — event-driven generation with ZPA back-pressure (DESRunner) ──
  des: {
    /**
     * Emit ONE MU when the line can take it (ZPA pull), then re-arm a heartbeat.
     * Together with `onDownstreamReady` this makes the DES source demand-driven
     * (AutomaticGeneration → no production rate, see `emitIfDownstreamFree`). The
     * heartbeat is ONLY a deadlock-safety net for a missed one-shot wake — NOT the
     * cadence; `onDownstreamReady` drives normal generation. The source sits in the
     * band's `previousComponents`, so the band's `releaseMU` reaches it here.
     */
    onGenerate(self: RV.Self<SourceLocal>): void {
      emitIfDownstreamFree(self);
      self.in(generationInterval(self), 'Generate', null); // heartbeat safety net
    },

    /**
     * ASAP pull (the PRIMARY driver of automatic generation): the successor reported
     * free space → emit the next part IMMEDIATELY (flush a held one, or mint+transfer
     * a fresh one), not on the next heartbeat tick. This is what makes the DES source
     * demand-driven with no production rate — a new part appears the instant the line
     * can take it. The line's own capacity (1 part per conveyor) is the only
     * throttle. No-op while the successor is still full.
     */
    onDownstreamReady(self: RV.Self<SourceLocal>): void {
      emitIfDownstreamFree(self);
    },
  },
};

/**
 * Source — inert material-flow generator (factory-built). The continuous bind
 * stamps the inspector badge and runs setup, but `inert:true` registers NO
 * fixedUpdate — the engine RVSource (constructed from rv_extras) remains the sole
 * continuous spawn driver.
 */
const SourceBehavior = defineLibraryComponent(def, { inert: true });

export default SourceBehavior;
