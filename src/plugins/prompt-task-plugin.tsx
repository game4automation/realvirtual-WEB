// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * prompt-task-plugin — right-click a part, type an order, an agent picks it up
 * (plan-486 Phases 3–5).
 *
 * ## The context comes from the MENU TARGET, not from the selection
 *
 * `ContextMenuTarget` already carries exactly what the order is about: the node
 * the user aimed at, its component types, its `rv_extras`, and the raycast hit
 * point. The selection store does not: its `primaryPath` is whatever was
 * clicked last, which after a right-click on a different part is the WRONG
 * node, and its remembered hit point is not updated by programmatic selection
 * at all. Using the target closes both holes by construction.
 *
 * ## Two collectors, assembled explicitly
 *
 * `collectNodeAiContext` answers "what is this part", `formatMachineStatus`
 * answers "what is the plant doing" — connection state, simulation pause, drive
 * and sensor counts, active errors. Neither contains the other, and a task
 * about a sensor that fires too early is unreadable without both.
 *
 * ## The shortcut refuses to guess a hit point (F9)
 *
 * The keyboard route has no cursor ray. A remembered hit point from an earlier
 * click may belong to a completely different part — click A, select B from the
 * hierarchy, press the shortcut — so the shortcut path sets NO hit point rather
 * than an attractive wrong one.
 *
 * ## Everything happens at submit time
 *
 * No mirroring in the render or simulation tick: the context is collected in
 * the `onSubmit` handler, once, and the optional `tasks/*.md` file is written
 * against a backend bound at that same moment.
 */

import { useSyncExternalStore } from 'react';
import type { RVViewer } from '../core/rv-viewer';
import type { RVViewerPlugin } from '../core/rv-plugin';
import { PLUGIN_ORDER } from '../core/rv-plugin-order';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { ContextMenuItem, ContextMenuTarget } from '../core/hmi/context-menu-store';
import {
  collectNodeAiContext,
  docHintsForNodes,
  formatMachineStatus,
  type SearchAiContextViewer,
} from '../core/hmi/search-ai-context';
import { getConnectSnapshot, getViewerMode } from '../core/hmi/connect-store';
import { isEditableTarget } from '../core/hmi/search-shortcut';
import { evaluateVisibilityRule, getActiveContexts } from '../core/hmi/ui-context-store';
import {
  buildPromptTask,
  promptTaskMirrorPath,
  renderPromptTaskMarkdown,
  type PromptTask,
} from '../core/hmi/prompt-task-envelope';
import { getPromptTaskStore, type PromptTaskStore } from '../core/hmi/prompt-task-store';
import {
  PROMPT_TASK_VISIBILITY,
  PromptTaskPanel,
} from '../core/hmi/PromptTaskPanel';

export const PROMPT_TASK_PLUGIN_ID = 'prompt-task';
const MENU_ITEM_ID = 'prompt.task';
const MENU_OPEN_ITEM_ID = 'prompt.task-panel';

// ─── Panel open/close, as a tiny external store ─────────────────────────
//
// The context-menu item and the React panel are on opposite sides of the
// React boundary, so the open flag cannot be component state.

let _panelOpen = false;
const _panelListeners = new Set<() => void>();

export function setPromptPanelOpen(open: boolean): void {
  if (_panelOpen === open) return;
  _panelOpen = open;
  for (const l of _panelListeners) l();
}

function subscribePanel(listener: () => void): () => void {
  _panelListeners.add(listener);
  return () => { _panelListeners.delete(listener); };
}

function PromptTaskPanelHost(_props: UISlotProps) {
  const open = useSyncExternalStore(subscribePanel, () => _panelOpen, () => false);
  return <PromptTaskPanel store={getPromptTaskStore()} open={open} onClose={() => setPromptPanelOpen(false)} />;
}

// ─── Visibility ─────────────────────────────────────────────────────────

/**
 * Is the prompt UI available at all? Same rule the panel uses, evaluated
 * outside React because a context-menu `condition` is a plain callback.
 */
export function promptUiAvailable(): boolean {
  return evaluateVisibilityRule(PROMPT_TASK_VISIBILITY, getActiveContexts());
}

// ─── Context collection ─────────────────────────────────────────────────

