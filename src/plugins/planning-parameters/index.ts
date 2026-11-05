// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, writeLocalStorage } from '../../core/rv-safe-storage';

/**
 * PlanningParametersPlugin — the viewer's owner of the planning registry (plan-630 §2.6).
 *
 * The registry itself (`core/planning/`) is pure: it knows nothing of a viewer,
 * a document or React. This plugin is what gives it a home in a running viewer:
 *
 *  - it CREATES the one registry of the session and hands it the viewer's sim
 *    clock, the document identity and the display-switch storage;
 *  - it installs the §2.5a apply runner (`structural-reset.ts`), so an apply
 *    really halts, commits, reconfigures and restarts the run;
 *  - it mounts the planning window the FIRST time a model declares something
 *    (dynamic import, like `WEB_OPERATOR_PANEL_UI`) — a document without
 *    planning parameters never loads the overlay module;
 *  - it mirrors the display switches onto the existing overlay-visibility store
 *    (F11: one truth, the Groups panel and this window are two views of it);
 *  - it retires the `planning-*` Problems entries when the document goes;
 *  - it owns the document's scenarios (§2.8): reads the `PlanningScenarios` block of every
 *    loaded document, hands the active scenario to the registry as the start values, and
 *    writes the block back on an explicit save (`saveScenario`);
 *  - it owns the planning owner `component` (§2.14, Phase 8): the existing component
 *    properties the document selected for the window (`selection[]` of the same block) and
 *    the ONE writer of planning values into rv_extras (`component-params-owner.ts`).
 *
 * ## Scenarios
 *
 * The block of the loaded file is read in `onModelLoaded` — which runs before any project
 * plugin's `onModelLoaded` (core plugins register first), so a model that declares while it
 * adopts the document (PalletYard) finds its stored values already waiting as dormant values
 * and takes them as COMMITTED start values. A reset-class value (the PalletYard size) thus
 * reaches the model's own load-time rebuild, exactly like a value kept from a previous
 * document did before. A document without a block starts at the defaults: a document's
 * values no longer leak into the next one.
 *
 * ## How a model reaches the registry
 *
 * `getPlanningRegistry(viewer)` — the plugin is looked up by id, so nothing of
 * this has to live on `RVViewer`:
 *
 * ```ts
 * const planning = getPlanningRegistry(viewer);
 * const handle = planning?.declare({ owner: 'palletYard', title: 'Planung · PalletYard', params, onLive });
 * ```
 *
 * ## Why the toolbar reset is not an apply
 *
 * `viewer.resetSimulation()` from the toolbar restarts the structure that is
 * there; it does NOT take pending values over (§2.5 table). So the plugin turns
 * `'simulation-reset'` into `registry.notifySimulationReset()` (new run, live
 * queue dropped, pending kept) — except while an apply is in flight, where the
 * runner has already started the new run and the commit rows at t = 0 belong to
 * it.
 */

import { lazy } from 'react';
import type { RVViewer } from '../../core/rv-viewer';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { PluginContext } from '../../core/rv-plugin-context';
import {
  createPlanningRegistry,
  type PlanningApplyResult,
  type PlanningDisplayStorage,
  type PlanningRegistry,
} from '../../core/planning/rv-planning-registry';
import type { PlanningParamDef } from '../../core/planning/rv-planning-params';
import { clearProblemsOfCode, reportProblem } from '../../core/hmi/problems-store';
import type { PlanningSetManyResult } from '../../core/planning/rv-planning-registry';
import {
  checkScenarioName, collectScenarioValues, emptyScenarioBlock, hasScenario, parsePlanningScenarios,
  sameScenarioValues, withActiveScenario, withScenario,
  type PlanningScenarioBlock, type PlanningScenarioIssue,
} from '../../core/planning/rv-planning-scenario';
import type { ScenarioSaveResult } from './scenario-persistence';
import {
  OVERLAY_CATEGORIES, getOverlaySnapshot, isOverlayVisible, setOverlayVisible,
  subscribeOverlayVisibility, type OverlayCategory,
} from '../../core/overlay-visibility-store';
import { ensureUIElementRule, type UIVisibilityRule } from '../../core/hmi/ui-context-store';
import { modeContext } from '../../core/rv-mode-manager';
import { createStructuralResetRunner } from './structural-reset';
import { ensurePlanningCommandsRegistered } from './planning-command-descriptors';
import type { ComponentParamsOwner } from './component-params-owner';
import type { ComponentParamVerdict } from '../../core/planning/rv-planning-component-params';
import {
  PROBLEM_SELECTION_INVALID, PROBLEM_SELECTION_UNSUPPORTED, isComponentSelected, sameComponentSelection,
  sameComponentTarget, type ComponentParamSelection, type ComponentParamTarget,
} from '../../core/planning/rv-planning-component-selection';
import { withSelection, withoutScenarioKey } from '../../core/planning/rv-planning-scenario';
import { registerFieldRowAction } from '../../core/hmi/rv-field-row-actions';
import { getActiveAssetContext } from '../../core/editor/active-asset-store';
import { registerPlanningKpiSections } from './planning-kpis-hub';

