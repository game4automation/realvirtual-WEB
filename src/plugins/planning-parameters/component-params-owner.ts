// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * component-params-owner — the planning owner `component` (plan-630 §2.14, Phase 8).
 *
 * Declares the component properties a document SELECTED for the planning window
 * (`PlanningScenarios.selection[]`) plus the ones an experiment asked for on demand
 * (`ensure`, plan-2005 Phase 7 — hidden in the window, never stored in `selection[]`), and
 * owns the ONE writer of planning values into rv_extras: its `onStructuralReset` writes
 * the committed values with {@link writeComponentField} at a standstill and runs the
 * re-config path of the affected component types (DES: `reconfigureFromExtras`; `rebuild`:
 * the registered handler). The structural-reset runner then resets the simulation once.
 *
 * Everything the derivation needs from the viewer — address → node, schema, re-config
 * capability, the value the document carries — goes through {@link ComponentParamEnv}, so
 * the declaration rules stay in the pure `rv-planning-component-params.ts`.
 *
 * ## Defaults and start values
 *
 * `default` (the target of *Reset to defaults*) is the value the DOCUMENT carries: read
 * the first time a property is derived in this document load, before any planning write
 * (the writer below is the only planning writer), and kept until the document changes.
 * `initial` is the current effective value. A scenario value stored for the property
 * wins over both and is written into the field right after the declaration (the load-time
 * reconciliation of plan-681, `reconcileStructure`), so the model runs what the window shows.
 */

import type { Object3D } from 'three';
import {
  COMPONENT_PLANNING_OWNER,
  COMPONENT_PLANNING_TITLE,
  PROBLEM_SELECTION_INVALID,
  PROBLEM_SELECTION_UNSUPPORTED,
  componentBaseType,
  componentParamEffectiveKey,
  componentRebuildOf,
  deriveComponentParamDef,
  type ComponentParamEnv,
  type ComponentParamFieldInfo,
  type ComponentParamSelection,
  type ComponentParamTarget,
  type ComponentParamVerdict,
  type PlanningReconfig,
} from '../../core/planning/rv-planning-component-params';
import type { PlanningParamDef, PlanningValue, StructuralResetContext } from '../../core/planning/rv-planning-params';
import { readComponentField, writeComponentField } from '../../core/params/rv-param-field';
import type { PlanningHandle, PlanningRegistry } from '../../core/planning/rv-planning-registry';
import { clearProblemsOfCode, reportProblem } from '../../core/hmi/problems-store';
import { describeComponentType, descriptionsLoaded, ensureDescriptions } from '../../core/engine/rv-component-schema-info';
import { paramApplyOf } from '../../core/engine/rv-component-registry';
import { getMaterialFlow } from '../../core/material-flow/registry';
import { parseNodeAddress } from '../../core/engine/rv-node-id';

/** The slice of the viewer this owner reads. */
export interface ComponentOwnerViewer {
  readonly registry?: {
    getNodeByAddress(nodeId: string, occurrence?: string): Object3D | null;
    getAddressForNode?(node: Object3D): string | null;
    getPathForNode?(node: Object3D): string | null;
  } | null;
  readonly simulationKernel?: {
    desControl?(): { reconfigureFromExtras?(): void } | null;
  } | null;
}

/** Construction options. */
export interface ComponentParamsOwnerOptions {
  registry: PlanningRegistry;
  viewer(): ComponentOwnerViewer | null;
  /** Test seam: the environment for a viewer (default {@link createViewerComponentEnv}). */
  env?(viewer: ComponentOwnerViewer, documentValues: Map<string, unknown>): ComponentParamEnv;
}

/** A declared component parameter: where it writes, and how the model takes it over. */
interface DeclaredTarget {
  readonly target: ComponentParamTarget;
  readonly reconfig: PlanningReconfig;
  readonly label: string;
}

/** The node at a full address, or null. */
export function nodeAtAddress(viewer: ComponentOwnerViewer | null, address: string): Object3D | null {
  const reg = viewer?.registry;
  if (!reg) return null;
  const { occurrence, nodeId } = parseNodeAddress(address);
  return reg.getNodeByAddress(nodeId, occurrence);
}

