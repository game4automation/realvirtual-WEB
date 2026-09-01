// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-drafts — ONE draft keyspace for the unified document (plan-703
 * Phase 2).
 *
 * Phase 1 gave `RvDocument` a queue, transactions, coalescing and undo/redo but
 * deliberately no persistence, because the two lineages it replaces disagreed
 * about *both* halves of the question:
 *
 * | | scene lineage | asset lineage |
 * |---|---|---|
 * | format | **baked GLB bytes** (`scene-glb` slot `draft/<id>`) | **op array** (IDB `drafts`/`current`) |
 * | slots  | N (`draft/<savedId>`, `draft/<baseKey>`) | **one**, plus a manual shelf |
 *
 * Both answers are settled here, and both are forced by the document stack:
 *
 *  1. **The draft is an op array, never baked bytes.** Baking is O(model), and a
 *     stack means N frames can be dirty at once; re-baking every one of them on
 *     a debounce is not affordable. The op array is also already what a
 *     recovered document replays through (§9.3), so nothing has to learn a
 *     second recovery path.
 *  2. **One slot per stack FRAME.** With a single slot the child frame's
 *     autosave silently overwrites the parent's two seconds after a descend —
 *     which is the whole reason Phase 2 sits *before* the stack in Phase 4.
 *
 * ## Why the key is namespaced, and not just the occurrence chain
 *
 * The obvious key is the occurrence chain: it is already globally unique
 * *within one file*. It is not unique here, for two independent reasons:
 *
 *  - Reference node ids are **persisted UUIDs written into the GLB**. Copy a
 *    project folder and both copies carry byte-identical chains.
 *  - IndexedDB is scoped to the **origin**, not to the project: `DB_NAME` is one
 *    global database for every project the user ever opens.
 *
 * Together those two mean a bare chain does not merely risk an overwrite — a
 * descend inside project B would load project A's draft and present it as the
 * document under the cursor. The key is therefore
 * `<projectId>:<rootDocumentId>:<occurrenceChain>`, each segment percent-encoded
 * so the composition stays injective for ids that contain `:` or `/`
 * (path-derived `stableDocumentId` routinely does).
 *
 * ## Failure posture
 *
 * Everything is best-effort and logs rather than throws — a draft is a safety
 * net, and a save that fails because the net is full is worse than no net.
 * {@link shelveDocumentDraft} is the one exception and REJECTS, for the same
 * reason its asset-lineage predecessor did: put-then-delete across two stores
 * is only safe to act on once the transaction has actually committed.
 */

import { ROOT_OCCURRENCE, occurrenceDepth, occurrenceSegments } from '../engine/rv-node-id';
import { debug } from '../engine/rv-debug'; // TEMP open-perf instrumentation
import { idbRequest, idbTxDone, openIdb } from '../persistence/rv-idb-utils';
import { readAllDocumentAliases } from '../project/rv-doc-alias';
import type { RvDocument } from './rv-document';
import type { RvOp } from './rv-unified-ops';

// ─── Schema (owned here) ────────────────────────────────────────────────
//
// This module is the ONE schema owner of the database. It used to share it with
// the asset lineage's own draft store; since plan-710 Phase 2 there is only one
// op-draft writer and `rv-asset-draft-storage` is types-only.

/** The one draft database of the origin. */
export const DRAFT_DB_NAME = 'rv-asset-editor';
/** v2 added `shelf` (plan-410 F3); v3 adds `frames` (plan-703 Phase 2). */
export const DRAFT_DB_VERSION = 3;
/**
 * The retired single-slot store of the asset lineage.
 *
 * **Never read and never written since plan-710 Phase 2** — kept in the schema
 * only so an existing database keeps opening at version 3 without an upgrade,
 * and so {@link __clearDraftStoresForTests} can still empty it. A draft left in
 * here by an older build is not offered back (user decision, §2.3): recovery
 * reads the `frames` keyspace and nothing else.
 */
export const DRAFT_STORE_LEGACY = 'drafts';
/** Shelved drafts, keyed by `shell.id`. Survives the format change. */
export const DRAFT_STORE_SHELF = 'shelf';
/** One record per stack frame, keyed by {@link draftKeyOf}. */
export const DRAFT_STORE_FRAMES = 'frames';
/**
 * The single key the asset lineage ever used in {@link DRAFT_STORE_LEGACY}.
 *
 * Exported for the negative test that seeds a leftover legacy record and asserts
 * recovery ignores it. Production code must not name this key.
 */
