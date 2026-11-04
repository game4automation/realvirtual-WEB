// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-writer — THE writer of stored references (plan-769 Phase 3, F1/F6/F17).
 *
 * Everything a file stores names a node by ADDRESS (`#<id>`, `<p>#<id>`, `<p>/<b>#<id>`,
 * relative to the document that holds the reference — plan § 2.3), never by path. This
 * module turns what a reader of the live scene sees ({@link NodeRegistry.readStoredRef})
 * into that stored form:
 *
 *  - a reference that resolves → `{ address }` relative to the referrer's document;
 *  - a reference its file judged unresolved → `{ unresolvedPath, reason }` (D7, kept,
 *    never guessed), an address whose target is gone stays that address (an orphan by id);
 *  - a path the web wrote this session (`legacy`) → the exact / alias / space lookup in the
 *    referrer's scope first (what Phase 2's copies write), then {@link NodeRegistry.findNodeForUser}
 *    (runtime → authored → legacy Three spelling → guess); a GUESSED hit is written, but
 *    reported (`reference-saved-from-guess`, F9) — a guess must not become a permanent
 *    address unnoticed;
 *  - a target without a persistent id gets one (F17): in the export the id its clone is
 *    written with (`idOf`, the live tree stays untouched), elsewhere {@link ensureNodeId}.
 *
 * The positions are the ones {@link visitReferences} knows: every `ComponentReference`
 * at any depth, every declared path field ({@link PATH_FIELDS}) and every declared NAME
 * field (`Source.ThisObjectAsMU`: its target's address replaces the name — an empty name
 * means "the owner itself" and stays). Not written here: the override KEYS of
 * `AssetOverrides` (relative to another asset — Phase 4).
 *
 * {@link ensureUniqueNodeIds} is the save half of F2: every exported node carries its id
 * under `realvirtual.NodeId` (seeded `_rvNodeId` promoted, a missing one minted, a
 * duplicate re-minted with `node-id-duplicate-reminted`).
 */

import type { Object3D } from 'three';
import {
  storedReferenceForm,
  storedReferenceValue,
  visitReferences,
  type StoredUnresolvedReason,
  type VisitedReference,
} from './rv-node-path-rewrite.mjs';
import { NodeRegistry } from './rv-node-registry';
import { identityIdOf, ensureRuntimeIdentity, getDecodeIdentity } from './rv-decode-identity';
import { seedNodeId } from './rv-node-id-seed.mjs';
import { ADDRESS_SEPARATOR, ROOT_OCCURRENCE, fullNodeAddress, getNodeId, parseNodeAddress, setNodeId } from './rv-node-id';
import { RV_ORIG_NAME_KEY, RV_SEEDED_NODE_ID_KEY } from './rv-authored-keys';
import { RV_SYNTHETIC_KEY } from './rv-bake-chunk';
import { findByNameInSubtree } from './rv-traverse-utils';

// ─── Reading a reference for writing ───────────────────────────────────

/** How the writer reached a target (diagnostics, tests). */
export type WriteVia = 'address' | 'migrated' | 'exact' | 'user' | 'guess';

/** The target of one stored reference, as the WRITER reads it. */
export type WriteTarget =
  | { status: 'resolved'; node: Object3D; via: WriteVia; /** absolute address it resolved to (address / migrated) */ address?: string; stage?: string }
  | { status: 'pending'; address: string }
  | { status: 'unresolved'; reason: StoredUnresolvedReason; path?: string; address?: string };

/** Lookup stages that are the path as written — never a guess (plan-765, Phase 2 copies). */
const EXACT_STAGES: ReadonlySet<string> = new Set(['exact', 'alias', 'space']);

