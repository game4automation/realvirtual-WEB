// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure utilities for the Hierarchy Browser.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5) — these functions
 * have no React dependencies and are unit-testable in isolation.
 *
 * Since plan-754 the scene hierarchy no longer BUILDS a tree here: rows are
 * `Object3D`s and come from `hierarchy-rows.ts`. What stays is the generic row
 * vocabulary (`TreeNode`, `flattenVisibleTree`, `computeAncestors`), which the
 * project tree borrows for files, plus the badge/signal/logic-step formatting
 * the rows render.
 *
 * Categories:
 * - Generic row shape + flattening (TreeNode, flattenVisibleTree, flattenTree)
 * - Category filter id (HierarchyFilterId, parseFilterId, matchesFilter,
 *   migrateLegacyFilter) — plan-597
 * - Signal-sort comparator (sortSignalNodes)
 * - Ancestor path computation (computeAncestors)
 * - Badge utilities (splitTypes, isSignalType, isBoolSignal, isLogicStepType,
 *   shortStepType, badgeColor, badgeLabel, formatSignalValue, signalBadgeColor,
 *   formatContainerProgress, getStepInfoForPath)
 */

import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine, StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { baseComponentType } from './rv-inspector-helpers';
import { categoryOf, isCategoryId } from '../engine/rv-component-category';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';
import { componentColor } from './rv-inspector-helpers';
import {
  SIGNAL_VALUE_NEUTRAL,
  signalDirectionFromType,
  signalValueColor,
  signalValueColorForValue,
} from './signal-colors';
import { readSignalValue, formatValue } from './rv-value-resolver';
import { getDisplayName } from '../engine/rv-component-registry';
import { parseSnapName } from '../../plugins/snap-point/snap-name-parser';

// ─── Tree data structure ─────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string | null;
  types: string[];
  hasOverrides: boolean;
  children: TreeNode[];
  /**
   * Whether the row renders an expand caret, when that cannot be read off
   * {@link children}. The scene hierarchy builds children only for the expanded
   * part of the graph (plan-754), so a collapsed row has an empty array and
   * still has children; a file tree leaves this undefined and the array decides.
   */
  hasChildren?: boolean;
  /**
   * Key for the expanded set, when it is not the path. The scene hierarchy keys
   * on `Object3D.uuid` — paths change on rename/reparent and do not exist for
   * unregistered nodes, so they cannot carry expansion state (plan-754 §2.7).
   */
  expandKey?: string;
  /**
   * This row is the root of the loaded main GLB (plan-715).
   *
   * Drives the row's LOCK rendering (no eye, no drag handle, no inline rename) —
   * the root is selectable and its metadata is editable, but it is structurally
   * frozen (see `rv-model-root.ts`).
   */
  isModelRoot?: boolean;
  /**
   * This row is a placed layout object whose `LayoutObject.Locked` is set.
   *
   * Drives the row's lock glyph (a click unlocks) and removes the drag source.
   * Set on the placement root only — the lock blocks edits below it, but it is
   * one fact on one object and is shown once. The eye stays: hiding a locked
   * machine to look behind it is viewing, not editing.
   */
  locked?: boolean;
  /**
   * Label to render INSTEAD of {@link name} (the document name for the root
   * row). The path space keeps using `name`; this is presentation only, exactly
   * like the snap and chunk labels.
   */
  displayLabel?: string;
  /**
   * Marks a display-only row with no scene object behind it. The only kind is
   * `'baked-fold'` — the scene hierarchy's "Geometry · N chunks" row that folds
   * a boundary's chunk meshes (plan-505, `ChunkFoldRow` in `hierarchy-rows.ts`).
   * Not selectable, no path, no context menu.
   */
  synthetic?: 'baked-fold';
}

export interface VisibleTreeRow {
  node: TreeNode;
  depth: number;
  /** Stable virtualizer key, including for duplicate path-less group rows. */
  rowKey: string;
  /** One-based position within this row's sibling group. */
  posInSet: number;
  /** Number of rows in this row's sibling group. */
  setSize: number;
}

// ─── Category filter (plan-597) ─────────────────────────────────────────

/**
 * The hierarchy filter: everything, one coarse category, or one fine label
 * inside a category. Category ids come from `CATEGORY_ORDER`
 * (rv-component-category.ts), labels from `ui.filter` (or the built-in rule).
 * The label may contain spaces and `/`; it is everything after the FIRST `/`.
 */
export type HierarchyFilterId = 'all' | `cat:${string}` | `cat:${string}/${string}`;