export const LEGACY_DRAFT_KEY = 'current';

/** Open (and upgrade) the shared draft database. */
export function openDraftDb(): Promise<IDBDatabase> {
  return openIdb(DRAFT_DB_NAME, DRAFT_DB_VERSION, [
    DRAFT_STORE_LEGACY,
    DRAFT_STORE_SHELF,
    DRAFT_STORE_FRAMES,
  ]);
}

// ─── Frame identity ─────────────────────────────────────────────────────

/**
 * Which stack frame a draft belongs to.
 *
 * `projectId` is nullable on purpose: "no project open" is a real state (a
 * shared link, a bare built-in) and gets its own namespace rather than being
 * folded into whatever project happened to be open last.
 */
export interface RvDraftFrameKey {
  /** Open project, or null when none is. */
  projectId: string | null;
  /** The document at the BOTTOM of the stack — not this frame's document. */
  rootDocumentId: string;
  /** Occurrence chain from the root down to this frame; `''` is the root. */
  occurrence: string;
}

/** Marks "no project open" — distinct from a project literally named `''`. */
const NO_PROJECT = '~';

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * The storage key for a frame.
 *
 * Percent-encoding each segment is what makes the three-part composition
 * injective: `:` becomes `%3A` and `/` becomes `%2F`, so no combination of ids
 * can be spelled two ways or collide with a different split.
 */
export function draftKeyOf(frame: RvDraftFrameKey): string {
  const project = frame.projectId && frame.projectId.trim() !== ''
    ? encodeSegment(frame.projectId)
    : NO_PROJECT;
  return `${project}:${encodeSegment(frame.rootDocumentId)}:${encodeSegment(frame.occurrence)}`;
}

/** Inverse of {@link draftKeyOf}; null when the key is not one of ours. */
export function parseDraftKey(key: string): RvDraftFrameKey | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  try {
    return {
      projectId: parts[0] === NO_PROJECT ? null : decodeURIComponent(parts[0]),
      rootDocumentId: decodeURIComponent(parts[1]),
      occurrence: decodeURIComponent(parts[2]),
    };
  } catch {
    return null;
  }
}

/** The key prefix shared by every frame of one root document. */
function rootPrefix(projectId: string | null, rootDocumentId: string): string {
  const project = projectId && projectId.trim() !== '' ? encodeSegment(projectId) : NO_PROJECT;
  return `${project}:${encodeSegment(rootDocumentId)}:`;
}

/** The key prefix shared by every draft of one project. */
function projectPrefix(projectId: string | null): string {
  const project = projectId && projectId.trim() !== '' ? encodeSegment(projectId) : NO_PROJECT;
  return `${project}:`;
}

/** Every key starting with `prefix` — `￿` sorts above any encoded char. */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
}

// ─── The record ─────────────────────────────────────────────────────────

/**
 * Where a drafted document started from.
 *
 * The first three variants mirror the asset lineage's `AssetDraftBase` field
 * for field, so migrating one is a copy rather than a translation. The fourth
 * is the scene lineage: its draft content is baked bytes that already live in
 * the scene-GLB store, and the draft record only has to *name* the slot. That
 * keeps the migration lossless without pretending bytes can become ops.
 */
