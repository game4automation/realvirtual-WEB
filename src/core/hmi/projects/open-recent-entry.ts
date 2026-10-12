// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * open-recent-entry — the one chain behind a deliberate open of a document
 * (plan-478 F3, generalised by plan-509 and plan-513).
 *
 * ONE awaitable function, in this order and no other:
 *
 *   0. **the workspace switch lock** — shared with `requestMode`, so a click
 *      that arrives while a guarded switch is mid-dialog answers `'busy'`
 *      instead of starting a second switch behind it (R3-2);
 *   0.5 **unsaved scene work** — the same dialog every other document switch
 *      raises, asked before ANY mutation, same-project included (R3-1);
 *   1. **exit guards, before the project** — a FOREIGN project only, and only
 *      for what cannot be stale: the stored last mode (plan-513 SOL R2 F2);
 *   2. **project** — opened through `openProjectById`, awaited, with a real
 *      result contract;
 *   3. **the target mode, decided once** — from the live row, the demo status
 *      and the stored last mode (`effectiveOpenMode`), with the exit guards
 *      asked for exactly that transition unless step 1 already asked it;
 *   4. **document** — through the EXISTING editor handoff
 *      (`openDocumentAsWorkingScene`), which is handed the target and carries
 *      it out without asking again.
 *
 * ## One mode decision per open (plan-513)
 *
 * Until plan-513 three places decided in turn: `SceneStore.openDocument`
 * applied the row's declared mode, the editor handoff parked and came back,
 * and this chain set its target LAST. Each of those moves was a bare `setMode`
 * the chain had to predict (`firstDeparture`), and between them the workspace
 * passed through modes nobody asked for. Now the chain decides the target once,
 * after the project is open, and everything below it only executes: the
 * handoff opens with `modeDecidedByCaller`, so the row's mode is not applied a
 * second time.
 *
 * **The target is still reached through the promise, not an effect.** It may
 * be `viewer`, and `mode:viewer` unmounts the dashboard host
 * (`HMIShell.tsx:69`); a promise survives its caller's unmount, an effect keyed
 * on a pending ref does not (SOL R2 F2/F3 of plan-478).
 *
 * ## Which departure is asked about
 *
 * {@link plannedDeparture}: the target itself when it differs from the active
 * mode; when both are the editor, the handoff's PARK mode — an editor → editor
 * open leaves the editor to reload it, and the editor's guard must be asked
 * about that (plan-478 SOL R2 F1). Every real transition is asked exactly once.
 *
 * ## The in-flight lock
 *
 * Module-level and held from BEFORE the guards until AFTER the mode is
 * activated (F11). `runVerb`'s `busy` cannot do this job: it is released by its
 * own callback, which says nothing about whether the document has finished
 * loading (SOL R2 F3). A second click inside the window is ignored, never
 * queued — a queued second target would land after the first has already moved
 * the workspace.
 *
 * ## The re-check after the project open
 *
 * For a FOREIGN project the chain knows before the open only what the caller
 * stored — the last mode. The row's declared mode (and whether the project is
 * a demo) is read LIVE once the project is open; a transition step 1 did not
 * ask about gets its own ask then. A veto there answers `vetoed-after-open`:
 * the project is already switched and stays open, the document is not loaded,
 * the mode is left alone. The search index's copy of the declared mode never
 * enters a guard decision — it may be stale (plan-513 SOL R2 F2).
 */

import type { RecentBackend, RecentDocumentEntry } from '../../project/rv-project-recents';
import {
  effectiveOpenMode,
  handoffParkMode,
  plannedDeparture,
} from '../../project/rv-document-mode';
import { openProjectById, type OpenProjectDeps } from './open-project-by-id';

export type OpenRecentResult =
  | 'opened'
  | 'busy'
  | 'dirty-cancelled'
  | 'vetoed'
  /**
   * A veto AFTER the project open: the re-check vetoed, or the editor refused
   * its re-entry at the end of an editor → editor open. The project stays open.
   */
  | 'vetoed-after-open'
  | 'project-cancelled'
  | 'project-denied'
  | 'project-missing'
  | 'project-failed'
  | 'document-missing';

export interface OpenRecentModes {
  activeMode: string | null;
  lockedMode?: string | null;
  has(id: string): boolean;
  list(): readonly { id: string }[];
  setMode(id: string): void;
  runExitGuards(to: string, token?: symbol): Promise<boolean>;
  /** The shared workspace switch lock (plan-478 R3-2). Null when held. */
  acquireSwitchLock(): symbol | null;
  releaseSwitchLock(token: symbol): void;
}