/**
 * The node a stored reference of `referrer` names, read for WRITING — the one rule the
 * save, the editor copy (`cloneNode`, D9) and the setField read-back share:
 * the file's verdict ({@link NodeRegistry.readStoredRef}); for a `legacy` read the exact
 * chain in the referrer's scope (`exact` / `alias` / `space`), then — unless `exactOnly` —
 * {@link NodeRegistry.findNodeForUser} (its `guess` is flagged `via: 'guess'`).
 * `value` is a stored value (`storedReferenceValue`) or a raw reference / path-field leaf.
 */
export function referenceTargetForWrite(
  registry: NodeRegistry,
  referrer: Object3D,
  value: unknown,
  opts?: { componentType?: string; exactOnly?: boolean; kind?: 'path' | 'name' },
): WriteTarget {
  const stored = storedReferenceValue(value);
  if (stored === null) return { status: 'unresolved', reason: 'missing' };
  const r = registry.readStoredRef(referrer, stored, { kind: opts?.kind });
  if (r.status === 'resolved') return { status: 'resolved', node: r.node, via: r.via, address: r.address };
  if (r.status === 'pending') return { status: 'pending', address: r.address };
  if (r.status === 'unresolved') {
    return {
      status: 'unresolved', reason: r.reason,
      ...(r.path !== undefined ? { path: r.path } : {}),
      ...(r.address !== undefined ? { address: r.address } : {}),
    };
  }
  // legacy: a path INPUT (written this session, or a document without an identity).
  const path = r.path;
  if (opts?.kind === 'name') {
    // A NAME field's own rule (`RVSource`): unique by name in the referrer's asset,
    // else the name read as a path (below) — never a suffix guess.
    const byName = findByNameInSubtree(registry.enclosingScope(referrer).root, path);
    if (byName) return { status: 'resolved', node: byName, via: 'exact', stage: 'name-in-subtree' };
  }
  const ct = opts?.componentType ?? '';
  const exact = registry.resolveWithStage({ path }, ct, referrer)
    ?? (ct !== '' ? registry.resolveWithStage({ path }, '', referrer) : null);
  if (exact && EXACT_STAGES.has(exact.stage)) return { status: 'resolved', node: exact.node, via: 'exact', stage: exact.stage };
  if (opts?.exactOnly) return { status: 'unresolved', reason: 'missing', path };
  const user = registry.findNodeForUser(path);
  if (user) {
    return user.via === 'guess'
      ? { status: 'resolved', node: user.node, via: 'guess', stage: user.stage }
      : { status: 'resolved', node: user.node, via: 'user' };
  }
  return { status: 'unresolved', reason: 'missing', path };
}

/**
 * F17: the node's persistent id — its identity, else a fresh UUIDv4 minted as its
 * runtime identity and indexed in its document (so the reference written now resolves
 * in this session too). `null` when the node lies in no registered document.
 */
export function ensureNodeId(registry: NodeRegistry, node: Object3D): string {
  const occ = documentOccurrenceOfNode(registry, node);
  const id = ensureRuntimeIdentity(node);
  if (occ !== null && registry.getAddressForNode(node) === null) registry.registerNodeId(node, occ);
  return id;
}

/**
 * The occurrence of the document `node` belongs to: its own address, else the nearest
 * registered ancestor's ({@link NodeRegistry.docOccurrenceOf}); the root of the main
 * document counts even before it has an id of its own.
 */
export function documentOccurrenceOfNode(registry: NodeRegistry, node: Object3D): string | null {
  const occ = registry.docOccurrenceOf(node);
  if (occ !== null) return occ;
  // No indexed ancestor: the main document still holds the node when its root does.
  const root = registry.rootOfOccurrence(ROOT_OCCURRENCE);
  for (let n: Object3D | null = node; n; n = n.parent) {
    if (n === root) return ROOT_OCCURRENCE;
    // Content of a reference node is another file — never the main document's.
    if (n !== node && registry.isReferenceNode(n)) return null;
  }
  return null;
}

