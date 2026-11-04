// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-parser.ts — Parse LogicStep node extras from GLB into
 * MaintenanceProcedure data structures for the maintenance wizard.
 *
 * Handles both combined MaintenanceStep format and composable
 * SerialContainer with sub-steps format. Flattens nested containers
 * so each WaitForUserConfirm or MaintenanceStep becomes one visible
 * wizard step.
 *
 * plan-522: the web-authored format — a node with
 * `LogicStep_MaintenanceProcedure`, whose DIRECT children carrying
 * `LogicStep_MaintenanceStep` are the steps in hierarchy order; the action
 * components of a step node (DriveTo, SetSignalBool, AnimateTransform,
 * SetTransparency, Effect, incl. `_N` keys) become its `actions[]`. Everything
 * the guide does not execute is reported in `warnings[]`, never dropped
 * silently. Camera fields of this format are viewer coordinates (no Unity
 * conversion); the old `CameraPos` ScriptableObject format stays readable.
 */

import type { Object3D } from 'three';
import { isComponentReference, storedReferenceForm, storedReferenceLabel, storedReferenceValue } from './engine/rv-node-path-rewrite.mjs';
import { forEachComponentRef } from './engine/rv-component-registry';
import {
  MAINTENANCE_PROCEDURE_TYPE,
  MAINTENANCE_STEP_TYPE,
  MAINTENANCE_ARROW_TYPE,
  MAINTENANCE_TRIGGER_TYPE,
} from './engine/rv-maintenance-components';
import {
  DEFAULT_TRIGGER_RULES,
  MAINTENANCE_TRIGGER_KINDS,
  type MaintenanceTriggerCombine,
  type MaintenanceTriggerCompare,
  type MaintenanceTriggerEdge,
  type MaintenanceTriggerKind,
  type TriggerRules,
} from './maintenance-trigger-eval';
import { sanitizeLikeThree } from './engine/rv-three-names';
import type { NodeRegistry } from './engine/rv-node-registry';

// ─── Public Types ───────────────────────────────────────────────────────

/** Camera bookmark — position + orbit target for animateCameraTo(). */
export interface CameraBookmark {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
}

/** Completion type for a wizard step. */
export type CompletionType = 'Checkbox' | 'ConfirmWarning' | 'Observation';

/** Severity level for annotation display. */
export type StepSeverity = 'Info' | 'Warning' | 'Error' | 'Success';

/** Machine action types a maintenance step can carry (plan-522). */
export type MaintenanceActionType =
  | 'DriveTo' | 'SetSignalBool' | 'AnimateTransform' | 'SetTransparency' | 'Effect';

/** One machine action of a step — the raw component data, interpreted by the runtime. */
export interface MaintenanceAction {
  type: MaintenanceActionType;
  /** rv_extras of the component (the runtime interprets them). */
  data: Record<string, unknown>;
  /** Step node — the scope for resolving the action's references. */
  node: Object3D;
  /** Seconds after entering the step; 0 when absent. */
  startDelay: number;
}

/** An arrow shown with a step (`LogicStep_Arrow` on a child node of the step node). */
export interface MaintenanceArrow {
  /** The arrow node — its pose is the arrow's pose (local XY plane, +X / about +Z). */
  node: Object3D;
  type: 'Linear' | 'RotateCW' | 'RotateCCW' | 'Symbol';
  /** Edge length in metres. */
  size: number;
  animate: boolean;
  /** Type Symbol: the step symbol key (MAINTENANCE_SYMBOLS). */
  symbol?: string;
  /** Type Symbol: text below the symbol. */
  label?: string;
}

/** A single visible wizard step in the maintenance procedure. */
export interface MaintenanceStep {
  /** Step index within the procedure (0-based). */
  index: number;
  /** Step title. */
  title: string;
  /** Detailed instruction text. */
  instruction: string;
  /** Optional safety warning (displayed in red). */
  warningNote: string;
  /** Icon name for the step. */
  icon: string;
  /** Severity level. */
  severity: StepSeverity;
  /** Camera bookmark for this step (null if no camera data). */
  camera: CameraBookmark | null;
  /** Camera animation duration in seconds. */
  cameraDuration: number;
  /** Hierarchy paths of objects to highlight. */
  highlightPaths: string[];
  /** Label for the completion checkbox/button. */
  checkboxLabel: string;
  /** Completion type (Checkbox, ConfirmWarning, Observation). */
  completionType: CompletionType;
  /** Estimated time in minutes for this step (0 = not specified). */
  estimatedMinutes: number;
  /** Machine actions of this step (plan-522); [] when none. */
  actions: MaintenanceAction[];
  /** Arrows shown while the step is (child nodes with `LogicStep_Arrow`); absent = none. */
  arrows?: MaintenanceArrow[];
  /** Document link of the step (plan-522 Phase 6); absent = none. */
  document?: MaintenanceDocumentLink;
  /** Step symbol key (MAINTENANCE_SYMBOLS), absent = none (plan-522 Phase 6). */
  symbol?: string;
}

/**
 * A step's link into a manual (plan-522 Phase 6), resolved when the step is
 * shown: the document of the `AASLink` at `sourcePath` whose title or kind
 * contains one of `keywords` first, the explicit `url` (`{lang}` = UI
 * language) as fallback.
 */