export type RvDraftBase =
  // `{ kind: 'empty' }` was removed by plan-719 F3, exactly as in the twin —
  // see `AssetDraftBase` for why a base meaning "this exists only in memory"
  // has nothing left to describe. Persisted records are recovered through
  // `migrateLegacyEmptyDraft`.
  /**
   * A GLB DOCUMENT the user owns. Field-identical twin of `AssetDraftBase`'s
   * variant of the same name — see there for what collapsed into it (plan-716
   * §2.6) and why `path === ''` is a statement rather than a gap.
   */
  | { kind: 'document'; documentId: string; path: string; name: string }
  /**
   * A built-in / published model addressed by its stable deploy-served URL.
   * Field-identical twin of `AssetDraftBase`'s variant of the same name.
   */
  | { kind: 'builtinModel'; url: string; name: string }
  | {
      kind: 'providerAsset';
      providerId: string;
      sourceId: string;
      assetId: string;
      version?: string;
      label: string;
    }
  /**
   * Editor lineage: reached by DESCENDING into an `AssetReference`
   * (plan-703 §2.7.3 decision (a)). Mirrors `AssetDraftBase`'s variant of the
   * same name — the two unions are kept field-identical on purpose so a draft
   * record round-trips through `assetDraftOfFrame` without a translation table.
   */
  | {
      kind: 'referencedAsset';
      assetId: string;
      providerId?: string;
      sourceId?: string;
      path?: string;
      label: string;
    }
  /**
   * Scene lineage: baked bytes under this slot in the scene-GLB store.
   *
   * NOT `AssetDraftBase.document` (plan-711 §2.1, Triage R1-I5), despite both
   * naming something scene-shaped. This one is a STORAGE ADDRESS — the slot the
   * baked body was written to — and the editor's open path refuses it
   * (`assetDraftOfFrame` returns null for it). `document` is an IDENTITY: which
   * document is on screen, so a mode switch can tell "same document" from
   * "different document". A draft record may address a scene; only an identity
   * may be compared with {@link sameDocumentBase}.
   */
  | { kind: 'sceneGlbSlot'; slot: string; label: string };

/**
 * What the DERIVED bytes projection of this same log contains (plan-711 §2.4).
 *
 * The scene lineage persists a document a second way — baked GLB bytes in a
 * scene-GLB slot — and that projection is a CACHE of the very op log this
 * record carries, never a second truth. The stamp is what makes "cache" a
 * checkable claim rather than a hope: it names the slot, the revision the bytes
 * had when they were written, and how many ops of THIS log were folded into
 * them.
 *
 * Absent means "nothing is known about a bytes projection" — which is the
 * normal state for the asset lineage, and the transition moment for the scene
 * one (an old bytes slot beside a record written by a build that already knew
 * about this field). {@link decideDocumentRecovery} answers both the same way.
 */
export interface RvDraftBytesCache {
  /** The scene-GLB slot the bytes live in, e.g. `draft/<sceneId>`. */
  slot: string;
  /** The revision (content hash) those bytes had. */
  revision: string;
  /** How many ops of this record's log the bytes already contain. */
  floor: number;
}

/** What one frame persists. */
export interface RvDocumentDraft {
  /** {@link draftKeyOf} of {@link frame}. Recomputed on write — never trusted. */
  key: string;
  frame: RvDraftFrameKey;
  /** `occurrenceDepth(frame.occurrence)`; 0 is the root frame. */
  depth: number;
  shell: {
    id: string;
    name: string;
    base: RvDraftBase;
    createdAt: number;
  };
  ops: RvOp[];
  savedAt: number;
  /** The derived bytes projection of {@link ops}, when there is one. */
  bytesCache?: RvDraftBytesCache;
}

/** What a caller supplies; key and depth are derived. */
export type RvDocumentDraftInput = Omit<RvDocumentDraft, 'key' | 'depth' | 'savedAt'> & {
  savedAt?: number;
};

/** Normalise an input record into the stored shape. */
export function toDocumentDraft(input: RvDocumentDraftInput): RvDocumentDraft {
  return {
    key: draftKeyOf(input.frame),
    frame: input.frame,
    depth: occurrenceDepth(input.frame.occurrence),
    shell: input.shell,
    ops: input.ops,
    savedAt: input.savedAt ?? Date.now(),
    // Spread-free on purpose: an `undefined` stamp must leave the field ABSENT,
    // because "no bytes projection is known" and "a bytes projection that is
    // undefined" have to be the same record after a structured clone.
    ...(input.bytesCache ? { bytesCache: input.bytesCache } : {}),
  };
}

// ─── The shared document's frame (plan-711 §2.4, F5) ────────────────────

