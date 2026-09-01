// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-transfer — the exclusive, symmetric session a cross-source copy
 * or move runs inside (plan-413 §2.7, SOL R1-2 / R2-2).
 *
 * ## Why a session exists at all
 *
 * The obvious shape — "hand the verb a passive backend handle for the other
 * side" — cannot work, and the review found out why before the code did:
 * `writeBlob`, `deleteBlob` and `writeScene` all go through `assertWritable`,
 * which demands `writable` **and** `isActive`
 * ([project-backend.ts:245](./backends/project-backend.ts)). A backend that
 * nobody activated throws on every write. And a *move* needs write rights on
 * **both** sides, because the source is where the delete happens.
 *
 * So a transfer opens a session: each side is either the store's already-active
 * backend (delegated, never touched) or a short-lived backend this session
 * activates itself and **guarantees** to deactivate again, flush included, in a
 * `finally`. {@link withTransferSession} is the only shape that can promise
 * that, which is why it — not {@link openTransferSession} — is what the verbs
 * and the dashboard use.
 *
 * ## Activating a second backend is safe here, and it is worth saying why
 *
 * §2.2.1b forbids two *writers* because the scene mutation bus is global and
 * unscoped: a second `RVProjectFolderWriter` would mirror the open project's
 * every save into the other folder. A `FolderBackend` constructed **without a
 * writer host** never creates that writer — `activate()` sets the gate and
 * returns ("active but non-writing"). Its blob surface writes straight to disk,
 * which is exactly and only what a document transfer needs. So the session is
 * not a loophole in the one-writer rule; it never asks for a writer.
 *
 * The active `ProjectStore` never changes. A transfer is not a project switch,
 * and making it one would mean the dashboard's list, the scene store and every
 * open editor moved sideways under a user who asked to copy one file.
 *
 * ## Exactly one at a time
 *
 * Two concurrent transfers could activate the same folder twice and interleave
 * two manifest read-modify-writes. {@link withTransferSession} serialises them
 * on a promise chain; {@link openTransferSession} — the primitive the plan
 * names — refuses rather than queues, because a caller that forgets to close
 * would otherwise deadlock the next one instead of failing visibly.
 */

import {
  updateManifestCas,
} from './rv-project-storage';
import { readDocuments } from './rv-project-documents';
import { getProjectStore } from './project-store';
import type { ProjectBackend, ResolvedBackendBlob } from './backends/project-backend';
import type { RvDocumentEntry } from './rv-project-types';

// ─── Endpoints ──────────────────────────────────────────────────────────

/** One end of a transfer, before the session has made it usable. */
export interface DocumentTransferEndpoint {
  /** Shown in messages. The project's name, not its id. */
  label: string;
  backend: ProjectBackend;
  /**
   * The folder holding `project.json`, when this endpoint has one.
   *
   * Absent for a browser (OPFS) project, whose manifest is not a file this
   * layer can compare-and-swap. Such a side accepts bytes and reports that the
   * manifest half did not happen — the classification scan is what repairs it.
   */
  dir?: FileSystemDirectoryHandle | null;
  /**
   * True when `backend` is the store's ACTIVE backend.
   *
   * Such a side is delegated to as-is: the session neither activates nor
   * deactivates it, because deactivating the open project at the end of a copy
   * would silence its writer for the rest of the sitting.
   */
  isActiveProject?: boolean;
}

// ─── Sides ──────────────────────────────────────────────────────────────

/**
 * What a verb may do to one side of a transfer.
 *
 * Deliberately narrower than `ProjectBackend`: bytes in, bytes out, bytes gone,
 * and one manifest edit. A verb that could reach `writeScene` or `activate`
 * through this handle would be able to do the things the session exists to keep
 * exclusive.
 */
export interface DocumentTransferSide {
  readonly label: string;
  readonly backendId: string;
  readonly writable: boolean;
  readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null>;
  writeBlob(relPath: string, blob: Blob): Promise<void>;
  deleteBlob(relPath: string): Promise<void>;
  /** The manifest's `documents[]`, or `[]` when this side has no manifest. */
  listDocuments(): Promise<RvDocumentEntry[]>;
  /**
   * Read-modify-write this side's `documents[]` under compare-and-swap.
   *
   * Returns `false` when the side has no manifest **file** — a browser project.
   * That is not a failure: the manifest is a cache of the bytes (§2.5), so a
   * side that cannot record the row still holds the document, and the next scan
   * puts the row back. Saying so beats pretending the write happened.
   */
  updateManifestEntry(
    apply: (documents: RvDocumentEntry[]) => RvDocumentEntry[],
  ): Promise<boolean>;
}

