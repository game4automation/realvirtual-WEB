// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-rename-wiring — connects the signal-rename coordinator (plan-590) to the documents the
 * viewer opens, and gives the command, the dialog and the MCP tool ONE way to reach it.
 *
 * Three jobs:
 *
 *  1. **Environment.** {@link signalRenameEnvironmentFor} decides which document a rename writes
 *     to. In the asset editor that is the open `AssetDocument` (the editor has no scene overlay);
 *     everywhere else it is the `SceneStore`. Read on every apply / undo, so a rename follows the
 *     mode the user is in, not the mode the coordinator was created in.
 *  2. **History interception.** {@link installSignalRenameWiring} makes the coordinator the history
 *     interceptor of the scene document and of every asset document the editor opens — at OPEN
 *     time, not only when a rename writes. A tagged entry (`meta.journalId`) whose journal is gone
 *     (the page was reloaded) is then refused instead of being undone model-only, which would leave
 *     CONNECT, planner and historian on the new name.
 *  3. **Feedback.** A refused undo / redo leaves the stacks where they were and says why, as a
 *     toast — read from `RvDocument.lastHistoryInterception`, the one place the verdict is kept.
 *
 * {@link summarizeSignalRenamePlan} is the serialisable preview the command returns for a dry run:
 * the plan without the step payloads (ST code can be long), which is what the dialog renders and
 * what an MCP client reads.
 */

import type { RVViewer } from '../rv-viewer';
import type { RvDocument, RvHistoryInterception } from '../ops/rv-document';
import {
  createDefaultSignalRenameEnvironment,
  getSignalRenameCoordinator,
  signalRenameDocTargetForAsset,
  type SignalRenameCoordinator,
  type SignalRenameEnvironment,
} from '../engine/rv-signal-rename-coordinator';
import type {
  SignalRenameConnectInfo,
  SignalRenamePlan,
  SignalRenameStepKind,
  SignalRenameViewerLike,
} from '../engine/rv-signal-rename';
import { getActiveAssetContext, subscribeActiveAsset } from '../editor/active-asset-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { showInstruction } from './instruction-store';

/** Mode id of the asset editor (same spelling as `rv-editor-guard-core`). */
const EDITOR_MODE = 'editor';

type RenameViewer = SignalRenameViewerLike & { getPlugin?(id: string): unknown };
/** The live viewer, or the structural slice the coordinator reads (tests). */
export type SignalRenameWiringViewer = RVViewer | RenameViewer;

// ─── Environment / coordinator ───────────────────────────────────────────

/**
 * The rename environment of `viewer` right now: the asset document in the editor (no overlay), the
 * scene store otherwise. CONNECT, planner, historian and Problems come from the default wiring.
 */
export function signalRenameEnvironmentFor(wiringViewer: SignalRenameWiringViewer): SignalRenameEnvironment {
  const viewer = wiringViewer as unknown as RenameViewer;
  const modes = (viewer as { modes?: { activeMode?: string } }).modes;
  const ctx = modes?.activeMode === EDITOR_MODE ? getActiveAssetContext() : null;
  if (ctx) {
    return createDefaultSignalRenameEnvironment(viewer, {
      model: signalRenameDocTargetForAsset(viewer, ctx.doc),
      overlay: null,
    });
  }
  return createDefaultSignalRenameEnvironment(viewer);
}

/**
 * THE coordinator of `viewer`. Every caller goes through here, so the environment provider is the
 * mode-following one regardless of who asks first.
 */
export function signalRenameCoordinatorFor(wiringViewer: SignalRenameWiringViewer): SignalRenameCoordinator {
  const viewer = wiringViewer as unknown as RenameViewer;
  return getSignalRenameCoordinator(viewer, () => signalRenameEnvironmentFor(viewer));
}

// ─── History interception + refused-undo toast ───────────────────────────

/** Instruction id of the refused-undo toast (one at a time — a second refusal replaces it). */
export const SIGNAL_RENAME_REFUSED_TOAST_ID = 'signal-rename-history-refused';

/** The sentence a refused undo / redo of a rename shows. */
export function describeRefusedHistoryMove(
  coordinator: SignalRenameCoordinator, interception: RvHistoryInterception,
): string {
  const verb = interception.direction === 'undo' ? 'Undo' : 'Redo';
  const entry = coordinator.entry(interception.journalId);
  if (!entry) {
    return `${verb} of a signal rename from an earlier session is not possible — `
      + 'its CONNECT, planner and historian parts are no longer known. Rename the signal again instead.';
  }
  const what = `${verb} of the signal rename "${entry.oldName}" → "${entry.newName}" was refused`;
  if (coordinator.lockedBy) return `${what}: a rename has an unknown CONNECT outcome — re-check it in Problems first.`;
  if (entry.state === 'inconsistent') return `${what}: the rename is inconsistent — repair it in Problems first.`;
  if (entry.error) return `${what}: ${entry.error}`;
  return `${what}: a document was edited after the rename, or CONNECT is not reachable. Nothing was changed.`;
}

