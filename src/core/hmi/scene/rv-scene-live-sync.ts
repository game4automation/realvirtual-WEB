// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-live-sync — "another tab is editing this scene", and what to say
 * when two of them collide (plan-397 §2.8, phase 6).
 *
 * ## `BroadcastChannel` is a hint, not a protocol
 *
 * The plan is explicit about this and it is worth restating where the code
 * lives: a channel guarantees no locking, survives no crashed tab, and knows
 * nothing about a second editor opening the project folder from outside the
 * browser. It cannot be the thing that keeps two writers apart.
 *
 * What keeps them apart is the compare-and-swap on the body's revision
 * (phase 5). By the time a conflict is *detected* the user has already been
 * editing for a while, though — so the channel earns its place by saying so
 * earlier: "someone else has this scene open" is worth knowing before the save
 * that fails, not after.
 *
 * Hence the split here:
 *
 *  - {@link announceSceneWrite} — fire-and-forget notice that this tab wrote a
 *    slot. Other tabs turn it into a passive hint.
 *  - {@link reportSceneConflict} — the failed precondition. Not a hint: the
 *    user's autosave has stopped, and they have to be told.
 *
 * Both surface through one listener list so the shell renders them in one
 * place rather than growing a second notification style per feature.
 */

const CHANNEL_NAME = 'rv-scene-writes';

export type SceneSyncNotice =
  | {
      kind: 'other-tab';
      /** Body slot the other tab wrote — a scene id or a draft slot. */
      slot: string;
      message: string;
    }
  | {
      kind: 'conflict';
      /** Scene name, for a message the user can act on. */
      sceneName: string;
      message: string;
    }
  | {
      /**
       * This tab is holding a scene that the migration has since converted
       * (plan-716 §2.4, R1-S4).
       *
       * NOT a conflict, and the distinction is the whole reason it is its own
       * kind. A conflict says "someone changed this behind you, save under a new
       * name" — advice that would make a SECOND copy here, because the scene was
       * not changed at all: it was given a new identity, and this tab is simply
       * addressing the old one. The only correct action is to reload.
       */
      kind: 'moved';
      /** Scene name, so the user knows which of their tabs is stale. */
      sceneName: string;
      message: string;
    }
  | {
      /**
       * A link resolved through the alias map onto a document that is not
       * there (plan-716 §2.4, §9.2 fallback).
       *
       * Distinct from `moved`, whose advice is "reload": reloading this one
       * lands in exactly the same place. The only useful thing to say is what
       * was asked for and that the list is now open.
       */
      kind: 'missing-document';
      documentId: string;
      message: string;
    }
  | {
      kind: 'autosave-error';
      /** Body slot whose autosave failed — the notice's identity (plan-422 F2). */
      slot: string;
      /** Why it failed, in the words the storage layer used. */
      reason: string;
      message: string;
    }
  | {
      kind: 'orphaned-bindings';
      /** Model whose load produced the finding — reported once per load (F9). */
      modelId: string;
      count: number;
      /** Carrier node paths that no longer resolve. */
      paths: string[];
      /**
       * Saved links whose slot the second pass located unambiguously, and which
       * one click could therefore put back (plan-425 F3). Zero = the notice is
       * information only. Counted separately from `count` because they are a
       * different finding: `paths` are carriers that are GONE, these are slots
       * that merely MOVED.
       */
      repairable: number;
      message: string;
    };

/**
 * Stable identity of a notice (plan-422 §2.3).
 *
 * Keying the replay buffer by `kind` alone was enough while both kinds were
 * one-per-session, and stopped being enough the moment a notice needed to be
 * TAKEN BACK: "the autosave of slot X recovered" can only clear the notice it
 * refers to if that notice can be named. The slot (or model) is what makes the
 * name specific; `conflict` keeps a bare id because a refused save is about the
 * workspace as a whole.
 */
export function sceneSyncNoticeId(notice: SceneSyncNotice): string {
  switch (notice.kind) {
    case 'other-tab': return `other-tab:${notice.slot}`;
    case 'conflict': return 'conflict';
    case 'moved': return 'moved';
    case 'missing-document': return `missing-document:${notice.documentId}`;
    case 'autosave-error': return `autosave-error:${notice.slot}`;
    case 'orphaned-bindings': return `orphaned-bindings:${notice.modelId}`;
  }
}

/** What a subscriber hears: a notice arriving, or one being withdrawn. */
export type SceneSyncEvent =
  | { type: 'notice'; id: string; notice: SceneSyncNotice }
  | { type: 'clear'; id: string };

type Listener = (notice: SceneSyncNotice) => void;
type EventListener = (event: SceneSyncEvent) => void;

const listeners = new Set<Listener>();
const eventListeners = new Set<EventListener>();
/** The active notice per id, replayed to a late subscriber. */
const latest = new Map<string, SceneSyncNotice>();

