// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * variants-runtime — the LAZY half of variants (plan-2013 §2.7, Phase 1, no UI). Loaded by
 * the eager `VariantsPlugin` only when the preference is on or a caller asks for it.
 *
 * Binds the variant store to the loaded document: reads its `Variants` block, applies the
 * saved `active` variant after the scene is complete (only at load, only with the
 * preference on), installs the variant edit target while a variant is in the scene and
 * sets the eager `isVariantInScene()` flag the old planning paths check. Saving writes only
 * the normal document save, whose provider bakes the `Variants` block without
 * turning a variant value into a base value.
 */

import type { Object3D } from 'three';
import {
  createParamApplyService,
  type ParamApplyService,
  type ParamApplyViewer,
} from '../../core/params/rv-param-apply';
import { overrideKey, parseVariantsBlock } from '../../core/variants/rv-variant-model';
import { VariantStore, type VariantResult } from '../../core/variants/rv-variant-store';
import { createVariantEditTarget, type VariantEditTarget, type VariantTargetHost } from '../../core/variants/rv-variant-edit-target';
import { getActiveEditTarget, setActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { currentRunLease, subscribeRunLease, setVariantInScene, setVariantsSaveProvider, setSceneVariantProvenanceProvider, setSceneBaseProvider, setColumnMigrationContext } from '../../core/hmi/rv-run-lease';
import { USER_PAUSE_REASON } from '../../core/engine/rv-constants';
import { getSceneStore } from '../../core/hmi/scene/scene-store-singleton';
import { saveDocument, type SavePlannerResult } from '../../core/editor/rv-save-document';
import { clearProblemsOfCode, reportProblem } from '../../core/hmi/problems-store';
import { PROBLEM_PARAM_ROLLBACK } from '../../core/params/rv-param-apply';
import type { UIPluginRegistry } from '../../core/rv-ui-registry';
import { VariantFieldIndex } from '../../core/variants/rv-variant-index';
import { registerFieldRowAction } from '../../core/hmi/rv-field-row-actions';
import { createVariantSwitcherSlot } from './VariantToolbarSwitcher';
import { createVariantCompareSlot } from './VariantCompareDialog';
import { variantFieldRowAction } from './VariantFieldMarker';
import { setVariantUiRuntime } from './variant-ui';
import { showInstruction } from '../../core/hmi/instruction-store';

// Test seam (9.3): proves the opt-in boundary at runtime — set only when this chunk evaluates.
(globalThis as { __rvVariantsRuntimeLoaded?: boolean }).__rvVariantsRuntimeLoaded = true;

/** Problems code: a variant value whose node is not in this configuration. */
export const PROBLEM_VARIANT_TARGET_MISSING = 'variant-target-missing';
/** Problems code: the document's Variants block had entries that were dropped. */
export const PROBLEM_VARIANTS_BLOCK_INVALID = 'variants-block-invalid';
/** Problems code: a variant was applied, but something after the reset was off. */
export const PROBLEM_VARIANT_APPLY_WARNING = 'variant-apply-warning';
const DOCUMENT_PROBLEMS = [PROBLEM_VARIANT_TARGET_MISSING, PROBLEM_VARIANTS_BLOCK_INVALID, PROBLEM_VARIANT_APPLY_WARNING, PROBLEM_PARAM_ROLLBACK, 'variant-scope-failed'];

/** The viewer slice the runtime uses. */
export type VariantsViewer = ParamApplyViewer & VariantTargetHost & {
  whenSceneReady?(): Promise<unknown>;
  getPlugin?(id: string): unknown;
  uiRegistry?: Pick<UIPluginRegistry, 'register' | 'unregister'>;
  modes?: { registerEnterGuard?(modeId: string, guard: () => boolean | Promise<boolean>): () => void };
};

export interface VariantsSaveResult {
  persistedTo: 'glb' | 'session';
  /** Monotonic store revision of the snapshot offered to the writer. */
  revision: number;
}

export interface VariantsRuntimeOptions {
  viewer(): VariantsViewer | null;
  documentLoadId(): string;
  /** Called when a variant is created (T1: "or by creating the first variant"). */
  enablePreference?(): void;
  /** Test seam for the normal document-save path. */
  saveDocument?: () => Promise<SavePlannerResult>;
}

interface PlanningRegistryLike {
  getSnapshot(): { pendingCount: number; experimentRunning: boolean };
  isApplyInProgress(): boolean;
}

/** The old planning registry's state blocks an activation (Gate R2 #5). */
function planningBlocker(viewer: VariantsViewer | null): string | null {
  const plugin = viewer?.getPlugin?.('planning-parameters') as { registry?: PlanningRegistryLike } | undefined;
  const reg = plugin?.registry;
  if (!reg) return null;
  const snap = reg.getSnapshot();
  return snap.pendingCount > 0 || snap.experimentRunning || reg.isApplyInProgress() ? 'planning-pending' : null;
}

export class VariantsRuntime {
  readonly store: VariantStore;
  readonly service: ParamApplyService;
  /**
   * `FieldKey → variants`, pulled forward on every store change (Concept D's icon states).
   * Built once per document and updated incrementally, so an inspector row's state is a
   * single Map lookup and no change triggers a full inspector refresh.
   */
  readonly index = new VariantFieldIndex();
  private _removeFieldRowAction: (() => void) | null = null;
  private _abort = new AbortController();
  private _bound = 0;
  private _target: VariantEditTarget | null = null;
  private _uiViewer: VariantsViewer | null = null;
  private _removeEditorGuard: (() => void) | null = null;
  private _removeStoreListener: (() => void) | null = null;
  private _removeSnapshotListener: (() => void) | null = null;
  private _saveBound = false;
  private _removeLeaseListener: (() => void) | null = null;
  private _bindingGeneration = 0;
  private _scopeReady: Promise<void> = Promise.resolve();
  private _pauseSequence = 0;
  private readonly _scopePauses = new Set<() => void>();
  private readonly _bindingListeners = new Set<() => void>();
  private readonly _beforeUnload = (event: BeforeUnloadEvent): void => {
    if (!this._saveBound || !this.store.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  constructor(private readonly opts: VariantsRuntimeOptions) {
    const viewerOrThrow = (): VariantsViewer => {
      const v = opts.viewer();
      if (!v) throw new Error('no viewer');
      return v;
    };
    // The service reads the viewer lazily: one runtime serves every document of the session.
    const viewerProxy = new Proxy({} as ParamApplyViewer, {
      get: (_t, prop) => {
        const v = viewerOrThrow() as unknown as Record<string | symbol, unknown>;
        const value = v[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(v) : value;
      },
    });
    this.service = createParamApplyService({
      viewer: viewerProxy,
      documentLoadId: () => `${opts.documentLoadId()}#${this._bound}`,
      signal: () => this._abort.signal,
    });
    this.store = new VariantStore({
      apply: async (ops, options) => {
        await this._scopeReady.catch(() => {});
        const viewer = viewerOrThrow();
        const reason = `variant-scope:${++this._pauseSequence}`;
        viewer.setSimulationPaused(reason, true);
        const release = (): void => { viewer.setSimulationPaused(reason, false); this._scopePauses.delete(release); };
        this._scopePauses.add(release);
        try {
          const r = await this.service.apply(ops, options ?? { origin: 'variant' });
          this._warn(r.warning);
          if (!r.ok) {
            if (r.error !== 'document-changed') viewer.setSimulationPaused(USER_PAUSE_REASON, true);
            release();
          }
          return r;
        } catch (error) {
          viewer.setSimulationPaused(USER_PAUSE_REASON, true);
          release();
          throw error;
        }
      },
      readBase: (k) => this.service.readBase(k),
      check: (component, field, value) => {
        const v = this.service.checkValue(component, field, value);
        return v.ok ? { ok: true } : { ok: false, detail: v.detail };
      },
      coexistenceBlocker: () => planningBlocker(opts.viewer()),
      onSceneChanged: (active) => this._sceneChanged(active),
      onCommit: () => { this._target?.recordVariantCommit(); this._reportUnresolved(); this._resolveScope(); },
    });
    // The index is pulled forward BEFORE any React listener runs (this subscription is the
    // first one), so a row that re-renders because of the change already sees the new state.
    this._removeStoreListener = this.store.subscribe(() => {
      this.index.sync(this.store.block, this.store.sceneVariant);
      getSceneStore()?.refreshExternalState();
    });
  }

  get bound(): boolean { return this._saveBound; }
  getBindingGeneration = (): number => this._bindingGeneration;
  subscribeBinding = (listener: () => void): (() => void) => {
    this._bindingListeners.add(listener);
    return () => { this._bindingListeners.delete(listener); };
  };

  /** A loaded document: read its block; with `applyActive` its saved variant goes into the scene. */
  async bindDocument(root: Object3D | { userData?: Record<string, unknown> } | null, o: { applyActive: boolean }): Promise<VariantResult> {
    this.unbindDocument();
    const bound = ++this._bound;
    // Only a document that HAS a `Variants` key is parsed: `parseVariantsBlock` falls back to
    // reading its argument AS the block, so handing it the whole `realvirtual` extras of a
    // document without variants reported a bogus "version undefined is not supported".
    const extras = (root?.userData as Record<string, unknown> | undefined)?.realvirtual;
    const carries = typeof extras === 'object' && extras !== null && !Array.isArray(extras)
      && (extras as Record<string, unknown>).Variants !== undefined;
    const { block, issues } = parseVariantsBlock(carries ? extras : undefined);
    for (const i of issues) {
      reportProblem({
        id: `${PROBLEM_VARIANTS_BLOCK_INVALID}:${i.code}:${i.detail}`, severity: 'warning',
        code: PROBLEM_VARIANTS_BLOCK_INVALID, title: `Variants block (${i.code})`, detail: i.detail,
      });
    }
    this.store.load(block);
    // A block that did not parse cleanly is not ours to rewrite: until a deliberate edit
    // makes the store dirty, a save leaves the file's block exactly as it is.
    let untouchable = issues.length > 0;
    setVariantsSaveProvider({
      payload: () => {
        if (untouchable && !this.store.dirty) return undefined;
        untouchable = false;
        return this.store.snapshot();
      },
      dirty: () => this.store.dirty,
      markSaved: (payload) => this.store.markSaved(payload),
    });
    setSceneVariantProvenanceProvider(() => {
      const id = this.store.sceneVariant;
      const v = id === null ? null : this.store.variant(id);
      return v ? { variantId: v.id, name: v.name, revision: v.revision, overrides: v.overrides } : null;
    });
    const store = this.store;
    setSceneBaseProvider({
      get version() { return store.version; },
      sceneOverrideKeys: () => new Set((store.sceneVariant === null ? []
        : store.variant(store.sceneVariant)?.overrides ?? []).map(overrideKey)),
      baseValueOf: key => {
        const [address, component, field] = key.split('|');
        return store.baseOf({ address, component, field });
      },
    });
    this._saveBound = true;
    this._removeLeaseListener = subscribeRunLease(() => {
      if (!currentRunLease()) this._resolveScope();
    });
    setColumnMigrationContext({
      store: this.store,
      baseValueOf: key => {
        const base = this.store.baseOf(key) ?? this.service.readBase(key);
        return base?.kind === 'value' ? base.value : undefined;
      },
      resolveAddress: path => {
        const registry = this.opts.viewer()?.registry;
        const node = registry?.getNode(path);
        const address = node && registry?.getAddressForNode?.(node);
        return address ? [address] : [];
      },
    });
    const { onVariantSetChanged } = await import('../../core/material-flow/rv-project-manager');
    if (bound !== this._bound) return { ok: false, error: 'document-changed' };
    const knownVariants = this.store.block.variants.map(v => ({ ...v, overrides: v.overrides.map(o => ({ ...o })) }));
    let restored = false; // Per binding: DES may become available only after model load.
    const viewer = this.opts.viewer();
    if (viewer?.simulationKernel?.desControl?.()) {
      try {
        await onVariantSetChanged(viewer as unknown as import('../../core/material-flow/rv-project-manager').ProjectManagerViewerLike, true);
        restored = true;
      } catch (error) { return { ok: false, error: 'experiment-restore-failed', detail: String(error) }; }
      if (bound !== this._bound) return { ok: false, error: 'document-changed' };
    }
    let pending = false;
    let writing = false;
    const snapshotChanged = (): void => {
      pending = true;
      // A batch or a snapshot holds the store: restoring or writing recovery copies now would
      // only fail. unlock() publishes again, and that notification does the work.
      if (this.store.locked) return;
      if (writing) return;
      writing = true;
      void (async () => {
        // Restore publishes synchronously while restoringStores suppresses writes.
        // Defer and coalesce notifications, then capture the final store after restore.
        await Promise.resolve();
        while (pending && bound === this._bound) {
          if (this.store.locked) break; // keep `pending`; unlock() notifies again
          pending = false;
          const v = this.opts.viewer();
          if (!v?.simulationKernel?.desControl?.()) return;
          const projectViewer = v as unknown as import('../../core/material-flow/rv-project-manager').ProjectManagerViewerLike;
          if (!restored) {
            await onVariantSetChanged(projectViewer, true, knownVariants);
            if (bound !== this._bound) return;
            restored = true;
          }
          await onVariantSetChanged(projectViewer, false);
        }
      })().catch(error => {
        pending = false;
        if (bound !== this._bound) return;
        reportProblem({ id: 'experiment-snapshot-failed', code: 'experiment-snapshot-failed', severity: 'error',
          title: 'Experiment recovery snapshot could not be saved', detail: String(error) });
      }).finally(() => {
        writing = false;
        if (pending && bound === this._bound) snapshotChanged();
      });
    };
    this._removeSnapshotListener = this.store.subscribe(snapshotChanged);
    if (typeof window !== 'undefined') window.addEventListener('beforeunload', this._beforeUnload);
    this._removeEditorGuard = this.opts.viewer()?.modes?.registerEnterGuard?.('editor', () => this._returnToBaseForAssetEditor()) ?? null;
    this._bindingGeneration++;
    for (const listener of this._bindingListeners) listener();
    this._syncUiPreference();
    getSceneStore()?.refreshExternalState();
    const active = block?.active ?? null;
    if (!o.applyActive || !active) {
      // Orphans are reported for every variant, also when nothing is applied — but only
      // once the scene exists, or every address would look missing.
      void (async () => {
        await this.opts.viewer()?.whenSceneReady?.();
        if (bound === this._bound) this._reportUnresolved();
      })();
      return { ok: true };
    }
    await this.opts.viewer()?.whenSceneReady?.();
    if (bound !== this._bound) return { ok: false, error: 'document-changed' };
    return this.activate(active);
  }

  /** The document goes: Base flag off, edit target removed, transactions of it aborted. */
  unbindDocument(): void {
    this._removeSnapshotListener?.();
    this._removeSnapshotListener = null;
    for (const release of this._scopePauses) release();
    setColumnMigrationContext(null);
    this._removeLeaseListener?.();
    this._removeLeaseListener = null;
    this._abort.abort();
    this._abort = new AbortController();
    this._bound++;
    this._removeTarget();
    this._removeEditorGuard?.();
    this._removeEditorGuard = null;
    if (typeof window !== 'undefined') window.removeEventListener('beforeunload', this._beforeUnload);
    this.setUiEnabled(false);
    this._saveBound = false;
    setVariantsSaveProvider(null);
    setSceneVariantProvenanceProvider(null);
    setSceneBaseProvider(null);
    this.store.load(null);
    this.index.clear();
    if (this.store.locked) this.store.unlock();
    getSceneStore()?.refreshExternalState();
    setVariantInScene(false);
    for (const code of DOCUMENT_PROBLEMS) clearProblemsOfCode(code);
  }

  /** Creates a variant (and switches the preference on, T1). */
  create(name: string, from?: string): VariantResult {
    const r = this.store.create(name, from ? { from } : {});
    if (r.ok) { this.opts.enablePreference?.(); this._syncUiPreference(); }
    return r;
  }

  /** Puts a variant (null = Base) into the scene. */
  async activate(id: string | null): Promise<VariantResult> {
    const r = await this.store.activate(id);
    if (r.ok) {
      try { await this._scopeReady; }
      catch (error) { return { ok: false, error: 'scope-resolution-failed', detail: String(error) }; }
    }
    this._reportUnresolved();
    return r;
  }

  private _warn(warning: string | undefined): void {
    if (!warning) return;
    reportProblem({ id: PROBLEM_VARIANT_APPLY_WARNING, severity: 'warning', code: PROBLEM_VARIANT_APPLY_WARNING, title: 'Variant applied with a warning', detail: warning });
  }

  /** Runs the normal open-document save, which bakes this runtime's provider payload. */
  async save(): Promise<VariantsSaveResult> {
    if (!this._saveBound) throw new Error('No document bound');
    const bound = this._bound;
    const revision = this.store.version;
    const store = getSceneStore();
    const result = await (this.opts.saveDocument
      ? this.opts.saveDocument()
      : store ? saveDocument(null, store) : Promise.resolve({ kind: 'blocked', reason: 'No document save available.' } as const));
    if (bound !== this._bound) throw new Error('document-changed');
    if (result.kind === 'saved') {
      return { persistedTo: 'glb', revision };
    }
    if (result.kind === 'no-op') return { persistedTo: 'glb', revision };
    if (result.kind === 'blocked') return { persistedTo: 'session', revision };
    if (result.kind === 'conflict' || result.kind === 'error') throw new Error(result.message);
    if (result.kind === 'target-changed') throw new Error('The project changed while saving — nothing was adopted. Try again.');
    throw new Error(result.kind === 'busy' ? 'A document save is already running.' : 'Document save cancelled.');
  }

  dispose(): void {
    this._removeStoreListener?.();
    this._removeStoreListener = null;
    this.unbindDocument();
    this._bindingListeners.clear();
  }

  /** The eager preference owner calls this only to tear down an already-loaded runtime. */
  setUiEnabled(on: boolean): void {
    const viewer = this.opts.viewer();
    if (!on || !viewer?.uiRegistry) {
      this._uiViewer?.uiRegistry?.unregister('variants-runtime-ui');
      this._uiViewer = null;
      this._removeFieldRowAction?.();
      this._removeFieldRowAction = null;
      setVariantUiRuntime(null);
      return;
    }
    if (this._uiViewer === viewer) return;
    this._uiViewer?.uiRegistry?.unregister('variants-runtime-ui');
    // Concept D: the switcher sits with the sim controls (`toolbar-button-leading`, right
    // of Play/Reset/Speed/Clock), the field icons are rendered by the inspector's own rows
    // through the field-row action, and the compare table is an overlay opened on demand.
    viewer.uiRegistry.register({
      id: 'variants-runtime-ui',
      slots: [
        { slot: 'toolbar-button-leading', component: createVariantSwitcherSlot(this), order: 20 },
        { slot: 'overlay', component: createVariantCompareSlot(this), order: 54 },
      ],
    });
    this._removeFieldRowAction?.();
    this._removeFieldRowAction = registerFieldRowAction(variantFieldRowAction(this));
    setVariantUiRuntime(this);
    this._uiViewer = viewer;
  }

  private _syncUiPreference(): void {
    const plugin = this.opts.viewer()?.getPlugin?.('variants') as { enabled?: boolean } | undefined;
    this.setUiEnabled(plugin?.enabled === true);
  }

  private async _returnToBaseForAssetEditor(): Promise<boolean> {
    if (this.store.sceneVariant === null) return true;
    const result = await this.activate(null);
    if (!result.ok) {
      showInstruction({
        id: 'variant-asset-editor-base',
        text: result.detail ? `${result.error}: ${result.detail}` : result.error,
        anchor: { kind: 'edge', edge: 'bottom' }, style: 'toast', autoClearAfterMs: 6000, source: 'variants',
      });
      return false;
    }
    showInstruction({
      id: 'variant-asset-editor-base', text: 'Switched to Base for asset editing',
      anchor: { kind: 'edge', edge: 'bottom' }, style: 'toast', autoClearAfterMs: 4000, source: 'variants',
    });
    return true;
  }

  private _resolveScope(): void {
    if (currentRunLease()) return;
    // Apply resets before the store publishes its new scene identity. Resolve the
    // destination afterwards, while the freshly reset run is still at t = 0.
    const bound = this._bound;
    const releases = [...this._scopePauses];
    const viewer = this.opts.viewer();
    const previous = this._scopeReady;
    this._scopeReady = (async () => {
      await previous.catch(() => {});
      if (!viewer?.simulationKernel?.desControl?.()) return;
      const { ensureActiveScope, experimentScopeHook } = await import('../../core/material-flow/rv-project-manager');
      if (bound !== this._bound) return;
      if (!experimentScopeHook) return;
      const scope = await ensureActiveScope(viewer as unknown as import('../../core/material-flow/rv-project-manager').ProjectManagerViewerLike);
      if (!scope && bound === this._bound) throw new Error('Cannot resolve the scene experiment column');
    })().catch(error => {
      if (bound === this._bound) {
        viewer?.setSimulationPaused(USER_PAUSE_REASON, true);
        reportProblem({ id: 'variant-scope-failed', severity: 'error', code: 'variant-scope-failed',
          title: 'Simulation paused: experiment column could not be resolved', detail: String(error) });
      }
      throw error;
    }).finally(() => { for (const release of releases) release(); });
    void this._scopeReady.catch(() => {});
  }

  private _sceneChanged(active: string | null): void {
    this._resolveScope();
    setVariantInScene(active !== null);
    this._removeTarget();
    const viewer = this.opts.viewer();
    if (active !== null && viewer) {
      this._target = createVariantEditTarget({
        store: this.store,
        variantId: active,
        host: viewer,
        check: (c, f, v) => {
          const r = this.service.checkValue(c, f, v);
          return r.ok ? { ok: true } : { ok: false, detail: r.detail };
        },
        historyHost: getSceneStore(),
        message: (text, id) => showInstruction({
          id, text, anchor: { kind: 'edge', edge: 'bottom' }, style: 'toast',
          autoClearAfterMs: 5000, source: 'variants',
        }),
      });
      setActiveEditTarget(this._target);
    }
  }

  private _removeTarget(): void {
    if (this._target && getActiveEditTarget() === this._target) setActiveEditTarget(null);
    this._target?.dispose();
    this._target = null;
  }

  /**
   * Orphaned overrides are made visible CENTRALLY, for every variant — not only for the one
   * in the scene (Codex): a node, component or field that went is reported in the Problems
   * panel and marked in the compare table, and the value is never silently dropped.
   */
  private _reportUnresolved(): void {
    clearProblemsOfCode(PROBLEM_VARIANT_TARGET_MISSING);
    const seen = new Set<string>();
    for (const v of this.store.block.variants) {
      for (const o of v.overrides) {
        const key = `${o.address}|${o.component}.${o.field}`;
        if (seen.has(key)) continue;
        const missing = this.store.isUnresolved(o) || this.service.resolve(o) === null;
        if (!missing) continue;
        seen.add(key);
        reportProblem({
          id: `${PROBLEM_VARIANT_TARGET_MISSING}:${key}`,
          severity: 'info', code: PROBLEM_VARIANT_TARGET_MISSING,
          title: `Variant value ${o.component}.${o.field} is not in this configuration`,
          detail: `no node at '${o.address}' — the variants keep the value`,
        });
      }
    }
  }
}

/** Factory used by the eager loader's `import()`. */
export function createVariantsRuntime(opts: VariantsRuntimeOptions): VariantsRuntime {
  return new VariantsRuntime(opts);
}
