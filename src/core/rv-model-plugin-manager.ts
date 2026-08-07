// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-plugin-manager.ts — Per-model dynamic plugin loading.
 *
 * Each model can have a `plugins/index.ts` that registers model-specific plugins.
 * When a new model loads, the previous model's plugins are unloaded and the new
 * model's plugins are loaded. Core plugins and global private plugins are unaffected.
 *
 * Plugin modules are discovered at build time via import.meta.glob so Vite
 * code-splits them into separate chunks.
 */

import { debug, logInfo, debugWarn } from './engine/rv-debug';
import type { RVViewer } from './rv-viewer';
import { applyEnvironmentPreset, hasUserEnvironmentOverride, type EnvironmentPresetName } from './hmi/environment-presets';
import { isContextActive, _subscribe as subscribeUiContext } from './hmi/ui-context-store';
import { peekPersistedActivePanels } from './hmi/left-panel-manager';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ModelPluginModule {
  /** Which model filenames (without .glb extension) this module handles. */
  models: string[];
  /**
   * Optional environment preset applied each time this model loads. Overrides
   * any persisted user values; the user can still adjust them afterwards via
   * the Environment settings tab (changes persist for the session).
   */
  defaultEnvironmentPreset?: EnvironmentPresetName;
  /** Register all plugins for this model. */
  registerModelPlugins(viewer: RVViewer): void;
  /** Unregister (remove) all plugins that were registered. */
  unregisterModelPlugins(viewer: RVViewer): void;
}

/**
 * Stable model identity used by model plugins and signature-unlock storage.
 * Query strings and the final .glb suffix are ignored.
 */
export function resolveModelName(url: string): string {
  const withoutQuery = url.split('?')[0];
  const lastSlash = withoutQuery.lastIndexOf('/');
  const fileName = lastSlash >= 0 ? withoutQuery.substring(lastSlash + 1) : withoutQuery;
  return fileName.replace(/\.glb$/i, '');
}

// ─── Plugin Module Discovery ───────────────────────────────────────────

// Vite resolves these globs at build time and code-splits each match.
// Public model plugins (in the main project)
const pluginModuleImporters = import.meta.glob<ModelPluginModule>([
  '/src/plugins/models/*/index.ts',
  '/src/plugins/models/*/index.tsx',
], { eager: false });

// Private project plugin modules
// Glob paths in Vite are relative to the importing file's location (src/core/).
// MUST be gated behind __RV_HAS_PRIVATE__: import.meta.glob matches whatever is
// on disk, so on a machine WITH the private folder a forced-public build
// (VITE_PUBLIC_BUILD=1) would otherwise bundle customer project plugins into
// the public bundle — and break on @rv-private imports that have no stub. The
// dead branch (and every chunk behind it) is eliminated by Rollup.
const privatePluginModuleImporters: Record<string, () => Promise<ModelPluginModule>> =
  __RV_HAS_PRIVATE__
    ? import.meta.glob<ModelPluginModule>([
        '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.ts',
        '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.tsx',
        '../../../realvirtual-web-pro/projects/*/plugins/index.ts',
        '../../../realvirtual-web-pro/projects/*/plugins/index.tsx',
        '../../../projects/*/plugins/index.ts',
        '../../../projects/*/plugins/index.tsx',
      ], { eager: false })
    : {};

// Merge both sets
const allImporters: Record<string, () => Promise<ModelPluginModule>> = {
  ...pluginModuleImporters,
  ...privatePluginModuleImporters,
};

if (import.meta.env.DEV) {
  debug('plugins', `Discovered ${Object.keys(allImporters).length} model plugin module(s)`);
}

// ─── Manager ───────────────────────────────────────────────────────────

export class ModelPluginManager {
  private activeModule: ModelPluginModule | null = null;
  private activeModelName: string | null = null;
  /** Cache loaded modules to avoid re-importing on model switch back. */
  private moduleCache = new Map<string, ModelPluginModule>();
  /** Cache project folder names for private project plugins. */
  private _projectFolderCache = new Map<string, string>();

  // ─── Planner-aware registration state ────────────────────────────────
  // Model plugins are suppressed while the layout planner is active so the
  // user gets a clean planning workspace. Registration deferred until they
  // exit planner mode; unregistered again on re-entry. The state machine:
  //   plannerActive  ⇒  no model plugins registered (regardless of model)
  //   plannerInactive ⇒ activeModule's plugins registered (if a module exists)