/** Plugin id — `viewer.getPlugin(PLANNING_PLUGIN_ID)`. */
export const PLANNING_PLUGIN_ID = 'planning-parameters';

/** Owner of the display switches (F11): the adapter on the overlay-visibility store. */
export const DISPLAY_OWNER = 'display';

/** Visibility id of the planning window. */
export const PLANNING_VISIBILITY_ID = 'planning-parameters';

/**
 * Where the window is at home: everywhere a plant runs — viewer, DES workspace,
 * commissioning, planner — and NOT in the asset editor, which authors a tree.
 * Registered at start-up rather than carried on the slot entry; see
 * `PLANNING_OVERLAY_UI` for why.
 */
export const PLANNING_VISIBILITY_RULE: UIVisibilityRule = { hiddenIn: [modeContext('editor')] };

/** Problems codes this plugin retires when the document goes (`owner-teardown`). */
const PLANNING_PROBLEM_CODES = [
  'planning-declaration-invalid',
  'planning-param-orphaned',
  'planning-scenario-value-invalid',
  'planning-scenario-block-invalid',
  'planning-apply-failed',
  'planning-apply-rollback-failed',
  'planning-committed-recovered',
  'planning-committed-recovery-failed',
  PROBLEM_SELECTION_INVALID,
  PROBLEM_SELECTION_UNSUPPORTED,
  // plan-2005 Phase 7: a batch could not put the planning values back — about THIS document.
  'experiment-restore-failed',
] as const;

/** Verdict while the lazily loaded `component` owner is not there yet. */
const COMPONENT_OWNER_LOADING: ComponentParamVerdict = Object.freeze({
  ok: false, code: 'unresolved', message: 'planning components are still loading', key: null, effectiveKey: null,
});

/** The inspector's "Show in planning window" toggle — its own chunk, loaded on first use. */
const PlanningFieldAction = lazy(() => import('./PlanningFieldAction'));

/** Problems code of a stored block (or one of its scenarios) this viewer could not use. */
const PROBLEM_SCENARIO_BLOCK = 'planning-scenario-block-invalid';
/** Problems code of one stored value or key that was dropped. */
const PROBLEM_SCENARIO_VALUE = 'planning-scenario-value-invalid';

/** The scenario side of the session, for the window (value-stable between changes). */
export interface PlanningScenarioState {
  /** The scenarios of this session (what a save of the active one builds on). */
  readonly block: PlanningScenarioBlock;
  /** What the FILE carries — as loaded, or as last saved. */
  readonly saved: PlanningScenarioBlock;
  readonly saving: boolean;
  /** Last save error, in words; null after a successful save. */
  readonly error: string | null;
  /**
   * The file holds something the session dropped while reading it (a malformed key, a
   * non-scalar value, an unreadable block): a save would change the file even when the
   * values match. Cleared by a successful save.
   */
  readonly fileDiffers: boolean;
}

const DISPLAY_STORAGE_PREFIX = 'rv-planning-display:';