export interface DocumentTransferSession {
  readonly source: DocumentTransferSide | null;
  readonly target: DocumentTransferSide | null;
  /** Idempotent. Flushes and deactivates every side this session activated. */
  close(): Promise<void>;
}

export interface DocumentTransferRequest {
  source?: DocumentTransferEndpoint;
  target?: DocumentTransferEndpoint;
}

// ─── Side construction ──────────────────────────────────────────────────

function sideOf(endpoint: DocumentTransferEndpoint): DocumentTransferSide {
  const { backend, dir, label } = endpoint;
  return {
    label,
    backendId: backend.id,
    get writable() { return backend.writable; },
    readBlobUrl: (relPath) => backend.readBlobUrl(relPath),
    writeBlob: (relPath, blob) => backend.writeBlob(relPath, blob),
    deleteBlob: (relPath) => backend.deleteBlob(relPath),
    listDocuments: async () => {
      const manifest = await backend.readManifest().catch(() => null);
      return readDocuments(manifest) ?? [];
    },
    updateManifestEntry: async (apply) => {
      if (!dir) return false;
      await updateManifestCas(dir, (current) => {
        if (!current) {
          throw new Error(`"${label}" has no manifest to update.`);
        }
        // `readDocuments` rather than `current.documents`: a manifest that has
        // not been migrated has no `documents[]` at all, and appending to
        // `undefined` is how a copy would silently land nowhere.
        return { ...current, documents: apply(readDocuments(current) ?? []) };
      });
      // plan-725 §2.7. A copy across sources rewrites `documents[]` through this
      // own CAS wrapper, not through the store's — so none of the store's own
      // notify sites can see it, and it has to say so itself. Fire-and-forget by
      // construction: `notifyProjectChanged` never throws and never awaits.
      getProjectStore().notifyProjectChanged();
      return true;
    },
  };
}

// ─── Session ────────────────────────────────────────────────────────────

let openSession: DocumentTransferSession | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Open a transfer session. **The caller owns `close()`** — prefer
 * {@link withTransferSession}, which owns it for you.
 *
 * Throws when another session is open. Refusing rather than queueing is the
 * deliberate half: a queue would turn a caller that forgot to close into a hang
 * with no symptom, and a hang is the one failure nobody reports usefully.
 */
export async function openTransferSession(
  req: DocumentTransferRequest,
): Promise<DocumentTransferSession> {
  if (openSession) {
    throw new Error('Another copy or move is still running — wait for it to finish.');
  }

  const activated: ProjectBackend[] = [];
  const activate = async (endpoint: DocumentTransferEndpoint | undefined) => {
    if (!endpoint) return null;
    if (!endpoint.isActiveProject && !endpoint.backend.isActive) {
      await endpoint.backend.activate();
      activated.push(endpoint.backend);
    }
    return sideOf(endpoint);
  };

  let source: DocumentTransferSide | null = null;
  let target: DocumentTransferSide | null = null;
  try {
    source = await activate(req.source);
    target = await activate(req.target);
  } catch (e) {
    // Half-open is not a state anything should have to reason about: undo the
    // activations we did manage before rethrowing.
    for (const backend of activated.reverse()) {
      await backend.deactivate().catch(() => {});
    }
    throw e;
  }

  let closed = false;
  const session: DocumentTransferSession = {
    source,
    target,
    close: async () => {
      if (closed) return;
      closed = true;
      openSession = null;
      for (const backend of activated.reverse()) {
        // Flush before deactivate AND rely on deactivate's own flush: the two
        // are not redundant across backends — the browser backend has no writer
        // to flush and the folder one flushes inside `deactivate`, so doing
        // both is what makes "the bytes are on disk when close() resolves" true
        // for either of them.
        await backend.flush().catch(() => {});
        await backend.deactivate().catch(() => {});
      }
    },
  };
  openSession = session;
  return session;
}

/**
 * Run `fn` inside a session and close it no matter how `fn` ends.
 *
 * Serialised: a second call waits for the first to finish rather than being
 * refused, because a UI that fires two verbs in quick succession should perform
 * both, not lose one to a race it cannot see.
 */
export async function withTransferSession<T>(
  req: DocumentTransferRequest,
  fn: (session: DocumentTransferSession) => Promise<T>,
): Promise<T> {
  const run = queue.then(async () => {
    const session = await openTransferSession(req);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  });
  // The chain must survive a rejection, or one failed transfer would block
  // every later one forever.
  queue = run.then(() => undefined, () => undefined);
  return run;
}

/** Test seam — forgets a session a crashed test left behind. */
export function resetTransferSessionForTests(): void {
  openSession = null;
  queue = Promise.resolve();
}