/**
 * What the chain opens — a recent, a model-search hit (plan-509), or a card of
 * the open project (plan-513).
 *
 * `lastMode` is the document's stored last-used mode (`rv-document-modes`),
 * resolved by the caller; it is the ONE input that may decide a guard question
 * before a foreign project is open. `indexedDeclaredMode` is the row's declared
 * mode as the caller's search index knows it — display only, never a guard
 * input, because the index may be stale (plan-513 SOL R2 F2).
 */
export interface OpenDocumentTarget {
  projectId: string;
  backend: RecentBackend;
  documentId: string;
  projectName: string;
  /** Stored last mode (from rv-document-modes), resolved by the caller. */
  lastMode?: string;
  /** Declared row mode as the caller knew it (search index); only a pre-open guess. */
  indexedDeclaredMode?: string;
}

/** Everything the chain needs except how a gone document is forgotten. */
export interface OpenChainBaseDeps extends OpenProjectDeps {
  modes: OpenRecentModes;
  /**
   * Is the project that is open right now a DEMO deployment?
   *
   * Asked AFTER the open, and asked of `project.kind`, not of the entry's
   * backend: `bundled` is not the same thing as demo — a deploy root carrying
   * a customer manifest is bundled too (`project-store.ts:1374-1402`,
   * SOL R2 F6a).
   */
  isDemoProject(): boolean;
  /**
   * The open project's documents — read from the STORE, not from React.
   *
   * `mode` is the row's own declared workspace mode — one of the inputs of the
   * target decision (plan-513), read live after the project open.
   */
  documents(): readonly { id: string; mode?: string }[];
  /**
   * `openDocumentAsWorkingScene` bound to the live viewer + scene store.
   *
   * Takes the chain's switch token so the handoff's `requestMode('editor')` is
   * the one re-entry allowed while the chain holds the workspace lock, and the
   * target mode the chain decided (plan-513), which the handoff carries out
   * without asking again. Resolves `false` when the editor refused its
   * re-entry (editor → editor); anything else counts as done.
   */
  openDocument(documentId: string, switchToken?: symbol, targetMode?: string): Promise<void | boolean>;
  /**
   * Ask about UNSAVED SCENE work before anything moves (plan-478 R3-1).
   *
   * The dashboard's own `trySwitch` sits in the host and wraps only the host's
   * own verbs; this chain calls the handoff directly, so without this
   * dependency a recents click walked straight past the unsaved-changes dialog
   * that every other document switch raises. Resolves `false` when the user
   * cancels. Optional, so a headless caller (MCP, a test) is not forced to
   * model a dialog it has no screen for.
   */
  confirmDiscardDirtyScene?(): Promise<boolean>;
  /** Surface a message to the user. */
  notify(message: string): void;
}

export interface OpenDocumentDeps extends OpenChainBaseDeps {
  /** Drop the caller's record of a document that has gone (F7 / plan-509 F6). */
  forget(projectId: string, documentId: string): void;
}

export interface OpenRecentDeps extends OpenChainBaseDeps {
  /** Drop a recent whose document has gone (F7). */
  forgetRecent(projectId: string, documentId: string): void;
}

/** `mode` when this build registers it, else null — an unknown mode is no target. */
function registered(mode: string | undefined, modes: OpenRecentModes): string | null {
  return mode && modes.has(mode) ? mode : null;
}

/** The mode the open project's own row for the target declares, or null. */
function liveRowModeOf(target: OpenDocumentTarget, deps: OpenChainBaseDeps): string | null {
  const row = deps.documents().find(d => d.id === target.documentId);
  return typeof row?.mode === 'string' && row.mode ? row.mode : null;
}

let inFlight = false;

/** Is a recents open running right now? The UI disables its rows on this. */
export function isOpeningRecent(): boolean {
  return inFlight;
}

/**
 * A recent, through the shared chain — the wrapper the recents UI calls.
 *
 * The entry's own `mode` is history, not a target (plan-513): the caller reads
 * the document's last mode from `rv-document-modes` and hands it in.
 */
export async function openRecentEntry(
  entry: RecentDocumentEntry,
  deps: OpenRecentDeps,
  opts: { lastMode?: string | null } = {},
): Promise<OpenRecentResult> {
  const { forgetRecent, ...base } = deps;
  return openProjectDocument({
    projectId: entry.projectId,
    backend: entry.backend,
    documentId: entry.documentId,
    projectName: entry.projectName,
    ...(opts.lastMode ? { lastMode: opts.lastMode } : {}),
  }, { ...base, forget: forgetRecent });
}