function schemaFieldOf(component: string, field: string): ComponentParamFieldInfo | null {
  // Descriptions are a lazy chunk: start the load so later calls carry them (this path is sync).
  if (!descriptionsLoaded()) void ensureDescriptions().catch(() => undefined);
  const info = describeComponentType(component, null);
  const f = info?.fields.find((x) => x.name === field);
  if (!f) return null;
  const out: ComponentParamFieldInfo = { type: f.type };
  if (f.unit) out.unit = f.unit;
  if (f.enum) out.enum = f.enum;
  if (f.default !== undefined) out.default = f.default;
  if (f.readonly) out.readonly = true;
  if (f.signal) out.signal = f.signal;
  if (f.refType) out.refType = f.refType;
  if (f.deprecated) out.deprecated = true;
  if (f.description) out.description = f.description;
  return out;
}

/**
 * The re-config path of one target in the viewer: `des-extras` only for a field the DES
 * definition of exactly that component key re-reads (`seedConfig` applies the
 * definition's schema to `extras[def.type]` — a `Source_1` block or a field outside the
 * schema would be written and never read); `rebuild` as declared.
 */
export function viewerReconfigOf(target: ComponentParamTarget): PlanningReconfig | null {
  const mode = paramApplyOf(target.component);
  if (mode !== 'des-extras') return mode;
  const schema = getMaterialFlow(target.component)?.schema as Record<string, unknown> | undefined;
  return schema && Object.prototype.hasOwnProperty.call(schema, target.field) ? 'des-extras' : null;
}

/** The viewer environment of the derivation (§2.14). */
export function createViewerComponentEnv(viewer: ComponentOwnerViewer, documentValues: Map<string, unknown>): ComponentParamEnv {
  const read = (target: ComponentParamTarget): unknown => {
    const node = nodeAtAddress(viewer, target.address);
    return node ? readComponentField(node, target.component, target.field) : undefined;
  };
  return {
    schemaField: schemaFieldOf,
    reconfigOf: viewerReconfigOf,
    resolves: (address) => nodeAtAddress(viewer, address) !== null,
    documentValue(target) {
      const eff = componentParamEffectiveKey(target.address, target.component, target.field);
      if (!eff) return undefined;
      if (!documentValues.has(eff)) documentValues.set(eff, read(target));
      return documentValues.get(eff);
    },
    currentValue: read,
    nodeLabel(address) {
      const node = nodeAtAddress(viewer, address);
      if (!node) return address;
      const path = viewer.registry?.getPathForNode?.(node) ?? node.name ?? address;
      const parts = path.split('/').filter(Boolean);
      return parts.slice(-2).join('/') || address;
    },
  };
}

export class ComponentParamsOwner {
  private readonly _registry: PlanningRegistry;
  private readonly _viewer: () => ComponentOwnerViewer | null;
  private readonly _envFor: (viewer: ComponentOwnerViewer, documentValues: Map<string, unknown>) => ComponentParamEnv;

  private _handle: PlanningHandle | null = null;
  private _selection: ComponentParamSelection[] = [];
  /** Experiment factors declared on demand (effective key → target). */
  private readonly _ensured = new Map<string, ComponentParamTarget>();
  /** Effective key → value the document carried (read before any planning write). */
  private readonly _documentValues = new Map<string, unknown>();
  /** Owner-local key → what it writes. */
  private _declared = new Map<string, DeclaredTarget>();
  /** Scene of this document is ready — addresses resolve. */
  private _ready = false;
  private _generation = 0;

  constructor(options: ComponentParamsOwnerOptions) {
    this._registry = options.registry;
    this._viewer = options.viewer;
    this._envFor = options.env ?? createViewerComponentEnv;
  }

  /** The selection this owner declares (document-wide). */
  get selection(): readonly ComponentParamSelection[] { return this._selection; }

  /** Effective keys of the declared parameters. */
  declaredKeys(): string[] {
    return [...this._declared.keys()].map((k) => `${COMPONENT_PLANNING_OWNER}.${k}`);
  }

  /** The target of a declared effective key. */
  targetOf(effectiveKey: string): ComponentParamTarget | undefined {
    const local = effectiveKey.startsWith(`${COMPONENT_PLANNING_OWNER}.`) ? effectiveKey.slice(COMPONENT_PLANNING_OWNER.length + 1) : '';
    return this._declared.get(local)?.target;
  }

  /** Another document: drop the declaration and everything document-bound. */
  newDocument(): void {
    this._generation++;
    this._ready = false;
    this._handle?.dispose();
    this._handle = null;
    this._selection = [];
    this._ensured.clear();
    this._documentValues.clear();
    this._declared = new Map();
    clearProblemsOfCode(PROBLEM_SELECTION_INVALID);
    clearProblemsOfCode(PROBLEM_SELECTION_UNSUPPORTED);
  }