  /** True when activeModule's registerModelPlugins has been called and
   *  unregisterModelPlugins has not yet run. */
  private _registered = false;
  /** Most recent viewer ref — needed by the UI-context subscription so it
   *  can register/unregister between model loads. */
  private _lastViewer: RVViewer | null = null;
  /** Current planner-active state, tracked to detect transitions. */
  private _plannerActive = false;
  /** Unsub for the UI-context store subscription. */
  private _ctxUnsub: (() => void) | null = null;

  /** Extract the project folder name from a private plugin path, or null for public plugins. */
  private extractProjectFolder(path: string): string | null {
    const segments = path.replace(/\\/g, '/').split('/');
    const pluginsIdx = segments.indexOf('plugins');
    if (pluginsIdx > 0 && segments.includes('projects')) {
      return segments[pluginsIdx - 1];
    }
    return null;
  }

  /**
   * Find the matching plugin module importer for a model name.
   * Returns the module and the project folder name (for private project plugins).
   */
  private async findModuleWithPath(modelName: string): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    // Check cache first
    const cached = this.moduleCache.get(modelName);
    if (cached) return { mod: cached, projectFolder: this._projectFolderCache.get(modelName) ?? null };

    // Try each importer — check folder name match first (fast path)
    for (const [path, importer] of Object.entries(allImporters)) {
      // Extract folder name from path: /src/plugins/models/DemoRealvirtualWeb/index.ts → DemoRealvirtualWeb
      const segments = path.replace(/\\/g, '/').split('/');
      const indexIdx = segments.findIndex(s => s.startsWith('index.'));
      const folderName = indexIdx > 0 ? segments[indexIdx - 1] : null;

      // For project paths, the folder before "plugins" is the project name
      const pluginsIdx = segments.indexOf('plugins');
      const projectName = pluginsIdx > 0 ? segments[pluginsIdx - 1] : null;

      // Quick match on folder/project name
      if (folderName === modelName || projectName === modelName) {
        try {
          const mod = await importer();
          const projectFolder = this.extractProjectFolder(path);
          this.moduleCache.set(modelName, mod);
          if (projectFolder) this._projectFolderCache.set(modelName, projectFolder);
          return { mod, projectFolder };
        } catch (e) {
          debugWarn('plugins', `Failed to load model plugins from ${path}: ${e}`);
          return null;
        }
      }
    }

    // Slow path: load all modules and check their `models` array
    for (const [path, importer] of Object.entries(allImporters)) {
      try {
        const mod = await importer();
        if (mod.models && mod.models.includes(modelName)) {
          const projectFolder = this.extractProjectFolder(path);
          // Cache for all declared model names
          for (const name of mod.models) {
            this.moduleCache.set(name, mod);
            if (projectFolder) this._projectFolderCache.set(name, projectFolder);
          }
          return { mod, projectFolder };
        }
      } catch (e) {
        debugWarn('plugins', `Failed to load model plugins from ${path}: ${e}`);
      }
    }

