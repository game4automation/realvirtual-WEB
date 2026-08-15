// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-tree-move — performing what `planTreeMove` decided
 * (plan-703 Phase 5 rest / Phase 6, §2.6.5, F12/F13).
 *
 * `planTreeMove` answers *what* a move touches and refuses to know how to write
 * it. This module is the write, and it is the whole of the plan's core promise:
 *
 * > **A move in the tree breaks no reference.**
 *
 * Which decomposes into exactly three writes:
 *
 *  1. **The manifest is COMPUTED first** (not yet written), so every refusal it
 *     can raise aborts before a single byte has moved. For anything carrying a
 *     `documentId`: {@link moveDocumentPath} rewrites `path` and leaves the id
 *     alone — that is F12; the reference resolver addresses by `assetId` first,
 *     so an untouched id IS the repair. A row the manifest does not have is a
 *     refusal since plan-717 Phase 4 — the adopt verb registers every file
 *     before the tree can offer it, so a gap here is a broken guarantee and not
 *     a case to mint through.
 *     Since plan-717 F6 the row's display NAME follows too, but only when the
 *     file stem changed — that is what separates a rename from a move, and it
 *     is why this is the ONE rename path for every document.
 *  2. **The bytes.** Copy to the destination, then delete the source. Copy
 *     first, delete after: a failure between the two leaves the file in both
 *     places, which the user can see and fix. The other order can lose it.
 *     The computed manifest is written after the bytes it describes.
 *  3. **`docs-index.json`**, for anything that does not carry an id —
 *     {@link rewriteDocsIndexPaths} repoints rows that already exist and creates
 *     none (§2.6.5, decision 23).
 *  4. **The backward repoint** (plan-718 §2.4). The three writes above all
 *     repoint a row at its OWN bytes. A connect config, a script or a knowledge
 *     file has no row of its own — it is only ever pointed AT — so moving one
 *     changes nothing anywhere unless someone goes looking for the rows that
 *     name it. {@link repointDocumentRefs} is that search, and it runs in the
 *     same computed-before-any-byte-moves phase, with its own counter.
 *
 * ## Why the IO is a parameter
 *
 * Because "a move rewrites the row and not the id" is a claim about the rules,
 * not about the file system, and it must be checkable without one. Every effect
 * goes through {@link TreeMoveIO}, so §9.8 can assert the manifest and the
 * docs-index that come out of a move against plain objects.
 *
 * ## Partial failure is reported, not swallowed
 *
 * A byte move that succeeded followed by a manifest write that did not is the
 * one genuinely bad state here — the file is somewhere the manifest does not
 * point. It throws, and the message names both paths, because a silent success
 * would leave a reference broken in exactly the way this module exists to
 * prevent.
 */

import type { RvProject } from './rv-project-types';
import { findDocumentById, moveDocumentPath } from './rv-asset-identity';
import { repointDocumentRefs } from './rv-project-refs';
import {
  DOCS_INDEX_FILE,
  parseDocsIndex,
  rewriteDocsIndexPaths,
  type DocsIndex,
  type DocsPathMove,
} from './rv-docs-index';
import type { TreeMovePlan } from './rv-project-tree';

/** Everything a move needs from the outside world, and nothing more. */
export interface TreeMoveIO {
  /** Bytes at a project-relative path, or null when there are none. */
  readBytes(relPath: string): Promise<Blob | null>;
  writeBytes(relPath: string, blob: Blob): Promise<void>;
  deleteBytes(relPath: string): Promise<void>;
  /** The manifest as it stands, or null when this project has none. */
  readManifest(): Promise<RvProject | null>;
  /** Persist a manifest. Called only when a row actually changed. */
  writeManifest(project: RvProject): Promise<void>;
  /**
   * Raw `docs-index.json` payload, or null when the file is absent.
   *
   * Absent is the normal case — most projects ship no document index — and it
   * must cost nothing: no file is created, and the whole docs-index step is
   * skipped rather than writing an empty object.
   */
  readDocsIndex?(): Promise<unknown | null>;
  writeDocsIndex?(index: DocsIndex): Promise<void>;
}

