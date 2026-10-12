// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-bake-survival.ts — which nodes survive a destructive bake (plan-754 D4/D7).
 *
 * PURE and READ-ONLY: nothing here mutates a tree, a registry or a geometry.
 * Phase 0 of plan-754 uses it for the removal REPORT only — the bake still
 * removes nothing.
 *
 * A node survives when
 *   (1)  it carries an rv component (or an authored `rv.BakeRole`),
 *   (1b) a component reference points at it (resolved FORWARD: component →
 *        reference fields → target), or a model plugin claims it (D17),
 *   (1c) its name matches the snap pattern (`SNAP_NAME`, rv-bake-pipeline.ts),
 *   (2)  it is an ancestor of a survivor — survivor paths never change,
 *   (3)  it is a keep mesh (what the bake leaves individual).
 * Everything else would be removed; its triangles live on in the nearest
 * boundary's chunk.
 *
 * Effective bake role = strongest of the node's own role and its incoming
 * tags: `keep > chunk > merge > unclaimed`. A reference can only claim `merge`
 * (the node survives) or `chunk` (the node is a boundary) — never `keep`.
 *
 * Layering: imports the engine-layer snap predicate; never imports hmi/ or
 * plugins/ (no fourth snap parser, no upward import — plan-754 §2.1).
 */

import type { Mesh, Object3D } from 'three';
import type { BakeRole } from './rv-bake-chunk';
import {
  bakeTargetOf,
  claimsNodeOf,
  forEachComponentRef,
  getFieldDescriptor,
  type ReferenceBakeTarget,
} from './rv-component-registry';
import {
  classifyRoles,
  isPlacementMarker,
  makeBehaviouralTest,
  makeOwnRoleResolver,
  SNAP_NAME,
  type BakeOptions,
  type RoleClassification,
} from './rv-bake-pipeline';
import { findByNameInSubtree } from './rv-traverse-utils';
import { resolveReferencePath, scopeOf, type ReferenceScope } from './rv-reference-resolver';
import { NodeRegistry } from './rv-node-registry';

// ─── Reference semantics table ───────────────────────────────────────

/** How the survival walker finds the TARGET of one declared field. */
export type ReferenceKind = 'ref' | 'refArray' | 'pathString' | 'nameInSubtree';

export interface ReferenceBakeTargetEntry {
  /** rv extras key of the component (`userData.realvirtual[component]`). */
  component: string;
  /** Field name. A dotted name walks into records / arrays of records
   *  (`connections.source` = every `connections[i].source`). */
  field: string;
  kind: ReferenceKind;
  bakeTarget: ReferenceBakeTarget;
}

/**
 * TS-side declaration of reference semantics the generated schema cannot carry
 * (plan-754 D15: no rv-odt.json / Unity change). ONE table: the chunk-tagged
 * fields and the path-string fields. Every `componentRef` / `componentRefArray`
 * field NOT listed here defaults to `bakeTargetOf(descriptor)` = `'merge'`.
 *
 * The table only tells the walker how to FIND the target — the components keep
 * their own resolvers (Kinematic Phase 8b, group build, `RVSource`, the
 * connection registry).
 */
