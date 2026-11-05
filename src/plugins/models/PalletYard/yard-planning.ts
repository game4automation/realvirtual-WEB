// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Project planning state and transactions, relocated from the old plugin. */
import type { Object3D } from 'three';
import type { PlantParameters, PlantParameterContext, PlantLiveContext } from '@rv/core/fleet/define-plant-plugin';
import type { PlanningRegistry } from '@rv/core/planning/rv-planning-registry';
import type { PlanningDeclaration, PlanningValue, PendingLiveChange, StructuralResetContext } from '@rv/core/planning/rv-planning-params';
import { getPlanningPlugin } from '@rv/plugins/planning-parameters';
import { DEFAULT_SIZE, DEFAULT_VEHICLES, DEFAULT_YARD, NO_AGV_DOWNTIME, SIZE_MAX, SIZE_MIN, composeYardWithVehicles, defaultVehiclesFor, maxVehiclesFor, withDowntimes, type AgvDowntime, type YardComposition } from './yard-compose';
import { PALLET_YARD_OWNER, PALLET_YARD_PLANNING_TITLE, SIZE_KEY, VEHICLES_KEY, derivePalletYardConfig, palletYardKpis, palletYardParams, validatePalletYard } from './parameters';
import { learnYardTemplates, materializeYard, findYardNode, type YardTemplates, type MaterializeReport } from './yard-materialize';
import type { PalletYardConfig } from './layout';
import { applyYardLive, SIZE_RECONCILE_PAUSE_REASON } from './yard-runtime';
import { yardMeanOrderSec } from './yard-order-kpis';
import { registerPalletYardSchema, readAgvDowntime, readVehicleCount, AGV_DOWNTIME_STOCHASTIC_FIELD, AGV_MTBF_FIELD, AGV_MTTR_FIELD, VEHICLE_COUNT_FIELD, YARD_STRUCTURAL_FIELDS, activeYardPlugin, setActiveYardPlanning } from './yard-schema';

const sameDowntime = (a: AgvDowntime, b: AgvDowntime): boolean =>
  a.mtbf === b.mtbf && (a.mtbf === 0 || (a.mttr === b.mttr && a.stochastic === b.stochastic));

export class YardPlanning implements PlantParameters {
  private context: PlantParameterContext | null = null;
  private root: Object3D | null = null;
  private offField: (() => void) | null = null;
  private get viewer() { return this.context?.viewer ?? null; }
  private get planning() { return this.context?.planning ?? null; }
  get runtime() { return this.context?.runtime ?? null; }
  /** The yard as it stands in the scene right now (`composeYard(n)`; the document's size after a load). */
  yard: YardComposition = DEFAULT_YARD;
  /** `PalletYard.Size` of the loaded document (the source the save keeps). */
  docSize = DEFAULT_SIZE;
  /**
   * `PalletYard.VehicleCount` of the loaded document, or null when the document
   * does not carry the field — then the size's own default applies and a size
   * change still scales the fleet (plan-2015). A value the user, a variant or an
   * experiment set is kept across size changes and only clamped to what fits.
   */
  docVehicles: number | null = null;
  /**
   * AGV breakdowns in effect (`PalletYard.AgvMtbf` / `AgvMttr` /
   * `AgvDowntimeStochastic`): the document's, or what a variant / experiment /
   * hand edit set since. Every composition of this session carries them, so a
   * changed AGV count keeps one `Downtime` per vehicle.
   */
  docDowntime: AgvDowntime = NO_AGV_DOWNTIME;
  /** Pose compensation per asset, learned from the loaded document (yard-materialize.ts). */
  private templates: YardTemplates | null = null;
  /** The planning declaration of this document (null without the planning plugin / not a yard). */
  private planningRegistry: PlanningRegistry | null = null;
  /** A materialisation failed half-way: the next structural reset rebuilds even at the same size. */
  private structureDirty = false;
  /** The load-time reconcile is running (its failure restores the document size itself). */
  private reconciling = false;
  /** The document identity the start hold of the load reconcile belongs to. */
  private holdToken = 0;
  /** A hand edit of `VehicleCount` is rebuilding — its own write-back must not re-enter. */
  private editingVehicleCount = false;
  /** What the last materialisation changed (diagnostics, tests). */
  lastMaterialize: MaterializeReport | null = null;