/**
 * `absolute` (`<occ>#<id>`) relative to the document occurrence `docOcc` (§ 2.3): the
 * same occurrence → `#<id>`; an occurrence below it → `<rest>#<id>`. `null` when the
 * target lies outside the referrer's document (not expressible relative to it).
 */
export function relativeAddress(docOcc: string, absolute: string): string | null {
  const { occurrence, nodeId } = parseNodeAddress(absolute);
  if (occurrence === docOcc) return `${ADDRESS_SEPARATOR}${nodeId}`;
  if (docOcc === ROOT_OCCURRENCE) return `${occurrence}${ADDRESS_SEPARATOR}${nodeId}`;
  if (occurrence.startsWith(`${docOcc}/`)) return `${occurrence.slice(docOcc.length + 1)}${ADDRESS_SEPARATOR}${nodeId}`;
  return null;
}

/** The stored form of one reference: an address, or a kept path with its reason. */
export type StoredForm =
  | { address: string }
  | { unresolvedPath: string; reason: StoredUnresolvedReason };

/** Options of {@link storedFormFor}. */
export interface StoredFormOptions {
  componentType?: string;
  /** `'name'` for a NAME field (`Source.ThisObjectAsMU`): read by its owner's rule. */
  kind?: 'path' | 'name';
  /**
   * Is a target of the referrer's OWN document part of what is written? (the export
   * drops runtime helpers; a reference to one would name a node the file lacks).
   */
  survives?(target: Object3D): boolean;
  /** Called for a target reached only through a guessing stage (F9). */
  onGuess?(target: Object3D, path: string, stage: string | undefined): void;
  /**
   * The id a target WITHOUT an indexed id is written with. The export passes the id of
   * the target's clone (the file's id, live tree untouched); default: {@link ensureNodeId}.
   */
  idOf?(target: Object3D): string | null;
  /** Exact lookups only for a path written this session — never `findNodeForUser`'s guess. */
  exactOnly?: boolean;
}

/**
 * THE writer: the stored form of `value` (a raw reference / path-field leaf / path) of
 * `referrer`. `null` = no reference at this position (an empty value) — leave it.
 */
export function storedFormFor(
  registry: NodeRegistry,
  referrer: Object3D,
  value: unknown,
  opts?: StoredFormOptions,
): StoredForm | null {
  const form = storedReferenceForm(value);
  if (!form) return null;
  if (form.form === 'path' && form.path.trim() === '') return null;
  const written = form.form === 'path' ? form.path : form.form === 'unresolved' ? form.unresolvedPath : form.address;
  const keep = (reason: StoredUnresolvedReason, path?: string): StoredForm =>
    (form.form === 'address' ? { address: form.address } : { unresolvedPath: path ?? written, reason });
  if (form.form === 'unresolved') return { unresolvedPath: form.unresolvedPath, reason: form.reason };

  const docOcc = documentOccurrenceOfNode(registry, referrer);
  if (docOcc === null) return keep('missing');
  const target = referenceTargetForWrite(registry, referrer, value, {
    componentType: opts?.componentType, kind: opts?.kind, ...(opts?.exactOnly ? { exactOnly: true } : {}),
  });
  if (target.status === 'pending') {
    const rel = relativeAddress(docOcc, target.address);
    return rel ? { address: rel } : keep('missing');
  }
  if (target.status === 'unresolved') {
    // An address whose target is gone stays the address (an orphan BY ID — an undo
    // brings the node back under the same id); a path keeps its written spelling.
    return keep(target.reason, target.path);
  }
  const node = target.node;
  if ((node.userData as Record<string, unknown> | undefined)?.[RV_SYNTHETIC_KEY] === true) return keep('synthetic-target');
  if (target.via === 'guess') opts?.onGuess?.(node, written, target.stage);
  let absolute = target.address ?? registry.getAddressForNode(node);
  if (absolute === null) {
    // F17: a target without an indexed id — the caller's id for it (the export: the id
    // its clone is written with), else a minted one (`ensureNodeId`).
    const occ = documentOccurrenceOfNode(registry, node);
    const id = opts?.idOf ? opts.idOf(node) : (occ !== null ? ensureNodeId(registry, node) : null);
    absolute = occ !== null && id ? fullNodeAddress(occ, id) : null;
  }
  if (absolute === null) return keep('missing');
  // A node of the referrer's own document that the file does not contain (a runtime
  // helper the export drops) cannot be addressed by the file.
  if (parseNodeAddress(absolute).occurrence === docOcc && opts?.survives && !opts.survives(node)) {
    return keep('missing');
  }
  const rel = relativeAddress(docOcc, absolute);
  return rel ? { address: rel } : keep('missing');
}