export const REFERENCE_BAKE_TARGETS: ReadonlyArray<ReferenceBakeTargetEntry> = Object.freeze([
  // chunk — the referrer moves, hides, scales, scrolls or clones the target as a unit.
  { component: 'KinematicJoint', field: 'BodyA', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'KinematicJoint', field: 'BodyB', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'WebVisibility', field: 'AdditionalTargets', kind: 'refArray', bakeTarget: 'chunk' },
  { component: 'Chain', field: 'ChainElement', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'Source', field: 'ThisObjectAsMU', kind: 'nameInSubtree', bakeTarget: 'chunk' },
  { component: 'RibbonWinder', field: 'RollMesh', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'RibbonRoller', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'RibbonWinder', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
  { component: 'RibbonDancer', field: 'MantleMesh', kind: 'ref', bakeTarget: 'chunk' },
  // An instruction step outlines its targets and (`Isolate`) hides everything
  // else — both need real geometry, and the targets are typically BARE CAD
  // solids nothing else claims (Mauser: 14 of 28 were removed by the bake).
  // The steps are read raw, so the schema never sees these as references.
  { component: 'CustomRuntimeInstruction', field: 'steps.targetObjects', kind: 'pathString', bakeTarget: 'chunk' },
  { component: 'CustomRuntimeInstruction', field: 'steps.targetObject', kind: 'pathString', bakeTarget: 'chunk' },
  // merge — the target only has to exist as a node.
  { component: 'EnergyChain', field: 'Anchor', kind: 'ref', bakeTarget: 'merge' },
  { component: 'EnergyChain', field: 'Follower', kind: 'ref', bakeTarget: 'merge' },
  { component: 'KinematicTarget', field: 'TargetLink', kind: 'ref', bakeTarget: 'merge' },
  { component: 'Kinematic', field: 'Parent', kind: 'pathString', bakeTarget: 'merge' },
  { component: 'Kinematic', field: 'GroupNamePrefix', kind: 'pathString', bakeTarget: 'merge' },
  { component: 'Group', field: 'GroupNamePrefix', kind: 'pathString', bakeTarget: 'merge' },
  // A physics zone lists its static walls by RAW path (rawFields, not a schema
  // ref). Such a wall is typically an EMPTY node carrying only BoxCollider
  // extras — nothing else claims it, and without this entry the bake drops it,
  // so the zone warns "not found in the scene" and parts fall straight through
  // (Festo hopper, 2026-09-24). `merge`: the node with its extras must exist.
  { component: 'WebPhysicsZone', field: 'StaticColliders', kind: 'pathString', bakeTarget: 'merge' },
  // `RvConnection` edges live in the rv-ODT `Connections` block of one node.
  { component: 'Connections', field: 'connections.source', kind: 'pathString', bakeTarget: 'merge' },
  { component: 'Connections', field: 'connections.target', kind: 'pathString', bakeTarget: 'merge' },
] as ReferenceBakeTargetEntry[]);

const _tableByComponent = new Map<string, ReferenceBakeTargetEntry[]>();
for (const e of REFERENCE_BAKE_TARGETS) {
  let list = _tableByComponent.get(e.component);
  if (!list) _tableByComponent.set(e.component, (list = []));
  list.push(e);
}

/**
 * Table entries of an extras KEY. Keys follow the `_N` dedup convention
 * (`Group`, `Group_1`, …): a second block of a type declares the same
 * references, so a key without entries of its own falls back to its base type
 * (`/_\d+$/` stripped — the rule `claimsNodeOf` and the pre-bake dispatcher
 * use; plan-755). Exact key first. Without it `Group_1.GroupNamePrefix` tagged
 * nothing and its prefix node could be pruned under a name that needs it.
 */
function tableEntriesOf(component: string): ReferenceBakeTargetEntry[] | undefined {
  const exact = _tableByComponent.get(component);
  if (exact) return exact;
  const base = component.replace(/_\d+$/, '');
  return base === component ? undefined : _tableByComponent.get(base);
}

/**
 * The tag one reference field puts on its target: the table entry when the
 * field is declared, otherwise the schema descriptor's `bakeTarget`, otherwise
 * `'merge'`.
 */
export function referenceBakeTargetOf(component: string, field: string): ReferenceBakeTarget {
  const entries = tableEntriesOf(component);
  if (entries) for (const e of entries) if (e.field === field) return e.bakeTarget;
  return bakeTargetOf(getFieldDescriptor(component, field));
}

// ─── Target finders ──────────────────────────────────────────────────

/** The one lookup the walker needs from a registry (`NodeRegistry` satisfies it). */
export interface SurvivalPathResolver {
  getNode(path: string): Object3D | null;
}

/** A path-string field holds a plain string or (older exports) a `{ path }` record. */
export function pathOfPathString(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (value && typeof value === 'object') {
    const p = (value as { path?: unknown }).path;
    if (typeof p === 'string' && p.length > 0) return p;
  }
  return null;
}

/** Target of a `pathString` field — the same `registry.getNode(path)` the component uses. */
export function findPathStringTarget(value: unknown, resolver: SurvivalPathResolver): Object3D | null {
  const path = pathOfPathString(value);
  return path ? resolver.getNode(path) : null;
}

/**
 * Target of a `nameInSubtree` field (`Source.ThisObjectAsMU`): the component's
 * own lookup order — by name inside the scope first ({@link findByNameInSubtree},
 * shared with `RVSource`), then the registry. An empty value or a value naming
 * the owner itself is a self-reference and yields the owner.
 */
export function findNameInSubtreeTarget(
  value: unknown,
  owner: Object3D,
  scope: Object3D,
  resolver: SurvivalPathResolver,
): Object3D | null {
  if (typeof value !== 'string' || value.length === 0) return owner;
  return findByNameInSubtree(scope, value) ?? resolver.getNode(value);
}

/** Values of a (possibly dotted) field: `a.b` walks records and arrays of records. */
function valuesAt(record: Record<string, unknown>, field: string): unknown[] {
  let current: unknown[] = [record];
  for (const seg of field.split('.')) {
    const next: unknown[] = [];
    for (const c of current) {
      if (!c || typeof c !== 'object') continue;
      const v = (c as Record<string, unknown>)[seg];
      if (Array.isArray(v)) for (const item of v) next.push(item);
      else if (v !== undefined && v !== null) next.push(v);
    }
    current = next;
  }
  return current;
}

// ─── Model ───────────────────────────────────────────────────────────

export type SurvivalReason =
  | 'root' | 'component' | 'plugin-claim' | 'referenced' | 'snap' | 'keep-mesh' | 'ancestor';

/**
 * One reference field whose target did not resolve. The count alone said only
 * "something is missing"; the component and the field say WHO is missing it,
 * which is the only form the author of the export can act on.
 */
export interface UnresolvedReference {
  /** rv extras key of the referring component. */
  component: string;
  field: string;
  kind: ReferenceKind;
  /** Path of the node that carries the referring component. */
  owner: string;
  /** The value that failed to resolve. */
  path: string;
}

/** D17: a node a model plugin needs at runtime, claimed before the bake. */
export interface BakeClaim {
  path: string;
  role: ReferenceBakeTarget;
}

export interface SurvivalCounts {
  /** Nodes under (and including) the root. */
  nodes: number;
  survivors: number;
  removed: number;
  /** Removed nodes that are drawables (their triangles live on in a chunk). */
  removedMeshes: number;
  /** Surviving nodes whose own mesh is merged into a chunk ("keep the node, delete the mesh"). */
  mergedSurvivorMeshes: number;
  /** Distinct source geometries only staged meshes reference — released after a destructive bake. */
  releasableGeometries: number;
  /** Triangles staged through `InstancedMesh` expansion (instances × triangles). */
  instancedTriangles: number;
  /** Targets that become a chunk boundary ONLY through an incoming `chunk` tag or
   *  claim (own role neither `chunk` nor `keep`) — what the tags change in the bake. */
  tagOnlyChunkBoundaries: number;
  /** Reference fields whose target did not resolve to a node. */
  unresolvedReferences: number;
  /** `unresolvedReferences` tallied by `Component.field` — which components they come from. */
  unresolvedByField: Readonly<Record<string, number>>;
  /** Plugin claims whose path did not resolve. */
  unresolvedClaims: number;
}

export interface SurvivalModel {
  /** Strongest of own component roles and incoming reference tags; undefined = unclaimed. */
  roleOf(node: Object3D): BakeRole | undefined;
  survives(node: Object3D): boolean;
  reasonOf(node: Object3D): SurvivalReason | null;
  /** Tops of the subtrees that would be removed (a removed top removes its whole subtree). */
  removalTops: Object3D[];
  /**
   * THE role pass of this bake (plan-582 §2.4): roles, mover cut, keep vs
   * chunk, partitions and the `InstancedMesh` triangle count, computed BEFORE
   * the material phase. Feed to `BakeOptions.roles` so the bake buckets items
   * instead of classifying the tree a second time.
   */
  roles: RoleClassification;
  /** Strongest incoming tag per target (references + claims) — feed to `BakeOptions.incomingRoles`. */
  incoming: ReadonlyMap<Object3D, ReferenceBakeTarget>;
  /** Nodes a plugin claimed (resolved claims only). */
  claimed: ReadonlySet<Object3D>;
  /** Claims whose path did not resolve — reported, never thrown. */
  unresolvedClaims: BakeClaim[];
  /** Reference fields whose target did not resolve, with the path that failed. */
  unresolvedReferences: UnresolvedReference[];
  counts: SurvivalCounts;
}

const ROLE_RANK: Record<BakeRole, number> = { merge: 1, chunk: 2, keep: 3 };

/** `keep > chunk > merge > undefined`. */
export function strongestBakeRole(a: BakeRole | undefined, b: BakeRole | undefined): BakeRole | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export interface ComputeSurvivalOptions {
  /** Same predicate the bake gets (`BakeOptions.forceSplit`) — keeps the keep/chunk split identical. */
  forceSplit?: BakeOptions['forceSplit'];
  /** Readable path of the node OWNING an unresolved reference. Defaults to `node.name`. */
  pathOf?: (node: Object3D) => string;
  /**
   * plan-757 F7: the asset scope every reference field, path-string field and
   * plugin claim is read in through the ONE resolver (`rv-reference-resolver.ts`)
   * — as written inside the asset, then root-stripped, else unresolved. Defaults
   * to `root` at its own path with its current name; `prepareAndBake` passes the
   * root's historical names as well.
   */
  scope?: ReferenceScope;
}

/** Unresolved references kept per model — enough to find them, not a second scene graph. */
const UNRESOLVED_REFERENCE_CAP = 500;

/**
 * Compute the survival model of `root`'s tree. `registry` resolves reference
 * paths (a `NodeRegistry`, or any `{ getNode }`). `claims` are the plugin
 * claims (D17). Read-only.
 */
/**
 * Does this extras block carry a collider an author placed as physics
 * geometry? `BoxCollider` (the WEB physics authoring's key) or a non-empty
 * Unity `colliders[]` list. Read together with "the node has no mesh" by
 * `computeSurvival` — on a mesh the same keys are export annotations.
 */
export function carriesAuthoredCollider(rv: Record<string, unknown>): boolean {
  const box = rv['BoxCollider'];
  if (box && typeof box === 'object') return true;
  const list = rv['colliders'];
  return Array.isArray(list) && list.length > 0;
}

export function computeSurvival(
  root: Object3D,
  registry: SurvivalPathResolver,
  claims?: ReadonlyArray<BakeClaim>,
  options?: ComputeSurvivalOptions,
): SurvivalModel {
  const ownRoleOf = makeOwnRoleResolver();
  const isBehavioural = makeBehaviouralTest();

  // ── Pass 1: incoming tags, resolved FORWARD (component → fields → targets).
  const incoming = new Map<Object3D, ReferenceBakeTarget>();
  const unresolvedReferences: UnresolvedReference[] = [];
  const unresolvedByField: Record<string, number> = {};
  let unresolvedCount = 0;
  const pathOf = options?.pathOf ?? ((n: Object3D) => n.name);
  // THE resolver (plan-757 F7): what `prepare` resolves is what the runtime
  // registry resolves after the bake — same scope, same three steps.
  const scope = options?.scope ?? scopeOf(root, NodeRegistry.computeNodePath(root));
  const scoped: SurvivalPathResolver = { getNode: (p) => resolveReferencePath(registry, p, scope).node };
  /** `miss` describes the field for the report; it is only built on a failure. */
  const tag = (
    target: Object3D | null,
    role: ReferenceBakeTarget,
    miss: () => UnresolvedReference,
  ): void => {
    if (!target) {
      unresolvedCount++;
      const m = miss();
      const key = `${m.component}.${m.field}`;
      unresolvedByField[key] = (unresolvedByField[key] ?? 0) + 1;
      if (unresolvedReferences.length < UNRESOLVED_REFERENCE_CAP) unresolvedReferences.push(m);
      return;
    }
    if (target === root) return;
    if (role === 'chunk' || !incoming.has(target)) incoming.set(target, role);
  };
  let nodes = 0;
  root.traverse((node) => {
    nodes++;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    for (const component in rv) {
      const cfg = rv[component];
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
      const record = cfg as Record<string, unknown>;
      // Schema-typed references (scalar + array) — the shared iterator.
      forEachComponentRef(record, (field, ref) => {
        tag(scoped.getNode(ref.path), referenceBakeTargetOf(component, field),
          () => ({ component, field, kind: 'ref', owner: pathOf(node), path: ref.path }));
      });
      // Declared path-string / name-in-subtree fields.
      const entries = tableEntriesOf(component);
      if (!entries) continue;
      for (const e of entries) {
        if (e.kind === 'pathString') {
          for (const v of valuesAt(record, e.field)) {
            const path = pathOfPathString(v);
            if (path === null) continue;
            tag(findPathStringTarget(v, scoped), e.bakeTarget,
              () => ({ component, field: e.field, kind: e.kind, owner: pathOf(node), path }));
          }
        } else if (e.kind === 'nameInSubtree') {
          // Mirrors the component's OWN lookup (`RVSource`): by name in the
          // subtree, then the plain registry — not a path, so not the resolver.
          const target = findNameInSubtreeTarget(record[e.field], node, root, registry);
          // A self-reference claims nothing new — the owner survives as a component.
          if (target !== node) {
            tag(target, e.bakeTarget,
              () => ({ component, field: e.field, kind: e.kind, owner: pathOf(node), path: String(record[e.field]) }));
          }
        }
      }
    }
  });

  // ── Plugin claims (D17).
  const claimed = new Set<Object3D>();
  const unresolvedClaims: BakeClaim[] = [];
  if (claims) {
    for (const c of claims) {
      // D17: a claim is reported, never thrown — including a malformed one. A
      // plugin computes its paths from its own model knowledge, so a missing
      // node yields `undefined` there just as easily as a wrong spelling.
      if (typeof c?.path !== 'string' || c.path.length === 0) {
        unresolvedClaims.push({ path: String(c?.path), role: c?.role ?? 'merge' });
        continue;
      }
      const target = scoped.getNode(c.path);
      if (!target) { unresolvedClaims.push({ path: c.path, role: c.role }); continue; }
      claimed.add(target);
      if (target !== root && (c.role === 'chunk' || !incoming.has(target))) incoming.set(target, c.role);
    }
  }

  // ── Keep meshes: exactly what the bake leaves individual.
  //
  // plan-582 §2.4: THE role pass of this bake. It runs here, ONCE, before the
  // material phase, and travels on as `SurvivalModel.roles` — `bake()` takes it
  // as input instead of classifying a second time.
  const classification = classifyRoles(root, { forceSplit: options?.forceSplit, incomingRoles: incoming });
  const keepSet = new Set<Object3D>(classification.keep.map((k) => k.mesh));
  const stagedSet = new Set<Object3D>(classification.staged);

  /**
   * D4 (1): "carries an rv component". An own bake role covers every
   * registered behavioural component and an authored `rv.BakeRole`. On top of
   * that, conservatively: placement markers (the instantiate root) and any
   * config block of a type that claims its node — an unknown or UI-only type
   * may still be addressed by path at runtime.
   *
   * plan-755 D7: "claims its node" is the explicit `claimsNode` capability,
   * not the former implicit `ui.hidden && bake === 'merge'` guess. `Group` and
   * the Unity export markers declare `false`: a node that carries nothing else
   * survives only as reference target, plugin claim, snap, keep mesh or
   * ancestor. `ownRoleOf` and `isBehavioural` honour the same field (both are
   * asked here, independently), and `claimsNodeOf` resolves `Group_1` to
   * `Group` — so all three agree on a pure annotation node.
   */
  const carriesComponent = (node: Object3D): boolean => {
    if (ownRoleOf(node) !== undefined) return true;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return false;
    if (isBehavioural(rv)) return true;
    // A collider on a node that draws NOTHING is authored physics geometry —
    // the hopper walls and the closure plate of the Festo cell are empty
    // `BoxCollider` nodes the WEB physics authoring wrote, and the physics
    // plugin finds a moving collider only by traversing the drive's surviving
    // subtree. Dropping the node dropped the body: the logos fell through the
    // closed slide (2026-09-24). The Unity export markers `colliders` /
    // `rigidbody` sit on the CAD MESHES themselves and stay pure annotation
    // (Mauser: thousands of them), so the mesh test is what keeps this cheap.
    if (!(node as Mesh).isMesh && carriesAuthoredCollider(rv)) return true;
    for (const key in rv) {
      const cfg = rv[key];
      if (!cfg || typeof cfg !== 'object') continue;
      if (isPlacementMarker(key)) return true;
      // A pure annotation (`claimsNode: false`) holds no node; unknown = claims.
      if (!claimsNodeOf(key)) continue;
      return true;
    }
    return false;
  };

  // ── Pass 2: direct survivors, then ancestors.
  const reasons = new Map<Object3D, SurvivalReason>();
  reasons.set(root, 'root');
  root.traverse((node) => {
    if (node === root) return;
    let reason: SurvivalReason | null = null;
    if (carriesComponent(node)) reason = 'component';
    else if (claimed.has(node)) reason = 'plugin-claim';
    else if (incoming.has(node)) reason = 'referenced';
    else if (SNAP_NAME.test(node.name)) reason = 'snap';
    else if (keepSet.has(node)) reason = 'keep-mesh';
    if (reason) reasons.set(node, reason);
  });
  for (const node of [...reasons.keys()]) {
    if (node === root) continue; // the root's own parents are outside the model
    let p = node.parent;
    while (p && p !== root && !reasons.has(p)) {
      reasons.set(p, 'ancestor');
      p = p.parent;
    }
  }

  // ── Removal tops + counts.
  const removalTops: Object3D[] = [];
  let removedMeshes = 0;
  let mergedSurvivorMeshes = 0;
  const stagedGeometries = new Set<unknown>();
  const retainedGeometries = new Set<unknown>();
  root.traverse((node) => {
    const geometry = (node as Mesh).geometry as unknown;
    if (reasons.has(node)) {
      if (stagedSet.has(node)) mergedSurvivorMeshes++;
    } else {
      if (node.parent && reasons.has(node.parent)) removalTops.push(node);
      if (geometry) removedMeshes++;
    }
    if (geometry) (stagedSet.has(node) ? stagedGeometries : retainedGeometries).add(geometry);
  });
  let releasableGeometries = 0;
  for (const g of stagedGeometries) if (!retainedGeometries.has(g)) releasableGeometries++;

  let tagOnlyChunkBoundaries = 0;
  for (const [target, role] of incoming) {
    if (role !== 'chunk') continue;
    const own = ownRoleOf(target);
    if (own !== 'chunk' && own !== 'keep') tagOnlyChunkBoundaries++;
  }

  const survivors = reasons.size;
  return {
    roles: classification,
    roleOf(node: Object3D): BakeRole | undefined {
      if (node === root) return undefined;
      return strongestBakeRole(ownRoleOf(node), incoming.get(node));
    },
    survives: (node: Object3D): boolean => reasons.has(node),
    reasonOf: (node: Object3D): SurvivalReason | null => reasons.get(node) ?? null,
    removalTops,
    incoming,
    claimed,
    unresolvedClaims,
    unresolvedReferences,
    counts: {
      nodes,
      survivors,
      removed: nodes - survivors,
      removedMeshes,
      mergedSurvivorMeshes,
      releasableGeometries,
      instancedTriangles: classification.instancedTriangles,
      tagOnlyChunkBoundaries,
      unresolvedReferences: unresolvedCount,
      unresolvedByField,
      unresolvedClaims: unresolvedClaims.length,
    },
  };
}

// ─── Phase-0 removal report ──────────────────────────────────────────

/** One recorded report — tests and DevTools read it, product code never does. */
export interface BakeRemovalReport {
  assetId: string;
  counts: SurvivalCounts;
  /** Paths of the removal tops, capped at {@link REMOVAL_TOPS_CAP}. */
  removalTops: string[];
  removalTopsTotal: number;
  unresolvedClaims: BakeClaim[];
  /** Unresolved reference fields, capped — the component and field each one comes from. */
  unresolvedReferences: UnresolvedReference[];
  /** G1: claimed / referenced / component nodes found in the removal set (must be empty). */
  g1Violations: string[];
  /**
   * Whether the plugin claims (D17) were actually COLLECTED for this bake.
   *
   * `false` means "nobody asked the plugins", not "the plugins claimed
   * nothing": model plugins load DEFERRED in planner mode (see
   * `ModelPluginManager`), so at bake time no plugin exists to answer
   * `bakeClaims()`. Without this flag the report said `unresolvedClaims: 0` and
   * looked exactly like a clean run — D17 silently switched off precisely where
   * the destructive bake could remove a node a plugin needs.
   */
  claimsComplete: boolean;
  /** Milliseconds `computeSurvival` took. */
  ms: number;
}

/**
 * Every removal report in order, oldest first (the `bakeEvents` precedent,
 * rv-bake-pipeline.ts): capped, never read by product code.
 */
export const bakeRemovalReport: BakeRemovalReport[] = [];
const REMOVAL_REPORT_CAP = 32;
const REMOVAL_TOPS_CAP = 200;

/** Assets already warned about incomplete claims — one warning per asset, not per load. */
const _warnedIncompleteClaims = new Set<string>();

/** Clear the recorded reports (test-only). */
export function _resetBakeRemovalReportForTesting(): void {
  bakeRemovalReport.length = 0;
  _lastSurvivalCounts = null;
  _warnedIncompleteClaims.clear();
}

type LastSurvivalCounts = SurvivalCounts & {
  assetId: string;
  g1Violations: number;
  claimsComplete: boolean;
  ms: number;
};

let _lastSurvivalCounts: LastSurvivalCounts | null = null;

/** Counts of the most recent report — what `web_status.bake.survival` shows. */
export function lastBakeSurvivalCounts(): LastSurvivalCounts | null {
  return _lastSurvivalCounts;
}

/**
 * G1 check over a model: every node that carries a component, is a reference
 * target or a resolved plugin claim must survive. By construction this is
 * empty — the function exists so the gate is an independent walk over the
 * tree, not a restatement of `computeSurvival`'s own bookkeeping.
 */
export function findClaimedNodesInRemovalSet(
  model: SurvivalModel,
  /** Extra evidence that a node is needed — the loader passes "has a constructed
   *  component instance in the registry", which also covers components the
   *  loader derives from naming conventions rather than from extras. */
  isNeeded?: (node: Object3D) => boolean,
): Object3D[] {
  const isBehavioural = makeBehaviouralTest();
  const out: Object3D[] = [];
  for (const top of model.removalTops) {
    top.traverse((node) => {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (
        isBehavioural(rv) || model.incoming.has(node) || model.claimed.has(node)
        || SNAP_NAME.test(node.name) || isNeeded?.(node)
      ) {
        out.push(node);
      }
    });
  }
  return out;
}

/**
 * Compute the survival model and record the removal report. NOTHING is removed
 * (plan-754 Phase 0). `pathOf` turns a node into a readable path for the report.
 */
export function recordBakeRemovalReport(
  assetId: string,
  root: Object3D,
  registry: SurvivalPathResolver,
  claims: ReadonlyArray<BakeClaim> | undefined,
  pathOf: (node: Object3D) => string,
  options?: ComputeSurvivalOptions & {
    isNeeded?: (node: Object3D) => boolean;
    /** See {@link BakeRemovalReport.claimsComplete}. Defaults to `true` —
     *  a caller that has no plugin layer at all (tests, the model cache) is
     *  not "missing" claims, it simply has none. */
    claimsComplete?: boolean;
  },
): SurvivalModel {
  const t0 = performance.now();
  const model = computeSurvival(root, registry, claims, { ...options, pathOf });
  const ms = performance.now() - t0;
  const violations = findClaimedNodesInRemovalSet(model, options?.isNeeded);
  const claimsComplete = options?.claimsComplete ?? true;
  const report: BakeRemovalReport = {
    assetId,
    counts: model.counts,
    removalTops: model.removalTops.slice(0, REMOVAL_TOPS_CAP).map(pathOf),
    removalTopsTotal: model.removalTops.length,
    unresolvedClaims: model.unresolvedClaims,
    unresolvedReferences: model.unresolvedReferences,
    g1Violations: violations.slice(0, REMOVAL_TOPS_CAP).map(pathOf),
    claimsComplete,
    ms,
  };
  bakeRemovalReport.push(report);
  if (bakeRemovalReport.length > REMOVAL_REPORT_CAP) bakeRemovalReport.shift();
  _lastSurvivalCounts = { ...model.counts, assetId, g1Violations: violations.length, claimsComplete, ms };
  // Say it once per asset: `unresolvedClaims: 0` is otherwise indistinguishable
  // from a clean D17 run, and the nodes those claims would have kept are the
  // ones a destructive bake is free to remove.
  if (!claimsComplete && !_warnedIncompleteClaims.has(assetId)) {
    _warnedIncompleteClaims.add(assetId);
    console.warn(
      `[BakeSurvival] Plugin bake claims were NOT collected for "${assetId}" — model plugins had not `
      + 'loaded yet (deferred, e.g. planner mode). D17 claim protection is inactive for this bake; '
      + '`unresolvedClaims: 0` means "not checked", not "all resolved".',
    );
  }
  return model;
}