export interface TreeMoveOutcome {
  /** Every `(from, to)` pair whose bytes were moved, in write order. */
  moved: DocsPathMove[];
  /** Manifest rows repointed. Their ids are unchanged — that is the point. */
  manifestRows: number;
  /** `docs-index.json` rows repointed. Zero means the file was not written. */
  docsIndexRows: number;
  /**
   * `connectRef`/`scriptRef`/`knowledgeRef` values repointed at a moved file
   * (plan-718 §2.4).
   *
   * Its OWN counter, deliberately not folded into `manifestRows`: that one
   * counts rows that moved with their bytes, this one counts rows that did not
   * move at all and merely pointed at something that did. Adding them would make
   * every existing assertion on `manifestRows` mean something new.
   */
  refRows: number;
}

/** One file the plan moves: where from, where to, and what has to be updated. */
interface MoveStep {
  from: string;
  to: string;
  documentId?: string;
  rewritesDocsIndex: boolean;
}

/**
 * Flatten a plan into the files it actually moves.
 *
 * A folder move carries no bytes of its own — the folder is derived from its
 * children's paths — so the steps are exactly its descendants. A file move is
 * one step. Exported because the ordering ("descendants, never the folder
 * itself") is a rule a test should be able to state directly.
 */
export function treeMoveSteps(plan: TreeMovePlan): MoveStep[] {
  // A folder's steps are its descendants — ALWAYS, including none at all. An
  // empty folder used to fall through to the single-step fallback below and
  // be read as a file, which made every empty-folder rename throw
  // `"<name>" could not be read` (field finding 2026-08-14). Its own rename
  // is the declared-folders remap the caller performs, not a byte move.
  if (plan.folder || plan.descendants.length > 0) {
    return plan.descendants.map(d => ({
      from: d.from,
      to: d.to,
      ...(d.documentId ? { documentId: d.documentId } : {}),
      rewritesDocsIndex: d.rewritesDocsIndex,
    }));
  }
  return [{
    from: plan.from,
    to: plan.to,
    ...(plan.documentId ? { documentId: plan.documentId } : {}),
    rewritesDocsIndex: plan.rewritesDocsIndex,
  }];
}

/**
 * Carry out `plan`. Throws on the first refusal, having written nothing after it.
 *
 * The destination is probed before anything is written: `canMoveInTree` already
 * refused a taken *name*, but the tree only knows the listings it was built
 * from, and a file the listing never mentioned can still be sitting there.
 */