/**
 * The ONE frame key a document gets when two projections share it.
 *
 * `rootDocumentId` is normally the document INSTANCE id — freshly random per
 * `new AssetDocument`, which is exactly right while a document belongs to one
 * lineage and dies with its session. A SHARED document is the opposite case: it
 * outlives the editor session that borrowed it, both projections must write the
 * same slot (or "one draft" is two), and a crash has to be recoverable by a
 * side that never saw the instance id. So the id comes from the document's
 * IDENTITY instead — the same identity {@link RvDraftBase} carries and
 * `sameDocumentBase` compares.
 *
 * Null for everything else, and that is the whole gate: only a SLOT-ADDRESSED
 * document can be bound (`_resolveOpenPlan`'s bind branch), so only it needs an
 * identity-derived slot. A path-addressed document — a library or project file,
 * opened in the editor alone — keeps its instance-keyed frame, and so does a
 * source.
 *
 * The gate is `path === ''` rather than a kind because plan-716 §2.6 collapsed
 * the kinds: `sceneDocument` and `libraryGlb` are now one kind, and testing the
 * KIND here would hand every library asset a shared identity-keyed slot it has
 * never had. `path === ''` is the exact set the old `kind === 'sceneDocument'`
 * named — the collapse is meant to be invisible to this gate, not to widen it.
 *
 * `projectId` is null to match every other frame this lineage writes; the
 * document id is already globally unique, and inventing a project scope here —
 * on one of the two writers only — would make the two sides disagree about the
 * key.
 */
export function sharedDocumentFrame(
  base: RvDraftBase | null | undefined,
): RvDraftFrameKey | null {
  if (!isSharedDocument(base)) return null;
  // plan-716 Phase 4 finishes what Phase 3 left half-done. Phase 3 had already
  // made the VALUE a documentId (the R1-I5 transition), but it still reached
  // this line through `base.sceneId` and so spelled the frame `scene:<docId>` —
  // consistent, and wrong about what the id IS. With the kind collapsed there is
  // no id here that is not a document id, so the frame says so.
  return rootFrame(null, `doc:${base.documentId}`);
}

/** The gate, once: a document that two projections can share. */
function isSharedDocument(
  base: RvDraftBase | null | undefined,
): base is Extract<RvDraftBase, { kind: 'document' }> {
  return !!base && base.kind === 'document' && !base.path;
}

/**
 * Frames this document's draft may ALSO be found under — oldest last.
 *
 * The `scene:` prefix is a PERMANENT read path (plan-716 §2.4, R1-A8), not a
 * migration-window courtesy. Form-A drafts live in IndexedDB, whose records the
 * §2.3 walk deliberately does not touch: rewriting a database of op logs during
 * a boot is a far larger risk than carrying one extra `get` on the recovery
 * path, and the recovery path runs once per open.
 *
 * There are TWO historic spellings to try, and they are not the same mistake:
 *
 *  1. `scene:<documentId>` — what PHASE 3 wrote. Its ids were already document
 *     ids; only the prefix was stale. Any draft autosaved by a Phase-3 build is
 *     under this key, so it is tried for EVERY document, migrated or not.
 *  2. `scene:<scn_…>` — what every build before the migration wrote, under the
 *     old catalogue id. Reachable only by walking the alias map BACKWARDS, and
 *     only for a document that actually came from a migrated scene.
 *
 * Ordered newest-first so the common case costs one lookup, and the reverse
 * alias walk is skipped entirely when no alias resolves to this document.
 */
export function sharedDocumentFrameFallbacks(
  base: RvDraftBase | null | undefined,
): RvDraftFrameKey[] {
  if (!isSharedDocument(base)) return [];
  const frames = [rootFrame(null, `scene:${base.documentId}`)];
  for (const sceneId of sceneIdsAliasedTo(base.documentId)) {
    frames.push(rootFrame(null, `scene:${sceneId}`));
  }
  return frames;
}

/**
 * The old scene ids that now name this document — the alias map, backwards.
 *
 * The map is keyed the other way on purpose (an old link resolves forward, in
 * O(1), on the routing hot path), so the reverse direction is a scan. It is
 * affordable exactly where it is used: once per open, on the draft-recovery
 * path, over a map with one entry per scene the profile ever had.
 *
 * Normally zero or one id. More than one is possible and is not an error — two
 * catalogue rows can have been merged onto one document by an id collision —
 * and every one of them is tried.
 */
function sceneIdsAliasedTo(documentId: string): string[] {
  try {
    return Object.entries(readAllDocumentAliases())
      .filter(([sceneId, target]) => target === documentId && sceneId !== documentId)
      .map(([sceneId]) => sceneId);
  } catch {
    return [];
  }
}

/**
 * The shared draft of a scene document, trying the new frame then the legacy one.
 *
 * The read half of the permanent alias path. Deliberately a function rather than
 * a flag on {@link loadDocumentDraft}: only the SHARED frame has two spellings,
 * and giving the general loader a fallback would make every asset-lineage lookup
 * pay for a case that cannot apply to it.
 */