export interface MaintenanceDocumentLink {
  /** Button label, e.g. "Betriebsanleitung". */
  title: string;
  /** Page to open (`#page=`), 0 = first page. */
  page: number;
  /** Explicit address; '' = look the document up in the AAS. */
  url: string;
  /** Registry path of the node carrying the `AASLink`; '' = none. */
  sourcePath: string;
  /** Lower-case alternatives matched against the AAS document title / kind. */
  keywords: string[];
}

/** What makes a procedure due (plan-522 Phase 6). */
export interface MaintenanceTrigger {
  /** The authored `ComponentReference` of the drive (resolved by the plugin in `scopeNode`'s asset). */
  driveRef: Record<string, unknown>;
  /** Display path of the drive (tile hover / focus). */
  drivePath: string;
  /** The procedure node: asset scope of the reference. */
  scopeNode: Object3D;
  unit: 'km' | 'h';
  /** Due at this counter value (in `unit`), > 0. */
  interval: number;
  /** Counter speed-up, > 0. */
  acceleration: number;
}

/**
 * One trigger of a procedure (plan-522 Phase 7): a child node with
 * `LogicStep_MaintenanceTrigger`, or the implicit one of the Phase-6 fields
 * (`legacy`). References stay in their authored form; the plugin resolves them
 * once per load in `scopeNode`'s asset.
 */
export interface MaintenanceTriggerDef {
  /** Display name: the trigger node's authored name (`_N` key appended), `legacy` for the implicit one. */
  name: string;
  /** The trigger node; the procedure node for the implicit legacy trigger. */
  node: Object3D;
  /** The implicit trigger of the Phase-6 procedure fields. */
  legacy: boolean;
  /** Validated rules for the evaluator. */
  rules: TriggerRules;
  enabled: boolean;
  /** Authored `Signal` reference (object form), absent = none. */
  signalRef?: Record<string, unknown>;
  /** Display path of the signal; '' = none. */
  signalPath: string;
  /** PLC type the stored reference names (`PLCInputBool`, …); '' = unknown. */
  signalType: string;
  /** Authored `Drive` reference, absent = none. */
  driveRef?: Record<string, unknown>;
  drivePath: string;
  /** Asset scope of the references (the trigger node). */
  scopeNode: Object3D;
  /** Authoring problems found while parsing (wrong signal type, missing source, unknown kind). */
  issues: string[];
}

/** Output signal references of a procedure (plan-522 Phase 7); absent = not wired. */
export interface MaintenanceOutputRefs {
  due?: Record<string, unknown>;
  overdue?: Record<string, unknown>;
  state?: Record<string, unknown>;
  remaining?: Record<string, unknown>;
}

/** Root maintenance procedure parsed from GLB. */
export interface MaintenanceProcedure {
  /** Procedure name (from the SerialContainer node name). */
  name: string;
  /** Total estimated time in minutes (sum of step estimates). */
  estimatedMinutes: number;
  /** Ordered list of wizard steps. */
  steps: MaintenanceStep[];
  /** Parse findings (unsupported components, unresolved references, ...) — plan-522. */
  warnings: string[];
  /** Message-panel tile (plan-522 Phase 6): absent = 'WhenDue'. */
  message?: 'WhenDue' | 'Always';
  /** Tile subtitle; absent = generated. */
  messageText?: string;
  /** Mileage / operating-hours trigger (Phase-6 fields); absent = none. Also listed in `triggers` as `legacy`. */
  trigger?: MaintenanceTrigger;
  /** Every trigger in hierarchy order, the implicit legacy one first (plan-522 Phase 7); absent = none. */
  triggers?: MaintenanceTriggerDef[];
  /** How the triggers combine; absent = 'Any'. */
  triggerCombine?: MaintenanceTriggerCombine;
  /** Output signals; absent = none wired. */
  outputs?: MaintenanceOutputRefs;
  /** The procedure node (scope of the output references). */
  node?: Object3D;
}

/** The part of the registry the reference check reads (plan-769: the file's verdict). */
type StoredRefReader = Pick<NodeRegistry, 'readStoredRef'> & Partial<Pick<NodeRegistry, 'getPathForNode'>>;

/** Options of {@link parseMaintenanceProcedures}. */
export interface MaintenanceParseOptions {
  /**
   * The viewer's registry. With it, a reference the file carries is judged by the
   * file's verdict (`readStoredRef`, plan-769); without it (tests, offline tools)
   * the reference check walks the step's ancestors.
   */
  registry?: StoredRefReader | null;
}

// ─── Camera Position Parsing ────────────────────────────────────────────

/**
 * Parse a CameraPos ScriptableObject's inline data into a CameraBookmark.
 * Handles both direct fields and nested `data` wrapper (SO inline format).
 */
export function parseCameraPos(raw: Record<string, unknown>): CameraBookmark | null {
  // Support ScriptableObject inline format with nested `data` field
  const data = (raw['type'] === 'ScriptableObject' && raw['data'])
    ? raw['data'] as Record<string, unknown>
    : raw;

  const cameraTransformPos = data['CameraTransformPos'] as { x: number; y: number; z: number } | undefined;
  const targetPos = data['TargetPos'] as { x: number; y: number; z: number } | undefined;

  if (!cameraTransformPos && !targetPos) return null;

  // Convert Unity LHS to glTF RHS: negate X
  return {
    px: cameraTransformPos ? -cameraTransformPos.x : 0,
    py: cameraTransformPos?.y ?? 0,
    pz: cameraTransformPos?.z ?? 0,
    tx: targetPos ? -targetPos.x : 0,
    ty: targetPos?.y ?? 0,
    tz: targetPos?.z ?? 0,
  };
}