/** Category + optional label of a filter id. `all` → both null. */
export function parseFilterId(id: string): { category: string | null; label: string | null } {
  if (!id.startsWith('cat:')) return { category: null, label: null };
  const rest = id.slice(4);
  const slash = rest.indexOf('/');
  if (slash === -1) return { category: rest || null, label: null };
  const label = rest.slice(slash + 1);
  return { category: rest.slice(0, slash) || null, label: label || null };
}

/** Build a filter id from a category and an optional label. */
export function filterIdOf(category: string, label?: string | null): HierarchyFilterId {
  return label ? `cat:${category}/${label}` : `cat:${category}`;
}

/** Does a node with these component types match the filter? A node matches when
 *  AT LEAST ONE of its types is in the category (and, if set, carries the label). */
export function matchesFilter(types: readonly string[], id: HierarchyFilterId): boolean {
  if (id === 'all') return true;
  const { category, label } = parseFilterId(id);
  if (category === null) return true;
  for (const t of types) {
    const c = categoryOf(t);
    if (c.category === category && (label === null || c.label === label)) return true;
  }
  return false;
}

const LEGACY_FILTERS: Readonly<Record<string, HierarchyFilterId>> = {
  drives: 'cat:drives',
  sensors: 'cat:sensors',
  signals: 'cat:signals',
  logic: 'cat:logic',
};

/**
 * Read a persisted filter value. The pre-plan-597 values
 * (`drives`/`sensors`/`signals`/`logic`) migrate to their category; anything
 * that is not `all` or a `cat:` id with a KNOWN category becomes `all`. Whether
 * the category has hits in the loaded model is a separate, later question.
 */
export function migrateLegacyFilter(raw: string | null | undefined): HierarchyFilterId {
  if (!raw || raw === 'all') return 'all';
  const legacy = LEGACY_FILTERS[raw];
  if (legacy) return legacy;
  const { category, label } = parseFilterId(raw);
  if (category === null || !isCategoryId(category)) return 'all';
  return filterIdOf(category, label);
}

/** The signal sort bar + sorted flat list apply to the whole Signals category
 *  AND to any one signal label inside it (`cat:signals/PLCOutputBool`). */
export function isSignalsFilter(id: HierarchyFilterId): boolean {
  return parseFilterId(id).category === 'signals';
}

/** The logic-step indentation applies to `cat:logic` and every `cat:logic/<label>`. */
export function isLogicFilter(id: HierarchyFilterId): boolean {
  return parseFilterId(id).category === 'logic';
}

// ─── Signal sort ─────────────────────────────────────────────────────────

export type SignalSort = 'name' | 'type';

/** The minimum a row must expose to be sortable as a signal. Structural, not
 *  nominal, so it fits both the scene rows and any path-shaped list. */
export interface SortableSignalNode {
  path: string | null;
  types: string[];
  name?: string;
}

/** Leaf name of a sortable node — the last path segment, else its own name. */
function signalSortKey(node: SortableSignalNode): string {
  const fromPath = node.path ? node.path.split('/').pop() ?? node.path : null;
  return (fromPath ?? node.name ?? '').toLowerCase();
}

/** Sort signal nodes: 'name' = alphabetical by leaf name, 'type' = group by Out/In then alphabetical. */
export function sortSignalNodes<T extends SortableSignalNode>(nodes: readonly T[], sort: SignalSort): T[] {
  const sorted = [...nodes];
  if (sort === 'name') {
    sorted.sort((a, b) => signalSortKey(a).localeCompare(signalSortKey(b)));
  } else {
    // Group by type: Outputs first, then Inputs
    sorted.sort((a, b) => {
      const aIsOut = a.types.some(t => t.startsWith('PLCOutput'));
      const bIsOut = b.types.some(t => t.startsWith('PLCOutput'));
      if (aIsOut !== bIsOut) return aIsOut ? -1 : 1;
      return signalSortKey(a).localeCompare(signalSortKey(b));
    });
  }
  return sorted;
}

/**
 * Flatten every TreeNode in depth-first, parent-first order, ignoring expansion.
 * This remains useful for full-tree test assertions; render virtualization uses
 * `flattenVisibleTree` so collapsed descendants are omitted.
 *
 * Returns each node with its `depth` (0 = root) so the consumer can render indentation
 * without reconstructing the hierarchy.
 */
export function flattenTree(nodes: TreeNode[]): Array<{ node: TreeNode; depth: number }> {
  const flat: Array<{ node: TreeNode; depth: number }> = [];
  function walk(node: TreeNode, depth: number): void {
    flat.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  }
  for (const node of nodes) walk(node, 0);
  return flat;
}

/**
 * Flatten only rows visible under the current expansion state. Unlike
 * `flattenTree`, collapsed descendants are omitted. ARIA sibling metadata is
 * computed per branch, and path-less duplicate groups receive unique keys.
 */