/**
 * The value written in place of `value` at a reference position: a ComponentReference
 * keeps its `type` / `componentType` / `componentIndex` and drops `path`; a path-field
 * leaf (string or record) becomes the stored record itself.
 */
export function storedValueAt(position: Pick<VisitedReference, 'kind' | 'value'>, form: StoredForm): unknown {
  if (position.kind !== 'ref') return { ...form };
  const v = position.value as Record<string, unknown>;
  const out: Record<string, unknown> = { type: 'ComponentReference', ...form };
  if (typeof v.componentType === 'string') out.componentType = v.componentType;
  if (typeof v.componentIndex === 'number' && 'address' in form) out.componentIndex = v.componentIndex;
  return out;
}

/**
 * plan-769 Phase 3b — a LIVE writer's value (setField from the reference field, MCP,
 * mechanism authoring, any op): every ComponentReference in `value` that names a node
 * by an exact lookup becomes `{ type, address, componentType }` relative to `owner`'s
 * document; anything else stays as written (an unresolved path is the user's input, the
 * save keeps or reports it). PATH_FIELDS and NAME fields are left as strings — they are
 * plain string fields in the inspector; the save converts them. Returns `value` itself
 * when nothing changed (a copy otherwise).
 */
export function addressedReferenceValue(
  registry: NodeRegistry,
  owner: Object3D,
  componentType: string,
  fieldName: string,
  value: unknown,
  opts?: { onUnsavedTarget?(t: UnsavedReferenceTarget): void },
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const bag: Record<string, unknown> = { [componentType]: { [fieldName]: JSON.parse(JSON.stringify(value)) } };
  let changed = false;
  visitReferences(bag, (r) => {
    if (r.kind !== 'ref' || r.form !== 'path' || r.path.trim() === '') return;
    const form = storedFormFor(registry, owner, r.value, { componentType: r.refComponentType, exactOnly: true });
    if (!form || !('address' in form)) return;
    r.set(storedValueAt(r, form));
    changed = true;
    const unsaved = unsavedTargetOf(registry, owner, form.address);
    if (unsaved) opts?.onUnsavedTarget?.(unsaved);
  }, { skipComponent: (key) => SKIPPED_COMPONENTS.has(key) || SKIPPED_COMPONENTS.has(key.replace(/_d+$/, '')) });
  return changed ? (bag[componentType] as Record<string, unknown>)[fieldName] : value;
}

/** F21: a reference into ANOTHER document whose target id exists in no file yet. */
export interface UnsavedReferenceTarget {
  /** The relative address just written. */
  address: string;
  /** The target node (in a placement / frame of another document). */
  target: Object3D;
  /** The reference node whose document holds the target (the one to save first). */
  documentRoot: Object3D | null;
}

/** UUIDv4 — the id format of a node minted in the web (seeded file ids are UUIDv5). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * plan-769 F21 — does `address` (relative to `owner`'s document) name a node of ANOTHER
 * document whose id only lives in this session (a runtime UUIDv4, no `NodeId` from a
 * file)? Then the reference resolves now, but not after a reload — until that document
 * is saved with the id. `null` when the target is in the owner's own document or its
 * id came from a file.
 */
