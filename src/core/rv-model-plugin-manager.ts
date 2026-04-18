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

// ─── Plugin Module Discovery ───────────────────────────────────────────

// Vite resolves these globs at build time and code-splits each match.
// Public model plugins (in the main project)
const pluginModuleImporters = import.meta.glob<ModelPluginModule>([
  '/src/plugins/models/*/index.ts',
  '/src/plugins/models/*/index.tsx',
], { eager: false });

// Private project plugin modules
// Glob paths in Vite are relative to the importing file's location (src/core/).
// In public builds without the private folder, this glob returns {}.
const privatePluginModuleImporters = import.meta.glob<ModelPluginModule>([
  '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.ts',
  '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.tsx',
], { eager: false });

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

  /**
   * Extract the model base name (without .glb) from a URL.
   * Works for both local paths and full URLs.
   */
  private resolveModelName(url: string): string {
    const withoutQuery = url.split('?')[0];
    const lastSlash = withoutQuery.lastIndexOf('/');
    const fileName = lastSlash >= 0 ? withoutQuery.substring(lastSlash + 1) : withoutQuery;
    return fileName.replace(/\.glb$/i, '');
  }

  /** Extract the project folder name from a private plugin path, or null for public plugins. */
  private extractProjectFolder(path: string): string | null {
    const segments = path.replace(/\\/g, '/').split('/');
    const pluginsIdx = segments.indexOf('plugins');
    if (pluginsIdx > 0 && path.includes('Private~')) {
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
   */
  async onModelLoading(modelUrl: string, viewer: RVViewer): Promise<void> {
    // Prefer pendingModelUrl (original URL set before loadModel) over the passed URL which may be a blob:
    const resolveUrl = viewer.pendingModelUrl || modelUrl;
    const modelName = this.resolveModelName(resolveUrl);

    // Same model — nothing to do
    if (modelName === this.activeModelName) return;

    // Unload previous model plugins
    if (this.activeModule) {
      debug('plugins', `Unloading model plugins for '${this.activeModelName}'`);
      try {
        this.activeModule.unregisterModelPlugins(viewer);
      } catch (e) {
        console.error(`[ModelPluginManager] Error unloading plugins for '${this.activeModelName}':`, e);
      }
      this.activeModule = null;
      this.activeModelName = null;
      viewer.projectAssetsPath = null; // Reset so next model gets fresh resolution
    }

    // Find and load new model plugins
    const findResult = await this.findModuleWithPath(modelName);
    if (findResult) {
      const { mod, projectFolder } = findResult;
      debug('plugins', `Loading model plugins for '${modelName}'${projectFolder ? ` (project: ${projectFolder})` : ''}`);
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
        mod.registerModelPlugins(viewer);
        // Only apply the model's default environment preset if the user hasn't
        // customized environment settings — otherwise respect their saved values.
        if (!hasUserEnvironmentOverride()) {
          applyEnvironmentPreset(viewer, mod.defaultEnvironmentPreset ?? 'Bright');
        }
        this.activeModule = mod;
        this.activeModelName = modelName;
        logInfo(`Model plugins loaded for '${modelName}'`);
      } catch (e) {
        console.error(`[ModelPluginManager] Error loading plugins for '${modelName}':`, e);
      }
    } else {
      debug('plugins', `No model-specific plugins found for '${modelName}'`);
      // Apply default environment preset for models without a plugin module,
      // but only if the user hasn't customized their environment settings.
      if (!hasUserEnvironmentOverride()) {
        applyEnvironmentPreset(viewer, 'Bright');
      }
    }
  }
}