  adoptDocument(root: Object3D, ctx: PlantParameterContext): void {
    this.context = ctx;
    this.root = root;
    registerPalletYardSchema();
    setActiveYardPlanning(this);
    this.offField = ctx.viewer.on('component-field-changed', e => {
      if (e.componentType === 'PalletYard' && YARD_STRUCTURAL_FIELDS.includes(e.fieldName)) void this.onVehicleCountEdited();
    });
    const yardRoot = findYardNode(root, 'PalletYardRoot');
    const cfgNode = yardRoot ? (yardRoot.userData?.realvirtual as Record<string, unknown> | undefined)?.PalletYard as Record<string, unknown> | undefined : undefined;
    if (!yardRoot || !cfgNode) { this.yard = DEFAULT_YARD; this.templates = null; this.docVehicles = null; this.docDowntime = NO_AGV_DOWNTIME; return; }
    const size = Number(cfgNode.Size ?? DEFAULT_SIZE);
    this.docSize = Number.isInteger(size) && size >= SIZE_MIN && size <= SIZE_MAX ? size : DEFAULT_SIZE;
    this.docVehicles = readVehicleCount(cfgNode, this.docSize);
    this.docDowntime = readAgvDowntime(cfgNode);
    this.yard = this.composeFor(this.docSize);
    this.templates = learnYardTemplates(root, this.yard);
    this.structureDirty = false;
    this.planningRegistry = getPlanningPlugin(ctx.viewer)?.registry ?? null;
  }

  afterDeclare(ctx: PlantParameterContext): void {
    this.context = ctx;
    const committed = this.planning?.get<number>(SIZE_KEY);
    const plannedVehicles = this.plannedVehicles();
    if ((typeof committed === 'number' && committed !== this.docSize)
      || (plannedVehicles !== null && plannedVehicles !== this.yard.counts.vehicles)) void this.reconcileOnLoad();
  }

  declare(_doc: Object3D): PlanningDeclaration | null {
    if (!this.templates) return null;
    return {
      owner: PALLET_YARD_OWNER, title: PALLET_YARD_PLANNING_TITLE,
      params: palletYardParams(this.yard),
      kpis: palletYardKpis({
        counters: () => this.runtime?.counters ?? null, simSeconds: () => this.runtime?.simSeconds ?? 0,
        meanOrderSec: () => yardMeanOrderSec(this.runtime),
      }),
      validate: validatePalletYard,
    };
  }

  onLive(change: PendingLiveChange, ctx: PlantLiveContext): void {
    if (ctx.runtime) applyYardLive(ctx.runtime, change.key, change.to);
    ctx.applied(ctx.runtime?.clock.now() ?? ctx.viewer.simTime ?? 0);
  }

  private planningValues(): Readonly<Record<string, PlanningValue>> {
    return this.planning?.values() ?? {};
  }

  /** The run configuration at the committed planning values. */
  currentConfig(): PalletYardConfig {
    return derivePalletYardConfig(this.yard, this.planningValues());
  }

  async onStructuralReset(committed: Readonly<Record<string, PlanningValue>>, ctx: StructuralResetContext & PlantParameterContext): Promise<void> {
    const viewer = this.viewer;
    const root = this.root;
    if (!viewer || !root) return;
    const size = typeof committed[SIZE_KEY] === 'number' ? committed[SIZE_KEY] as number : this.docSize;
    const next = this.composeFor(size, this.plannedVehicles() ?? this.docVehicles);
    if (next.counts.vehicles !== this.yard.counts.vehicles || size !== this.yard.size || this.structureDirty) {
      try {
        await this.materialize(next, ctx);
      } catch (err) {
        if (this.reconciling && this.docSize !== size && !ctx.signal.aborted) {
          // No previous values to revert to: back to the document's own size, and
          // committed follows the scene (plan-681 F2; a refusal is a Problems entry).
          await this.materialize(this.composeFor(this.docSize), ctx);
          this.planning?.recoverCommitted({ [SIZE_KEY]: this.yard.size });
        }
        throw err;
      }
    }
  }