export async function loadSharedDocumentDraft(
  base: RvDraftBase | null | undefined,
): Promise<RvDocumentDraft | null> {
  const frame = sharedDocumentFrame(base);
  if (!frame) return null;
  const found = await loadDocumentDraft(frame);
  if (found) return found;
  for (const fallback of sharedDocumentFrameFallbacks(base)) {
    const legacy = await loadDocumentDraft(fallback);
    if (legacy) return legacy;
  }
  return null;
}

// ─── Per-frame CRUD ─────────────────────────────────────────────────────

/** Write (overwrite) one frame's draft. Best-effort — logs, never throws. */
export async function saveDocumentDraft(input: RvDocumentDraftInput): Promise<void> {
  const draft = toDocumentDraft(input);
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_FRAMES, 'readwrite');
    tx.objectStore(DRAFT_STORE_FRAMES).put(draft, draft.key);
    await idbTxDone(tx);
  } catch (e) {
    console.warn('[rv-document-drafts] draft save failed:', e);
  } finally {
    db?.close();
  }
}

/** One frame's draft, or null when it has none / storage is unavailable. */
export async function loadDocumentDraft(frame: RvDraftFrameKey): Promise<RvDocumentDraft | null> {
  let db: IDBDatabase | null = null;
  const perfT0 = performance.now(); // TEMP open-perf instrumentation
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_FRAMES, 'readonly');
    const found = await idbRequest<RvDocumentDraft | undefined>(
      tx.objectStore(DRAFT_STORE_FRAMES).get(draftKeyOf(frame)) as IDBRequest<RvDocumentDraft | undefined>,
    );
    // TEMP open-perf instrumentation — a giant record shows up as get-time.
    debug('perf', '[open-perf] loadDocumentDraft get', {
      ms: Math.round(performance.now() - perfT0),
      key: draftKeyOf(frame),
      ops: found?.ops?.length ?? -1,
    });
    return found ?? null;
  } catch (e) {
    console.warn('[rv-document-drafts] draft load failed:', e);
    return null;
  } finally {
    db?.close();
  }
}

/** Drop one frame's draft (after save / explicit discard). Best-effort. */
export async function clearDocumentDraft(frame: RvDraftFrameKey): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_FRAMES, 'readwrite');
    tx.objectStore(DRAFT_STORE_FRAMES).delete(draftKeyOf(frame));
    await idbTxDone(tx);
  } catch (e) {
    console.warn('[rv-document-drafts] draft clear failed:', e);
  } finally {
    db?.close();
  }
}

async function readRange(range: IDBKeyRange | null): Promise<RvDocumentDraft[]> {
  let db: IDBDatabase | null = null;
  const perfT0 = performance.now(); // TEMP open-perf instrumentation
  try {
    db = await openDraftDb();
    const perfOpenMs = performance.now() - perfT0; // TEMP open-perf
    const tx = db.transaction(DRAFT_STORE_FRAMES, 'readonly');
    const all = await idbRequest<RvDocumentDraft[]>(
      tx.objectStore(DRAFT_STORE_FRAMES).getAll(range) as IDBRequest<RvDocumentDraft[]>,
    );
    // TEMP open-perf instrumentation — splits the DB open from the read, so a
    // slow scan can be told apart from a stalled/queued connection. `ops` is
    // the only bulky field in a record; its total count is what makes the
    // structured-clone deserialization expensive, so report it.
    debug('perf', '[open-perf] readRange', {
      openMs: Math.round(perfOpenMs),
      readMs: Math.round(performance.now() - perfT0 - perfOpenMs),
      records: all?.length ?? 0,
      ops: (all ?? []).reduce((n, d) => n + (d.ops?.length ?? 0), 0),
      scan: range === null ? 'all' : 'prefix',
    });
    return all ?? [];
  } catch (e) {
    console.warn('[rv-document-drafts] draft list failed:', e);
    return [];
  } finally {
    db?.close();
  }
}

/**
 * Every dirty frame of one root document, **bottom frame first**.
 *
 * This is the crash-recovery entry point, and the ordering is the feature. N
 * slots are what first make it possible to edit three levels down and then
 * close the tab; offering only the root frame back would have made the
 * multi-slot change itself the cause of a data-loss path that one slot never
 * had. Recovery reinstates the whole stack, in the order it was descended.
 */
