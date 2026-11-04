// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PathNetworkUiPlugin — hosts the path-network planner UI (plan-628 Phase 5):
 * the pointer/keyboard controller and the "Path network" toolbar tool shown
 * in every authoring mode (the legacy `planner` UI context is set in planner
 * AND des, authoring-modes.ts). Registered after the path visualizer so its
 * canvas listeners come second (a visualizer handle grab wins).
 *
 * plan-628 8.1: while an authoring mode is active it also puts the built-in
 * path-block catalog (`path-blocks`) into the planner library and installs the
 * planner's path-block entry handler, so a library card click / drag arms the
 * same tool as the toolbar catalog (`layout.path.place` / `.junction`).
 *
 * plan-628 8.11a: it registers the controller's marquee hit provider with the
 * planner, so the planner's rubber-band marquee selects path blocks too.
 */

import type { ComponentType } from 'react';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { PathVisualizerPlugin } from '../path-visualizer-plugin';
import type { LibraryCatalog } from '../../core/library/library-types';
import type { PathBlockEntryHandler } from '../layout-planner';
import type { BoxSelectHitProvider } from '../layout-planner/box-select-hit';
import { AUTHORING_TOOL_RULE, isAuthoringMode } from '../layout-planner/authoring-modes';
import { TOOL_GROUP } from '../../core/hmi/button-panel-sections';
import type { PathNetworkInteraction } from './path-network-interaction';
import { PATH_LIBRARY_CATALOG_KEY, pathBlockLibraryEntries } from './path-network-ui-model';
import { PathNetworkToolButton } from './PathNetworkToolbar';
import { ensurePathNetworkCommandsRegistered } from './path-network-commands';
import { registerTransferStationDockUi } from './TransferStationDockAction';

type InteractionModule = typeof import('./path-network-interaction');
const defaultInteractionLoader = (): Promise<InteractionModule> => import('./path-network-interaction');
let interactionLoader = defaultInteractionLoader;

/** Test seam for delayed or failed chunk loads (also works in the browser runner). */
export function setPathNetworkInteractionLoaderForTests(loader: (() => Promise<InteractionModule>) | null): void {
  interactionLoader = loader ?? defaultInteractionLoader;
}

export class PathNetworkUiPlugin implements RVViewerPlugin {
  readonly id = 'path-network-ui';
  readonly core = true;
  readonly slots: UISlotEntry[] = [
    {
      slot: 'button-group',
      component: PathNetworkToolButton as ComponentType<UISlotProps>,
      order: 275,
      group: TOOL_GROUP.model,
      visibilityRule: { ...AUTHORING_TOOL_RULE },
    },
  ];

  private _interaction: PathNetworkInteraction | null = null;
  private _gen = 0;
  private _ready: Promise<PathNetworkInteraction | null> = Promise.resolve(null);
  private _resolveReady: ((ui: PathNetworkInteraction | null) => void) | null = null;
  private _listeners = new Set<() => void>();

  /** Before init / without a visualizer, resolves to null; during loading, waits. */
  whenInteractionReady(): Promise<PathNetworkInteraction | null> {
    return this._ready;
  }

  readonly subscribeInteraction = (cb: () => void): (() => void) => {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  };

  private emitInteraction(): void {
    for (const cb of this._listeners) cb();
  }

  private _viewer: RVViewer | null = null;
  private _offMode: (() => void) | null = null;
  private _uninstallHandler: (() => void) | null = null;
  private _catalogShown = false;
  private _uninstallMarquee: (() => void) | null = null;
  private _uninstallDockUi: (() => void) | null = null;

  /** The controller (null before loading completes / without a path visualizer). */
  get interaction(): PathNetworkInteraction | null {
    return this._interaction;
  }