/**
 * Watch one document for refused interceptions. `seen` starts at the CURRENT interception, so an
 * old refusal is never toasted when the document is (re)attached.
 */
function watchRefusals(coordinator: SignalRenameCoordinator, doc: RvDocument): () => void {
  let seen = doc.lastHistoryInterception;
  return doc.subscribe(() => {
    const now = doc.lastHistoryInterception;
    if (!now || now === seen) return;
    seen = now;
    if (now.verdict !== 'refused') return;
    showInstruction({
      id: SIGNAL_RENAME_REFUSED_TOAST_ID,
      text: describeRefusedHistoryMove(coordinator, now),
      anchor: { kind: 'edge', edge: 'bottom' },
      style: 'toast',
      autoClearAfterMs: 6000,
      source: 'signal-rename',
    });
  });
}

const _installed = new WeakMap<object, () => void>();

/**
 * Make the coordinator of `viewer` the history interceptor of the scene document and of every
 * asset document the editor opens, and toast refused moves. Idempotent per viewer; returns the
 * uninstall function.
 */
export function installSignalRenameWiring(viewer: RVViewer): () => void {
  const existing = _installed.get(viewer);
  if (existing) return existing;
  const coordinator = signalRenameCoordinatorFor(viewer);
  const watched = new Map<RvDocument, () => void>();

  const attach = (doc: RvDocument | null | undefined): void => {
    if (!doc || watched.has(doc)) return;
    coordinator.attach(doc);
    watched.set(doc, watchRefusals(coordinator, doc));
  };
  const sync = (): void => {
    attach(getSceneStore()?.document);
    attach(getActiveAssetContext()?.doc.document);
  };

  sync();
  const offAsset = subscribeActiveAsset(sync);
  const uninstall = (): void => {
    offAsset();
    for (const off of watched.values()) off();
    watched.clear();
    coordinator.dispose();
    _installed.delete(viewer);
  };
  _installed.set(viewer, uninstall);
  return uninstall;
}

// ─── Serialisable preview ────────────────────────────────────────────────

/** One step of a preview — the plan step without its payload. */
export interface SignalRenamePreviewStep {
  kind: SignalRenameStepKind;
  label: string;
  detail?: string;
  write: boolean;
  nodePath?: string;
  count?: number;
}

/** What a dry run returns: everything the dialog shows, nothing it does not need. */
export interface SignalRenamePreview {
  oldName: string;
  newName: string;
  nodePath: string;
  signalType: string;
  ok: boolean;
  blockers: string[];
  warnings: string[];
  wireChanges: SignalRenamePlan['wireChanges'];
  requiresWireConfirmation: boolean;
  counts: Record<SignalRenameStepKind, number>;
  steps: SignalRenamePreviewStep[];
  owners: string[];
  scope: string;
  connect: SignalRenameConnectInfo;
}

/** The serialisable preview of a plan (the step values — ST code, mapping arrays — are left out). */
export function summarizeSignalRenamePlan(plan: SignalRenamePlan): SignalRenamePreview {
  return {
    oldName: plan.oldName,
    newName: plan.newName,
    nodePath: plan.nodePath,
    signalType: plan.signalType,
    ok: plan.ok,
    blockers: [...plan.blockers],
    warnings: [...plan.warnings],
    wireChanges: plan.wireChanges.map((w) => ({ ...w })),
    requiresWireConfirmation: plan.requiresWireConfirmation,
    counts: { ...plan.counts },
    steps: plan.steps.map((s) => ({
      kind: s.kind,
      label: s.label,
      ...(s.detail ? { detail: s.detail } : {}),
      write: s.write,
      ...(s.nodePath ? { nodePath: s.nodePath } : {}),
      ...(s.count !== undefined ? { count: s.count } : {}),
    })),
    owners: [...plan.owners],
    scope: plan.scope,
    connect: {
      ...plan.connect,
      changedInterfaces: plan.connect.changedInterfaces.map((c) => ({ ...c })),
      inactiveProfiles: [...plan.connect.inactiveProfiles],
    },
  };
}