  /**
   * The yard at `size` with the AGV count that is in effect (plan-2015): the
   * stored `VehicleCount` when the document (or a variant / experiment / hand
   * edit) carries one — clamped to what the new size has start positions for —
   * else the size's own default, so a pure size change still scales the fleet
   * the way it did before the parameter existed.
   */
  /**
   * The AGV count the planning window has EXPLICITLY committed, or null when the
   * row was never touched (`source: 'default'`). The distinction matters: an
   * untouched row always carries the default of the yard it was declared for, so
   * reading it blindly would freeze the fleet at the old size's default and a
   * pure size change would stop scaling the fleet (plan-681 behaviour).
   *
   * Precedence of the AGV count, highest first:
   *   1. an explicit planning value (window, scenario, experiment)
   *   2. `PalletYard.VehicleCount` in rv_extras (the document, a variant, a hand edit)
   *   3. the size's own default (`vehiclesPerModule`)
   */
  plannedVehicles(): number | null {
    const state = this.planningRegistry?.list().find((p) => p.key === `${PALLET_YARD_OWNER}.${VEHICLES_KEY}`);
    if (!state || state.source === 'default' || typeof state.value !== 'number') return null;
    return state.value;
  }

  composeFor(size: number, vehicles: number | null = this.plannedVehicles() ?? this.docVehicles, downtime: AgvDowntime = this.docDowntime): YardComposition {
    const want = vehicles === null ? defaultVehiclesFor(size) : Math.min(Math.max(1, vehicles), maxVehiclesFor(size));
    if (size === DEFAULT_SIZE && want === DEFAULT_VEHICLES) return withDowntimes(DEFAULT_YARD, downtime);
    return composeYardWithVehicles(size, want, downtime);
  }

  /** Make the scene BE `next`, keep the declaration in step, and remember what stands there. */
  private async materialize(next: YardComposition, ctx: Pick<StructuralResetContext, 'awaitPlacements' | 'signal'>): Promise<void> {
    const viewer = this.viewer;
    const root = this.root;
    if (!viewer || !root) throw new Error('palletYard: no scene to rebuild');
    if (!this.templates) throw new Error('palletYard: the loaded document is not a PalletYard (no templates)');
    // plan-2015: the `vehicles` row's bound and default are the yard's — a changed
    // count must redeclare too, so an untouched row keeps showing what stands there.
    const keysChange = next.size !== this.yard.size || next.counts.vehicles !== this.yard.counts.vehicles;
    this.structureDirty = true;
    this.lastMaterialize = await materializeYard(viewer as unknown as Parameters<typeof materializeYard>[0], root, next, this.templates, ctx);
    this.structureDirty = false;
    this.yard = next;
    if (keysChange) this.planning?.redeclare(palletYardParams(next));
  }

  /**
   * Rebuild the yard to `vehicles` AGVs (plan-2015) — the body both the
   * `paramApply: 'rebuild'` handler and the Inspector edit run. Out-of-range
   * values throw here, not silently compose something else; the apply then
   * rolls the value back and calls the handler again with the previous one.
   */
  async rebuildYard(
    size: number, vehicles: number, ctx: Pick<StructuralResetContext, 'awaitPlacements' | 'signal'>,
    downtime: AgvDowntime = this.docDowntime,
  ): Promise<void> {
    const next = composeYardWithVehicles(size, vehicles, downtime);
    this.context?.prepareUnbind();
    this.docVehicles = vehicles;
    this.docDowntime = downtime;
    await this.materialize(next, ctx);
  }

  /**
   * A hand edit of `PalletYard.VehicleCount` in the Inspector: the value is
   * already in rv_extras, the structure is not. Rebuild in an own structural
   * transaction (ONE reset at its close) and, when the value does not compose,
   * put the previous one back into the field so the row never shows a number
   * the scene does not have.
   */
  private async onVehicleCountEdited(): Promise<void> {
    const viewer = this.viewer;
    if (!viewer || this.editingVehicleCount) return;
    const cfg = this.yardExtras();
    if (!cfg) return;
    const size = this.yard.size;
    const want = readVehicleCount(cfg, size) ?? defaultVehiclesFor(size);
    const wantDowntime = readAgvDowntime(cfg);
    if (want === this.yard.counts.vehicles && sameDowntime(wantDowntime, this.docDowntime) && !this.structureDirty) return;
    const previous = this.yard.counts.vehicles;
    const previousDowntime = this.docDowntime;
    const ctx = this.rebuildContext(new AbortController().signal);
    this.editingVehicleCount = true;
    try {
      await viewer.structuralEdit(() => this.rebuildYard(size, want, ctx, wantDowntime));
    } catch (err) {
      console.warn(`[PalletYard] ${VEHICLE_COUNT_FIELD} ${want} / AGV downtime could not be built — back to ${previous}`, err);
      cfg[VEHICLE_COUNT_FIELD] = previous;
      cfg[AGV_MTBF_FIELD] = previousDowntime.mtbf;
      cfg[AGV_MTTR_FIELD] = previousDowntime.mttr;
      cfg[AGV_DOWNTIME_STOCHASTIC_FIELD] = previousDowntime.stochastic;
      try {
        await viewer.structuralEdit(() => this.rebuildYard(size, previous, ctx, previousDowntime));
      } catch { /* the Problems panel of the materialisation carries it */ }
    } finally {
      this.editingVehicleCount = false;
    }
  }