  init(viewer: RVViewer): void {
    const viz = viewer.getPlugin<PathVisualizerPlugin>('path-visualizer');
    if (!viz) return;
    // The UI writes only through layout.path.* — register them here too, not
    // only in the MCP bridge (a viewer without MCP has the UI as well).
    ensurePathNetworkCommandsRegistered();
    this._uninstallDockUi = registerTransferStationDockUi(viewer);
    const gen = ++this._gen;
    this._ready = new Promise((resolve) => { this._resolveReady = resolve; });
    this._viewer = viewer;
    if (typeof viewer.on === 'function') {
      this._offMode = viewer.on('mode-changed', () => this.syncLibrary());
    }
    const loadInteraction = interactionLoader;
    void Promise.resolve().then(() => loadInteraction()).then((module) => {
      if (gen !== this._gen) return;
      this._interaction = new module.PathNetworkInteraction(viewer, viz);
      this.syncLibrary();
      this.emitInteraction();
      this._resolveReady?.(this._interaction);
      this._resolveReady = null;
    }).catch((error: unknown) => {
      if (gen !== this._gen) return;
      console.warn('Failed to load path network interaction', error);
      this._resolveReady?.(null);
      this._resolveReady = null;
    });
  }

  onModelLoaded(): void {
    // The planner may have come up after this plugin's init (plugin order).
    this.syncLibrary();
  }

  /**
   * plan-435 teardown: the model's blocks are gone — drop what the controller
   * holds about them (drag, armed tool, selection, pins, click layout, typed
   * prompt). The library catalog, entry handler and marquee provider are
   * viewer-scoped (they follow the mode) and stay; the copy clipboard stays too
   * (pasting into the next document is wanted).
   */
  onModelCleared(): void {
    this._interaction?.clearModelState();
  }

  /** 8.1: the path-block catalog + entry handler follow the authoring modes. */
  private syncLibrary(): void {
    const viewer = this._viewer;
    const ui = this._interaction;
    const planner = viewer?.getPlugin?.('layout-planner') as unknown as PlannerLibraryHost | undefined;
    if (!viewer || !ui || !planner?.store) return;
    // 8.11a: one marquee for placements AND path blocks (registered once per planner).
    if (!this._uninstallMarquee && planner.registerBoxSelectHitProvider) {
      this._uninstallMarquee = planner.registerBoxSelectHitProvider(ui.boxSelectProvider);
    }
    const show = isAuthoringMode(viewer.modes?.activeMode ?? null);
    if (show && !this._catalogShown) {
      const catalog: LibraryCatalog = { version: '1.0', name: 'Path Network', entries: pathBlockLibraryEntries() };
      planner.store.addCatalogDirect?.(PATH_LIBRARY_CATALOG_KEY, catalog);
      const handler: PathBlockEntryHandler = {
        pick: (entry) => { void ui.pickLibraryEntry(entry); },
        beginDrag: (entry) => ui.beginLibraryDrag(entry),
        endDrag: () => ui.endLibraryDrag(),
      };
      this._uninstallHandler = planner.setPathBlockEntryHandler?.(handler) ?? null;
      this._catalogShown = true;
    } else if (!show && this._catalogShown) {
      planner.store.removeCatalog?.(PATH_LIBRARY_CATALOG_KEY);
      this._uninstallHandler?.();
      this._uninstallHandler = null;
      this._catalogShown = false;
    }
  }

  onRender(): void {
    this._interaction?.tick();
  }

  dispose(): void {
    ++this._gen;
    this._resolveReady?.(null);
    this._resolveReady = null;
    this._ready = Promise.resolve(null);
    this._uninstallDockUi?.();
    this._uninstallDockUi = null;
    this._offMode?.();
    this._offMode = null;
    this._uninstallHandler?.();
    this._uninstallHandler = null;
    this._uninstallMarquee?.();
    this._uninstallMarquee = null;
    this._catalogShown = false;
    this._viewer = null;
    this._interaction?.dispose();
    this._interaction = null;
    this.emitInteraction();
  }
}

/** The slice of the layout planner this plugin uses (structural: no module import of the plugin class). */
interface PlannerLibraryHost {
  store?: {
    addCatalogDirect?(key: string, catalog: LibraryCatalog): void;
    removeCatalog?(key: string): void;
  };
  setPathBlockEntryHandler?(handler: PathBlockEntryHandler | null): () => void;
  registerBoxSelectHitProvider?(provider: BoxSelectHitProvider): () => void;
}