export async function listDirtyStack(
  root: { projectId: string | null; rootDocumentId: string },
): Promise<RvDocumentDraft[]> {
  const drafts = await readRange(prefixRange(rootPrefix(root.projectId, root.rootDocumentId)));
  return drafts.sort((a, b) => (a.depth - b.depth) || (a.savedAt - b.savedAt));
}

/**
 * What a crash left behind for one root document, ready to be offered back.
 *
 * The UI that presents this belongs to Phase 4 (there is no stack to restore
 * into before then); what lives here is the part that must not be re-derived by
 * whoever builds it — the order, and the honest report of what is missing.
 */
export interface RvStackRecoveryPlan {
  /** Frames to reinstate, bottom first. Empty when nothing was left behind. */
  frames: RvDocumentDraft[];
  /** Newest `savedAt` across the plan — what to show as "unsaved since". */
  savedAt: number;
  /**
   * Occurrence chains a recovered frame descends FROM that have no draft of
   * their own.
   *
   * Not an error and not a reason to drop anything: an intermediate frame is
   * simply clean (descended through, never edited), which is the common case.
   * It is reported because the restore has to re-open that document from its
   * bytes rather than from a draft, and a restorer that assumed one draft per
   * level would silently skip a frame.
   */
  cleanAncestors: string[];
}

/**
 * Turn the dirty frames of one root document into an ordered recovery plan.
 *
 * N slots are what first made it possible to edit three levels down and then
 * close the tab. Offering only the root frame back would have made the
 * multi-slot change itself the cause of a data-loss path that a single slot
 * never had — so recovery is defined over the whole stack from the start.
 */
export async function planStackRecovery(
  root: { projectId: string | null; rootDocumentId: string },
): Promise<RvStackRecoveryPlan> {
  const frames = await listDirtyStack(root);
  if (frames.length === 0) return { frames, savedAt: 0, cleanAncestors: [] };

  const present = new Set(frames.map((f) => f.frame.occurrence));
  const cleanAncestors: string[] = [];
  for (const frame of frames) {
    const segments = occurrenceSegments(frame.frame.occurrence);
    // Every proper prefix of the chain is a frame the restore must pass through.
    for (let i = 0; i < segments.length; i++) {
      const ancestor = segments.slice(0, i).join('/');
      if (!present.has(ancestor) && !cleanAncestors.includes(ancestor)) {
        cleanAncestors.push(ancestor);
      }
    }
  }
  return {
    frames,
    savedAt: frames.reduce((max, f) => Math.max(max, f.savedAt ?? 0), 0),
    cleanAncestors,
  };
}

/** Every frame draft in the database, newest first. Diagnostics and tests. */
export async function listAllDocumentDrafts(): Promise<RvDocumentDraft[]> {
  const drafts = await readRange(null);
  return drafts.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

async function deleteRange(range: IDBKeyRange): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_FRAMES, 'readwrite');
    tx.objectStore(DRAFT_STORE_FRAMES).delete(range);
    await idbTxDone(tx);
  } catch (e) {
    console.warn('[rv-document-drafts] draft range clear failed:', e);
  } finally {
    db?.close();
  }
}

/** Drop every frame draft of one root document (the whole stack). */
export async function clearDocumentDraftsForRoot(
  root: { projectId: string | null; rootDocumentId: string },
): Promise<void> {
  await deleteRange(prefixRange(rootPrefix(root.projectId, root.rootDocumentId)));
}

/** Drop every frame draft belonging to one project (on close / switch). */
export async function clearDocumentDraftsForProject(projectId: string | null): Promise<void> {
  await deleteRange(prefixRange(projectPrefix(projectId)));
}

// ─── Shelf ──────────────────────────────────────────────────────────────
//
// Carried over from plan-410 F3 unchanged in PURPOSE — "keep this draft where
// no autosave can reach it until the user decides" — and unchanged in KEY
// (`shell.id`), so a shelf entry survives the format change in place. What
// changes is the payload: the ops are now `RvOp[]`.

/**
 * Move a frame's draft onto the shelf — atomically, in one transaction over
 * both stores.
 *
 * The one function here that REJECTS. The caller may only open the requested
 * document once the shelving has committed; anything weaker loses a draft in
 * exactly the situation the shelf exists to prevent.
 */