// ─── Highlight Path Extraction ──────────────────────────────────────────

/**
 * Extract highlight target paths from a HighlightTargets array in GLB extras.
 * Targets are serialized as relative hierarchy path strings or component references.
 */
function parseHighlightTargets(targets: unknown, resolveStored?: (value: unknown) => string | null): string[] {
  if (!Array.isArray(targets)) return [];
  const paths: string[] = [];
  for (const t of targets) {
    if (typeof t === 'string' && t.length > 0) {
      paths.push(t);
    } else if (isComponentReference(t)) {
      // THE ComponentReference guard of the rewrite core (plan-769: one guard, not a twin).
      // plan-769 Phase 3: an address-form target is named by id — the step node's
      // registry turns it into the node's path; without one its label stands in.
      if (typeof t.path === 'string') { if (t.path) paths.push(t.path); continue; }
      const label = resolveStored?.(t) ?? storedReferenceLabel(t);
      if (label) paths.push(label);
    } else if (t && typeof t === 'object') {
      // Legacy record without the reference `type`: `{ path: "...", component: "..." }`.
      const path = (t as Record<string, unknown>)['path'] as string | undefined;
      if (path) paths.push(path);
    }
  }
  return paths;
}

// ─── Completion Type Parsing ────────────────────────────────────────────

function parseCompletionType(raw: unknown): CompletionType {
  if (typeof raw === 'string') {
    if (raw === 'ConfirmWarning' || raw === 'WarningAcknowledge') return 'ConfirmWarning';
    if (raw === 'Observation' || raw === 'Button') return 'Observation';
  }
  return 'Checkbox';
}

function parseSeverity(raw: unknown): StepSeverity {
  if (typeof raw === 'string') {
    if (raw === 'Warning') return 'Warning';
    if (raw === 'Error') return 'Error';
    if (raw === 'Success') return 'Success';
  }
  return 'Info';
}

// ─── Step Extraction from Node Extras ───────────────────────────────────

/**
 * Try to extract a MaintenanceStep from a combined MaintenanceStep component.
 */
function parseMaintenanceStepComponent(
  data: Record<string, unknown>,
  nodeName: string,
  index: number,
  resolveStored?: (value: unknown) => string | null,
): MaintenanceStep {
  const camera = parseStepCamera(data);

  return {
    index,
    title: (data['Title'] as string) || nodeName,
    instruction: (data['Instruction'] as string) || '',
    warningNote: (data['WarningNote'] as string) || '',
    icon: (data['Icon'] as string) || 'build',
    severity: parseSeverity(data['Severity']),
    camera,
    cameraDuration: (data['CameraDuration'] as number) ?? 0.8,
    highlightPaths: parseHighlightTargets(data['HighlightTargets'], resolveStored),
    checkboxLabel: (data['CheckboxLabel'] as string) || 'Done',
    completionType: parseCompletionType(data['CompletionType']),
    estimatedMinutes: (data['EstimatedMinutes'] as number) ?? 0,
    actions: [],
    ...documentLinkOf(data, resolveStored),
    ...(typeof data['Symbol'] === 'string' && data['Symbol'] && data['Symbol'] !== 'None' ? { symbol: data['Symbol'] } : {}),
  };
}

/** The step's document link (plan-522 Phase 6), or nothing without a title. */
function documentLinkOf(
  data: Record<string, unknown>,
  resolveStored?: (value: unknown) => string | null,
): { document?: MaintenanceDocumentLink } {
  const title = typeof data['DocumentTitle'] === 'string' ? data['DocumentTitle'].trim() : '';
  if (!title) return {};
  const rawPage = data['DocumentPage'];
  const page = typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 0;
  const url = typeof data['DocumentUrl'] === 'string' ? data['DocumentUrl'].trim() : '';
  const source = data['DocumentSource'];
  const sourcePath = source ? (parseHighlightTargets([source], resolveStored)[0] ?? '') : '';
  const keywords = (typeof data['DocumentKeyword'] === 'string' ? data['DocumentKeyword'] : '')
    .split('|').map((k) => k.trim().toLowerCase()).filter(Boolean);
  return { document: { title, page, url, sourcePath, keywords } };
}

/** Message mode, text and trigger of a procedure root (plan-522 Phase 6). */
function procedureExtrasOf(
  node: Object3D,
  data: Record<string, unknown>,
  resolveStored?: (value: unknown) => string | null,
): Pick<MaintenanceProcedure, 'message' | 'messageText' | 'trigger'> {
  const out: Pick<MaintenanceProcedure, 'message' | 'messageText' | 'trigger'> = {};
  if (data['Message'] === 'Always') out.message = 'Always';
  if (typeof data['MessageText'] === 'string' && data['MessageText'].trim()) out.messageText = data['MessageText'].trim();
  const ref = data['TriggerDrive'];
  const interval = data['TriggerInterval'];
  if (isComponentReference(ref) && typeof interval === 'number' && Number.isFinite(interval) && interval > 0) {
    const acc = data['TriggerAcceleration'];
    out.trigger = {
      driveRef: ref as unknown as Record<string, unknown>,
      drivePath: parseHighlightTargets([ref], resolveStored)[0] ?? '',
      scopeNode: node,
      unit: data['TriggerUnit'] === 'h' ? 'h' : 'km',
      interval,
      acceleration: typeof acc === 'number' && Number.isFinite(acc) && acc > 0 ? acc : 1,
    };
  }
  return out;
}

