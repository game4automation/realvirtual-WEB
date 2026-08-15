// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVCustomRuntimeInstruction — TypeScript counterpart of Unity
 * `CustomRuntimeInstruction.cs`.
 *
 * The richer sibling of WebError: a structured runtime instruction with five
 * types (Info/Maintenance/Warning/Error/Success), an ordered list of steps (each
 * with an instruction text, an optional camera target and an optional document
 * URL), an optional dismiss button, and a signal that pushes the card on a rising
 * edge and removes it on a falling edge.
 *
 * Web responsibilities:
 *  - register/remove the entry in the central InstructionRuntimeStore (drives the
 *    instruction panel) on signal edges,
 *  - keep a type-colored 3D highlight gizmo on the OWNING node lit while active,
 *  - highlight the CURRENT step's targets (highlightStep) as a type-colored fill
 *    overlay + silhouette edges (the same visual as the metadata object
 *    highlight) plus the pulsing OutlinePass status outline in the same color
 *    (rv-status-outline.ts — the Toray-style silhouette pulse).
 *
 * The per-step camera focus is driven by the panel plugin (View button →
 * viewer.fitToNodes / isolateNodes), not here.
 *
 * Gotchas handled (plan §2.5 / §5.1):
 *  - `steps` is read RAW from node.userData (NOT from an instance field): the
 *    schema has no field type for a nested object list, and resolveComponentRefs()
 *    would mutate any object reference inside it.
 *  - `ErrorColor` is read RAW via parseColorToHex (Unity Color has no FieldType),
 *    and only when UseCustomErrorColor is truthy; otherwise the type color is used.
 *  - target paths are resolved + the gizmo is created in onSceneReady (AABB correct
 *    after kinematic re-parenting). init() and onSceneReady() never throw.
 */

import { type Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import type { GizmoHandle } from './rv-gizmo-manager';
import { NodeRegistry } from './rv-node-registry';
import {
  ERROR_BLINK_HZ,
  parseColorToHex,
  createErrorHighlightGizmo,
  createStatusHighlightGizmos,
} from './rv-error-visual';
import { showStatusOutline, hideStatusOutline } from './rv-status-outline';
import { wireValueSignal } from './rv-signal-wiring';
import type { InstructionEntry, InstructionStep } from './rv-instruction-runtime-store';

// ─── Types ────────────────────────────────────────────────────────────────

export type InstructionType = 'info' | 'maintenance' | 'warning' | 'error' | 'success';

/** Built-in default per-type 3D-highlight colors (0xRRGGBB). Drives the
 *  owning-node blink gizmo AND the per-step target gizmos. Authoritative
 *  mapping (per product spec, kept in sync with CustomRuntimeInstruction.cs
 *  GetTypeVisuals): info=blue, maintenance=purple, warning=orange-yellow,
 *  error=red, success=green. */
const DEFAULT_TYPE_COLOR: Record<InstructionType, number> = {
  info: 0x3399ff,       // blue
  maintenance: 0x9c27b0, // purple
  warning: 0xffb300,    // orange-yellow
  error: 0xe53935,      // red
  success: 0x43a047,    // green
};

/** Live per-type highlight palette. Mutable so a model/customer loader can
 *  recolor the instruction highlights via {@link setInstructionTypeColors}.
 *  Read lazily at gizmo-creation time; model plugins register BEFORE the GLB is
 *  parsed (ModelPluginManager.onModelLoading runs ahead of loadGLB), so an
 *  override set in registerModelPlugins() is already active for every marker. */
const TYPE_COLOR: Record<InstructionType, number> = { ...DEFAULT_TYPE_COLOR };

/** Override one or more instruction-type highlight colors (0xRRGGBB). Accepts a
 *  partial map, so a loader can recolor just 'maintenance' and leave the rest.
 *  Call from a model plugin's registerModelPlugins(); pair it with
 *  {@link resetInstructionTypeColors} in unregisterModelPlugins() so the palette
 *  does not leak into the next model. Non-finite values are ignored. */
export function setInstructionTypeColors(
  overrides: Partial<Record<InstructionType, number>>,
): void {
  for (const key of Object.keys(overrides) as InstructionType[]) {
    const v = overrides[key];
    if (typeof v === 'number' && Number.isFinite(v)) TYPE_COLOR[key] = v;
  }
}

/** Restore the built-in default instruction highlight palette. */
export function resetInstructionTypeColors(): void {
  Object.assign(TYPE_COLOR, DEFAULT_TYPE_COLOR);
}

/** Current highlight color for an instruction type (test/inspection helper). */
export function getInstructionTypeColor(type: InstructionType): number {
  return TYPE_COLOR[type] ?? DEFAULT_TYPE_COLOR.info;
}

// The enum-tolerant `type` map (C# enum string 'Error' OR int index '3' →
// lowercase internal value) now lives in the rv-ODT spec (schema/v1/rv-odt.json,
// CustomRuntimeInstruction.type.enumMap) and is loaded via loadSchemaFromSpec.

/** Default blink rate for the dauer-highlight when BlinkSpeed is absent from the
 *  GLB (matches the CustomRuntimeInstruction.cs field default). */
const DEFAULT_BLINK_HZ = 2;

/** Target paths already warned about (once per path per session — a stale
 *  reference would otherwise spam the console on every step navigation). */
const warnedTargetPaths = new Set<string>();

// ─── Step parsing (raw rv_extras → InstructionStep[]) ───────────────────────

/** Coerce ONE raw target reference (string path or `{path}` object) to a node
 *  path, or null when empty/invalid. */
function parseTargetRef(t: unknown): string | null {
  if (typeof t === 'string') return t.length > 0 ? t : null;
  if (t && typeof t === 'object' && typeof (t as Record<string, unknown>).path === 'string') {
    const p = (t as Record<string, unknown>).path as string;
    return p.length > 0 ? p : null;
  }
  return null;
}

/** Coerce a raw rv_extras step entry to an InstructionStep (defensive).
 *  Reads BOTH the new `targetObjects` list (multi-target, highlighted in
 *  parallel) and the legacy single `targetObject` field, de-duplicated. */
function parseStep(raw: unknown): InstructionStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const instruction = typeof r.instruction === 'string' ? r.instruction : '';

  const targetPaths: string[] = [];
  // New multi-target field: array of relative node-path strings (or `{path}`).
  const arr = r.targetObjects;
  if (Array.isArray(arr)) {
    for (const item of arr) {
      const p = parseTargetRef(item);
      if (p && !targetPaths.includes(p)) targetPaths.push(p);
    }
  }
  // Legacy single-target field, appended for backward compatibility.
  const legacy = parseTargetRef(r.targetObject);
  if (legacy && !targetPaths.includes(legacy)) targetPaths.push(legacy);

  const targetPath = targetPaths.length > 0 ? targetPaths[0] : null;
  const url = typeof r.url === 'string' && r.url.length > 0 ? r.url : null;
  return { instruction, targetPath, targetPaths, url };
}