export function unsavedTargetOf(registry: NodeRegistry, owner: Object3D, address: string): UnsavedReferenceTarget | null {
  if (parseNodeAddress(address).occurrence === '') return null;
  const r = registry.readStoredRef(owner, { address });
  if (r.status !== 'resolved') return null;
  const target = r.node;
  if (getNodeId(target)) return null;
  const id = identityIdOf(target);
  if (!id || !UUID_V4.test(id)) return null;
  let documentRoot: Object3D | null = null;
  for (let n: Object3D | null = target.parent; n; n = n.parent) if (registry.isReferenceNode(n)) { documentRoot = n; break; }
  return { address, target, documentRoot };
}

/** What one {@link writeStoredReferences} pass did. */
export interface ReferenceWriteReport {
  references: number;
  addresses: number;
  unresolved: number;
  guessed: Array<{ referrer: Object3D; componentType: string; field: string; path: string; target: Object3D; stage?: string }>;
}

/** Component records whose content is relative to ANOTHER asset (override keys — Phase 4). */
const SKIPPED_COMPONENTS: ReadonlySet<string> = new Set(['AssetOverrides']);

/**
 * Rewrite every stored reference of `extras` (one node's `realvirtual` bag, IN PLACE —
 * the caller owns it: an export clone) into its stored form. `referrer` is the LIVE node
 * the extras belong to (whose document the references are relative to).
 */
export function writeStoredReferences(
  registry: NodeRegistry,
  referrer: Object3D,
  extras: Record<string, unknown>,
  report: ReferenceWriteReport,
  opts?: Pick<StoredFormOptions, 'survives' | 'idOf'>,
): void {
  visitReferences(extras, (r) => {
    // `r.value`: the ComponentReference, the path-field leaf (string / record), or the
    // name of a NAME field (its target's address is written in its place).
    const form = storedFormFor(registry, referrer, r.value, {
      componentType: r.refComponentType,
      ...(r.kind === 'name' ? { kind: 'name' as const } : {}),
      survives: opts?.survives,
      ...(opts?.idOf ? { idOf: opts.idOf } : {}),
      onGuess: (target, path, stage) => {
        report.guessed.push({ referrer, componentType: r.componentKey, field: r.field, path, target, ...(stage ? { stage } : {}) });
      },
    });
    if (!form) return;
    report.references++;
    if ('address' in form) report.addresses++; else report.unresolved++;
    r.set(storedValueAt(r, form));
  }, { skipComponent: (key) => SKIPPED_COMPONENTS.has(key) || SKIPPED_COMPONENTS.has(key.replace(/_\d+$/, '')) });
}

// ─── Ids on save ──────────────────────────────────────────────────────

/** One re-minted duplicate of {@link ensureUniqueNodeIds}. */
export interface RemintedDuplicate {
  /** The id two (or more) exported nodes carried. */
  id: string;
  /** The new id the later node is written with. */
  reminted: string;
  /** The live node behind the re-minted clone node (the clone node when unknown). */
  node: Object3D;
}

/** What {@link ensureUniqueNodeIds} did. */
export interface NodeIdReport {
  nodes: number;
  promoted: number;
  minted: number;
  reminted: RemintedDuplicate[];
}

/**
 * The save half of F2: every node of the EXPORT clone `clone` carries a unique
 * `realvirtual.NodeId` — its identity (an authored id stays, a seeded `_rvNodeId` is
 * promoted), a missing one is minted, a duplicate (every node of one id but the one the
 * address index holds — stored references to that id resolve to it — else the first in
 * preorder) is re-minted.
 *
 * Only the CLONE is written: the export never mutates the live tree. Minted and
 * re-minted ids are therefore DETERMINISTIC (UUIDv5 of the node's name path in the clone,
 * resp. of the duplicated id and its rank, ` n` retry like the seed) — two saves of
 * one session write the same file, and the reload persists exactly those ids. A node an
 * op created carries its id already (Phase 2); what is minted here is a node nothing
 * gave an identity (a hand-built tree, a runtime node that survived the prune).
 * Synthetic bake objects get no id (they never reach an editor export).
 */