type Vec3 = { x: number; y: number; z: number };

function isVec3(v: unknown): v is Vec3 {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r['x'] === 'number' && typeof r['y'] === 'number' && typeof r['z'] === 'number';
}

/**
 * Camera of a `LogicStep_MaintenanceStep`. Two formats:
 * - old (Unity-authored): `CameraPosition` is a `CameraPos` ScriptableObject
 *   (`type === 'ScriptableObject'` or `CameraTransformPos` / `TargetPos`) —
 *   converted from Unity like before ({@link parseCameraPos});
 * - plan-522 (web-authored): `CameraPosition` / `CameraTarget` are `{x,y,z}` in
 *   viewer coordinates, taken as they are. Both at (0,0,0) = no camera move.
 */
function parseStepCamera(data: Record<string, unknown>): CameraBookmark | null {
  const raw = data['CameraPosition'];
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] === 'ScriptableObject' || 'CameraTransformPos' in r || 'TargetPos' in r) {
    return parseCameraPos(r);
  }
  if (!isVec3(r)) return null;
  const target = data['CameraTarget'];
  const t: Vec3 = isVec3(target) ? target : { x: 0, y: 0, z: 0 };
  if (r.x === 0 && r.y === 0 && r.z === 0 && t.x === 0 && t.y === 0 && t.z === 0) return null;
  return { px: r.x, py: r.y, pz: r.z, tx: t.x, ty: t.y, tz: t.z };
}

// ─── Composable Step Flattening ─────────────────────────────────────────

/**
 * Accumulator for composable sub-steps inside a SerialContainer.
 * Each WaitForUserConfirm creates a visible wizard step using the
 * accumulated camera, highlight, and annotation data.
 */
interface StepAccumulator {
  camera: CameraBookmark | null;
  cameraDuration: number;
  highlightPaths: string[];
  title: string;
  instruction: string;
  warningNote: string;
  icon: string;
  severity: StepSeverity;
}

function emptyAccumulator(): StepAccumulator {
  return {
    camera: null,
    cameraDuration: 0.8,
    highlightPaths: [],
    title: '',
    instruction: '',
    warningNote: '',
    icon: 'build',
    severity: 'Info',
  };
}

/**
 * Flatten composable sub-steps within a SerialContainer into wizard steps.
 * Each WaitForUserConfirm or blocking step becomes one visible step,
 * incorporating any preceding SetCameraPosition, Highlight, ShowAnnotation.
 */
function flattenComposableSteps(
  children: { name: string; rv: Record<string, unknown> }[],
  startIndex: number,
  resolveStored?: (value: unknown) => string | null,
): MaintenanceStep[] {
  const steps: MaintenanceStep[] = [];
  let acc = emptyAccumulator();

  for (const child of children) {
    const rv = child.rv;

    // SetCameraPosition component
    if (rv['LogicStep_SetCameraPosition']) {
      const data = rv['LogicStep_SetCameraPosition'] as Record<string, unknown>;
      const cameraRaw = data['CameraPosition'] as Record<string, unknown> | undefined;
      if (cameraRaw) acc.camera = parseCameraPos(cameraRaw);
      acc.cameraDuration = (data['Duration'] as number) ?? 0.8;
    }

    // Highlight component
    if (rv['LogicStep_Highlight']) {
      const data = rv['LogicStep_Highlight'] as Record<string, unknown>;
      const clearPrev = (data['ClearPrevious'] as boolean) ?? true;
      if (clearPrev) acc.highlightPaths = [];
      const targets = parseHighlightTargets(data['Targets'], resolveStored);
      acc.highlightPaths.push(...targets);
    }

    // ShowAnnotation component
    if (rv['LogicStep_ShowAnnotation']) {
      const data = rv['LogicStep_ShowAnnotation'] as Record<string, unknown>;
      acc.title = (data['Title'] as string) || child.name;
      acc.instruction = (data['Instruction'] as string) || '';
      acc.warningNote = (data['WarningNote'] as string) || '';
      acc.icon = (data['Icon'] as string) || 'build';
      acc.severity = parseSeverity(data['Severity']);
    }

    // WaitForUserConfirm — creates a visible wizard step
    if (rv['LogicStep_WaitForUserConfirm']) {
      const data = rv['LogicStep_WaitForUserConfirm'] as Record<string, unknown>;
      steps.push({
        index: startIndex + steps.length,
        title: acc.title || child.name,
        instruction: acc.instruction,
        warningNote: acc.warningNote,
        icon: acc.icon,
        severity: acc.severity,
        camera: acc.camera,
        cameraDuration: acc.cameraDuration,
        highlightPaths: [...acc.highlightPaths],
        checkboxLabel: (data['ButtonLabel'] as string) || 'Done',
        completionType: parseCompletionType(data['ConfirmationType']),
        estimatedMinutes: 0,
        actions: [],
      });
      // Reset accumulator for next sub-step group
      acc = emptyAccumulator();
    }

    // MaintenanceStep inside a SerialContainer (combined component as child)
    if (rv['LogicStep_MaintenanceStep']) {
      const data = rv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
      steps.push(parseMaintenanceStepComponent(
        data,
        child.name,
        startIndex + steps.length,
        resolveStored,
      ));
      acc = emptyAccumulator();
    }
  }

  return steps;
}