export async function shelveDocumentDraft(input: RvDocumentDraftInput): Promise<void> {
  const draft = toDocumentDraft({ ...input, savedAt: Date.now() });
  const db = await openDraftDb();
  try {
    const tx = db.transaction([DRAFT_STORE_FRAMES, DRAFT_STORE_SHELF], 'readwrite');
    tx.objectStore(DRAFT_STORE_SHELF).put(draft, draft.shell.id);
    tx.objectStore(DRAFT_STORE_FRAMES).delete(draft.key);
    await idbTxDone(tx);
  } finally {
    db.close();
  }
}

/** Every shelved draft, newest first. Best-effort — never throws. */
export async function listShelvedDocumentDrafts(): Promise<RvDocumentDraft[]> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_SHELF, 'readonly');
    const all = await idbRequest<RvDocumentDraft[]>(
      tx.objectStore(DRAFT_STORE_SHELF).getAll() as IDBRequest<RvDocumentDraft[]>,
    );
    return (all ?? []).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  } catch (e) {
    console.warn('[rv-document-drafts] shelf list failed:', e);
    return [];
  } finally {
    db?.close();
  }
}

/** Take a draft off the shelf, removing it in the same transaction. */
export async function unshelveDocumentDraft(id: string): Promise<RvDocumentDraft | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_SHELF, 'readwrite');
    const store = tx.objectStore(DRAFT_STORE_SHELF);
    const found = await idbRequest<RvDocumentDraft | undefined>(
      store.get(id) as IDBRequest<RvDocumentDraft | undefined>,
    );
    if (found) store.delete(id);
    await idbTxDone(tx);
    return found ?? null;
  } catch (e) {
    console.warn('[rv-document-drafts] unshelve failed:', e);
    return null;
  } finally {
    db?.close();
  }
}

/** Drop a shelved draft for good (explicit user discard). Best-effort. */
export async function discardShelvedDocumentDraft(id: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDraftDb();
    const tx = db.transaction(DRAFT_STORE_SHELF, 'readwrite');
    tx.objectStore(DRAFT_STORE_SHELF).delete(id);
    await idbTxDone(tx);
  } catch (e) {
    console.warn('[rv-document-drafts] shelf discard failed:', e);
  } finally {
    db?.close();
  }
}

// ─── Autosave seam ──────────────────────────────────────────────────────

/** Debounce window. Matches the asset lineage's, so the feel is unchanged. */
export const DRAFT_AUTOSAVE_DELAY_MS = 2000;

export interface RvDraftAutosaveOptions {
  frame: RvDraftFrameKey;
  /** Shell metadata, read at flush time so a rename is picked up. */
  shell: () => RvDocumentDraft['shell'];
  /**
   * What the OTHER projection's bytes currently hold of this log (plan-711
   * §2.4). Read at flush time like the shell, because the scene keeps baking
   * while the document is not bound and the stamp moves with it.
   */
  bytesCache?: () => RvDraftBytesCache | null;
  delayMs?: number;
}

/**
 * The ONE op-draft writer of the asset/editor lineage (plan-710 §2.3).
 *
 * `RvDocument` deliberately knows nothing about storage — it only announces
 * change — so this is the whole of the coupling between a document and its
 * draft slot. One autosaver serves one frame; a stack of N frames holds N of
 * them, each writing its own key, which is what makes "an autosave in the child
 * leaves the parent draft untouched" true by construction rather than by care.
 *
 * Until plan-710 this class was finished but never instantiated, and
 * `AssetDocument` carried a second, hand-rolled debounce beside it writing a
 * single legacy slot. Both are gone: the facade owns one of these and nothing
 * else writes an op draft.
 *
 * A CLEAN document clears its slot instead of writing one. Without that, a
 * document that was saved (or undone back to its baseline) would leave a draft
 * behind that recovery would later offer as unsaved work.
 *
 * The SCENE lineage is deliberately not a customer: its draft is baked GLB
 * bytes, not ops, and a scene has no stack frame to key on (§2.3). It hangs its
 * own bake on the same `onChanged` seam.
 *
 * ── The one exception, and why it is not a second writer (plan-711 §2.4) ────
 *
 * A scene document the EDITOR has bound is written from here too, because for
 * the duration of the binding the editor facade is what holds it. That is not
 * the scene lineage acquiring an op draft behind its own back: the frame key
 * comes from the document's IDENTITY ({@link sharedDocumentFrame}), the record
 * carries a {@link RvDraftBytesCache} stamp saying what the scene's bytes hold
 * of the same log, and `decideDocumentRecovery` arbitrates the two with ONE
 * rule. Still one writer per slot; the slot is simply named after the document
 * instead of after the instance.
 */