/**
 * Subscribe to scene-sync notices, replaying what has already happened.
 *
 * Replay matters here for the same reason it does in the blob store: writes
 * begin during boot and the shell mounts afterwards, so a listener that only
 * saw future notices would miss the conflict that stopped the autosave.
 *
 * This form hears notices only. A consumer that renders them — and therefore
 * has to stop rendering one that was withdrawn — wants
 * {@link onSceneSyncEvent} instead.
 */
export function onSceneSyncNotice(listener: Listener): () => void {
  listeners.add(listener);
  for (const notice of latest.values()) {
    try { listener(notice); } catch { /* a bad listener is not our failure */ }
  }
  return () => { listeners.delete(listener); };
}

/**
 * Subscribe to notices AND clears, replaying the active ones.
 *
 * The banner keeps its own copy of what is showing, so a cleared notice that
 * arrived only as an absence from the replay buffer would stay on screen
 * forever. The clear has to be an event.
 */
export function onSceneSyncEvent(listener: EventListener): () => void {
  eventListeners.add(listener);
  for (const [id, notice] of latest) {
    try { listener({ type: 'notice', id, notice }); } catch { /* ignore */ }
  }
  return () => { eventListeners.delete(listener); };
}

/** Withdraw ONE notice by id and tell everyone, so renderers can drop it. */
export function clearSceneSyncNotice(id: string): void {
  if (!latest.delete(id)) return;
  for (const l of [...eventListeners]) {
    try { l({ type: 'clear', id }); } catch { /* ignore */ }
  }
}

/** Drop the whole replay buffer. Teardown and tests. */
export function clearSceneSyncNotices(): void {
  const ids = [...latest.keys()];
  latest.clear();
  for (const id of ids) {
    for (const l of [...eventListeners]) {
      try { l({ type: 'clear', id }); } catch { /* ignore */ }
    }
  }
}

function emit(notice: SceneSyncNotice): void {
  const id = sceneSyncNoticeId(notice);
  latest.set(id, notice);
  for (const l of [...listeners]) {
    try { l(notice); } catch { /* ignore */ }
  }
  for (const l of [...eventListeners]) {
    try { l({ type: 'notice', id, notice }); } catch { /* ignore */ }
  }
}

// ─── Channel ────────────────────────────────────────────────────────────

let channel: BroadcastChannel | null = null;
/** Identifies this tab, so its own broadcasts are not reported back to it. */
const TAB_ID = Math.random().toString(36).slice(2);

interface WriteMessage {
  tab: string;
  slot: string;
  revision: string;
  /** Absent on every message written before plan-716 — see {@link ChannelMessage}. */
  type?: 'write';
}

/**
 * The migration finished somewhere (plan-716 §2.3 step 1 / §2.4).
 *
 * Rides the EXISTING channel rather than opening a second one: a tab that cares
 * about "the storage under me changed" is already listening here, and two
 * channels would mean two connection lifecycles to keep in step for one fact.
 */
interface MigrationDoneMessage {
  tab: string;
  type: 'migration-done';
  /** How many rows the run converted. Diagnostics for the waiting tab. */
  migrated: number;
}

/**
 * Everything the channel carries.
 *
 * The `type` discriminator is the compatibility hinge: a write announcement from
 * a tab running the previous build has no `type` at all, so "absent means
 * `write`" is what keeps a mixed-version pair of tabs understanding each other
 * during exactly the update this plan ships.
 */
type ChannelMessage = WriteMessage | MigrationDoneMessage;

type MigrationDoneListener = (info: { migrated: number }) => void;

const migrationDoneListeners = new Set<MigrationDoneListener>();

/**
 * Hear that another tab finished the migration.
 *
 * The waiting half of §2.3 step 1: a tab that did not get the Web Lock has no
 * business migrating and no business proceeding on the pre-migration picture
 * either, so it parks here until the holder says it is done.
 */
export function onSceneMigrationDone(listener: MigrationDoneListener): () => void {
  migrationDoneListeners.add(listener);
  return () => { migrationDoneListeners.delete(listener); };
}

/** Tell every other tab that the migration completed here. Never throws. */
export function announceSceneMigrationDone(migrated: number): void {
  const ch = ensureChannel();
  if (!ch) return;
  try {
    ch.postMessage({ tab: TAB_ID, type: 'migration-done', migrated } satisfies MigrationDoneMessage);
  } catch { /* the lock holder still finished; the waiter falls back to its timeout */ }
}

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;      // private mode / unsupported — the CAS still protects us
  }
  channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.tab === TAB_ID) return;
    if (data.type === 'migration-done') {
      const migrated = typeof data.migrated === 'number' ? data.migrated : 0;
      for (const l of [...migrationDoneListeners]) {
        try { l({ migrated }); } catch { /* a bad listener must not strand the waiter */ }
      }
      return;
    }
    emit({
      kind: 'other-tab',
      slot: String(data.slot ?? ''),
      message: 'Another tab is editing this scene. The last save wins, and you will be told if yours is refused.',
    });
  };
  return channel;
}