export function flattenVisibleTree(
  nodes: TreeNode[],
  expanded: ReadonlySet<string>,
): VisibleTreeRow[] {
  const rows: VisibleTreeRow[] = [];

  const walkSiblings = (siblings: TreeNode[], depth: number, parentKey: string): void => {
    const setSize = siblings.length;
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index];
      const rowKey = node.path ?? `group:${parentKey}/${node.name}#${index}`;
      rows.push({ node, depth, rowKey, posInSet: index + 1, setSize });

      const hasChildren = node.hasChildren ?? node.children.length > 0;
      if (hasChildren && expanded.has(node.expandKey ?? node.path ?? node.name)) {
        walkSiblings(node.children, depth + 1, rowKey);
      }
    }
  };

  walkSiblings(nodes, 0, 'root');
  return rows;
}

// ─── Ancestor path computation ───────────────────────────────────────────

/**
 * Compute all ancestor path segments for a given path.
 * E.g. "A/B/C/D" -> ["A", "A/B", "A/B/C"]
 */
export function computeAncestors(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }
  return ancestors;
}

// ─── Snap label ──────────────────────────────────────────────────────────

/**
 * Readable hierarchy label for a snap-point Empty (`Snap-<AXIS><FLOW>-<typeId>`).
 * `Snap-ZN-convroll` → `Snap in (Z) · convroll` (N→in, P→out, B→bidi). Returns
 * `null` for any node name that is not a snap, so the caller keeps the raw name.
 */
export function snapLabel(name: string): string | null {
  const parsed = parseSnapName(name);
  if (!parsed) return null;
  return `Snap ${parsed.flow} (${parsed.dir.axis}) · ${parsed.typeId}`;
}

// ─── Signal helpers ──────────────────────────────────────────────────────

/**
 * Owner-qualified label for a scoped signal node in the flat ("Signals") list.
 * The node path is `${owner}/Signals/${leaf}` (technical, `/`-separated); the
 * displayed SYMBOL is the dot form `${owner}.${leaf}` (matches the PLC byName).
 * For a path without a `/Signals/` segment, falls back to the bare leaf.
 */
export function signalOwnerLabel(path: string): string {
  const marker = '/Signals/';
  const idx = path.indexOf(marker);
  if (idx === -1) return path.split('/').pop() ?? path;
  const owner = path.slice(0, idx).split('/').pop() ?? '';
  const leaf = path.slice(idx + marker.length);
  return owner ? `${owner}.${leaf}` : leaf;
}

