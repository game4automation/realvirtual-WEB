// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Pure utilities for the Hierarchy Browser.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5) — these functions
 * have no React dependencies and are unit-testable in isolation.
 *
 * Categories:
 * - Tree building / filtering / counting (buildTree, filterTree, countNodes)
 * - Type filter predicate (matchesTypeFilter)
 * - Signal-sort comparator (sortSignalNodes)
 * - Ancestor path computation (computeAncestors)
 * - Badge utilities (splitTypes, isSignalType, isBoolSignal, isLogicStepType,
 *   shortStepType, badgeColor, badgeLabel, formatSignalValue, signalBadgeColor,
 *   formatContainerProgress, getStepInfoForPath)
 */

import type { RVViewer } from '../rv-viewer';
import type { EditableNodeInfo } from './rv-extras-editor';
import type { RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine, StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { extractComponentTypes } from './rv-inspector-helpers';
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
import { tooltipRegistry } from './tooltip/tooltip-registry';
import { parseSnapName } from '../../plugins/snap-point/snap-name-parser';

// ─── Tree data structure ─────────────────────────────────────────────────

export interface TreeNode {
  name: string;
  path: string | null;
  types: string[];
  hasOverrides: boolean;
  children: TreeNode[];
  /** LayoutObjects can hold uninjected Three.js descendants. Set so the row
   *  renders an expand caret even before children are lazily injected. */
  canExpandLazy?: boolean;
  /**
   * This row is the root of the loaded main GLB (plan-715).
   *
   * Set only by {@link buildStructureTree} and only when the caller passed
   * {@link ModelRootInfo} derived from the real `viewer.currentModelRoot`. Drives
   * the row's LOCK rendering (no eye, no drag handle, no inline rename) — the
   * root is selectable and its metadata is editable, but it is structurally
   * frozen (see `rv-model-root.ts`).
   */
  isModelRoot?: boolean;
  /**
   * Label to render INSTEAD of {@link name} (the document name for the root
   * row). The path space keeps using `name`; this is presentation only, exactly
   * like the snap and LayoutObject labels.
   */
  displayLabel?: string;
}

/**
 * The model root as {@link buildStructureTree} needs it: already resolved to
 * path-space keys by the CALLER, which is the only place that holds the real
 * `Object3D` and can compare by identity (plan-715 §2.4.2).
 *
 * `buildStructureTree` synthesizes its nodes from path SEGMENTS and has no
 * Object3D to compare against, so it matches on these derived keys. That is a
 * derived identity check, not a name-based substitute for one — pass keys read
 * off `viewer.currentModelRoot`, never a guessed name.
 */
export interface ModelRootInfo {
  /** The root's own path in the registry (its bare name — see doc-node-paths.md §1). */
  rootPath: string;
  /** Display label for the root row (document name / GLB file name). */
  label?: string;
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

/** Internal tree node augmented with a child lookup map for O(1) insertion. */
interface BuildTreeNode extends TreeNode {
  _childMap?: Map<string, BuildTreeNode>;
}

// ─── Type filter ─────────────────────────────────────────────────────────

export type TypeFilter = 'all' | 'drives' | 'sensors' | 'signals' | 'logic';

export function matchesTypeFilter(types: string[], filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'drives') return types.some(t => t === 'Drive' || t.startsWith('Drive_'));
  if (filter === 'sensors') return types.some(t => t === 'Sensor' || t === 'WebSensor');
  if (filter === 'signals') return types.some(t => t.startsWith('PLCInput') || t.startsWith('PLCOutput'));
  if (filter === 'logic') return types.some(t => t.startsWith('LogicStep_'));
  return true;
}

// ─── Signal sort ─────────────────────────────────────────────────────────

export type SignalSort = 'name' | 'type';

/** Sort signal nodes: 'name' = alphabetical by leaf name, 'type' = group by Out/In then alphabetical. */
export function sortSignalNodes(nodes: EditableNodeInfo[], sort: SignalSort): EditableNodeInfo[] {
  const sorted = [...nodes];
  if (sort === 'name') {
    sorted.sort((a, b) => {
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } else {
    // Group by type: Outputs first, then Inputs
    sorted.sort((a, b) => {
      const aIsOut = a.types.some(t => t.startsWith('PLCOutput'));
      const bIsOut = b.types.some(t => t.startsWith('PLCOutput'));
      if (aIsOut !== bIsOut) return aIsOut ? -1 : 1;
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }
  return sorted;
}

// ─── Tree building ───────────────────────────────────────────────────────

/** Component types whose raw Three.js children are lazily injected into the
 *  tree: placed catalog items and imported CAD roots (STEP part meshes carry
 *  no rv_extras of their own, so only lazy injection makes them browsable). */
const LAZY_EXPAND_TYPES = new Set(['LayoutObject', 'CADLink']);

/**
 * Build the expansion-independent hierarchy structure from editable nodes.
 * LayoutObject/CADLink Three.js descendants are deliberately handled later by
 * `applyLazyInjection`, allowing this result to be cached across expand toggles.
 *
 * `modelRoot` (plan-715) makes the GLB root the visible top row instead of the
 * level that gets folded away. Passing it changes ONE thing: the wrapper-collapse
 * loop no longer consumes the first level when that level IS the model root.
 * Deeper single-child wrappers still collapse exactly as before, and omitting the
 * argument reproduces the pre-715 behaviour bit for bit — which is what keeps
 * every legacy caller (and the structure-cache tests) unchanged.
 */
export function buildStructureTree(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
  modelRoot?: ModelRootInfo | null,
): TreeNode[] {
  const root: BuildTreeNode = { name: '', path: null, types: [], hasOverrides: false, children: [], _childMap: new Map() };

  for (const info of nodes) {
    const segments = info.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      const fullPath = segments.slice(0, i + 1).join('/');
      const childMap = current._childMap ?? (current._childMap = new Map());
      let child = childMap.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: fullPath,
          types: isLast ? info.types : [],
          hasOverrides: false,
          children: [],
          _childMap: new Map(),
        };
        childMap.set(seg, child);
        current.children.push(child);
      }

      if (isLast) {
        child.path = info.path;
        child.types = info.types;
        child.hasOverrides = overlay ? !!overlay.nodes[info.path] : false;
      }

      current = child;
    }
  }

  // Clean up temporary lookup maps to reduce memory
  function stripMaps(node: BuildTreeNode): void {
    delete node._childMap;
    for (const child of node.children) stripMaps(child as BuildTreeNode);
  }
  stripMaps(root);

  // Flatten GLB root wrapper: if top level has a single child with no component types
  // (the synthetic gltf.scene node like "demoglb"), skip it and show its children instead.
  //
  // …UNLESS that single child is the MODEL ROOT (plan-715). It is a real,
  // registered, selectable node — the asset's identity and, since plan-714, the
  // anchor for its metadata — so folding it away hid the one row the user needs
  // to address. The stop applies to level 1 only: a wrapper chain BELOW the root
  // is still noise and still collapses.
  let topNodes = root.children;
  while (topNodes.length === 1 && topNodes[0].types.length === 0 && topNodes[0].children.length > 0) {
    if (modelRoot && topNodes[0].path === modelRoot.rootPath) break;
    topNodes = topNodes[0].children;
  }

  // Tag by lookup rather than by position: in the planner the scene holds the
  // model root AND `_layoutRoot` as siblings, so the root is not necessarily
  // `topNodes[0]` — and the two must stay separate top-level groups, never
  // merged into one row.
  if (modelRoot) {
    const rootRow = topNodes.find((n) => n.path === modelRoot.rootPath);
    if (rootRow) {
      rootRow.isModelRoot = true;
      if (modelRoot.label) rootRow.displayLabel = modelRoot.label;
    }
  }

  return topNodes;
}

/**
 * Apply expanded-state-dependent LayoutObject/CADLink injection to a cached
 * structural tree. Only changed branches are copied; the structure is never
 * mutated and unaffected branch identities remain stable.
 */
export function applyLazyInjection(
  nodes: TreeNode[],
  viewer: RVViewer | undefined,
  expandedPaths: ReadonlySet<string> = new Set<string>(),
  overlay: RVExtrasOverlay | null = null,
): TreeNode[] {
  if (!viewer) return nodes;

  let changed = false;
  const next = nodes.map((node) => {
    const injected = applyLazyInjectionToNode(node, viewer, expandedPaths, overlay);
    if (injected !== node) changed = true;
    return injected;
  });
  return changed ? next : nodes;
}

/** Compatibility facade for existing callers and tests. */
export function buildTree(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
  viewer?: RVViewer,
  expandedPaths?: ReadonlySet<string>,
): TreeNode[] {
  return applyLazyInjection(
    buildStructureTree(nodes, overlay),
    viewer,
    expandedPaths ?? new Set<string>(),
    overlay,
  );
}

function applyLazyInjectionToNode(
  node: TreeNode,
  viewer: RVViewer,
  expandedPaths: ReadonlySet<string>,
  overlay: RVExtrasOverlay | null,
): TreeNode {
  let childrenChanged = false;
  const children = node.children.map((child) => {
    const next = applyLazyInjectionToNode(child, viewer, expandedPaths, overlay);
    if (next !== child) childrenChanged = true;
    return next;
  });

  const nextNode = childrenChanged ? { ...node, children } : node;
  if (!node.path || !node.types.some((type) => LAZY_EXPAND_TYPES.has(type))) return nextNode;

  const object = viewer.registry?.getNode(node.path);
  if (!object) return nextNode;
  if (expandedPaths.has(node.path)) {
    return injectThreeJsChildren(nextNode, object, viewer, expandedPaths, overlay);
  }

  const canExpandLazy = hasInjectableThreeJsChildren(object);
  if (nextNode.canExpandLazy === canExpandLazy) return nextNode;
  return { ...nextNode, canExpandLazy: canExpandLazy || undefined };
}

/**
 * Inject Three.js children of a LayoutObject node as TreeNode children.
 *
 * Recursive injection cascades only into children that are themselves in
 * `expandedPaths` — keeping the cost bounded by the user's actual expansion
 * state, never by total scene size.
 *
 * The function is idempotent across multiple invocations on the same
 * parent: existing children (registered via the normal `editableNodes`
 * scan) are not duplicated, and NodeRegistry registration only fires when
 * a path is not yet known.
 */
function injectThreeJsChildren(
  parent: TreeNode,
  parentObj: import('three').Object3D,
  viewer: RVViewer,
  expandedPaths: ReadonlySet<string>,
  overlay: RVExtrasOverlay | null,
): TreeNode {
  // O(1) dedup via Map (avoids quadratic some() scans for large LayoutObjects)
  const existingChildPaths = new Map<string, TreeNode>();
  for (const c of parent.children) {
    if (c.path) existingChildPaths.set(c.path, c);
  }

  let changed = parent.canExpandLazy === true;
  let children = parent.children;
  const ensureChildrenCopy = (): TreeNode[] => {
    if (children === parent.children) children = [...parent.children];
    return children;
  };

  for (const child of parentObj.children) {
    // Skip highlight/ghost overlays + gizmo sprites (snap markers etc.) — they're
    // not real scene content. The snap-marker sprite is parented to the snap Empty
    // (attachToNode) and carries `_rvGizmo`; without this skip it surfaces as a raw
    // UUID node under each snap in the hierarchy.
    const childUd = (child.userData ?? {}) as Record<string, unknown>;
    if (childUd._highlightOverlay || childUd._isGhostOverlay || childUd._rvGizmo) continue;

    // Pfad-Sanitization: '/' im Namen ersetzen (Door/Frame -> Door_Frame)
    const safeName = ((child.name || child.uuid) as string).replace(/\//g, '_');
    if (!safeName) continue;
    const childPath = `${parent.path}/${safeName}`;
    if (existingChildPaths.has(childPath)) {
      // Recurse into existing child if expanded
      const existing = existingChildPaths.get(childPath)!;
      let nextExisting = existing;
      if (expandedPaths.has(childPath)) {
        nextExisting = injectThreeJsChildren(existing, child, viewer, expandedPaths, overlay);
      } else {
        const canExpandLazy = hasInjectableThreeJsChildren(child);
        if (existing.canExpandLazy !== canExpandLazy) {
          nextExisting = { ...existing, canExpandLazy: canExpandLazy || undefined };
        }
      }
      if (nextExisting !== existing) {
        const index = parent.children.indexOf(existing);
        ensureChildrenCopy()[index] = nextExisting;
        existingChildPaths.set(childPath, nextExisting);
        changed = true;
      }
      continue;
    }

    const types = extractComponentTypes(childUd.realvirtual);

    // Snap Empties get a readable label ("Snap in (Z) · convroll"); the path
    // stays the real scene path so selection/registry lookups are unaffected.
    const displayName = snapLabel(safeName) ?? safeName;

    const childNode: TreeNode = {
      path: childPath,
      name: displayName,
      types,
      children: [],
      hasOverrides: overlay ? !!overlay.nodes[childPath] : false,
    };
    ensureChildrenCopy().push(childNode);
    existingChildPaths.set(childPath, childNode);
    changed = true;

    // Idempotent NodeRegistry registration so subsequent lookups by path
    // succeed without polluting the suffix map.
    if (viewer.registry && !viewer.registry.getNode(childPath)) {
      viewer.registry.registerNode(childPath, child);
    }

    // Cascade lazily — only descend when the user has expanded this child
    if (expandedPaths.has(childPath)) {
      const injected = injectThreeJsChildren(childNode, child, viewer, expandedPaths, overlay);
      if (injected !== childNode) {
        children[children.length - 1] = injected;
        existingChildPaths.set(childPath, injected);
      }
    } else if (hasInjectableThreeJsChildren(child)) {
      // Not yet expanded but real Three.js descendants exist (e.g. Drive-Rot-Y
      // has Transport-Z, Snap-*, …) — show the expand caret so the user can
      // open them. Without this, deeply-nested kinematics from authored GLBs
      // are invisible until they happen to be expanded by some other code path.
      childNode.canExpandLazy = true;
    }
  }

  if (!changed) return parent;
  return { ...parent, children, canExpandLazy: undefined };
}

/** True when `obj` has any child that would inject into the tree (non-overlay). */
function hasInjectableThreeJsChildren(obj: import('three').Object3D): boolean {
  for (const c of obj.children) {
    const ud = (c.userData ?? {}) as Record<string, unknown>;
    if (ud._highlightOverlay || ud._isGhostOverlay || ud._rvGizmo) continue;
    if (!(c.name || c.uuid)) continue;
    return true;
  }
  return false;
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

      const hasChildren = node.children.length > 0 || node.canExpandLazy === true;
      if (hasChildren && expanded.has(node.path ?? node.name)) {
        walkSiblings(node.children, depth + 1, rowKey);
      }
    }
  };

  walkSiblings(nodes, 0, 'root');
  return rows;
}

/**
 * Paths of the rows CURRENTLY RENDERED by the tree view, in render order —
 * children are entered only when their parent row is expanded, the exact
 * mirror of TreeNodeRow's render condition. Used for Shift+click range
 * selection (a range over rows the user can actually see).
 */
export function visibleTreePaths(nodes: TreeNode[], expanded: ReadonlySet<string>): string[] {
  return flattenVisibleTree(nodes, expanded)
    .filter((row): row is VisibleTreeRow & { node: TreeNode & { path: string } } => !!row.node.path)
    .map((row) => row.node.path);
}

export function filterTree(nodes: TreeNode[], term: string, viewer?: RVViewer): TreeNode[] {
  if (!term) return nodes;
  const lower = term.toLowerCase();

  function filterRecursive(node: TreeNode): TreeNode | null {
    const nameMatches = node.name.toLowerCase().includes(lower);
    const pathMatches = node.path ? node.path.toLowerCase().includes(lower) : false;

    // Check component search resolvers (AAS description, Metadata content, etc.)
    let componentMatches = false;
    if (!nameMatches && !pathMatches && node.path && viewer?.registry) {
      const obj3d = viewer.registry.getNode(node.path);
      if (obj3d) {
        const searchTexts = tooltipRegistry.getSearchableText(obj3d);
        componentMatches = searchTexts.some(t => t.toLowerCase().includes(lower));
      }
    }

    const filteredChildren: TreeNode[] = [];
    for (const child of node.children) {
      const result = filterRecursive(child);
      if (result) filteredChildren.push(result);
    }

    if (nameMatches || pathMatches || componentMatches || filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    return null;
  }

  const result: TreeNode[] = [];
  for (const node of nodes) {
    const filtered = filterRecursive(node);
    if (filtered) result.push(filtered);
  }
  return result;
}

export function countNodes(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
): { total: number; withOverrides: number } {
  let withOverrides = 0;
  if (overlay) {
    for (const info of nodes) {
      if (overlay.nodes[info.path]) withOverrides++;
    }
  }
  return { total: nodes.length, withOverrides };
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

/** Split types into [nonSignals, signals] so signals render last (right-most). */
export function splitTypes(types: string[]): [string[], string[]] {
  const nonSignals: string[] = [];
  const signals: string[] = [];
  for (const t of types) {
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
  if (type.startsWith('Drive_')) return type.replace('Drive_', 'D:');
  // Components can declare a custom display name via registerComponent({ displayName })
  return getDisplayName(type);
}