export function ensureUniqueNodeIds(
  clone: Object3D,
  liveOf: (cloneNode: Object3D) => Object3D | undefined,
  registry: NodeRegistry | null,
): NodeIdReport {
  const report: NodeIdReport = { nodes: 0, promoted: 0, minted: 0, reminted: [] };
  const isSynthetic = (n: Object3D): boolean => (n.userData as Record<string, unknown>)[RV_SYNTHETIC_KEY] === true;
  // Pass 1 — who KEEPS a duplicated id, and every id that is taken.
  const keeper = new Map<string, Object3D>();
  const taken = new Set<string>();
  clone.traverse((node) => {
    if (isSynthetic(node)) return;
    const id = identityIdOf(node);
    if (!id) return;
    taken.add(id);
    if (!keeper.has(id)) { keeper.set(id, node); return; }
    const live = liveOf(node);
    const own = live && registry ? registry.getAddressForNode(live) : null;
    if (own !== null && parseNodeAddress(own).nodeId === id) keeper.set(id, node);
  });
  const fresh = (base: string): string => {
    let id = seedNodeId(base);
    for (let n = 1; taken.has(id); n++) id = seedNodeId(`${base} ${n}`);
    taken.add(id);
    return id;
  };
  const rank = new Map<string, number>();
  const visit = (node: Object3D, path: string): void => {
    if (isSynthetic(node)) return;
    report.nodes++;
    const ud = node.userData as Record<string, unknown>;
    let id = identityIdOf(node);
    if (id && keeper.get(id) !== node) {
      const k = (rank.get(id) ?? 0) + 1;
      rank.set(id, k);
      const next = fresh(` reminted ${id} ${k}`);
      report.reminted.push({ id, reminted: next, node: liveOf(node) ?? node });
      id = next;
    } else if (!id) {
      id = fresh(` minted ${path}`);
      report.minted++;
    } else if (!getNodeId(node)) {
      report.promoted++;
    }
    setNodeId(node, id);
    delete ud[RV_SEEDED_NODE_ID_KEY];
    for (const c of node.children) visit(c, `${path}/${c.name}`);
  };
  visit(clone, '');
  return report;
}

// ─── The document registry of an unregistered tree ─────────────────────

/**
 * A registry for a tree the live viewer does not hold (an export of a hand-built or
 * detached tree): every node under its registry path, the authored aliases of loader
 * renames, the root as the reference scope, the document under occurrence `''` with the
 * tree's decode identity (when it came from a decode). The SAME reader then judges its
 * references — no second implementation.
 */
export function documentRegistryFor(root: Object3D): NodeRegistry {
  const reg = new NodeRegistry();
  root.traverse((node) => {
    const path = NodeRegistry.computeNodePath(node);
    if (node !== root || path !== '') reg.registerNode(path, node);
    const orig = (node.userData as Record<string, unknown>)[RV_ORIG_NAME_KEY];
    if (typeof orig === 'string' && orig.length > 0 && orig !== node.name && node !== root) {
      const parentPath = node.parent ? NodeRegistry.computeNodePath(node.parent) : '';
      reg.registerAlias(parentPath ? `${parentPath}/${orig}` : orig, node);
    }
  });
  reg.registerScopeNames(root, [root.name, (root.userData as Record<string, unknown>)[RV_ORIG_NAME_KEY] as string | undefined]);
  reg.registerDocument(root, ROOT_OCCURRENCE, getDecodeIdentity(root));
  return reg;
}

/** The registry that holds `root` as a document: `registry` when it does, else a fresh one. */
export function registryForDocument(root: Object3D, registry: NodeRegistry | null | undefined): NodeRegistry {
  if (registry && registry.docOccurrenceOf(root) !== null) return registry;
  return documentRegistryFor(root);
}
