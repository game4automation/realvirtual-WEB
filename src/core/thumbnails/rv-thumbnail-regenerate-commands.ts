// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-thumbnail-regenerate-commands — "Regenerate thumbnails" of a project as
 * ONE registry command (plan-776 #20, plan-499).
 *
 * | Command                         | UI view                                   | MCP                                  |
 * |---------------------------------|-------------------------------------------|--------------------------------------|
 * | `project.regenerateThumbnails`  | project row ⋮ → "Regenerate thumbnails"   | `web_execute("project.regenerateThumbnails", {"projectId": …})` |
 *
 * #4 says nothing renders a thumbnail but a save; #20 adds exactly one
 * explicit exception: the user asks for every document of a project to be
 * re-rendered. It renders through the SAME path as a save — each document is
 * opened in the viewer the way every open opens it (placements materialised),
 * and the one writer (`rv-thumbnail-write.ts`) renders, writes and points the
 * row at the picture. Browsing still never loads a GLB (#2, guard 9.4).
 *
 * ## Why this module is light
 *
 * The dashboard registers the command and reads its `enabled()` rule for the
 * menu item (disabled + tooltip). The dashboard is the thumbnail READ side and
 * may not reach the renderer, the writer, the model cache or GLTFLoader — not
 * even lazily (guard 9.5). So this module holds the descriptor, the rule and
 * the project-open step only; the loop that loads documents and calls the
 * writer is `rv-thumbnail-regenerate.ts`, imported on the first run.
 *
 * ## The order inside `run()`
 *
 * A linked folder project that is not open is opened FIRST, the same way the
 * project list's Open does (`openProjectById` + `resolveLinkedOpen`, which may
 * ask for folder access again). That prompt needs the click's user activation,
 * so nothing slow — in particular not the lazy import of the loop — runs in
 * front of it. Refused access aborts the run with a message.
 */

import {
  commandRegistry,
  CommandError,
  type CommandContext,
  type CommandDescriptor,
  type CommandEnabled,
  type CommandImpl,
  type CommandRegistry,
  type ExecuteResult,
} from '../hmi/rv-command-registry';
import { getProjectStore } from '../project/project-store';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { readLinkedProjects } from '../project/rv-project-linked';
import { DEMO_PROJECT_ID } from '../project/backends/bundled-backend';
import { openProjectById, type OpenProjectResult } from '../hmi/projects/open-project-by-id';
import { resolveLinkedOpen } from '../hmi/projects/linked-project-verbs';
import {
  beginRegenerateProgress,
  finishRegenerateProgress,
  isRegenerateRunning,
} from './rv-thumbnail-regenerate-progress';

export const REGENERATE_THUMBNAILS_COMMAND = 'project.regenerateThumbnails';

export interface RegenerateThumbnailsArgs {
  /** The project's id, as the project list and `web_project_list` name it. */
  readonly projectId: string;
}

// ─── Refusal texts (tooltip AND tool result) ────────────────────────────

export const NO_PROJECT_ID = 'Name the project whose thumbnails to regenerate (projectId).';
export const READ_ONLY_PROJECT =
  'This project is read-only — its thumbnails cannot be written.';
export const ALREADY_RUNNING = 'Thumbnails are already being regenerated.';
export const UNSAVED_WORK =
  'Save or discard your unsaved changes first — Regenerate thumbnails opens every document of the project.';
export const NO_RENDERER = 'This viewer has no renderer — thumbnails cannot be rendered here.';
export const NO_SCENE_STORE = 'The scene store is not available.';
export const unknownProject = (id: string): string =>
  `No project "${id}" is open or linked — see web_project_list.`;

// ─── The target project ─────────────────────────────────────────────────

/** Which project a run regenerates, and how it gets there. */
export type RegenerateTarget =
  | { kind: 'open' }
  | { kind: 'linked' }
  | { kind: 'refused'; reason: string };

/**
 * The open project when it is the one named, a linked folder that will be
 * opened first, or why neither.
 *
 * "Open" is the PAIR, never the id alone (the `openProjectById` rule):
 * DemoRealvirtual exists under one id as the read-only bundled fallback and as
 * a linked folder, so a bundled open of a linked id targets the folder.
 */
export function regenerateTargetOf(projectId: string): RegenerateTarget {
  const store = getProjectStore();
  const open = store.getProject();
  const backend = store.getBackend();
  const isLinked = readLinkedProjects().some(l => l.id === projectId);
  if (open?.id === projectId && backend && !(backend.kind === 'bundled' && isLinked)) {
    return backend.writable ? { kind: 'open' } : { kind: 'refused', reason: READ_ONLY_PROJECT };
  }
  if (isLinked) return { kind: 'linked' };
  if (projectId === DEMO_PROJECT_ID) return { kind: 'refused', reason: READ_ONLY_PROJECT };
  return { kind: 'refused', reason: unknownProject(projectId) };
}

function projectIdOf(args: RegenerateThumbnailsArgs | null | undefined): string {
  return typeof args?.projectId === 'string' ? args.projectId.trim() : '';
}

/** THE availability rule — the menu item's tooltip and the tool's refusal. */
export function regenerateThumbnailsEnabled(
  viewer: { renderer?: unknown } | null | undefined,
  args: RegenerateThumbnailsArgs | null | undefined,
): CommandEnabled {
  const projectId = projectIdOf(args);
  if (!projectId) return { reason: NO_PROJECT_ID };
  const target = regenerateTargetOf(projectId);
  if (target.kind === 'refused') return { reason: target.reason };
  if (isRegenerateRunning()) return { reason: ALREADY_RUNNING };
  if (!getSceneStore()) return { reason: NO_SCENE_STORE };
  if (!viewer?.renderer) return { reason: NO_RENDERER };
  if (getProjectStore().hasUnsavedWork()) return { reason: UNSAVED_WORK };
  return true;
}

// ─── What was open before (re-opened at the end) ────────────────────────

/** The workspace before the run — the loop re-opens it when it is still reachable. */
export interface WorkspaceBookmark {
  projectId: string | null;
  /** The open document's manifest id, when the workspace is a document. */
  documentId: string | null;
  /** A non-document workspace that can be re-opened (a bundled model, the empty one). */
  base: { kind: 'builtin'; url: string; label: string } | { kind: 'empty' } | null;
  mode: string | null;
}

/** Read the bookmark NOW — before a project switch replaces what it describes. */
export function captureWorkspaceBookmark(viewer: { modes?: { activeMode?: string | null } }): WorkspaceBookmark {
  const scene = getSceneStore();
  const identity = scene?.documentIdentity() ?? null;
  const snap = scene?.getSnapshot();
  const draftBase = snap && !snap.transient ? snap.draft?.base ?? null : null;
  return {
    projectId: getProjectStore().getProject()?.id ?? null,
    documentId: identity && identity.kind === 'document' ? identity.documentId : null,
    base: draftBase?.kind === 'builtin'
      ? { kind: 'builtin', url: draftBase.url, label: draftBase.label }
      : draftBase?.kind === 'empty' ? { kind: 'empty' } : null,
    mode: viewer.modes?.activeMode ?? null,
  };
}

// ─── The project-open step ──────────────────────────────────────────────

const OPEN_REFUSALS: Record<Exclude<OpenProjectResult, 'opened' | 'already-open'>, string> = {
  denied: 'Folder access was not granted — the thumbnails were not regenerated.',
  missing: 'The project folder was not found — use Locate… in the project list first.',
  cancelled: 'The project was not opened — the thumbnails were not regenerated.',
  failed: 'The project could not be opened — the thumbnails were not regenerated.',
};

/** Make the target the open project (asking for folder access like Open does). Answers a refusal or null. */
async function openTarget(projectId: string): Promise<string | null> {
  const target = regenerateTargetOf(projectId);
  if (target.kind === 'refused') return target.reason;
  if (target.kind === 'linked') {
    const store = getProjectStore();
    const r = await openProjectById(
      { projectId, backend: 'folder' },
      {
        currentProject: () => null,
        isLinked: () => true,
        resolveLinkedOpen,
        store,
      },
    );
    if (r !== 'opened' && r !== 'already-open') return OPEN_REFUSALS[r];
  }
  // A folder whose write permission was refused opens READ-ONLY (it never throws).
  const backend = getProjectStore().getBackend();
  if (!backend?.writable || getProjectStore().getProject()?.id !== projectId) {
    return READ_ONLY_PROJECT;
  }
  return null;
}

function projectNameOf(projectId: string): string | null {
  const open = getProjectStore().getProject();
  if (open?.id === projectId) return open.name ?? null;
  return readLinkedProjects().find(l => l.id === projectId)?.name ?? null;
}

// ─── The command ────────────────────────────────────────────────────────

const regenerate: CommandImpl<RegenerateThumbnailsArgs, unknown> = {
  enabled: (ctx: CommandContext, args) =>
    regenerateThumbnailsEnabled(ctx.viewer as unknown as { renderer?: unknown }, args),
  run: async (ctx, args) => {
    const projectId = projectIdOf(args);
    const bookmark = captureWorkspaceBookmark(ctx.viewer);
    const controller = new AbortController();
    ctx.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    beginRegenerateProgress({ id: projectId, name: projectNameOf(projectId) }, () => controller.abort());
    let cancelled = false;
    try {
      const refusal = await openTarget(projectId);
      if (refusal) throw new CommandError(refusal);
      // Only now the loop and, through it, the writer and the renderer.
      const { regenerateProjectThumbnails, viewerRegenerateDeps } = await import('./rv-thumbnail-regenerate');
      const result = await regenerateProjectThumbnails(
        viewerRegenerateDeps(ctx.viewer, bookmark),
        { projectId, projectName: projectNameOf(projectId), signal: controller.signal },
      );
      cancelled = result.cancelled;
      finishRegenerateProgress({ cancelled });
      return result;
    } catch (e) {
      finishRegenerateProgress({ cancelled, error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  },
};

/** Build the descriptor (testable seam: no registry side effect). */
export function createThumbnailCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    {
      id: REGENERATE_THUMBNAILS_COMMAND,
      label: 'Regenerate thumbnails',
      readOnly: false,
      scope: 'none',
      available: true,
      unavailableReason: 'Regenerating thumbnails needs a viewer with a renderer.',
      // One document after another, each a full load: far above the 120 s
      // web_execute timeout for a real project, so MCP runs it as a job.
      timeoutMs: 30 * 60_000,
      cancellable: true,
      argsSchema: { projectId: 'string' },
      eagerImpl: regenerate as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(regenerate as CommandImpl<never, unknown>),
    },
  ] as CommandDescriptor<never, unknown>[];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration (the dashboard host and the MCP bridge call it). */
export function ensureThumbnailCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createThumbnailCommandDescriptors()) registry.register(d);
}

// ─── The menu item's two halves (the project row is a VIEW of the command) ──

type RegistryViewer = Parameters<CommandRegistry['enabled']>[2];

/** The row's ⋮ item: `true`, or the reason it is disabled (its tooltip). */
export function regenerateThumbnailsMenuState(
  projectId: string,
  viewer: RegistryViewer,
  registry: CommandRegistry = commandRegistry,
): true | { reason: string } {
  ensureThumbnailCommandsRegistered(registry);
  const en = registry.enabled(REGENERATE_THUMBNAILS_COMMAND, { projectId }, viewer);
  return en === true ? true : { reason: en.reason };
}

/** The row's ⋮ item clicked: dispatch the command by id, in the click's tick. */
export function dispatchRegenerateThumbnails(
  projectId: string,
  viewer: RegistryViewer,
  registry: CommandRegistry = commandRegistry,
): Promise<ExecuteResult> {
  ensureThumbnailCommandsRegistered(registry);
  return registry.execute(REGENERATE_THUMBNAILS_COMMAND, { projectId }, { origin: 'ui', viewer });
}