/** localStorage-backed display storage, by owner. Never throws (private window). */
const localDisplayStorage: PlanningDisplayStorage = {
  load(owner) {
    try {
      const raw = readLocalStorage(DISPLAY_STORAGE_PREFIX + owner);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  },
  save(owner, values) {
    try { writeLocalStorage(DISPLAY_STORAGE_PREFIX + owner, JSON.stringify(values)); } catch { /* unavailable */ }
  },
};

export class PlanningParametersPlugin implements RVViewerPlugin {
  readonly id = PLANNING_PLUGIN_ID;
  readonly core = true;
  readonly order = 60;

  private _viewer: RVViewer | null = null;
  private readonly _registry: PlanningRegistry;

  /** Bumped on every document change — the ONLY identity that means "another document". */
  private _documentLoadId = 'planning-doc-0';
  private _documentCounter = 0;
  private _documentAbort = new AbortController();

  /** Mounted the first time something is declared. */
  private _overlayMounted = false;
  private _applyInFlight = false;

  private _offListeners: Array<() => void> = [];
  /** Display keys this plugin wrote into the overlay store, to break the echo. */
  private _displayWriting = false;
  private _displayCategories: OverlayCategory[] = [];
  private _declaringDisplay = false;
  private _displayHandle: { redeclare(p: readonly PlanningParamDef[]): void; dispose(): void } | null = null;

  private _scenario: PlanningScenarioState = Object.freeze({
    block: emptyScenarioBlock(), saved: emptyScenarioBlock(), saving: false, error: null, fileDiffers: false,
  });
  private readonly _scenarioListeners = new Set<() => void>();

  /**
   * Owner `component` (§2.14): selected component properties and the one writer. Loaded
   * with `import()` at `init` (the derivation, the key hash and the schema lookup stay out
   * of the entry chunk); null until then.
   */
  private _component: ComponentParamsOwner | null = null;
  private _componentLoad: Promise<ComponentParamsOwner> | null = null;
  /** Settles when the current document's component declaration (and its reconciliation) is done. */
  private _componentSettled: Promise<void> = Promise.resolve();

  constructor() {
    this._registry = createPlanningRegistry({
      simTime: () => this._viewer?.simTime ?? 0,
      documentLoadId: () => this._documentLoadId,
      displayStorage: this._displayStorage(),
    });
  }

  /** The one registry of this session. */
  get registry(): PlanningRegistry { return this._registry; }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  init(viewer: RVViewer, _context?: PluginContext): void {
    ensurePlanningCommandsRegistered();
    this._viewer = viewer;
    this._offListeners.push(registerPlanningKpiSections(this._registry, viewer.stats));
    void this._loadComponentOwner().catch((err) => {
      console.error('[planning-parameters] loading the component owner failed:', err);
    });
    // Before any render, so the slot that arrives at runtime brings no rule.
    ensureUIElementRule(PLANNING_VISIBILITY_ID, PLANNING_VISIBILITY_RULE);
    this._registry.setApplyRunner(createStructuralResetRunner({
      viewer,
      documentLoadId: () => this._documentLoadId,
      signal: () => this._documentAbort.signal,
      markApplying: (active) => { this._applyInFlight = active; },
    }));

    // A toolbar reset starts a new run but keeps the pending values (§2.5).
    this._offListeners.push(viewer.on('simulation-reset', () => {
      if (this._applyInFlight) return;
      this._registry.notifySimulationReset();
    }));

    // F11: the overlay store stays the one truth. Its changes (Groups panel,
    // MCP, another plugin) come back into the registry here.
    this._offListeners.push(subscribeOverlayVisibility(() => {
      if (this._displayWriting) return;
      this._syncDisplayFromStore();
    }));

    // The registry publishes; the FIRST declaration is what mounts the window.
    this._offListeners.push(this._registry.subscribe(() => { void this._onRegistryChanged(); }));

    // §2.14: the inspector offers "Show in planning window" on every field that can be one.
    this._offListeners.push(registerFieldRowAction({
      id: 'planning-parameter',
      applies: ({ componentType, fieldName }) => getActiveAssetContext() === null
        && this._component?.isSelectable(componentType, fieldName) === true,
      component: PlanningFieldAction,
    }));
  }

  onModelLoaded(result: unknown, viewer: RVViewer): void {
    this._viewer = viewer;
    this._newDocument();
    this._loadDocumentScenarios(result);
    const loadId = this._documentLoadId;
    // After the scene is complete: the selected component properties resolve (they are
    // declared now), and a scenario key nobody declared is a finding (§2.4) — before that
    // it is simply a declaration that has not happened yet.
    this._componentSettled = viewer.whenSceneReady().then(async () => {
      const owner = await this._loadComponentOwner();
      if (this._viewer !== viewer || this._documentLoadId !== loadId) return;
      const reconciled = owner.sceneReady(this._scenario.block.selection ?? []);
      this._registry.reportOrphans();
      await reconciled;
    }).catch(() => { /* a failed load reports its own problem */ });
  }

  onModelCleared(_viewer: RVViewer): void {
    this._newDocument();
    // `owner-teardown`: the findings describe THAT document, so they go with it. By code:
    // the ids carry the key they are about (`planning-param-orphaned:<key>`).
    for (const code of PLANNING_PROBLEM_CODES) clearProblemsOfCode(code);
    this._setScenario({ block: emptyScenarioBlock(), saved: emptyScenarioBlock(), saving: false, error: null, fileDiffers: false });
  }

  dispose(): void {
    for (const off of this._offListeners) { try { off(); } catch { /* ignore */ } }
    this._offListeners = [];
    this._documentAbort.abort();
    this._registry.setApplyRunner(null);
    this._viewer = null;
  }

  // ─── Apply ───────────────────────────────────────────────────────────────

  /**
   * The structural reset of §2.5a — what the overlay's button, `web_param_apply`
   * and (later) the experiment batch call. A convenience: the registry itself is
   * just as good an entry, because the runner (not this method) is what tells
   * the plugin an apply is in flight.
   */
  applyPendingAndReset(): Promise<PlanningApplyResult> {
    return this._registry.applyPendingAndReset();
  }

  /** Identity of the loaded document — changes ONLY on a document change (§2.3, plan-2005 Phase 7 snapshot binding). */
  get documentLoadId(): string { return this._documentLoadId; }

  /** The load-time reconciliation of one owner (plan-681 Gate-R2 #4). */
  reconcileStructure(owner: string): Promise<PlanningApplyResult> {
    return this._registry.reconcileStructure(owner);
  }

  // ─── Scenarios (§2.8) ────────────────────────────────────────────────────

  /** The scenario state of the session (same object until it changes). */
  getScenarioState(): PlanningScenarioState { return this._scenario; }

  subscribeScenario(listener: () => void): () => void {
    this._scenarioListeners.add(listener);
    return () => { this._scenarioListeners.delete(listener); };
  }

  /**
   * Does the session differ from what the file says — another active scenario, or values
   * of the active one that a save would change? (The window's dirty marker.)
   */
  isScenarioDirty(): boolean {
    const { block, saved, fileDiffers } = this._scenario;
    if (fileDiffers) return true;
    if (!sameComponentSelection(block.selection, saved.selection)) return true;
    if (block.active !== saved.active || !hasScenario(saved.scenarios, block.active)) return true;
    return !sameScenarioValues(collectScenarioValues(this._registry), saved.scenarios[block.active]);
  }

  /**
   * Switch to another stored scenario: its values through the registry's normal paths —
   * `live` at the next sim instant, `reset` pending (the apply rebuilds). Not saved.
   */
  switchScenario(name: string): PlanningSetManyResult | { ok: false; error: string } {
    const { block } = this._scenario;
    if (!hasScenario(block.scenarios, name)) return { ok: false, error: `No scenario "${name}".` };
    const result = this._registry.applyScenario(block.scenarios[name], 'scenario');
    if (result.ok) this._setScenario({ ...this._scenario, block: withActiveScenario(block, name), error: null });
    return result;
  }

  /**
   * Save the session's values as scenario `name` (default: the active one) and make it the
   * active one — into the document's GLB when the open document can be written, otherwise
   * for the session only (`persistedTo: 'session'`, the reason with it). Explicit only;
   * nothing calls this on its own.
   */
  async saveScenario(name?: string): Promise<ScenarioSaveResult> {
    const checked = checkScenarioName(name ?? this._scenario.block.active);
    if (!checked.ok) throw new Error(checked.error);
    if (this._scenario.saving) throw new Error('A save is already running.');
    const loadId = this._documentLoadId;
    this._setScenario({ ...this._scenario, saving: true, error: null });
    try {
      const { resolveScenarioTarget, saveScenarioBlock } = await import('./scenario-persistence');
      // Values AND target are captured together, after the only await before the write:
      // a document change during the import must not send this document's values into
      // the next one (the CAS cannot catch that — the next file's revision is fresh).
      if (this._documentLoadId !== loadId) throw new Error('The document changed before the save started.');
      const next = withScenario(this._scenario.block, checked.name, collectScenarioValues(this._registry), true);
      const result = await saveScenarioBlock(next, resolveScenarioTarget());
      if (this._documentLoadId !== loadId) return result; // another document meanwhile
      const toFile = result.persistedTo === 'glb';
      this._setScenario({
        // A selection changed while the write was on its way stays the session's (the
        // dirty marker then says the file is behind) — review #6.
        block: withSelection(next, this._scenario.block.selection ?? []),
        saved: toFile ? (result.block ?? emptyScenarioBlock()) : this._scenario.saved,
        saving: false,
        error: null,
        fileDiffers: toFile ? false : this._scenario.fileDiffers,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this._documentLoadId === loadId) this._setScenario({ ...this._scenario, saving: false, error: message });
      throw err;
    }
  }

  // ─── Component properties (§2.14) ────────────────────────────────────────

  /** The component properties shown in the planning window (document-wide). */
  getComponentSelection(): readonly ComponentParamSelection[] {
    return this._scenario.block.selection ?? [];
  }

  /** Is this component property shown in the planning window? */
  isComponentParamShown(target: ComponentParamTarget): boolean {
    return isComponentSelected(this._scenario.block.selection, target);
  }

  /** Can a field of this component type be a planning parameter at all (address-free)? */
  isComponentFieldSelectable(component: string, field: string): boolean {
    return this._component?.isSelectable(component, field) === true;
  }

  /** Why (not) — the full derivation for one property, nothing declared. */
  componentParamVerdict(entry: ComponentParamSelection): ComponentParamVerdict {
    return this._component?.verdict(entry) ?? COMPONENT_OWNER_LOADING;
  }

  /** Settles when the current document's component properties are declared (and written, if a scenario said so). */
  whenComponentParamsSettled(): Promise<void> {
    return this._componentSettled;
  }

  /**
   * Shows an existing component property in the planning window: one change of the
   * session's `selection[]` (persisted with the next explicit Save, like any scenario
   * value). Refused — with the reason — when the property cannot be a parameter.
   */
  showComponentParam(entry: ComponentParamSelection): ComponentParamVerdict {
    const verdict = this.componentParamVerdict(entry);
    if (!verdict.ok) return verdict;
    if (this.isComponentParamShown(entry)) return verdict;
    this._applySelection([...this.getComponentSelection(), { ...entry }]);
    return verdict;
  }

  /**
   * Takes a component property out of the planning window. Its stored values go with it —
   * from EVERY scenario of the session and from the dormant values (also for a target that
   * never resolved), so neither a scenario switch nor the next Save brings it back.
   */
  hideComponentParam(target: ComponentParamTarget): boolean {
    const current = this.getComponentSelection();
    const next = current.filter((e) => !sameComponentTarget(e, target));
    if (next.length === current.length) return false;
    const key = this._component?.effectiveKeyOf(target) ?? null;
    if (key) {
      this._setScenario({ ...this._scenario, block: withoutScenarioKey(this._scenario.block, key) });
      this._registry.forgetDormant([key]);
    }
    this._applySelection(next);
    return true;
  }

  /**
   * Declares component properties on demand — hidden in the window, not in `selection[]`
   * (plan-2005 Phase 7: experiment factors). Same derivation, same key, same writer.
   */
  async ensureComponentParams(targets: readonly ComponentParamTarget[]): Promise<ComponentParamVerdict[]> {
    // Bound to the document it was asked for: the owner is loaded lazily and the scene may
    // still be loading — a request that outlives its document declares nothing (review #4).
    const loadId = this._documentLoadId;
    const owner = await this._loadComponentOwner();
    await this._componentSettled;
    if (this._documentLoadId !== loadId) {
      return targets.map((t) => ({
        ok: false, code: 'unresolved', message: 'the document changed', key: null, effectiveKey: owner.effectiveKeyOf(t),
      }) as ComponentParamVerdict);
    }
    return owner.ensure(targets);
  }

  private _applySelection(selection: readonly ComponentParamSelection[]): void {
    this._setScenario({ ...this._scenario, block: withSelection(this._scenario.block, selection) });
    void this._component?.setSelection(selection);
  }

  private _loadComponentOwner(): Promise<ComponentParamsOwner> {
    return (this._componentLoad ??= import('./component-params-owner').then((m) => {
      this._component = new m.ComponentParamsOwner({ registry: this._registry, viewer: () => this._viewer });
      return this._component;
    }));
  }

  /**
   * Reads the loaded file's `PlanningScenarios` block, reports what of it is unusable, and
   * hands the active scenario to the registry as the document's start values.
   */
  private _loadDocumentScenarios(result: unknown): void {
    const root = (result as { root?: { userData?: Record<string, unknown> } } | null)?.root;
    const parsed = parsePlanningScenarios(root?.userData?.['realvirtual']);
    for (const issue of parsed.issues) this._reportScenarioIssue(issue);
    const block = parsed.block ?? emptyScenarioBlock();
    this._setScenario({ block, saved: block, saving: false, error: null, fileDiffers: parsed.issues.length > 0 });
    this._loadStartValues(block.scenarios[block.active] ?? {});
  }

  /**
   * Hands a document's start values to the registry. While an experiment batch holds the
   * lock (plan-2005 Phase 7) the registry refuses; the values wait and go in the moment
   * the lock is released (the batch ends — it also ends on this very document change).
   */
  private _loadStartValues(values: Readonly<Record<string, unknown>>): void {
    this._offDeferredLoad?.();
    this._offDeferredLoad = null;
    if (this._registry.loadScenario(values)) return;
    const loadId = this._documentLoadId;
    const off = this._registry.subscribe(() => {
      if (this._registry.getSnapshot().experimentRunning) return;
      off();
      if (this._offDeferredLoad === off) this._offDeferredLoad = null;
      if (this._documentLoadId !== loadId) return;
      const before = new Map(this._registry.list().map((p) => [p.key, p.value]));
      this._registry.loadScenario(values);
      // The owners already built this document with the values of before (Codex P7 #3):
      // whoever's committed values moved now rebuilds — through the one apply path.
      const moved = [...new Set(this._registry.list().filter((p) => before.get(p.key) !== p.value).map((p) => p.owner))];
      void this._reconcileOwners(moved, loadId);
    });
    this._offDeferredLoad = off;
  }

  /** Reconciles `owners` one after the other (component owner: only fields that differ). */
  private async _reconcileOwners(owners: readonly string[], loadId: string): Promise<void> {
    for (const owner of owners) {
      if (this._documentLoadId !== loadId) return;
      if (owner === 'component') { await this._component?.reconcile(); continue; }
      for (;;) {
        const r = await this._registry.reconcileStructure(owner);
        if (r.error === 'apply-in-progress') { await this._registry.whenApplyIdle(); continue; }
        break;
      }
    }
  }

  private _offDeferredLoad: (() => void) | null = null;

  private _reportScenarioIssue(issue: PlanningScenarioIssue): void {
    const suffix = `${issue.code}:${issue.scenario ?? ''}:${issue.key ?? ''}`;
    if (issue.code === 'key-invalid' || issue.code === 'value-invalid') {
      reportProblem({
        id: `${PROBLEM_SCENARIO_VALUE}:${suffix}`,
        severity: 'warning',
        code: PROBLEM_SCENARIO_VALUE,
        title: `Stored planning value '${issue.key ?? ''}' dropped`,
        detail: issue.detail,
      });
      return;
    }
    reportProblem({
      id: `${PROBLEM_SCENARIO_BLOCK}:${suffix}`,
      severity: 'warning',
      code: PROBLEM_SCENARIO_BLOCK,
      title: issue.code === 'active-missing' ? 'Active planning scenario not found' : 'Stored planning scenarios not fully readable',
      detail: issue.detail,
    });
  }

  private _setScenario(next: PlanningScenarioState): void {
    this._scenario = Object.freeze({ ...next });
    for (const l of this._scenarioListeners) {
      try { l(); } catch { /* a listener must never break the plugin */ }
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private _newDocument(): void {
    this._documentAbort.abort();
    this._documentAbort = new AbortController();
    this._documentCounter += 1;
    this._documentLoadId = `planning-doc-${this._documentCounter}`;
    this._component?.newDocument();
  }

  /**
   * Writes a display switch straight through to the overlay store, so the
   * Groups panel and this window can never disagree. `_displayWriting` breaks
   * the echo: the store notifies synchronously, and that notification must not
   * write the same value back into the registry.
   */
  private _displayStorage(): PlanningDisplayStorage {
    return {
      load: (owner) => (owner === DISPLAY_OWNER ? this._readOverlayValues() : localDisplayStorage.load(owner)),
      save: (owner, values) => {
        if (owner !== DISPLAY_OWNER) { localDisplayStorage.save(owner, values); return; }
        this._displayWriting = true;
        try {
          for (const [key, value] of Object.entries(values)) {
            if (typeof value !== 'boolean') continue;
            if (isOverlayVisible(key as OverlayCategory) !== value) setOverlayVisible(key as OverlayCategory, value);
          }
        } finally { this._displayWriting = false; }
      },
    };
  }

  private _readOverlayValues(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const cat of this._displayCategories) out[cat] = isOverlayVisible(cat);
    return out;
  }

  /** Store → registry, without touching anything that did not change. */
  private _syncDisplayFromStore(): void {
    if (this._displayCategories.length === 0) return;
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this._readOverlayValues())) {
      values[`${DISPLAY_OWNER}.${key}`] = value;
    }
    const changed = this._registry.list().some(
      (p) => p.owner === DISPLAY_OWNER && values[p.key] !== undefined && values[p.key] !== p.value,
    );
    if (changed) this._registry.setMany(values, 'ui');
    // A category that appeared or vanished changes the declaration, not a value.
    if (this._presentCategories().join('|') !== this._displayCategories.join('|')) this._declareDisplaySwitches();
  }

  /** The overlay categories a model actually produces right now, in catalog order. */
  private _presentCategories(): OverlayCategory[] {
    return getOverlaySnapshot().present.map((c) => c.id);
  }

  /**
   * F11: one `display` boolean per PRESENT overlay category. Declared only once
   * a model has declared planning parameters of its own — otherwise the window
   * would appear on every document, against F2.
   */
  private _declareDisplaySwitches(): void {
    // `declare` publishes, and the publish lands back in `_onRegistryChanged`
    // before the handle is assigned — without this guard that is a recursion.
    if (this._declaringDisplay) return;
    this._declaringDisplay = true;
    try { this._declareDisplaySwitchesNow(); } finally { this._declaringDisplay = false; }
  }

  private _declareDisplaySwitchesNow(): void {
    const present = this._presentCategories();
    this._displayCategories = present;
    const labels = new Map(OVERLAY_CATEGORIES.map((c) => [c.id, c.label]));
    const params: PlanningParamDef[] = present.map((id, i) => ({
      key: id,
      label: labels.get(id) ?? id,
      type: 'boolean',
      default: true,
      group: 'Display',
      apply: 'live',
      role: 'display',
      order: i,
      ui: { chipRow: 'overlays' },
    }));
    if (this._displayHandle) { this._displayHandle.redeclare(params); return; }
    this._displayHandle = this._registry.declare({
      owner: DISPLAY_OWNER,
      title: 'Display',
      params,
    });
  }

  /**
   * The registry changed. Two things happen at most once: the display owner is
   * declared as soon as a model owner exists, and the overlay module is loaded
   * the first time there is anything to show.
   */
  private async _onRegistryChanged(): Promise<void> {
    // A model owner counts once it has something to SHOW: experiment factors declared on
    // demand (hidden) do not open the window.
    const hasModelOwner = this._registry.getSnapshot().params
      .some((p) => p.owner !== DISPLAY_OWNER && p.def.ui?.hidden !== true);
    if (hasModelOwner && !this._displayHandle) this._declareDisplaySwitches();
    if (this._overlayMounted || !hasModelOwner) return;
    this._overlayMounted = true;
    const viewer = this._viewer;
    if (!viewer) return;
    try {
      const mod = await import('./PlanningOverlay');
      viewer.uiRegistry.register(mod.PLANNING_OVERLAY_UI);
    } catch (err) {
      this._overlayMounted = false;
      console.error('[planning-parameters] loading the planning window failed:', err);
    }
  }
}

/**
 * The session's planning registry, or `undefined` in a viewer without the
 * plugin (an embed that switched it off, a test viewer).
 */
export function getPlanningRegistry(viewer: Pick<RVViewer, 'getPlugin'>): PlanningRegistry | undefined {
  return viewer.getPlugin<PlanningParametersPlugin>(PLANNING_PLUGIN_ID)?.registry;
}

/** The plugin itself, when the overlay or an MCP tool needs its apply path. */
export function getPlanningPlugin(viewer: Pick<RVViewer, 'getPlugin'>): PlanningParametersPlugin | undefined {
  return viewer.getPlugin<PlanningParametersPlugin>(PLANNING_PLUGIN_ID);
}