/**
 * The chain: guards, project, target decision, document (plan-478, generalised
 * by plan-509, one mode decision since plan-513). Shared by recents, the model
 * search and the open project's cards.
 */
export async function openProjectDocument(
  entry: OpenDocumentTarget,
  deps: OpenDocumentDeps,
): Promise<OpenRecentResult> {
  if (inFlight) return 'busy';
  inFlight = true;
  // The SHARED interlock, taken before any question is asked (plan-478 R3-2).
  // `inFlight` above only stops a second RECENT; this also stands aside for a
  // mode switch that is already mid-dialog — the case where both sides
  // previously believed they were the only switch in progress, each asked its
  // own guards, and both then switched. The token travels down to the handoff
  // so its `requestMode('editor')` is the one re-entry the lock allows.
  const token = deps.modes.acquireSwitchLock();
  if (token === null) { inFlight = false; return 'busy'; }
  try {
    const { modes } = deps;
    const current = deps.currentProject();
    const sameProject = current !== null
      && current.id === entry.projectId
      && current.backend === entry.backend;

    // (0.5) Unsaved SCENE work — before the mode guards and before any
    // mutation, including the same-project/same-mode case in which nothing
    // else in this chain would have asked the user anything at all.
    if (deps.confirmDiscardDirtyScene && !(await deps.confirmDiscardDirtyScene())) {
      return 'dirty-cancelled';
    }

    const park = handoffParkMode(modes);
    const lastMode = registered(entry.lastMode, modes);
    /** The transition already asked about, so it is never asked twice. */
    let asked: string | null = null;

    if (!sameProject) {
      // (1) Before anything moves — but only from what cannot be stale: the
      // stored last mode. The index's declared mode stays out (SOL R2 F2): a
      // stale index must not veto an open the live row would have allowed.
      const guess = lastMode ?? modes.activeMode;
      const early = guess ? plannedDeparture(modes.activeMode, guess, park) : null;
      if (early !== null && !(await modes.runExitGuards(early, token))) return 'vetoed';
      asked = early;

      // (2) Project.
      const result = await openProjectById(
        { projectId: entry.projectId, backend: entry.backend }, deps);
      if (result !== 'opened' && result !== 'already-open') {
        // Nothing was activated yet — step 1 only ASKED — so there is no mode
        // to restore. That is the whole benefit of asking before acting.
        if (result === 'cancelled') return 'project-cancelled';
        if (result === 'denied') return 'project-denied';
        if (result === 'missing') return 'project-missing';
        deps.notify('That project could not be opened.');
        return 'project-failed';
      }
    }

    // (3) The ONE decision: the live row and the project's kind are readable
    // now. A demo takes no last mode (plan-478 stays).
    const decided = effectiveOpenMode({
      lastMode,
      declaredMode: liveRowModeOf(entry, deps),
      isDemo: deps.isDemoProject(),
      has: (m) => modes.has(m),
    });
    const target = decided ?? modes.activeMode;
    const departure = target ? plannedDeparture(modes.activeMode, target, park) : null;
    if (departure !== null && departure !== asked
      && !(await modes.runExitGuards(departure, token))) {
      return sameProject ? 'vetoed' : 'vetoed-after-open';
    }

    // (4) Document — through the existing handoff, read off the STORE's
    // document list. The host's React snapshot is a frame behind at this point
    // and would still be describing the previous project.
    if (!deps.documents().some(d => d.id === entry.documentId)) {
      deps.forget(entry.projectId, entry.documentId);
      deps.notify('That document could not be found any more.');
      return 'document-missing';
    }
    // The handoff carries the target out — no mode step after it. Its only
    // way to say no is the editor refusing its own re-entry (editor → editor).
    const done = await deps.openDocument(entry.documentId, token, target ?? undefined);
    return done === false ? 'vetoed-after-open' : 'opened';
  } finally {
    // Always, and in this order: a leaked lock leaves the mode dropdown inert
    // for the rest of the session, which is a worse failure than any this
    // chain can otherwise produce.
    deps.modes.releaseSwitchLock(token);
    inFlight = false;
  }
}

/** Tests only. */
export function __resetOpenRecentInFlight(): void {
  inFlight = false;
}