// ─── Main Parser ────────────────────────────────────────────────────────

/**
 * Scan a GLB scene tree for maintenance procedures.
 *
 * Looks for SerialContainer nodes whose children contain MaintenanceStep
 * or composable step types. Each qualifying SerialContainer becomes a
 * MaintenanceProcedure.
 *
 * @param root  The GLB scene root Object3D.
 * @param opts  The viewer's registry (plan-769: references are judged by the file).
 * @returns     Array of parsed maintenance procedures.
 */
export function parseMaintenanceProcedures(root: Object3D, opts?: MaintenanceParseOptions): MaintenanceProcedure[] {
  const procedures: MaintenanceProcedure[] = [];
  const registry = opts?.registry ?? null;

  root.traverse((node: Object3D) => {
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;

    // plan-522: web-authored procedure node.
    const procData = rv[MAINTENANCE_PROCEDURE_TYPE];
    if (procData != null) {
      const proc = parseProcedureNode(node, typeof procData === 'object' ? procData as Record<string, unknown> : {}, registry);
      if (proc) procedures.push(proc);
      return;
    }

    // Look for SerialContainer nodes
    if (!rv['LogicStep_SerialContainer']) return;

    // Check children for maintenance step types
    const childInfos: { name: string; rv: Record<string, unknown> }[] = [];
    let hasMaintenanceContent = false;

    for (const child of node.children) {
      const childRv = child.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!childRv) continue;

      childInfos.push({ name: child.name, rv: childRv });

      // Check if this child or its children have maintenance-related steps
      if (childRv['LogicStep_MaintenanceStep']) {
        hasMaintenanceContent = true;
      }
      if (childRv['LogicStep_SerialContainer']) {
        // Nested SerialContainer — check for composable steps
        for (const grandchild of child.children) {
          const gcRv = grandchild.userData?.realvirtual as Record<string, unknown> | undefined;
          if (!gcRv) continue;
          if (gcRv['LogicStep_WaitForUserConfirm'] || gcRv['LogicStep_MaintenanceStep'] ||
              gcRv['LogicStep_SetCameraPosition'] || gcRv['LogicStep_Highlight'] ||
              gcRv['LogicStep_ShowAnnotation']) {
            hasMaintenanceContent = true;
          }
        }
      }
    }

    if (!hasMaintenanceContent) return;

    // Parse steps
    const steps: MaintenanceStep[] = [];

    for (const childInfo of childInfos) {
      const childRv = childInfo.rv;

      // Direct MaintenanceStep child
      if (childRv['LogicStep_MaintenanceStep']) {
        const data = childRv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
        steps.push(parseMaintenanceStepComponent(data, childInfo.name, steps.length, storedPathResolver(registry, node)));
        continue;
      }

      // Nested SerialContainer — flatten composable sub-steps
      if (childRv['LogicStep_SerialContainer']) {
        // Find the actual Object3D child to access grandchildren
        const childNode = node.children.find(c => c.name === childInfo.name);
        if (!childNode) continue;

        const grandchildInfos: { name: string; rv: Record<string, unknown> }[] = [];
        for (const gc of childNode.children) {
          const gcRv = gc.userData?.realvirtual as Record<string, unknown> | undefined;
          if (gcRv) grandchildInfos.push({ name: gc.name, rv: gcRv });
        }

        const subSteps = flattenComposableSteps(grandchildInfos, steps.length, storedPathResolver(registry, node));
        steps.push(...subSteps);
      }
    }

    if (steps.length === 0) return;

    // Re-index steps sequentially
    for (let i = 0; i < steps.length; i++) {
      steps[i].index = i;
    }

    const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);

    procedures.push({
      name: node.name,
      estimatedMinutes: totalEstimated,
      steps,
      warnings: [],
    });
  });

  return procedures;
}

// ─── Web-authored format (plan-522) ─────────────────────────────────────

/** Extras key (base type, `_N` stripped) → action type. */
const ACTION_TYPES: Readonly<Record<string, MaintenanceActionType>> = Object.freeze({
  LogicStep_DriveTo: 'DriveTo',
  LogicStep_SetSignalBool: 'SetSignalBool',
  LogicStep_AnimateTransform: 'AnimateTransform',
  LogicStep_SetTransparency: 'SetTransparency',
  LogicStep_Effect: 'Effect',
});

const baseKey = (key: string): string => key.replace(/_\d+$/, '');

/**
 * A node's AUTHORED name: the raw glTF spelling the loader keeps under
 * `userData._rvOrigName` when it had to de-duplicate (`02 Step` loaded as
 * `02_Step_1`), else the node name. Fallback for an empty `Title` /
 * `ProcedureName` (plan-522 Phase 5), so the panel never shows a loader suffix.
 */
function authoredNameOf(node: Object3D): string {
  const orig = (node.userData as Record<string, unknown> | undefined)?.['_rvOrigName'];
  return typeof orig === 'string' && orig.length > 0 ? orig : node.name;
}

/**
 * Parse one `LogicStep_MaintenanceProcedure` node. Steps = direct children
 * with `LogicStep_MaintenanceStep`, in hierarchy order; deeper nodes do not
 * belong to the procedure. Returns null when it has no step.
 */