/** Reduce the model URL to the basename shown in the machine status. */
function modelNameFromUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const clean = url.replace(/\\/g, '/').replace(/[?#].*$/, '');
  const basename = clean.slice(clean.lastIndexOf('/') + 1);
  if (!basename) return undefined;
  try { return decodeURIComponent(basename); } catch { return basename; }
}

/** The always-on plant block — deliberately NOT what collectNodeAiContext returns. */
export function collectMachineStatusBlock(viewer: SearchAiContextViewer): string {
  const now = typeof performance === 'undefined' ? 0 : performance.now();
  const drives = viewer.drives;
  const sensors = viewer.transportManager?.sensors;
  const errors = viewer.errorStore?.getActive?.() ?? [];
  return formatMachineStatus({
    modelName: modelNameFromUrl(viewer.currentModelUrl),
    viewerMode: getViewerMode(),
    connectState: getConnectSnapshot().state,
    simulationPaused: viewer.isSimulationPaused,
    driveCount: drives?.length,
    drivesRunning: drives?.filter((d) => d.isRunning).length,
    sensorCount: sensors?.length,
    sensorsOccupied: sensors?.filter((s) => s.occupied).length,
    activeErrors: errors.filter((e) => e.active !== false).map((e) => ({
      path: e.path,
      text: e.text,
      sinceSeconds: typeof e.since === 'number' ? Math.max(0, (now - e.since) / 1000) : 0,
    })),
  });
}

/** Everything a task carries about the scene, collected once, at submit time. */
export function buildTaskFromTarget(
  viewer: RVViewer,
  prompt: string,
  target: Pick<ContextMenuTarget, 'path' | 'types' | 'hitPoint'>,
): PromptTask {
  const ctxViewer = viewer as unknown as SearchAiContextViewer;
  const path = target.path ?? '';
  const nodeContext = path ? collectNodeAiContext(ctxViewer, path) : null;
  const selected = viewer.selectionManager?.getSnapshot()?.selectedPaths ?? [];
  return buildPromptTask({
    prompt,
    targetPath: path,
    // The TARGET first: an agent reading `selectedPaths[0]` gets the node the
    // user aimed at, not whatever happened to be selected before the click.
    selectedPaths: [path, ...selected],
    hitPoint: target.hitPoint ?? null,
    componentTypes: target.types ?? [],
    nodeContext: nodeContext?.machineContext ?? null,
    machineStatus: collectMachineStatusBlock(ctxViewer),
    docHints: path ? docHintsForNodes(ctxViewer, [path]) : [],
    viewerMode: getViewerMode(),
    modelName: modelNameFromUrl(viewer.currentModelUrl),
  });
}

// ─── Project mirror (F8) ────────────────────────────────────────────────

/** The slice of the project backend the mirror uses — bound at submit time. */
interface MirrorBackend {
  writable?: boolean;
  writeDocument(
    relPath: string,
    bytes: Uint8Array,
    options: { expectedRevision: 'create' },
  ): Promise<unknown>;
}

export interface MirrorOutcome {
  savedPath?: string;
  error?: string;
}

/**
 * Write the task as `tasks/<stamp>-<id>-<slug>.md` in the OPEN project.
 *
 * Three deliberate differences from `saveCanvasToProject`, the pattern this
 * follows otherwise:
 *
 *  - `expectedRevision: 'create'` (as `createDocument` uses), never `'any'`. A
 *    paper trail that overwrites is not a paper trail; the task id in the name
 *    makes a collision nearly impossible and a real one is REPORTED.
 *  - the backend is bound HERE, at submit time, and the write is awaited on
 *    that object — so switching project mid-write cannot land the file in the
 *    new project.
 *  - a failure is returned, never thrown away: the task stays in the queue and
 *    the reason reaches the panel.
 */
export async function mirrorPromptTaskToProject(task: PromptTask): Promise<MirrorOutcome> {
  const relPath = promptTaskMirrorPath(task);
  if (relPath.split('/').includes('..')) return { error: 'refused a path containing ".."' };
  let backend: MirrorBackend | null = null;
  try {
    const { getProjectStore } = await import('../core/project/project-store');
    backend = getProjectStore().getBackend() as unknown as MirrorBackend | null;
  } catch {
    return {};   // no project subsystem at all — mirroring is optional by design
  }
  if (!backend?.writable) return {};
  try {
    const bytes = new TextEncoder().encode(renderPromptTaskMarkdown(task));
    await backend.writeDocument(relPath, bytes, { expectedRevision: 'create' });
    return { savedPath: relPath };
  } catch (e) {
    return { error: `Could not write "${relPath}": ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Submit ─────────────────────────────────────────────────────────────

/**
 * The one path from a typed sentence to a queued task.
 *
 * Returns the task, or `null` when the queue refused it (full of open work) —
 * refusal is visible in the panel, never silent.
 */
export function submitPromptTask(
  viewer: RVViewer,
  prompt: string,
  target: Pick<ContextMenuTarget, 'path' | 'types' | 'hitPoint'>,
  store: PromptTaskStore = getPromptTaskStore(),
): PromptTask | null {
  const text = (prompt ?? '').trim();
  if (!text) return null;
  const task = buildTaskFromTarget(viewer, text, target);
  if (!store.enqueue(task).ok) return null;

  // Fire-and-forget: the queue is the source of truth, the file is the trail.
  void mirrorPromptTaskToProject(task).then((outcome) => {
    if (outcome.savedPath) task.projectMirrorPath = outcome.savedPath;
    if (outcome.error) {
      // eslint-disable-next-line no-console
      console.warn(`[rv][prompt-queue] ${outcome.error}`);
    }
  });
  return task;
}

// ─── Shortcut (F9) ──────────────────────────────────────────────────────

export interface PromptShortcutEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

/**
 * Ctrl/Cmd+Alt+A — "order for the current selection".
 *
 * Pure predicate so the editable-target guard is testable: without it the
 * shortcut would fire while the user is typing a task into the very input this
 * feature adds.
 */
export function isPromptTaskShortcut(e: PromptShortcutEvent): boolean {
  if (e.key !== 'a' && e.key !== 'A') return false;
  if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return false;
  return !isEditableTarget(e.target);
}

/**
 * The menu target the SHORTCUT uses — the primary selection, and no hit point.
 *
 * The missing hit point is the point of this function. A remembered one is only
 * correct when the last click and the current selection are the same node, and
 * nothing guarantees that.
 */
export function shortcutMenuTarget(viewer: RVViewer): ContextMenuTarget | null {
  const path = viewer.selectionManager?.getSnapshot()?.primaryPath ?? null;
  if (!path) return null;
  const node = viewer.registry?.getNode(path);
  if (!node) return null;
  return {
    path,
    node,
    types: viewer.registry?.getComponentTypes(path) ?? [],
    extras: (node.userData?.realvirtual as Record<string, unknown>) ?? {},
    // hitPoint / hitNormal deliberately absent — see the doc comment.
  };
}

// ─── Menu items ─────────────────────────────────────────────────────────

export function promptTaskContextMenuItems(viewer: RVViewer): ContextMenuItem[] {
  return [
    {
      id: MENU_ITEM_ID,
      label: 'Task for agent…',
      icon: 'smart_toy',
      order: 70,
      dividerBefore: true,
      condition: (target) => !!target.path && promptUiAvailable(),
      input: {
        placeholder: 'Describe the change…',
        onSubmit: (value, target) => { submitPromptTask(viewer, value, target); },
      },
    },
    {
      id: MENU_OPEN_ITEM_ID,
      label: () => {
        const { open, claimed } = getPromptTaskStore().counts();
        return claimed > 0 ? `Open tasks (${open}, ${claimed} claimed)` : `Open tasks (${open})`;
      },
      icon: 'list',
      order: 71,
      condition: () => promptUiAvailable() && getPromptTaskStore().list({ includeClaimed: true }).length > 0,
      action: () => setPromptPanelOpen(true),
    },
  ];
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class PromptTaskPlugin implements RVViewerPlugin {
  readonly id = PROMPT_TASK_PLUGIN_ID;
  readonly order = PLUGIN_ORDER.UI_OVERLAY;
  readonly core = true;

  readonly slots: UISlotEntry[] = [{
    slot: 'overlay',
    component: PromptTaskPanelHost,
    visibilityRule: PROMPT_TASK_VISIBILITY,
  }];

  private viewer: RVViewer | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    viewer.contextMenu.register({
      pluginId: PROMPT_TASK_PLUGIN_ID,
      items: promptTaskContextMenuItems(viewer),
    });
    this.keyHandler = (e: KeyboardEvent) => {
      if (!isPromptTaskShortcut(e) || !promptUiAvailable()) return;
      const target = shortcutMenuTarget(viewer);
      if (!target) return;
      e.preventDefault();
      // Surface ONLY the prompt row, at the centre of the viewport: the
      // shortcut has no cursor position, and inventing one would put the input
      // somewhere the user is not looking.
      viewer.contextMenu.openItems(
        { x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 3) },
        target,
        promptTaskContextMenuItems(viewer).filter((i) => i.id === MENU_ITEM_ID),
      );
    };
    window.addEventListener('keydown', this.keyHandler);
    this.syncProjectKey();
  }

  onModelLoaded(): void { this.syncProjectKey(); }

  /** Point the queue at the open project, so a project switch does not mix queues. */
  private syncProjectKey(): void {
    void import('../core/project/project-store')
      .then((m) => { getPromptTaskStore().setProjectKey(m.getProjectStore().getProject()?.id ?? null); })
      .catch(() => { /* no project subsystem — the `none` key is correct then */ });
  }

  dispose(): void {
    // Symmetric to init(): a menu item left registered would close over a dead
    // viewer, and a stray keydown listener would open a menu for it.
    this.viewer?.contextMenu.unregister(PROMPT_TASK_PLUGIN_ID);
    if (this.keyHandler) window.removeEventListener('keydown', this.keyHandler);
    this.keyHandler = null;
    this.viewer = null;
    setPromptPanelOpen(false);
  }
}
