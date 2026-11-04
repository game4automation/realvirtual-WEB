// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * library-commands — attach / detach a library to the open project, and the
 * two availability repairs, as registry commands (plan-655 F1, SOL review R1-4;
 * plan-778 Phase 2, F10/F11).
 *
 * | Command          | UI view                                        | MCP |
 * |------------------|------------------------------------------------|-----|
 * | `library.attach` | Add library… (Projects / URL / GitHub tabs)    | `web_execute("library.attach", {projectId})` or `{url}` |
 * | `library.detach` | Remove library (dashboard tree, planner panel) | `web_execute("library.detach", {projectId})` or `{url}` |
 * | `library.grant`  | **Grant** (Problems row, planner / dashboard badge) | `web_execute("library.grant", {projectId})` — needs a click |
 * | `library.locate` | **Locate folder…** (Problems row, badges)      | `web_execute("library.locate", {projectId})` — needs a click |
 * | `library.migrate` | **Update** (Problems row "Library reference can be updated", customer projects) | `web_execute("library.migrate", {})` — converts the realvirtual catalog URL to the library project id |
 *
 * `library.attach` / `library.detach` take EITHER `projectId` (a library
 * project, plan-778) OR `url` (an external catalog) — never both. The legacy
 * bundled catalog URL `/library/catalog.json` is a shim for the realvirtual
 * library project (`{projectId:'prj_realvirtual_library'}`); detaching ANY realvirtual
 * library URL (bundled or GitHub) detaches that project and drops every such URL entry.
 *
 * Grant and Locate call `requestPermission` / `showDirectoryPicker` as the
 * first statement of their `run` (`library-availability.ts`): these commands
 * are EAGER, so the registry reaches `run` synchronously from the click.
 */