  /** A rebuild context of this session: wait for the instancer, abort with `signal`. */
  rebuildContext(signal: AbortSignal): Pick<StructuralResetContext, 'awaitPlacements' | 'signal'> {
    const viewer = this.viewer;
    return { signal, awaitPlacements: () => viewer?.placements.whenMaterialized() ?? Promise.resolve() };
  }

  /** The `PalletYard` rv_extras block of the loaded scene, or null. */
  yardExtras(): Record<string, unknown> | null {
    const root = this.root;
    const yardRoot = root ? findYardNode(root, 'PalletYardRoot') : null;
    const rv = yardRoot ? yardRoot.userData?.realvirtual as Record<string, unknown> | undefined : undefined;
    return (rv?.PalletYard as Record<string, unknown> | undefined) ?? null;
  }

  /**
   * Rebuild to the AGV count that STANDS IN rv_extras right now (plan-2015) —
   * the `registerComponentRebuild` path of the planning window's component
   * parameters, which writes the value first and then asks the type to re-read
   * it. Nothing to do when the structure already matches.
   */
  async rebuildFromStoredCount(ctx: Pick<StructuralResetContext, 'awaitPlacements' | 'signal'>): Promise<void> {
    const cfg = this.yardExtras();
    if (!cfg) throw new Error('palletYard: the loaded document is not a PalletYard');
    const size = this.yard.size;
    const want = readVehicleCount(cfg, size) ?? defaultVehiclesFor(size);
    const downtime = readAgvDowntime(cfg);
    if (want === this.yard.counts.vehicles && sameDowntime(downtime, this.docDowntime) && !this.structureDirty) { this.docVehicles = want; return; }
    await this.rebuildYard(size, want, ctx, downtime);
  }

  /**
   * Load-time reconcile (plan-681 §2.2 "Laden", Gate-R2 #4): the session's
   * committed size differs from the document's. The simulation is held (its own
   * pause reason — autostart included) until the placements of the load are
   * there and the yard was rebuilt through the SAME apply runner
   * (`reconcileStructure`); a document change lifts the hold and drops it.
   */
  private async reconcileOnLoad(): Promise<void> {
    const viewer = this.viewer;
    const registry = this.planningRegistry;
    if (!viewer || !registry) return;
    const token = ++this.holdToken;
    viewer.setSimulationPaused(SIZE_RECONCILE_PAUSE_REASON, true);
    try {
      // `whenSceneReady`, not `placements.whenMaterialized`: this runs inside
      // onModelLoaded, BEFORE the viewer queues the load's deferred placements —
      // an idle instancer resolves at once and the rebuild then races the load's
      // own placements (plan-630 Phase 3: a saved size 3 came back with two
      // "asset not loaded" placeholders). The scene-ready join waits for the load
      // in flight first, then for its placements.
      await viewer.whenSceneReady();
      if (token !== this.holdToken) return;
      this.reconciling = true;
      const r = await registry.reconcileStructure(PALLET_YARD_OWNER);
      if (!r.ok) console.warn(`[PalletYard] size reconcile after load failed: ${r.error}${r.detail ? ` — ${r.detail}` : ''}`);
    } finally {
      this.reconciling = false;
      if (token === this.holdToken) viewer.setSimulationPaused(SIZE_RECONCILE_PAUSE_REASON, false);
    }
  }

  dispose(): void {
    this.holdToken++;
    this.viewer?.setSimulationPaused(SIZE_RECONCILE_PAUSE_REASON, false);
    this.offField?.(); this.offField = null;
    if (activeYardPlugin() === this) setActiveYardPlanning(null);
    this.context = null;
    this.planningRegistry = null;
    this.root = null; this.templates = null;
    this.yard = DEFAULT_YARD; this.docSize = DEFAULT_SIZE; this.docVehicles = null; this.docDowntime = NO_AGV_DOWNTIME;
    this.structureDirty = false;
  }
}