export async function applyTreeMove(
  io: TreeMoveIO,
  plan: TreeMovePlan,
): Promise<TreeMoveOutcome> {
  const steps = treeMoveSteps(plan).filter(s => s.from !== s.to);
  const moved: DocsPathMove[] = [];

  for (const step of steps) {
    if (await io.readBytes(step.to)) {
      throw new Error(`"${step.to}" already exists — move or rename that one first.`);
    }
  }

  // ── The manifest FIRST — computed before any byte moves (F12) ──
  //
  // Every refusal a manifest update can raise (missing manifest, destination
  // row taken, unmintable id) must abort with NOTHING written. The old order
  // moved the bytes and then threw, leaving the file somewhere the manifest
  // does not point — the exact state the module header calls the one genuinely
  // bad one, and reachable on every real project whose rows had not been
  // minted yet (`documents: []` ships in several).
  //
  // A row with no manifest entry is now a BUG, not a case (plan-717 Phase 4).
  // Until the adopt verb existed, a scanned file had an id the moment the tree
  // showed it and no row until something pinned it, so a move minted one at the
  // old path — "mint on first meaningful operation". Adoption removed the
  // premise: `adoptDiscoveredDocuments()` runs after the project opens and after
  // every rescan, and every file a writable project can show has a row before
  // the user can drag it. A missing row therefore means the guarantee broke
  // upstream, and minting one here would paper over it — with a row this module
  // has no scan result to fill in (no section, no hash, no ingested
  // collections). It refuses instead, before any byte moves.
  const withIds = steps.filter(s => s.documentId);
  let manifestRows = 0;
  let refRows = 0;
  let nextManifest: RvProject | null = null;
  // Read once for both halves. The manifest is needed for ANY step now, not only
  // for steps that carry an id: a connect config or a script has no row of its
  // own, and the rows that POINT at it are the whole of §2.4.
  const manifest = steps.length > 0 ? await io.readManifest() : null;
  if (withIds.length > 0) {
    if (!manifest) {
      throw new Error(
        `Cannot move "${plan.from}" — this project has no manifest to update.`,
      );
    }
    let next = manifest;
    for (const step of withIds) {
      const id = step.documentId!;
      if (!findDocumentById(next, id)) {
        throw new Error(
          `Cannot move "${step.from}" — unregistered file reached tree-move `
          + `(no row for id "${id}"): the adoption guarantee is broken. `
          + 'Reopen the project so its documents are adopted, and try again.',
        );
      }
      const after = renameDocumentRow(moveDocumentPath(next, id, step.to), id, step.from, step.to);
      if (after !== next) manifestRows++;
      next = after;
    }
    if (next !== manifest) nextManifest = next;
  }

  // ── The BACKWARD repoint (plan-718 §2.4, R3) ──
  //
  // Still before any byte moves, for the same reason as the forward half: this
  // can only add to the manifest that is about to be written, never to a
  // refusal, and computing it here keeps "one manifest write per move" true.
  // A move whose only effect is a repoint (an unregistered connect file, say)
  // still gets its manifest written — `nextManifest` becomes non-null here.
  if (manifest) {
    const repointed = repointDocumentRefs(nextManifest ?? manifest, steps);
    if (repointed.rewritten > 0) {
      refRows = repointed.rewritten;
      nextManifest = repointed.project;
    }
  }

  for (const step of steps) {
    const bytes = await io.readBytes(step.from);
    if (!bytes) throw new Error(`"${step.from}" could not be read.`);
    await io.writeBytes(step.to, bytes);
    await io.deleteBytes(step.from);
    moved.push({ from: step.from, to: step.to });
  }

  if (nextManifest) await io.writeManifest(nextManifest);

  // ── docs-index.json: repoint, never create (§2.6.5) ──
  let docsIndexRows = 0;
  const attachments = steps.filter(s => s.rewritesDocsIndex);
  if (attachments.length > 0 && io.readDocsIndex && io.writeDocsIndex) {
    const raw = await io.readDocsIndex();
    if (raw !== null && raw !== undefined) {
      const index = parseDocsIndex(raw);
      const result = rewriteDocsIndexPaths(
        index,
        attachments.map(s => ({ from: s.from, to: s.to })),
      );
      if (result.rewritten > 0) {
        await io.writeDocsIndex(result.index);
        docsIndexRows = result.rewritten;
      }
    }
  }

  return { moved, manifestRows, docsIndexRows, refRows };
}

/** The file stem of a path, without its extension — the display name candidate. */
function stemOf(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.(scene\.)?[a-z0-9]+$/i, '');
}

/**
 * Make the row's display NAME follow a rename — and only a rename (plan-717 F6).
 *
 * `moveDocumentPath` rewrites `path` and nothing else, by rule 3 of
 * `rv-asset-identity`, and that rule stays: a MOVE carries a document into
 * another folder under the same file name, and rewriting its name there would
 * overwrite an authored label with a value the user did not touch.
 *
 * A RENAME is the other half of the same gesture, and it is distinguishable
 * without a flag: the file STEM changed. When it did, the row's name follows,
 * because the two are the same thing to the user — F6 is "Rename changes the row
 * name AND the file name, the id stays". A row whose name already differs from
 * its old stem (an authored label) still follows: the user just typed a new file
 * name for it, and leaving a stale label behind is how a card ends up reading
 * "Belt" over a file called "Roller.glb".
 */
function renameDocumentRow(
  project: RvProject,
  id: string,
  from: string,
  to: string,
): RvProject {
  const nextName = stemOf(to);
  if (nextName === '' || nextName === stemOf(from)) return project;
  const documents = project.documents ?? [];
  const row = documents.find(d => d.id === id);
  if (!row || row.name === nextName) return project;
  return {
    ...project,
    documents: documents.map(d => (d === row ? { ...d, name: nextName } : d)),
  };
}

/** Re-exported so a caller needs one import to read/patch the index file. */
export { DOCS_INDEX_FILE };