import {
  commandRegistry,
  CommandError,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../hmi/rv-command-registry';
import type { RVViewer } from '../rv-viewer';
import { getProjectStore } from '../project/project-store';
import { readProjectLibraries } from './project-libraries';
import {
  attachLibraryToProject,
  attachProjectLibrary,
  countLibraryPlacements,
  detachLibraryFromProject,
  detachConfirmationMessage,
  detachProjectLibrary,
  EMPTY_URL,
  isLibraryProjectListed,
  libraryRemovalKeepsAvailable,
  NO_PROJECT_OPEN,
  notAttached,
  projectIdRefusal,
  projectNotAttached,
  type LibraryAttachDeps,
  type QualifiedPlacementLike,
} from './project-library-attach';
import { isBundledRealvirtualCatalogUrl, isRealvirtualCatalogUrl, REALVIRTUAL_LIBRARY_PROJECT_ID } from './library-origin';
import { getLibraryProjectLoader } from './library-project-loader';
import {
  grantLibraryAccess,
  grantRefusal,
  LIBRARY_GRANT_COMMAND,
  LIBRARY_LOCATE_COMMAND,
  locateLibraryFolder,
  locateRefusal,
} from './library-availability';
import {
  applyLibraryReferenceUpdate,
  LIBRARY_MIGRATE_COMMAND,
  migrateRefusal,
} from './library-reference-update';

export interface LibraryAttachArgs {
  readonly url?: string | null;
  readonly projectId?: string | null;
  readonly label?: string | null;
  readonly hint?: string | null;
}
export interface LibraryDetachArgs { readonly url?: string | null; readonly projectId?: string | null }
export interface LibraryProjectArgs { readonly projectId: string }

/** Button key of the dialog's Attach button — the UI view of `library.attach`. */
export const LIBRARY_ATTACH_KEY = 'library.attach';
export const LIBRARY_DETACH_KEY = 'library.detach';

export const URL_OR_PROJECT_ID = 'Give either projectId (a library project) or url (an external catalog), not both.';
export const EMPTY_TARGET = 'projectId (a library project, e.g. "prj_realvirtual_library") or url (a catalog.json URL) is required.';
const REALVIRTUAL_LIBRARY_LABEL = 'realvirtual Library';

const UNAVAILABLE = 'Libraries need an open project — open one with web_project_open first.';

/** Test seam: the project / library stores the commands act on (default: the app singletons). */
let _deps: LibraryAttachDeps | undefined;
export function setLibraryCommandDepsForTests(d: LibraryAttachDeps | null): void { _deps = d ?? undefined; }

function openProject(): ReturnType<ReturnType<typeof getProjectStore>['getProject']> {
  try { return _deps?.project ? _deps.project.getProject() : getProjectStore().getProject(); } catch { return null; }
}

/** What an attach / detach call targets once the shim is applied. */
type Target =
  | { kind: 'project'; projectId: string; label: string | null; hint: string | null }
  | { kind: 'url'; url: string; label: string | null }
  | { kind: 'refused'; reason: string };

function attachTarget(a: LibraryAttachArgs | undefined): Target {
  const url = String(a?.url ?? '').trim();
  const projectId = String(a?.projectId ?? '').trim();
  const label = typeof a?.label === 'string' && a.label.trim() ? a.label.trim() : null;
  if (url && projectId) return { kind: 'refused', reason: URL_OR_PROJECT_ID };
  if (projectId) {
    const refusal = projectIdRefusal(projectId);
    if (refusal) return { kind: 'refused', reason: refusal };
    const hint = typeof a?.hint === 'string' && a.hint.trim() ? a.hint.trim() : null;
    return { kind: 'project', projectId, label, hint };
  }
  if (!url) return { kind: 'refused', reason: EMPTY_TARGET };
  // Legacy shim (plan-778 F10): the bundled catalog IS the realvirtual library project now.
  if (isBundledRealvirtualCatalogUrl(url)) {
    return { kind: 'project', projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: label ?? REALVIRTUAL_LIBRARY_LABEL, hint: null };
  }
  return { kind: 'url', url, label };
}

function detachTarget(a: LibraryDetachArgs | undefined): Target {
  const url = String(a?.url ?? '').trim();
  const projectId = String(a?.projectId ?? '').trim();
  if (url && projectId) return { kind: 'refused', reason: URL_OR_PROJECT_ID };
  if (projectId) return { kind: 'project', projectId, label: null, hint: null };
  if (!url) return { kind: 'refused', reason: EMPTY_TARGET };
  // plan-778 review E1: EVERY realvirtual library URL (bundled or GitHub,
  // listed or not) detaches the realvirtual library PROJECT — one delta that
  // drops the id entry and every such URL entry. A detach by URL would be
  // undone by the migration fold of an unmigrated project's first save.
  if (isRealvirtualCatalogUrl(url)) {
    return { kind: 'project', projectId: REALVIRTUAL_LIBRARY_PROJECT_ID, label: null, hint: null };
  }
  return { kind: 'url', url, label: null };
}

/** The planner's placement records, when the planner is loaded (Decision D count). */
function placedRecordsOf(viewer: RVViewer | undefined): readonly QualifiedPlacementLike[] {
  try {
    const planner = viewer?.getPlugin?.('layout-planner') as
      { store?: { getSnapshot?: () => { placed?: readonly QualifiedPlacementLike[] } } } | undefined;
    return planner?.store?.getSnapshot?.()?.placed ?? [];
  } catch {
    return [];
  }
}

/** How many placements of the open document name library `projectId` (Decision D). */
export function countOpenLibraryPlacements(viewer: RVViewer | undefined, projectId: string): number {
  return countLibraryPlacements(placedRecordsOf(viewer), projectId);
}

const attach: CommandImpl<LibraryAttachArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const t = attachTarget(a);
    if (t.kind === 'refused') return { reason: t.reason };
    if (!openProject()) return { reason: NO_PROJECT_OPEN };
    return true;
  },
  run: async (_ctx, a) => {
    const t = attachTarget(a);
    if (t.kind === 'refused') throw new CommandError(t.reason);
    if (t.kind === 'project') {
      const r = await attachProjectLibrary({ projectId: t.projectId, label: t.label, hint: t.hint }, _deps);
      if (!r.ok) throw new CommandError(r.reason);
      return {
        ...r,
        next: `Its documents are listed by web_query("library.catalogList", {}) (source "library-projects/${t.projectId}"); `
          + 'its availability by web_query("library.list", {}).',
      };
    }
    const r = await attachLibraryToProject(t.url, t.label, _deps);
    if (!r.ok) throw new CommandError(r.reason);
    return { ...r, next: 'Its parts are listed by web_query("library.catalogList", {}) (source "catalog").' };
  },
};

const detach: CommandImpl<LibraryDetachArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const t = detachTarget(a);
    if (t.kind === 'refused') return { reason: t.reason };
    const project = openProject();
    if (!project) return { reason: NO_PROJECT_OPEN };
    if (t.kind === 'project' && !isLibraryProjectListed(project, t.projectId)) return { reason: projectNotAttached(t.projectId) };
    if (t.kind === 'url' && !readProjectLibraries(project).includes(t.url)) return { reason: notAttached(t.url) };
    return true;
  },
  run: async (ctx, a) => {
    const t = detachTarget(a);
    if (t.kind === 'refused') throw new CommandError(t.reason);
    if (t.kind === 'project') {
      const placements = countOpenLibraryPlacements(ctx.viewer, t.projectId);
      // Asked BEFORE the detach — afterwards the loader holds the new graph (review U1).
      const loader = getLibraryProjectLoader();
      const keeps = libraryRemovalKeepsAvailable(loader, t.projectId);
      const label = loader?.getNode(t.projectId)?.label ?? t.projectId;
      const r = await detachProjectLibrary(t.projectId, { ..._deps, placements });
      if (!r.ok) throw new CommandError(r.reason);
      return {
        ...r,
        ...(placements > 0 || keeps ? { note: detachConfirmationMessage(label, placements, keeps) } : {}),
      };
    }
    const r = await detachLibraryFromProject(t.url, _deps);
    if (!r.ok) throw new CommandError(r.reason);
    return { ...r };
  },
};