function parseProcedureNode(
  node: Object3D,
  data: Record<string, unknown>,
  registry: StoredRefReader | null,
): MaintenanceProcedure | null {
  const declaredName = data['ProcedureName'];
  const name = (typeof declaredName === 'string' && declaredName) || authoredNameOf(node);
  const warnings: string[] = [];
  const steps: MaintenanceStep[] = [];
  const triggers: MaintenanceTriggerDef[] = [];

  for (const child of node.children) {
    const crv = child.userData?.realvirtual as Record<string, unknown> | undefined;
    const stepData = crv?.[MAINTENANCE_STEP_TYPE] as Record<string, unknown> | undefined;
    // plan-522 Phase 7 (G12): a trigger child is read, not warned, not a step.
    const hasTrigger = !!crv && parseTriggerNode(child, crv, triggers, storedPathResolver(registry, child));
    if (hasTrigger && !stepData) continue;
    if (!crv || !stepData) {
      warnings.push(`Procedure "${name}": child "${child.name}" has no ${MAINTENANCE_STEP_TYPE} — ignored`);
      continue;
    }
    const step = parseMaintenanceStepComponent(stepData, authoredNameOf(child), steps.length, storedPathResolver(registry, child));
    const where = `Procedure "${name}", step "${child.name}"`;
    checkReferences(stepData, child, `${where}, ${MAINTENANCE_STEP_TYPE}`, warnings, registry);

    for (const key of Object.keys(crv)) {
      if (!key.startsWith('LogicStep_')) continue;
      const base = baseKey(key);
      if (base === MAINTENANCE_STEP_TYPE || base === MAINTENANCE_TRIGGER_TYPE) continue;
      const type = ACTION_TYPES[base];
      if (!type) {
        warnings.push(`${where}: ${key} is not executed by the maintenance guide`);
        continue;
      }
      const raw = crv[key];
      const actionData = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown> : {};
      const delay = actionData['StartDelay'];
      checkReferences(actionData, child, `${where}, ${key}`, warnings, registry);
      step.actions.push({
        type,
        data: actionData,
        node: child,
        startDelay: typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 0,
      });
    }
    step.arrows = parseArrows(child);
    steps.push(step);
  }

  if (steps.length === 0) return null;
  const declaredMinutes = data['EstimatedMinutes'];
  const estimatedMinutes = typeof declaredMinutes === 'number' && declaredMinutes > 0
    ? declaredMinutes : steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);
  const extras = procedureExtrasOf(node, data, storedPathResolver(registry, node));
  const proc: MaintenanceProcedure = { name, estimatedMinutes, steps, warnings, node, ...extras };
  // plan-522 Phase 7: the Phase-6 fields are the implicit first trigger — no GLB migration.
  if (extras.trigger) triggers.unshift(legacyTriggerOf(node, extras.trigger));
  if (triggers.length > 0) proc.triggers = triggers;
  if (data['TriggerCombine'] === 'All') proc.triggerCombine = 'All';
  const outputs = outputRefsOf(data);
  if (outputs) proc.outputs = outputs;
  return proc;
}

// ─── Triggers (plan-522 Phase 7) ────────────────────────────────────────

const TRIGGER_EDGES: readonly MaintenanceTriggerEdge[] = ['Rising', 'Falling', 'Both'];
const TRIGGER_COMPARES: readonly MaintenanceTriggerCompare[] = ['GreaterThan', 'GreaterOrEqual', 'LessThan', 'LessOrEqual', 'Equals'];

function finiteOr(v: unknown, fallback: number, min = -Infinity): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fallback;
}

/** Signal value types each kind accepts (G1); Travel / Interval read no signal. */
const KIND_SIGNAL_TYPES: Readonly<Record<MaintenanceTriggerKind, readonly ('Bool' | 'Int' | 'Float')[]>> = Object.freeze({
  Signal: ['Bool'],
  Count: ['Bool', 'Int'],
  RunTime: ['Bool'],
  Threshold: ['Int', 'Float'],
  Travel: [],
  Interval: [],
});

/** `Bool` / `Int` / `Float` of a PLC type name, '' when unknown. */
export function signalValueKindOf(plcType: string): 'Bool' | 'Int' | 'Float' | '' {
  if (plcType.endsWith('Bool')) return 'Bool';
  if (plcType.endsWith('Int')) return 'Int';
  if (plcType.endsWith('Float')) return 'Float';
  return '';
}

/** True when a signal of `plcType` fits the kind; an unknown type passes (the plugin checks the live type). */
export function signalTypeFitsKind(kind: MaintenanceTriggerKind, plcType: string): boolean {
  const vk = signalValueKindOf(plcType);
  return vk === '' || KIND_SIGNAL_TYPES[kind].includes(vk);
}

/**
 * Read every `LogicStep_MaintenanceTrigger` (incl. `_N` keys) of a child node
 * into `out`. Returns true when the node carries at least one.
 */
function parseTriggerNode(
  child: Object3D,
  crv: Record<string, unknown>,
  out: MaintenanceTriggerDef[],
  resolveStored?: (value: unknown) => string | null,
): boolean {
  let found = false;
  for (const key of Object.keys(crv)) {
    if (baseKey(key) !== MAINTENANCE_TRIGGER_TYPE) continue;
    found = true;
    const raw = crv[key];
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const suffix = key === MAINTENANCE_TRIGGER_TYPE ? '' : key.slice(MAINTENANCE_TRIGGER_TYPE.length);
    out.push(triggerDefOf(child, `${authoredNameOf(child)}${suffix}`, d, resolveStored));
  }
  return found;
}