/** Parse the raw `steps` value. Tolerant of BOTH a JSON array and the legacy
 *  numeric-keyed JObject (`{"0":…,"1":…}`) that pre-export-fix GLBs carry. */
export function parseSteps(raw: unknown): InstructionStep[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : (typeof raw === 'object' ? Object.values(raw as object) : []);
  const out: InstructionStep[] = [];
  for (const item of list) {
    const step = parseStep(item);
    if (step) out.push(step);
  }
  return out;
}

// ─── RVCustomRuntimeInstruction ─────────────────────────────────────────────

export class RVCustomRuntimeInstruction implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  // `type` stays enum-tolerant: the spec's enumMap maps the C# enum string
  // ('Error') AND the legacy int index ('3') to the lowercase internal value.
  // ErrorColor: NOT in the schema — Unity Color {r,g,b,a} has no FieldType.
  //   Read raw via parseColorToHex in init() (only when UseCustomErrorColor).
  // steps: NOT in the schema — no nested-object-list FieldType; read raw in init().
  // highlight (AbstractSelectionManager): irrelevant in the web — omitted.
  static readonly schema: ComponentSchema = loadSchemaFromSpec('CustomRuntimeInstruction');

  readonly node: Object3D;
  isOwner = true;

  // Schema-populated (exact C# Inspector field names)
  type: InstructionType = 'info';
  dismissible = true;
  /** When true, clicking the message also isolates the step's targets (web only). */
  Isolate = false;
  signal: string | null = null;
  BlinkSpeed = DEFAULT_BLINK_HZ;

  /** Node path — the InstructionRuntimeStore key. Cached once at construction. */
  readonly path: string;

  /** Parsed steps (read RAW from userData in init — never from a mutated field). */
  steps: InstructionStep[] = [];

  private _highlightHex = TYPE_COLOR.info;
  private _blinkHz = DEFAULT_BLINK_HZ;
  private _highlightGizmo?: GizmoHandle;
  /** Type-colored highlight gizmos for the CURRENT step's targets (parallel). */
  private _stepGizmos: GizmoHandle[] = [];
  /** Whether this instruction currently owns the OutlinePass status outline. */
  private _statusOutlineShown = false;
  private _unsubscribe?: () => void;
  private _ctx?: ComponentContext;
  /** Last raw signal level (for rising/falling edge detection). */
  private _signalHigh = false;
  /** Whether an entry is currently active (store has it / highlight shown). */
  private _active = false;
  /** Static (no-signal) mode → show once in onSceneReady, never re-show (F7). */
  private _static = false;

  constructor(node: Object3D) {
    this.node = node;
    this.path = NodeRegistry.computeNodePath(node);
  }

  init(ctx: ComponentContext): void {
    this._ctx = ctx;

    // Read steps RAW from rv_extras (resolveComponentRefs would null targetObject).
    const rv = this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
    const block = rv?.['CustomRuntimeInstruction'];
    this.steps = parseSteps(block?.['steps']);

    // Highlight color: type color by default; custom only when UseCustomErrorColor.
    this._highlightHex = TYPE_COLOR[this.type] ?? TYPE_COLOR.info;
    if (block && block['UseCustomErrorColor']) {
      this._highlightHex = parseColorToHex(block['ErrorColor'], this._highlightHex);
    }
    // BlinkSpeed 0 is a valid, explicit setting: "no blinking, only highlight"
    // (the gizmo treats blinkHz <= 0 as a static highlight). Only a missing/NaN or
    // negative value falls back to the default blink rate.
    this._blinkHz = Number.isFinite(this.BlinkSpeed) && this.BlinkSpeed >= 0 ? this.BlinkSpeed : ERROR_BLINK_HZ;

    this.node.userData._rvType = 'CustomRuntimeInstruction';
    Object.defineProperty(this.node.userData, '_rvComponentInstance', {
      value: this, writable: true, configurable: true, enumerable: false,
    });

    // Subscribe only when a signal is bound. Read the initial level here but apply
    // it in onSceneReady (once the gizmo exists) — no flicker.
    if (this.signal) {
      // plan-427: via the helper, so the level is re-applied after reset /
      // reconnect. `_onSignal` is its own edge detector (`_signalHigh` compare),
      // which makes a replay of an unchanged level a no-op — and lets a level
      // that went high while the link was down still raise the instruction.
      // The FIRST call is special-cased: at init() the gizmo does not exist
      // yet, so the level is only recorded and `onSceneReady()` applies it (the
      // no-flicker contract the hand-written initial read had).
      let deferInitial = true;
      this._unsubscribe = wireValueSignal(ctx.signalStore, this.signal, (v) => {
        if (deferInitial) { deferInitial = false; this._signalHigh = !!v; return; }
        this._onSignal(!!v);
      }, undefined, ctx.reapply).unsubscribe;
      deferInitial = false;
    } else {
      // No signal → static display (F7): shown once, never re-shown after dismiss.
      this._static = true;
    }
  }

  /** Gizmo creation + initial-state application deferred to onSceneReady so the
   *  subtree AABB is correct AFTER kinematic re-parenting (matches RVWebError).
   *  Never throws (runOnSceneReady isolates per component, but be defensive). */
  onSceneReady(ctx: ComponentContext): void {
    this._ctx = ctx;
    if (ctx.gizmoManager) {
      // Type-colored highlight on the owning node, hidden until active.
      this._highlightGizmo = createErrorHighlightGizmo(
        ctx.gizmoManager, this.node, 'Auto', this._highlightHex, this._blinkHz,
      );
    }

    if (this._static) {
      // Static display: activate once.
      this._setActive(true);
    } else if (this._signalHigh) {
      // Signal already high at load → active after onSceneReady (no rising edge fires).
      this._setActive(true);
    }
  }

  /** Build the store entry from the current parsed config. */
  private _buildEntry(): InstructionEntry {
    return {
      path: this.path,
      type: this.type,
      dismissible: this.dismissible,
      isolate: this.Isolate,
      dismissed: false,
      steps: this._effectiveSteps(),
      since: performance.now(),
      at: Date.now(),
    };
  }

  /** Comment of the bound signal (from the SignalStore meta), or null. */
  private _signalComment(): string | null {
    if (!this.signal || !this._ctx) return null;
    const store = this._ctx.signalStore;
    const name = store.nameForPath(this.signal);
    if (!name) return null;
    const comment = store.getSignalMeta(name)?.comment;
    return comment && comment.trim().length > 0 ? comment : null;
  }

  /** Steps to display, with the bound signal's comment used as a fallback where
   *  no instruction text was authored: any step with empty text inherits it, and
   *  a signal-only instruction (no steps) yields a single comment-only step. */
  private _effectiveSteps(): InstructionStep[] {
    const comment = this._signalComment();
    if (!comment) return this.steps;
    if (this.steps.length === 0) {
      return [{ instruction: comment, targetPath: null, targetPaths: [], url: null }];
    }
    return this.steps.map((s) =>
      s.instruction.trim().length === 0 ? { ...s, instruction: comment } : s,
    );
  }

  private _onSignal(high: boolean): void {
    if (high === this._signalHigh) return;
    this._signalHigh = high;
    if (high) {
      // Rising edge → (re)show, clears any prior dismissed state via setActive.
      this._setActive(true);
    } else {
      // Falling edge → remove + reset dismissed state for the next rising edge.
      this._setActive(false);
    }
  }

  private _setActive(active: boolean): void {
    this._active = active;
    this._highlightGizmo?.setVisible(active);
    if (!active) this.clearStepHighlight();
    const store = this._ctx?.instructionStore;
    if (!store) return;
    if (active) store.setActive(this.path, this._buildEntry());
    else store.remove(this.path);
  }

  /** Highlight all target objects of the given step in parallel, in the
   *  instruction's type color — a fill overlay + silhouette edges (the same
   *  visual as the metadata object highlight) plus the pulsing OutlinePass
   *  status outline (rv-status-outline.ts; pulse rate follows BlinkSpeed,
   *  0 = static outline).
   *  Replaces any prior step highlight. The panel calls this on activation and
   *  on every step navigation. No-op / graceful when the gizmo manager is
   *  absent or a target path cannot be resolved. */
  highlightStep(index: number): void {
    this.clearStepHighlight();
    const gm = this._ctx?.gizmoManager;
    const registry = this._ctx?.registry;
    if (!gm || !registry) return;
    const steps = this._effectiveSteps();
    const step = steps[index];
    if (!step) return;
    const targetNodes: Object3D[] = [];
    for (const path of step.targetPaths) {
      const node = registry.getNode(path);
      if (!node) {
        if (!warnedTargetPaths.has(path)) {
          warnedTargetPaths.add(path);
          console.warn(
            `[RVCustomRuntimeInstruction] "${this.path}" step ${index + 1}: target "${path}" not found — highlight skipped`,
          );
        }
        continue;
      }
      targetNodes.push(node);
      this._stepGizmos.push(...createStatusHighlightGizmos(gm, node, this._highlightHex));
    }
    // Blinking outline via the OutlinePass status channel (the same visual as
    // the Toray severity pulse). Batched targets get invisible proxies.
    const om = this._ctx?.outlineManager;
    const scene = this._ctx?.scene;
    if (om && scene && targetNodes.length > 0) {
      showStatusOutline({ scene, outlineManager: om }, targetNodes, this._highlightHex, {
        ownerKey: this.path,
        pulsePeriod: this._blinkHz > 0 ? 1 / this._blinkHz : 0,
      });
      this._statusOutlineShown = true;
    }
  }

  /** Dispose the current step's target highlight gizmos + status outline. */
  clearStepHighlight(): void {
    for (const g of this._stepGizmos) g.dispose();
    this._stepGizmos = [];
    if (this._statusOutlineShown) {
      this._statusOutlineShown = false;
      const om = this._ctx?.outlineManager;
      const scene = this._ctx?.scene;
      if (om && scene) hideStatusOutline({ scene, outlineManager: om }, this.path);
    }
  }

  /** Resolve the target nodes of a step (for camera framing by the panel). */
  stepTargetPaths(index: number): string[] {
    return this._effectiveSteps()[index]?.targetPaths ?? [];
  }

  /** Current active state (test/inspection helper). */
  isActive(): boolean {
    return this._active;
  }

  dispose(): void {
    this._unsubscribe?.();
    this._unsubscribe = undefined;
    this._highlightGizmo?.dispose();
    this._highlightGizmo = undefined;
    this.clearStepHighlight();
    this._ctx?.instructionStore?.remove(this.path);
    this._active = false;
    this._signalHigh = false;
  }
}

// ─── Self-register ──────────────────────────────────────────────────────

registerComponent({
  type: 'CustomRuntimeInstruction',
  displayName: 'Instruction',
  schema: RVCustomRuntimeInstruction.schema,
  capabilities: {
    hoverable: false,
    selectable: false,
    filterLabel: 'Instructions',
    badgeColor: '#ab47bc',
  },
  create: (node) => new RVCustomRuntimeInstruction(node),
  afterCreate: (inst, node) => {
    node.userData._rvType = 'CustomRuntimeInstruction';
    Object.defineProperty(node.userData, '_rvComponentInstance', {
      value: inst, writable: true, configurable: true, enumerable: false,
    });
    setComponentInstance(node, inst);
  },
});