export class RvDraftAutosave {
  private readonly _shell: () => RvDocumentDraft['shell'];
  private readonly _bytesCache: (() => RvDraftBytesCache | null) | null;
  private readonly _delayMs: number;
  private _frame: RvDraftFrameKey;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _pending: RvDocument | null = null;
  private _inFlight: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(opts: RvDraftAutosaveOptions) {
    this._frame = opts.frame;
    this._shell = opts.shell;
    this._bytesCache = opts.bytesCache ?? null;
    this._delayMs = opts.delayMs ?? DRAFT_AUTOSAVE_DELAY_MS;
  }

  get frame(): RvDraftFrameKey { return this._frame; }

  /**
   * Re-point at another frame.
   *
   * The pending write is dropped rather than redirected: it described the old
   * frame, and writing it under the new key is precisely the cross-frame
   * contamination the per-frame keyspace exists to prevent.
   */
  setFrame(frame: RvDraftFrameKey): void {
    this._cancelTimer();
    this._pending = null;
    this._frame = frame;
  }

  /** Pass as {@link RvDocumentOptions.onChanged}. */
  readonly onChanged = (doc: RvDocument): void => {
    if (this._disposed) return;
    this._pending = doc;
    this._cancelTimer();
    this._timer = setTimeout(() => { this._timer = null; void this.flush(); }, this._delayMs);
  };

  /** True while a debounced write is armed — nothing has reached storage yet. */
  get hasPendingWrite(): boolean { return this._pending !== null; }

  /**
   * Write `doc`'s draft NOW, whether or not a change was announced.
   *
   * The exit guard and the end of an in-place test run both need this: autosave
   * was SUSPENDED for the duration, so no `onChanged` ever reached this object,
   * and a plain {@link flush} would have nothing to write. Routing it through
   * the same pending slot keeps this class the single writer rather than making
   * the caller reach for `saveDocumentDraft` itself.
   */
  writeNow(doc: RvDocument): Promise<void> {
    if (this._disposed) return this._inFlight;
    this._pending = doc;
    return this.flush();
  }

  /** Write (or clear) the slot now. Resolves once storage has settled. */
  flush(): Promise<void> {
    this._cancelTimer();
    const doc = this._pending;
    this._pending = null;
    if (!doc || this._disposed) return this._inFlight;
    const frame = this._frame;
    const bytes = this._bytesCache?.() ?? null;
    this._inFlight = this._inFlight.then(() =>
      doc.dirty
        ? saveDocumentDraft({
            frame,
            shell: this._shell(),
            ops: [...doc.ops],
            ...(bytes ? { bytesCache: bytes } : {}),
          })
        : clearDocumentDraft(frame),
    );
    return this._inFlight;
  }

  /** Forget the pending write without touching storage. */
  cancel(): void {
    this._cancelTimer();
    this._pending = null;
  }

  dispose(): void {
    this._disposed = true;
    this.cancel();
  }

  private _cancelTimer(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
  }
}

// ─── Test support ───────────────────────────────────────────────────────

/**
 * Empty every store. Tests only.
 *
 * Clears rather than deletes the database: `deleteDatabase` blocks on any open
 * connection, and this module opens one per call.
 */
export async function __clearDraftStoresForTests(): Promise<void> {
  const db = await openDraftDb();
  try {
    const tx = db.transaction(
      [DRAFT_STORE_FRAMES, DRAFT_STORE_SHELF, DRAFT_STORE_LEGACY],
      'readwrite',
    );
    tx.objectStore(DRAFT_STORE_FRAMES).clear();
    tx.objectStore(DRAFT_STORE_SHELF).clear();
    tx.objectStore(DRAFT_STORE_LEGACY).clear();
    await idbTxDone(tx);
  } finally {
    db.close();
  }
}

/** The root frame of a document — the common case, spelled once. */
export function rootFrame(projectId: string | null, documentId: string): RvDraftFrameKey {
  return { projectId, rootDocumentId: documentId, occurrence: ROOT_OCCURRENCE };
}
