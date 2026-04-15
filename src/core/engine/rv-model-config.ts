// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-config.ts — Model-specific plugin configuration.
 *
 * Loads and merges plugin declarations from three sources:
 *   1. `modelname.json` sidecar file (highest priority)
 *   2. GLB scene-level extras (`rv_plugins`, `rv_plugin_config`)
 *   3. `settings.json` global fallback (lowest priority)
 *
 * When no `plugins` array is declared anywhere, the viewer uses "all-by-default"
 * mode (backward compatible). When declared, only the listed plugins activate.
 */

import { debugWarn } from './rv-debug';
import type { Scene } from 'three';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ModelConfig {
  /** Plugin IDs to activate. undefined = all-by-default; string[] = selective mode. */
  plugins?: string[];
  /** Per-plugin configuration objects, keyed by plugin ID. */
  pluginConfig?: Record<string, Record<string, unknown>>;
  /** Future: node path -> component -> property overrides applied on top of GLB extras. */
  propertyOverrides?: Record<string, Record<string, Record<string, unknown>>>;
}

// ─── Loading ───────────────────────────────────────────────────────────

/**
 * Fetch the companion `modelname.json` sidecar file for a GLB model.
 * Returns empty config on 404 or parse error (no throw).
 */
export async function loadModelJsonConfig(
  modelUrl: string,
  signal?: AbortSignal,
): Promise<ModelConfig> {
  const configUrl = modelUrl.replace(/\.glb$/i, '.json');
  try {
    const resp = await fetch(configUrl, { signal });
    if (!resp.ok) return {};
    const data = await resp.json();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      debugWarn('loader', `Invalid modelname.json format at ${configUrl}`);
      return {};
    }
    return data as ModelConfig;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e; // re-throw abort
    // 404, network error, or invalid JSON — all graceful
    return {};
  }
}

/**
 * Extract plugin config from GLB scene-level extras.
 * Looks for `rv_plugins` (string[]) and `rv_plugin_config` (object) on the scene root.
 */
export function extractGlbPluginConfig(scene: Scene): ModelConfig {
  // Walk top-level children to find the model root with extras
  for (const child of scene.children) {
    const extras = (child as { userData?: Record<string, unknown> }).userData;
    if (!extras) continue;

    const rv_plugins = extras['rv_plugins'];
    const rv_plugin_config = extras['rv_plugin_config'];

    if (rv_plugins !== undefined || rv_plugin_config !== undefined) {
      const config: ModelConfig = {};

      if (Array.isArray(rv_plugins)) {
        config.plugins = rv_plugins.filter((p): p is string => typeof p === 'string');
      }

      if (rv_plugin_config && typeof rv_plugin_config === 'object' && !Array.isArray(rv_plugin_config)) {
        config.pluginConfig = rv_plugin_config as Record<string, Record<string, unknown>>;
      }

      return config;
    }
  }

  return {};
}

/**
 * Deep-merge plugin configs: higher-priority values override lower-priority.
 * Arrays are replaced, not concatenated. undefined fields are skipped.
 */
function deepMergePluginConfig(
  base: Record<string, Record<string, unknown>>,
  override: Record<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const result = { ...base };
  for (const [key, val] of Object.entries(override)) {
    result[key] = { ...(result[key] ?? {}), ...val };
  }
  return result;
}

/**
 * Merge model config from multiple sources.
 * Priority: modelJson > glbExtras > settingsJson (global fallback).
 *
 * For `plugins`:
 *   - If modelJson declares plugins, use those.
 *   - Else if glbExtras declares plugins, use those.
 *   - Else if settings declares plugins, use those.
 *   - Else undefined (all-by-default mode).
 *
 * For `pluginConfig`:
 *   - Deep-merge: settingsJson < glbExtras < modelJson.
 */
export function mergeModelConfig(
  modelJson: ModelConfig,
  glbExtras: ModelConfig,
  settingsJson: ModelConfig,
): ModelConfig {
  // Determine plugins array (first non-undefined wins, highest priority first)
  const plugins = modelJson.plugins ?? glbExtras.plugins ?? settingsJson.plugins;

  // Deep-merge pluginConfig (lowest priority first)
  let pluginConfig: Record<string, Record<string, unknown>> = {};
  if (settingsJson.pluginConfig) {
    pluginConfig = deepMergePluginConfig(pluginConfig, settingsJson.pluginConfig);
  }
  if (glbExtras.pluginConfig) {
    pluginConfig = deepMergePluginConfig(pluginConfig, glbExtras.pluginConfig);
  }
  if (modelJson.pluginConfig) {
    pluginConfig = deepMergePluginConfig(pluginConfig, modelJson.pluginConfig);
  }

  // Property overrides (future — just pass through from modelJson)
  const propertyOverrides = modelJson.propertyOverrides;

  const result: ModelConfig = {};
  if (plugins !== undefined) result.plugins = plugins;
  if (Object.keys(pluginConfig).length > 0) result.pluginConfig = pluginConfig;
  if (propertyOverrides) result.propertyOverrides = propertyOverrides;

  return result;
}