function triggerDefOf(
  node: Object3D,
  name: string,
  d: Record<string, unknown>,
  resolveStored?: (value: unknown) => string | null,
): MaintenanceTriggerDef {
  const issues: string[] = [];
  const rawKind = d['Kind'];
  let kind: MaintenanceTriggerKind = DEFAULT_TRIGGER_RULES.kind;
  if (typeof rawKind === 'string' && (MAINTENANCE_TRIGGER_KINDS as readonly string[]).includes(rawKind)) {
    kind = rawKind as MaintenanceTriggerKind;
  } else if (rawKind !== undefined) {
    issues.push(`Kind "${String(rawKind)}" is not supported`);
  }
  const edge = TRIGGER_EDGES.includes(d['Edge'] as MaintenanceTriggerEdge) ? d['Edge'] as MaintenanceTriggerEdge : DEFAULT_TRIGGER_RULES.edge;
  const compare = TRIGGER_COMPARES.includes(d['Compare'] as MaintenanceTriggerCompare)
    ? d['Compare'] as MaintenanceTriggerCompare : DEFAULT_TRIGGER_RULES.compare;
  const rules: TriggerRules = {
    kind,
    edge,
    latch: d['Latch'] !== false,
    compare,
    threshold: finiteOr(d['Threshold'], DEFAULT_TRIGGER_RULES.threshold),
    hysteresis: finiteOr(d['Hysteresis'], 0, 0),
    debounceSeconds: finiteOr(d['DebounceSeconds'], 0, 0),
    interval: finiteOr(d['Interval'], 0, 0),
    warnAt: finiteOr(d['WarnAt'], DEFAULT_TRIGGER_RULES.warnAt, 0),
    overdueAfter: finiteOr(d['OverdueAfter'], 0, 0),
    acceleration: finiteOr(d['Acceleration'], 1, 0) || 1,
  };
  const def: MaintenanceTriggerDef = {
    name,
    node,
    legacy: false,
    rules,
    enabled: d['Enabled'] !== false,
    signalPath: '',
    signalType: '',
    drivePath: '',
    scopeNode: node,
    issues,
  };
  const sig = d['Signal'];
  if (isComponentReference(sig) && (storedReferenceLabel(sig) ?? '') !== '') {
    def.signalRef = sig as unknown as Record<string, unknown>;
    def.signalPath = parseHighlightTargets([sig], resolveStored)[0] ?? '';
    const ct = (sig as { componentType?: unknown }).componentType;
    def.signalType = typeof ct === 'string' ? ct : '';
  }
  const drv = d['Drive'];
  if (isComponentReference(drv) && (storedReferenceLabel(drv) ?? '') !== '') {
    def.driveRef = drv as unknown as Record<string, unknown>;
    def.drivePath = parseHighlightTargets([drv], resolveStored)[0] ?? '';
  }
  // G1: the value type per kind, judged on the stored reference's type.
  if (def.signalRef && def.signalType && KIND_SIGNAL_TYPES[kind].length > 0 && !signalTypeFitsKind(kind, def.signalType)) {
    issues.push(`${kind} cannot read a ${def.signalType} signal (needs ${KIND_SIGNAL_TYPES[kind].join(' or ')})`);
  }
  // Missing sources.
  if ((kind === 'Signal' || kind === 'Count' || kind === 'Threshold') && !def.signalRef) issues.push(`${kind} needs a Signal`);
  if (kind === 'Travel' && !def.driveRef) issues.push('Travel needs a Drive');
  if (kind === 'RunTime' && !def.signalRef && !def.driveRef) issues.push('RunTime needs a Signal or a Drive');
  if ((kind === 'Count' || kind === 'Travel' || kind === 'RunTime' || kind === 'Interval') && def.enabled && !(rules.interval > 0)) {
    issues.push(`${kind} has no Interval (0 = inactive)`);
  }
  return def;
}

/** The implicit Travel / RunTime trigger of the Phase-6 procedure fields (G10 discriminator `legacy`). */
function legacyTriggerOf(node: Object3D, t: MaintenanceTrigger): MaintenanceTriggerDef {
  return {
    name: 'legacy',
    node,
    legacy: true,
    rules: {
      ...DEFAULT_TRIGGER_RULES,
      kind: t.unit === 'h' ? 'RunTime' : 'Travel',
      interval: t.interval,
      acceleration: t.acceleration,
    },
    enabled: true,
    signalPath: '',
    signalType: '',
    driveRef: t.driveRef,
    drivePath: t.drivePath,
    scopeNode: t.scopeNode,
    issues: [],
  };
}

function outputRefsOf(data: Record<string, unknown>): MaintenanceOutputRefs | null {
  const out: MaintenanceOutputRefs = {};
  const pick = (field: string): Record<string, unknown> | undefined => {
    const r = data[field];
    return isComponentReference(r) && (storedReferenceLabel(r) ?? '') !== '' ? r as unknown as Record<string, unknown> : undefined;
  };
  const due = pick('DueSignal'); if (due) out.due = due;
  const overdue = pick('OverdueSignal'); if (overdue) out.overdue = overdue;
  const state = pick('StateSignal'); if (state) out.state = state;
  const remaining = pick('RemainingSignal'); if (remaining) out.remaining = remaining;
  return Object.keys(out).length > 0 ? out : null;
}