  /**
   * The document's scene is complete: declare the selection, then write stored scenario
   * values that differ from the fields (load-time reconciliation, one structural reset).
   */
  async sceneReady(selection: readonly ComponentParamSelection[]): Promise<void> {
    // The definitions carry field descriptions, a lazy chunk: load it before the first declare.
    await ensureDescriptions().catch(() => undefined);
    const generation = this._generation;
    this._ready = true;
    this._selection = selection.slice();
    this._declare();
    await this._reconcileIfNeeded(generation);
  }

  /** Replaces the selection (planning window / inspector action). */
  setSelection(selection: readonly ComponentParamSelection[]): Promise<void> {
    this._selection = selection.slice();
    if (!this._ready) return Promise.resolve();
    this._declare();
    return this._reconcileIfNeeded(this._generation);
  }

  /** The effective key of a target (the one key format), or null for unusable names. */
  effectiveKeyOf(target: ComponentParamTarget): string | null {
    return componentParamEffectiveKey(target.address, target.component, target.field);
  }

  /**
   * A declaration that just took over a stored value (a scenario value of a key declared
   * now — at load, on a late selection, on `ensure`) leaves the field behind the committed
   * value: write it, through the one writer, in one structural reset. Another owner's apply
   * in flight is waited for, not raced (`whenApplyIdle`); a document change ends it.
   */
  private async _reconcileIfNeeded(generation: number): Promise<void> {
    while (generation === this._generation && this._needsReconcile()) {
      const r = await this._registry.reconcileStructure(COMPONENT_PLANNING_OWNER);
      if (r.error === 'apply-in-progress') { await this._registry.whenApplyIdle(); continue; }
      // An experiment batch owns the registry (plan-2005 Phase 7): write after it.
      if (r.error === 'experiment-running') { await this._registry.whenExperimentDone(); continue; }
      return;
    }
  }

  /** Writes stored values that differ from their fields (after a deferred document load). */
  reconcile(): Promise<void> {
    return this._ready ? this._reconcileIfNeeded(this._generation) : Promise.resolve();
  }

  /** Can this property be shown in the planning window (address-free part of the rules)? */
  isSelectable(component: string, field: string): boolean {
    if (!viewerReconfigOf({ address: '', component, field })) return false;
    const info = schemaFieldOf(componentBaseType(component), field);
    if (!info || info.readonly || info.signal || info.refType || info.deprecated) return false;
    return info.type === 'number' || info.type === 'integer' || info.type === 'boolean'
      || (info.type === 'enum' && (info.enum?.length ?? 0) > 0);
  }

  /** The verdict for one entry (no declaration, no Problems entry). */
  verdict(entry: ComponentParamSelection, hidden = false): ComponentParamVerdict {
    const viewer = this._viewer();
    if (!viewer) return { ok: false, code: 'unresolved', message: 'no viewer', key: null, effectiveKey: null };
    return deriveComponentParamDef(entry, this._envFor(viewer, this._documentValues), { hidden });
  }

  /**
   * Declares component properties on demand (plan-2005 Phase 7: experiment factors) with
   * the same derivation — hidden in the window, not stored in `selection[]`. Already
   * declared targets answer with their verdict as they are.
   */
  async ensure(targets: readonly ComponentParamTarget[]): Promise<ComponentParamVerdict[]> {
    const out: ComponentParamVerdict[] = [];
    if (!this._ready) {
      for (const t of targets) out.push({ ok: false, code: 'unresolved', message: 'the scene is not ready', key: null, effectiveKey: this.effectiveKeyOf(t) });
      return out;
    }
    const generation = this._generation;
    let changed = false;
    for (const t of targets) {
      const v = this.verdict(t, true);
      out.push(v);
      if (!v.ok || this._declared.has(v.key) || this._ensured.has(v.effectiveKey)) continue;
      this._ensured.set(v.effectiveKey, { address: t.address, component: t.component, field: t.field });
      changed = true;
    }
    if (changed) {
      this._declare();
      await this._reconcileIfNeeded(generation);
    }
    return out;
  }