export function isSignalType(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

export function isBoolSignal(type: string): boolean {
  return type.includes('Bool');
}

/**
 * Ambient metadata types that are dropped from the hierarchy badge row.
 * They end up on nearly every node of an authored asset (agent knowledge,
 * mechanism mass bodies), so as badges they carry no scanning information —
 * they only crowd out the node name. The inspector still shows them in full.
 * Matched via {@link baseComponentType}, so numbered duplicates count too.
 */
const AMBIENT_BADGE_TYPES = new Set(['NodeKnowledge', 'MechanismBody']);

/** Split types into [nonSignals, signals] so signals render last (right-most).
 *  Badge-row specific: ambient metadata types are dropped entirely. */
export function splitTypes(types: string[]): [string[], string[]] {
  const nonSignals: string[] = [];
  const signals: string[] = [];
  for (const t of types) {
    if (AMBIENT_BADGE_TYPES.has(baseComponentType(t))) continue;
    if (isSignalType(t)) signals.push(t);
    else nonSignals.push(t);
  }
  return [nonSignals, signals];
}

/** Format a signal value for badge display. Single-sourced through the value
 *  resolver so hierarchy badges, inspector and tooltips never diverge. */
export function formatSignalValue(type: string, signalStore: SignalStore | null, path: string | null): string {
  if (!path) return '—';
  return formatValue(readSignalValue(signalStore, path), {
    boolStyle: 'glyph',
    intLike: type.includes('Int'),
  });
}

/**
 * Colour of a hierarchy signal badge, driven by the live VALUE (plan-341 §2.3):
 * hue = direction, intensity = state, neutral when there is no reading at all.
 *
 * This is a signal-value surface, not a type badge — it reads the store and
 * distinguishes TRUE from FALSE. Non-signal types keep {@link componentColor}.
 */
export function signalBadgeColor(type: string, signalStore: SignalStore | null, path: string | null): string {
  const dir = signalDirectionFromType(type);
  if (dir === 'unknown') return componentColor(type);
  if (!signalStore || !path) return SIGNAL_VALUE_NEUTRAL;
  const value = signalStore.getByPath(path);
  if (value === undefined) return SIGNAL_VALUE_NEUTRAL;
  // Bool signals report truthiness; numeric signals treat 0 as the weak step.
  if (isBoolSignal(type)) return signalValueColor(dir, value === true);
  return signalValueColorForValue(dir, value);
}

// ─── LogicStep helpers ───────────────────────────────────────────────────

export function isLogicStepType(type: string): boolean {
  return type.startsWith('LogicStep_');
}

/** Get badge color for a component type — dynamic for LogicStep types (Active/Waiting only). */
export function badgeColor(type: string, stepState?: StepState): string {
  if (isLogicStepType(type) && (stepState === StepState.Active || stepState === StepState.Waiting)) {
    return STEP_STATE_COLORS[stepState];
  }
  return componentColor(type);
}

/** Get step info from the logic engine for a given hierarchy path. */
export function getStepInfoForPath(engine: RVLogicEngine | null, path: string | null): StepStateInfo | null {
  if (!engine || !path) return null;
  return engine.getStepInfo(path);
}

/** Format container progress text. */
export function formatContainerProgress(info: StepStateInfo): string | null {
  if (info.type === 'Delay' && info.state === StepState.Active && info.elapsed !== undefined && info.duration !== undefined) {
    return `${info.elapsed.toFixed(1)}s/${info.duration.toFixed(1)}s`;
  }
  return null;
}

// ─── Badge label ─────────────────────────────────────────────────────────

/** Shorten verbose LogicStep type names to fit in compact badges. */
export function shortStepType(type: string): string {
  const raw = type.replace('LogicStep_', '');
  switch (raw) {
    case 'SerialContainer':   return 'Serial';
    case 'ParallelContainer': return 'Parallel';
    case 'SetSignalBool':     return 'SetBool';
    case 'WaitForSignalBool': return 'WaitBool';
    case 'WaitForSensor':     return 'WaitSens';
    case 'DriveToPosition':
    case 'DriveTo':           return 'DriveTo';
    case 'SetDriveSpeed':     return 'SetSpd';
    case 'Enable':            return 'Enable';
    case 'Delay':             return 'Delay';
    case 'Pause':             return 'Pause';
    default:                  return raw;
  }
}

export function badgeLabel(type: string, stepState?: StepState): string {
  if (isLogicStepType(type)) {
    const shortType = shortStepType(type);
    // Only show state label for Active/Waiting — Idle and Finished are not shown
    if (stepState === StepState.Active || stepState === StepState.Waiting) {
      return `${shortType} ${STEP_STATE_LABELS[stepState]}`;
    }
    return shortType;
  }
  if (type === 'RuntimeMetadata') return 'Metadata';
  if (type === 'ConnectSignal') return 'Conn';
  if (type === 'TransportSurface') return 'TS';
  if (type === 'DrivesRecorder') return 'Rec';
  if (type === 'ReplayRecording') return 'Replay';
  if (type === 'PLCOutputBool') return 'OutBool';
  if (type === 'PLCOutputFloat') return 'OutFloat';
  if (type === 'PLCOutputInt') return 'OutInt';
  if (type === 'PLCInputBool') return 'InBool';
  if (type === 'PLCInputFloat') return 'InFloat';
  if (type === 'PLCInputInt') return 'InInt';
  if (type.startsWith('PLCOutput')) return 'Out:' + type.replace('PLCOutput', '');
  if (type.startsWith('PLCInput')) return 'In:' + type.replace('PLCInput', '');
  // Mechanism root keeps a badge; the "(Rigid-Body)" displayName suffix is
  // inspector detail, not badge material.
  if (type === 'KinematicMechanism') return 'Mechanism';
  // Long drive behaviors get explicit short forms; the generic D: prefix rule
  // below covers the already-short remainder (D:Speed, D:Gear, D:CAM, …).
  if (type === 'Drive_ErraticPosition') return 'D:Erratic';
  if (type === 'Drive_DestinationMotor') return 'D:DestMotor';
  if (type === 'Drive_FollowPosition') return 'D:Follow';
  if (type === 'Drive_ContinousDestination') return 'D:ContDest';
  if (type === 'Drive_ProfidriveSpeed') return 'D:PdSpeed';
  if (type === 'Drive_ProfidrivePos') return 'D:PdPos';
  if (type === 'Drive_ProportionalValve') return 'D:PropValve';
  if (type === 'Drive_UniDriveMotor') return 'D:UniDrive';
  if (type === 'DrivePulseEncoder') return 'D:Encoder';
  if (type.startsWith('Drive_')) return type.replace('Drive_', 'D:');
  // Components can declare a custom display name via registerComponent({ displayName })
  return getDisplayName(type);
}