/** The arrows of a step: its child nodes carrying `LogicStep_Arrow`, in hierarchy order. */
function parseArrows(stepNode: Object3D): MaintenanceArrow[] {
  const arrows: MaintenanceArrow[] = [];
  for (const node of stepNode.children) {
    const raw = (node.userData?.realvirtual as Record<string, unknown> | undefined)?.[MAINTENANCE_ARROW_TYPE];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const d = raw as Record<string, unknown>;
    const type = d['Type'] === 'RotateCW' || d['Type'] === 'RotateCCW' || d['Type'] === 'Symbol' ? d['Type'] : 'Linear';
    const size = typeof d['Size'] === 'number' && Number.isFinite(d['Size']) && d['Size'] > 0 ? d['Size'] : 0.1;
    const arrow: MaintenanceArrow = { node, type, size, animate: d['Animate'] !== false };
    if (type === 'Symbol') {
      arrow.symbol = typeof d['Symbol'] === 'string' && d['Symbol'] ? d['Symbol'] : 'Inspect';
      if (typeof d['Label'] === 'string' && d['Label'].trim()) arrow.label = d['Label'].trim();
    }
    arrows.push(arrow);
  }
  return arrows;
}

/**
 * plan-769 Phase 3: the registry path an address-form reference of `owner`'s document
 * names (highlight targets are runtime paths), or undefined without a registry.
 */
function storedPathResolver(registry: StoredRefReader | null, owner: Object3D): ((value: unknown) => string | null) | undefined {
  if (!registry?.getPathForNode) return undefined;
  return (value: unknown): string | null => {
    const stored = storedReferenceValue(value);
    const r = stored === null ? null : registry.readStoredRef(owner, stored);
    return r?.status === 'resolved' ? (registry.getPathForNode!(r.node) ?? null) : null;
  };
}

/** Warn for every object-form reference of a record that resolves nowhere (the action stays). */
function checkReferences(
  record: Record<string, unknown>,
  stepNode: Object3D,
  where: string,
  warnings: string[],
  registry: StoredRefReader | null,
): void {
  forEachComponentRef(record, (field, ref) => {
    if (!referenceFound(stepNode, ref, registry)) {
      warnings.push(`${where}: reference ${field} "${storedReferenceLabel(ref) ?? ''}" not found`);
    }
  });
}

/**
 * plan-769: a reference the FILE carries has the file's verdict (`readStoredRef` —
 * resolved, pending in a placement that is still loading, or unresolved); the
 * ancestor walk below answers only a `legacy` read (no identity, a path the web
 * wrote this session) and the registry-less parse (tests, offline tools).
 */
function referenceFound(stepNode: Object3D, ref: unknown, registry: StoredRefReader | null): boolean {
  const form = storedReferenceForm(ref);
  if (!form) return true;
  // plan-769 Phase 3: a kept path is unresolved by its file; an address needs the registry.
  if (form.form === 'unresolved') return false;
  const read = registry?.readStoredRef(stepNode, storedReferenceValue(ref)!);
  if (!read) return form.form === 'path' ? !!resolveFromAncestors(stepNode, form.path) : true;
  if (read.status === 'resolved' || read.status === 'pending') return true;
  if (read.status === 'unresolved') return false;
  return !!resolveFromAncestors(stepNode, read.path);
}

/**
 * Find a reference target the way an asset-relative path can mean it: as
 * written below the step node or one of its ancestors (the asset root is one
 * of them), or with that ancestor's own name as the first segment. Only a
 * warning check — the runtime resolves through the engine's resolver.
 */
function resolveFromAncestors(stepNode: Object3D, path: string): Object3D | null {
  const segs = path.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return null;
  for (let a: Object3D | null = stepNode; a; a = a.parent) {
    const hit = walkPath(a, segs, 0);
    if (hit) return hit;
    if (nameMatches(a.name, segs[0])) {
      if (segs.length === 1) return a;
      const stripped = walkPath(a, segs, 1);
      if (stripped) return stripped;
    }
  }
  return null;
}

function nameMatches(nodeName: string, segment: string): boolean {
  return nodeName === segment || nodeName === sanitizeLikeThree(segment);
}

function walkPath(from: Object3D, segs: string[], start: number): Object3D | null {
  let cur: Object3D = from;
  for (let i = start; i < segs.length; i++) {
    const next: Object3D | undefined = cur.children.find((c) => nameMatches(c.name, segs[i]));
    if (!next) return null;
    cur = next;
  }
  return cur;
}

/**
 * Convenience: parse a single procedure from mock GLB extras.
 * Used primarily by tests and the maintenance plugin.
 */
export function parseMaintenanceProcedure(
  name: string,
  stepExtras: { name: string; rv: Record<string, unknown> }[],
): MaintenanceProcedure {
  const steps: MaintenanceStep[] = [];

  for (const entry of stepExtras) {
    const rv = entry.rv;

    if (rv['LogicStep_MaintenanceStep']) {
      const data = rv['LogicStep_MaintenanceStep'] as Record<string, unknown>;
      steps.push(parseMaintenanceStepComponent(data, entry.name, steps.length));
    }
  }

  // Re-index
  for (let i = 0; i < steps.length; i++) {
    steps[i].index = i;
  }

  const totalEstimated = steps.reduce((sum, s) => sum + s.estimatedMinutes, 0);

  return { name, estimatedMinutes: totalEstimated, steps, warnings: [] };
}