  /**
   * The one writer (§2.14): committed values → rv_extras, then the re-config paths. A
   * document change (`ctx.signal`) stops it before the first write and between rebuild
   * handlers; the runner then answers `document-changed` and the new load binds itself.
   */
  private async _writeCommitted(committed: Readonly<Record<string, PlanningValue>>, ctx: StructuralResetContext): Promise<void> {
    if (ctx.signal.aborted) return;
    const viewer = this._viewer();
    // Resolve every target BEFORE the first write: an unresolvable one fails the apply
    // without leaving a half-written model behind.
    const plan: Array<{ node: Object3D; declared: DeclaredTarget; value: PlanningValue }> = [];
    for (const [key, value] of Object.entries(committed)) {
      const declared = this._declared.get(key);
      if (!declared) continue;
      const node = nodeAtAddress(viewer, declared.target.address);
      if (!node) throw new Error(`component parameter '${declared.label}': no node at '${declared.target.address}'`);
      plan.push({ node, declared, value });
    }
    const changed: DeclaredTarget[] = [];
    for (const p of plan) {
      if (writeComponentField(p.node, p.declared.target.component, p.declared.target.field, p.value)) changed.push(p.declared);
    }
    if (changed.length === 0) return;
    // Write → re-config, never the other way round (§2.14).
    if (changed.some((c) => c.reconfig === 'des-extras')) {
      viewer?.simulationKernel?.desControl?.()?.reconfigureFromExtras?.();
    }
    const rebuild = new Map<string, ComponentParamTarget[]>();
    for (const c of changed) {
      if (c.reconfig !== 'rebuild') continue;
      const list = rebuild.get(c.target.component) ?? [];
      list.push(c.target);
      rebuild.set(c.target.component, list);
    }
    for (const [component, targets] of rebuild) {
      if (ctx.signal.aborted) return;
      const handler = componentRebuildOf(component);
      if (!handler) throw new Error(`no rebuild handler registered for '${component}'`);
      await handler(targets, ctx.signal);
    }
  }

  private _needsReconcile(): boolean {
    const viewer = this._viewer();
    if (!viewer || this._declared.size === 0) return false;
    for (const p of this._registry.list()) {
      if (p.owner !== COMPONENT_PLANNING_OWNER) continue;
      const declared = this.targetOf(p.key);
      if (!declared) continue;
      const node = nodeAtAddress(viewer, declared.address);
      if (!node) continue;
      // An absent field runs with the schema default — that is not a difference to write.
      const current = readComponentField(node, declared.component, declared.field);
      if ((current === undefined ? p.def.default : current) !== p.value) return true;
    }
    return false;
  }

  /** (Re)builds the declaration from the selection and the ensured targets. */
  private _declare(): void {
    clearProblemsOfCode(PROBLEM_SELECTION_INVALID);
    clearProblemsOfCode(PROBLEM_SELECTION_UNSUPPORTED);
    const viewer = this._viewer();
    const params: PlanningParamDef[] = [];
    const declared = new Map<string, DeclaredTarget>();
    const env = viewer ? this._envFor(viewer, this._documentValues) : null;

    const add = (entry: ComponentParamSelection, hidden: boolean, order: number) => {
      if (!env) return;
      const v = deriveComponentParamDef(entry, env, { hidden, order });
      if (v.ok) {
        if (declared.has(v.key)) return;
        declared.set(v.key, { target: v.def.target!, reconfig: v.reconfig, label: v.def.label });
        params.push(v.def);
        return;
      }
      if (v.code === 'unresolved') return; // stays dormant; orphan reporting covers stored values
      const id = `${v.code}:${v.effectiveKey ?? `${entry.address}|${entry.component}.${entry.field}`}`;
      const title = `Component field '${entry.component}.${entry.field}' cannot be a planning parameter`;
      if (v.code === PROBLEM_SELECTION_UNSUPPORTED) {
        reportProblem({ id, severity: 'warning', code: PROBLEM_SELECTION_UNSUPPORTED, title, detail: v.message });
      } else {
        reportProblem({ id, severity: 'warning', code: PROBLEM_SELECTION_INVALID, title, detail: v.message });
      }
    };
    this._selection.forEach((e, i) => add(e, false, i));
    let order = this._selection.length;
    for (const t of this._ensured.values()) add(t, true, order++);

    const removed = [...this._declared.keys()].filter((k) => !declared.has(k)).map((k) => `${COMPONENT_PLANNING_OWNER}.${k}`);
    this._declared = declared;

    if (params.length === 0) {
      if (this._handle) { this._handle.dispose(); this._handle = null; }
    } else if (this._handle) {
      this._handle.redeclare(params);
    } else {
      this._handle = this._registry.declare({
        owner: COMPONENT_PLANNING_OWNER,
        title: COMPONENT_PLANNING_TITLE,
        params,
        onStructuralReset: (committed, ctx) => this._writeCommitted(committed, ctx),
      });
    }
    // A property taken out of the window takes its value with it — no orphan left behind.
    if (removed.length > 0) this._registry.forgetDormant(removed);
  }
}
