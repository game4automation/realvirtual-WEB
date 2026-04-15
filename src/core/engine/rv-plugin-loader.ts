// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-plugin-loader.ts — Dynamic ESM plugin loader.
 *
 * Loads external plugins (pre-built `.js` files) at runtime via `import()`.
 * External plugins are placed in a `plugins/` folder relative to the model.
 *
 * Convention:
 *   models/plugins/{plugin-id}.js
 *
 * Supports both class exports and instance exports:
 *   export default class MyPlugin implements RVViewerPlugin { ... }
 *   export default new MyPlugin();
 */

import type { RVViewerPlugin } from '../rv-plugin';

export interface ExternalPluginModule {
  default: RVViewerPlugin | (new () => RVViewerPlugin);
}

/**
 * Load an external plugin by ID from a conventional path.
 *
 * @param pluginId  Plugin identifier (used as filename: `{pluginId}.js`).
 * @param baseUrl   Base URL for the models directory (e.g., `./models`).
 * @param signal    Optional AbortSignal for cancellation.
 * @returns The loaded plugin instance, or null if not found / load failed.
 */
export async function loadExternalPlugin(
  pluginId: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<RVViewerPlugin | null> {
  if (signal?.aborted) return null;

  const url = `${baseUrl}/plugins/${pluginId}.js`;
  try {
    const module = await import(/* @vite-ignore */ url) as ExternalPluginModule;
    const PluginOrInstance = module.default;
    if (!PluginOrInstance) {
      console.warn(`[rv] External plugin "${pluginId}" has no default export at ${url}`);
      return null;
    }

    // Support both class export and instance export
    const plugin = typeof PluginOrInstance === 'function'
      ? new (PluginOrInstance as new () => RVViewerPlugin)()
      : PluginOrInstance;

    // Basic shape validation
    if (!plugin.id || typeof plugin.id !== 'string') {
      console.warn(`[rv] External plugin at ${url} has no valid 'id' property — skipping`);
      return null;
    }

    return plugin;
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    console.warn(`[rv] External plugin "${pluginId}" not found at ${url}`);
    return null;
  }
}