    return null;
  }

  /**
   * Called from RVViewer.loadModel() before the onModelLoaded plugin loop.
   * Unloads the previous model's plugins and loads the new model's plugins.
   *
   * If planner mode is active, plugin REGISTRATION is deferred — the module
   * is still resolved & cached as `activeModule`, but its
   * `registerModelPlugins` is not called until the user exits planner mode.
   * (See `_handleContextChange` for the deferred-register path.)
   */
  async onModelLoading(modelUrl: string, viewer: RVViewer): Promise<void> {
    // Prefer pendingModelUrl (original URL set before loadModel) over the passed URL which may be a blob:
    const resolveUrl = viewer.pendingModelUrl || modelUrl;
    const modelName = resolveModelName(resolveUrl);

    // Cache viewer + subscribe to planner-context changes (idempotent).
    this._lastViewer = viewer;
    // Predict planner state. The live UI context lags behind on the very
    // first boot — the planner's onModelLoaded sets it AFTER this method
    // runs (it's the planner that reads its persisted open state). So we
    // also peek the persisted left-panel state directly to decide whether
    // to skip plugin registration up-front, avoiding a register→unregister
    // flash of the demo HMI on reload-while-planner-was-open.
    this._plannerActive =
      isContextActive('planner') ||
      peekPersistedActivePanels().has('layout-planner');
    this._ensureContextSubscription();

    // Same model — nothing to do
    if (modelName === this.activeModelName) return;

    // Unload previous model plugins (only if currently registered — when
    // we switch models inside planner mode they were never registered).
    if (this.activeModule) {
      if (this._registered) {
        debug('plugins', `Unloading model plugins for '${this.activeModelName}'`);
        try {
          this.activeModule.unregisterModelPlugins(viewer);
        } catch (e) {
          console.error(`[ModelPluginManager] Error unloading plugins for '${this.activeModelName}':`, e);
        }
      }
      this.activeModule = null;
      this.activeModelName = null;
      this._registered = false;
      viewer.projectAssetsPath = null; // Reset so next model gets fresh resolution
    }

    // Find and load new model plugins
    const findResult = await this.findModuleWithPath(modelName);
    if (findResult) {
      const { mod, projectFolder } = findResult;
      try {
        // Set project assets path so plugins can resolve assets via viewer.projectAssetsPath.
        // In dev mode: Vite serves at /private-assets/<folder>/. In production: settings.json has it.
        if (projectFolder) {
          const cfgPath = viewer.projectAssetsPath;
          // Only override if settings.json didn't already provide a project-specific path
          if (cfgPath === import.meta.env.BASE_URL) {
            viewer.projectAssetsPath = `/private-assets/${projectFolder}/`;
          }
        }
        // Apply the model's default environment preset so each model loads with
        // its intended look — but NOT when the user has an explicit environment
        // override (set via the Environment/Visual settings, or by applying a
        // visual preset, which calls markEnvironmentUserModified). A page reload
        // is indistinguishable from a model switch here; without this guard the
        // reload would re-clobber the environment portion (ground/floor/background)
        // of an active visual preset, so it no longer matched and the preset
        // dropdown fell back to "Custom". A fresh user (no override) is unaffected.
        // Lighting changes regardless of planner state — it's a scene visual,
        // not a plugin UI.
        if (!hasUserEnvironmentOverride()) {
          applyEnvironmentPreset(viewer, mod.defaultEnvironmentPreset ?? 'Bright');
        }

        this.activeModule = mod;
        this.activeModelName = modelName;

        if (this._plannerActive) {
          debug('plugins', `Skipped model plugins for '${modelName}' (planner active — will register on exit)`);
        } else {
          debug('plugins', `Loading model plugins for '${modelName}'${projectFolder ? ` (project: ${projectFolder})` : ''}`);
          viewer.withDefaultOrigin('project', () => mod.registerModelPlugins(viewer));
          this._registered = true;
          logInfo(`Model plugins loaded for '${modelName}'`);
        }
      } catch (e) {
        console.error(`[ModelPluginManager] Error loading plugins for '${modelName}':`, e);
      }
    } else {
      debug('plugins', `No model-specific plugins found for '${modelName}'`);
      // Apply the generic 'Bright' fallback so a fresh model load leaves the
      // environment in a predictable state — but never override an explicit user
      // environment choice (see note above), else a reload would reset it and an
      // active visual preset's environment would stop matching ("Custom").
      if (!hasUserEnvironmentOverride()) {
        applyEnvironmentPreset(viewer, 'Bright');
      }
    }
  }

  /**
   * Subscribe to UI-context changes once. The handler reacts to planner
   * toggles by registering/unregistering the active module's plugins so
   * the workspace state stays consistent with the rule:
   *   plannerActive ⇒ no model plugins; plannerInactive ⇒ active module's
   *   plugins registered.
   */
  private _ensureContextSubscription(): void {
    if (this._ctxUnsub) return;
    this._ctxUnsub = subscribeUiContext(() => this._handleContextChange());
  }

  private _handleContextChange(): void {
    const inPlanner = isContextActive('planner');
    if (inPlanner === this._plannerActive) return; // not a planner transition
    this._plannerActive = inPlanner;

    const viewer = this._lastViewer;
    const mod = this.activeModule;
    if (!viewer || !mod) return;

    if (inPlanner && this._registered) {
      // Planner just activated — pull model plugins out of the workspace.
      debug('plugins', `Planner active — unregistering model plugins for '${this.activeModelName}'`);
      try {
        mod.unregisterModelPlugins(viewer);
      } catch (e) {
        console.error(`[ModelPluginManager] Error unloading plugins for '${this.activeModelName}':`, e);
      }
      this._registered = false;
    } else if (!inPlanner && !this._registered) {
      // Planner just deactivated — register the deferred plugins. Each
      // plugin's onModelLoaded fires retroactively via viewer.use() (see
      // RVViewer.use → retroactive call when _lastLoadResult is set).
      debug('plugins', `Planner inactive — registering model plugins for '${this.activeModelName}'`);
      try {
        viewer.withDefaultOrigin('project', () => mod.registerModelPlugins(viewer));
        this._registered = true;
        logInfo(`Model plugins loaded for '${this.activeModelName}' (deferred from planner mode)`);
      } catch (e) {
        console.error(`[ModelPluginManager] Error loading plugins for '${this.activeModelName}':`, e);
      }
    }
  }
}