/** Tell other tabs that this one wrote a body. Never throws. */
export function announceSceneWrite(slot: string, revision: string): void {
  const ch = ensureChannel();
  if (!ch) return;
  try {
    ch.postMessage({ tab: TAB_ID, slot, revision } satisfies WriteMessage);
  } catch { /* a hint that fails to send is still only a hint */ }
}

/** Surface a failed write precondition. */
export function reportSceneConflict(sceneName: string): void {
  emit({
    kind: 'conflict',
    sceneName,
    message:
      `"${sceneName}" was changed somewhere else, so your automatic save was refused rather than `
      + 'overwriting it. Save under a new name to keep your version.',
  });
}

/**
 * Surface "this tab is holding the OLD identity of a converted scene"
 * (plan-716 §2.4, R1-S4).
 *
 * Reached instead of {@link reportSceneConflict} when the refused write turns
 * out to name a scene id that now has an alias. Without this weighting the user
 * sees the conflict copy — "save under a new name to keep your version" — for a
 * situation in which their version is not in danger and a new name would leave
 * them with two documents and no idea which one the migration kept.
 */
export function reportSceneMovedToDocument(sceneName: string): void {
  emit({
    kind: 'moved',
    sceneName,
    message:
      `"${sceneName}" was moved into the new document format while this tab had it open, so `
      + 'saving from here was refused rather than writing over it. Reload the page to continue '
      + 'working on it — nothing has been lost.',
  });
}

/** Surface a link that resolved onto a document which is no longer there. */
export function reportMissingDocument(documentId: string): void {
  emit({
    kind: 'missing-document',
    documentId,
    message:
      'That link points at a document that is no longer in this project. Your other documents '
      + 'are listed here — nothing else has been affected.',
  });
}

/**
 * Surface an autosave that failed for a reason other than a conflict
 * (plan-422 F2).
 *
 * Until now this path ended in `console.error` and nowhere else, which meant
 * the one state the user must not be wrong about — "is my work being kept?" —
 * was the one state the interface never mentioned. A failed bake stops the
 * draft body from being written at all, so every unsaved edit of the session is
 * riding on a message nobody sees.
 *
 * Repeated failures of the same slot collapse onto one notice with a refreshed
 * reason; {@link clearAutosaveError} takes it back when a save succeeds.
 */
export function reportAutosaveError(slot: string, reason: string): void {
  emit({
    kind: 'autosave-error',
    slot,
    reason,
    message:
      'Your automatic save failed, so recent changes exist only in this tab. '
      + `Save the scene under a new name to keep them. (${reason})`,
  });
}

/** The matching recovery: the next successful autosave of `slot` withdraws it. */
export function clearAutosaveError(slot: string): void {
  clearSceneSyncNotice(`autosave-error:${slot}`);
}

/**
 * Report stored bindings whose carrier node is not in the loaded model (F9).
 *
 * Node bindings persist by PATH (`doc-node-paths.md`), so re-parenting a group
 * in the Unity scene — exactly what phase 6 of plan-422 does to the demo —
 * breaks every binding a user had saved against the old path. Without this the
 * breakage is indistinguishable from the "bindings do not survive a reload" bug
 * that plan-422 phase 1 just fixed. The ops are KEPT: switching back to the
 * previous model restores them untouched.
 */
export function reportOrphanedBindings(
  modelId: string,
  paths: readonly string[],
  repairable = 0,
): void {
  if (paths.length === 0 && repairable === 0) return;
  const list = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, … (+${paths.length - 5} more)` : '');
  const lost = paths.length > 0
    ? `${paths.length} saved signal ${paths.length === 1 ? 'connection points' : 'connections point'} `
      + `at objects this model no longer has: ${list}. They are kept, but inactive.`
    : '';
  // A repairable link is a different sentence: nothing is missing, something
  // moved, and the viewer knows where to. Saying so is what turns the notice
  // from a report into an offer.
  const movable = repairable > 0
    ? `${repairable} saved signal ${repairable === 1 ? 'connection was' : 'connections were'} `
      + `found on a component that moved.`
    : '';
  emit({
    kind: 'orphaned-bindings',
    modelId,
    count: paths.length,
    paths: [...paths],
    repairable,
    message: [lost, movable].filter(Boolean).join(' '),
  });
}

/** Release the channel. Used by tests and on teardown. */
export function closeSceneSyncChannel(): void {
  try { channel?.close(); } catch { /* ignore */ }
  channel = null;
}