const grant: CommandImpl<LibraryProjectArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const reason = grantRefusal(String(a?.projectId ?? '').trim());
    return reason ? { reason } : true;
  },
  run: async (_ctx, a) => {
    // FIRST statement reaches `requestPermission` — no await before it (user activation).
    const r = await grantLibraryAccess(String(a.projectId ?? '').trim());
    if (!r.ok) throw new CommandError(r.reason);
    return { ...r };
  },
};

const locate: CommandImpl<LibraryProjectArgs, Record<string, unknown>> = {
  enabled: (_ctx, a) => {
    const reason = locateRefusal(String(a?.projectId ?? '').trim());
    return reason ? { reason } : true;
  },
  run: async (_ctx, a) => {
    // FIRST statement reaches `showDirectoryPicker` — no await before it (user activation).
    const r = await locateLibraryFolder(String(a.projectId ?? '').trim());
    if (!r.ok) throw new CommandError(r.reason);
    return { ...r };
  },
};

const migrate: CommandImpl<Record<string, never>, Record<string, unknown>> = {
  enabled: () => {
    const reason = migrateRefusal(_deps?.project);
    return reason ? { reason } : true;
  },
  run: async () => {
    const r = await applyLibraryReferenceUpdate(_deps?.project);
    if (!r.ok) throw new CommandError(r.reason);
    return { ...r };
  },
};

/** Build the descriptors (testable seam: no registry side effect). */
export function createLibraryCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    // plan-2007 Phase 4B: library.list / catalogList / catalogDescribe live in
    // core/hmi/query-commands.ts — their bodies sit in a decorated MCP tool file, and this
    // module is in the embed build's graph (ProjectsDashboardHost), which cannot transform it.
    {
      id: 'library.attach', label: 'Attach library', readOnly: false, scope: 'none',
      available: true, unavailableReason: UNAVAILABLE,
      buttonKey: () => LIBRARY_ATTACH_KEY,
      mcp: {
        tool: 'web_library_attach',
        // plan-778: projectId or url.
        params: [
          { name: 'projectId', type: 'string', required: false }, { name: 'url', type: 'string', required: false },
          { name: 'label', type: 'string', required: false }, { name: 'hint', type: 'string', required: false },
        ],
      },
      argsSchema: { projectId: 'string', url: 'string', label: 'string', hint: 'string' },
      eagerImpl: attach as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(attach as CommandImpl<never, unknown>),
    },
    {
      id: 'library.detach', label: 'Remove library', readOnly: false, scope: 'none',
      available: true, unavailableReason: UNAVAILABLE,
      buttonKey: () => LIBRARY_DETACH_KEY,
      mcp: {
        tool: 'web_library_detach',
        params: [{ name: 'projectId', type: 'string', required: false }, { name: 'url', type: 'string', required: false }],
      },
      argsSchema: { projectId: 'string', url: 'string' },
      eagerImpl: detach as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(detach as CommandImpl<never, unknown>),
    },
    {
      id: LIBRARY_GRANT_COMMAND, label: 'Grant library access', readOnly: false, scope: 'none',
      available: true, unavailableReason: UNAVAILABLE,
      argsSchema: { projectId: 'string' },
      eagerImpl: grant as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(grant as CommandImpl<never, unknown>),
    },
    {
      id: LIBRARY_LOCATE_COMMAND, label: 'Locate library folder', readOnly: false, scope: 'none',
      available: true, unavailableReason: UNAVAILABLE,
      argsSchema: { projectId: 'string' },
      eagerImpl: locate as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(locate as CommandImpl<never, unknown>),
    },
    {
      id: LIBRARY_MIGRATE_COMMAND, label: 'Update library reference', readOnly: false, scope: 'none',
      available: true, unavailableReason: UNAVAILABLE,
      argsSchema: {},
      eagerImpl: migrate as CommandImpl<never, unknown>,
      impl: () => Promise.resolve(migrate as CommandImpl<never, unknown>),
    },
  ] as CommandDescriptor<never, unknown>[];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the library commands. */
export function ensureLibraryCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createLibraryCommandDescriptors()) registry.register(d);
}
