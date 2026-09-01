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
import {
  loadRuntimeScript,
  lastRuntimeScriptFailure,
  type RuntimeScriptConsent,
  type RuntimeScriptSource,
} from './rv-script-runtime-loader';

// ─── Types ─────────────────────────────────────────────────────────────

export interface ModelPluginModule {
  /**
   * Which model filenames (without .glb extension) this module handles.
   *
   * @deprecated Since plan-718: the binding lives on the document row
   * (`documents[].scriptRef`) instead, so it survives a rename and allows one
   * module to serve several documents. Still READ for one release generation so
   * an unmigrated project keeps working (F10); new modules omit it.
   */
  models?: string[];
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
 * The same value seen as a model-plugin module, or null.
 *
 * Structural on purpose: a runtime module may arrive as a class that was
 * `new`-ed, as an exported instance, or as a namespace of two named exports.
 * What makes it usable is the pair of methods, not the export style.
 */
export function asModelPluginModule(value: unknown): ModelPluginModule | null {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  const candidate = value as Partial<ModelPluginModule>;
  if (typeof candidate.registerModelPlugins !== 'function') return null;
  if (typeof candidate.unregisterModelPlugins !== 'function') return null;
  return candidate as ModelPluginModule;
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
//
// MUST be gated behind __RV_EMBED__, for the same reason the private glob below
// is gated behind __RV_HAS_PRIVATE__: the glob is lazy, so every model plugin
// becomes its own async chunk that is EMITTED even when nothing ever fetches it.
// The embed build never loads a model plugin, but two of them (DemoRealvirtualWeb,
// DemoProcessIndustry) pull FpvPlugin, which is a React component — so React landed
// in dist-embed and broke the plan-326 AP1 guard "no React anywhere in the output"
// (found 2026-08-30). The dead branch and every chunk behind it is eliminated by Rollup.
const pluginModuleImporters: Record<string, () => Promise<ModelPluginModule>> =
  __RV_EMBED__
    ? {}
    : import.meta.glob<ModelPluginModule>([
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

/**
 * The SOURCE of each private project plugin module, as text.
 *
 * Same paths as the importer glob above, imported `?raw`. It exists so the
 * migration of §2.7 can read a module's `models: string[]` declaration **without
 * executing the module** — importing every plugin of every project just to read
 * one array would run their side effects and pull their chunks, at project open,
 * for a step that runs once in a project's life.
 *
 * Only the private project roots: a public model plugin lives outside every
 * project and therefore has no project-relative path to become a `scriptRef`.
 */
const privatePluginSourceImporters: Record<string, () => Promise<string>> =
  __RV_HAS_PRIVATE__
    ? import.meta.glob<string>([
        '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.ts',
        '../../../realvirtual-WebViewer-Private~/projects/*/plugins/index.tsx',
        '../../../realvirtual-web-pro/projects/*/plugins/index.ts',
        '../../../realvirtual-web-pro/projects/*/plugins/index.tsx',
        '../../../projects/*/plugins/index.ts',
        '../../../projects/*/plugins/index.tsx',
      ], { eager: false, query: '?raw', import: 'default' })
    : {};

/**
 * What the project's own plugin module declares, ready for the migration.
 *
 * `projectFolder` is matched case-INSENSITIVELY on the folder before `plugins/`,
 * because a project's folder and its `canonicalName` legitimately differ in case
 * (`Toray` / `toray`) and `validate-project.mjs` accepts that on purpose.
 *
 * The regex accepts both spellings in the tree — `export const models = [...]`
 * and `models: [...]` — and a module it cannot parse yields an empty list, which
 * costs a manual binding rather than producing a wrong one.
 */
export async function discoverDeclaredScriptRefs(
  projectFolder: string,
): Promise<Array<{ scriptRef: string; models: string[] }>> {
  const wanted = String(projectFolder ?? '').trim().toLowerCase();
  if (wanted === '') return [];
  const out: Array<{ scriptRef: string; models: string[] }> = [];
  for (const [path, load] of Object.entries(privatePluginSourceImporters)) {
    const segments = path.replace(/\\/g, '/').split('/');
    const pluginsIdx = segments.indexOf('plugins');
    if (pluginsIdx <= 0) continue;
    if (segments[pluginsIdx - 1].toLowerCase() !== wanted) continue;
    try {
      const source = await load();
      const match = /\bmodels\s*[:=]\s*\[([^\]]*)\]/.exec(source);
      const models = match
        ? [...match[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map(m => m[1])
        : [];
      out.push({ scriptRef: segments.slice(pluginsIdx).join('/'), models });
    } catch (e) {
      debugWarn('plugins', `Could not read the declaration in ${path}: ${e}`);
    }
  }
  return out;
}

/**
 * The module paths the build discovered, for tests and diagnostics.
 *
 * Exported so the `__RV_HAS_PRIVATE__` gate is checkable without a build: the
 * one thing that must never be true is a private project path in a public
 * build, and that is a statement about this list.
 */
export function discoveredPluginModulePaths(): string[] {
  return Object.keys(allImporters);
}

/** What a {@link ModelPluginManager} needs from the outside world. */
export interface ModelPluginManagerOptions {
  /**
   * Override the build-time glob result.
   *
   * The globs resolve to whatever is on disk, which makes the matching rules
   * untestable against a fixed set. Production passes nothing.
   */
  importers?: Record<string, () => Promise<ModelPluginModule>>;
  /**
   * The `scriptRef` of the document being loaded, or null when the model is not
   * a document of the open project (plan-718 §2.6).
   *
   * A seam, not a lookup: the manager must not import the project store — it
   * runs inside `loadModel()` and the composition root already knows both.
   */
  scriptRefProvider?: (ctx: { modelUrl: string; modelName: string }) => string | null | undefined;
  /**
   * Where the project's own files can be read from — the runtime mode of stage
   * 2b (§2.6 mode 2).
   *
   * A function rather than a value because the open project changes underneath a
   * long-lived manager; production hands over the active backend of the moment.
   * Absent (or returning null) means "build mode only", which is exactly what a
   * bundled deploy with no writable project wants.
   */
  runtimeScriptSource?: () => RuntimeScriptSource | null | undefined;
  /**
   * The per-project consent gate (2b.3, R8). Omitting it DENIES: unsandboxed
   * project code must not run because a wiring step was forgotten.
   */
  runtimeScriptConsent?: RuntimeScriptConsent;
}

// ─── scriptRef ↔ module resolution ─────────────────────────────────────

/** One spelling for a reference: `/`-separated, no leading `./` or `/`. */
export function normalizeScriptRef(ref: string): string {
  return String(ref ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
}

/**
 * Whether a discovered module path IS the file a `scriptRef` names.
 *
 * The reference is project-relative (`scripts/linie1/index.ts`); the glob key is
 * build-relative and spelled differently for each of the four roots
 * (`/src/plugins/models/…`, `../../../realvirtual-WebViewer-Private~/projects/…`).
 * The only thing the two share is the tail, so the match is a **segment-aligned
 * suffix**: `plugins/index.ts` matches `…/Toray/plugins/index.ts` but never
 * `…/other-plugins/index.ts`.
 *
 * Case-sensitive, like every other match in this module (K3). A reference that
 * differs only in case is a reference to a file that does not exist, and saying
 * so is the migration's job — not something to paper over at resolve time.
 */
export function moduleMatchesScriptRef(modulePath: string, scriptRef: string): boolean {
  const ref = normalizeScriptRef(scriptRef);
  if (ref === '') return false;
  const path = normalizeScriptRef(modulePath).replace(/^(\.\.\/)+/, '');
  return path === ref || path.endsWith(`/${ref}`);
}

// ─── Manager ───────────────────────────────────────────────────────────

export class ModelPluginManager {
  private activeModule: ModelPluginModule | null = null;
  private activeModelName: string | null = null;
  /**
   * Loaded modules, keyed by the MODULE's own glob path (plan-718 §2.6, F8).
   *
   * It used to be keyed by model name, which is wrong the moment two documents
   * share one module: the N:1 case imported the same file twice and cached it
   * under two names, so an invalidation could only ever reach one of them. The
   * module path is what `scriptRef` resolves TO, and it is the canonical form of
   * "keyed by scriptRef" — two references to one file collapse onto one entry,
   * and the legacy name paths get the same benefit for free.
   */
  private moduleCache = new Map<string, ModelPluginModule>();
  /** `ref:<scriptRef>` / `name:<modelName>` → module path. The lookup index. */
  private _moduleKeyByLookup = new Map<string, string>();
  /** Cache project folder names for private project plugins, keyed by module path. */
  private _projectFolderCache = new Map<string, string>();
  private readonly _importers: Record<string, () => Promise<ModelPluginModule>>;
  private readonly _scriptRefProvider: ModelPluginManagerOptions['scriptRefProvider'];
  private readonly _runtimeScriptSource: ModelPluginManagerOptions['runtimeScriptSource'];
  private readonly _runtimeScriptConsent: RuntimeScriptConsent | undefined;

  constructor(opts: ModelPluginManagerOptions = {}) {
    this._importers = opts.importers ?? allImporters;
    this._scriptRefProvider = opts.scriptRefProvider;
    this._runtimeScriptSource = opts.runtimeScriptSource;
    this._runtimeScriptConsent = opts.runtimeScriptConsent;
  }

  /**
   * Forget a cached module so the next load re-imports it (R13).
   *
   * The seam the runtime mode of stage 2b needs: saving a new version of a
   * script has to be able to say "the thing you have is stale". Accepts either a
   * `scriptRef` or a module path — a caller that saved a file knows the former.
   */
  invalidateScript(scriptRefOrModulePath: string): void {
    const ref = normalizeScriptRef(scriptRefOrModulePath);
    const viaLookup = this._moduleKeyByLookup.get(`ref:${ref}`);
    const keys = [...this.moduleCache.keys()].filter(
      key => key === viaLookup
        || key === scriptRefOrModulePath
        || key === `runtime:${ref}`
        || moduleMatchesScriptRef(key, ref),
    );
    for (const key of keys) {
      this.moduleCache.delete(key);
      this._projectFolderCache.delete(key);
      for (const [lookup, moduleKey] of [...this._moduleKeyByLookup]) {
        if (moduleKey === key) this._moduleKeyByLookup.delete(lookup);
      }
    }
  }

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

  /** Import one module, cache it under its own path, and record the lookup that found it. */
  private async _loadModule(
    path: string,
    importer: () => Promise<ModelPluginModule>,
    lookups: string[],
  ): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    const cached = this.moduleCache.get(path);
    const mod = cached ?? await importer();
    const projectFolder = this.extractProjectFolder(path);
    this.moduleCache.set(path, mod);
    if (projectFolder) this._projectFolderCache.set(path, projectFolder);
    for (const lookup of lookups) this._moduleKeyByLookup.set(lookup, path);
    return { mod, projectFolder };
  }

  /** A cache hit for an already-resolved lookup key, or null. */
  private _cached(lookup: string): { mod: ModelPluginModule; projectFolder: string | null } | null {
    const key = this._moduleKeyByLookup.get(lookup);
    if (!key) return null;
    const mod = this.moduleCache.get(key);
    if (!mod) return null;
    return { mod, projectFolder: this._projectFolderCache.get(key) ?? null };
  }

  /**
   * Find the plugin module for the model being loaded.
   *
   * Two resolvers, one binding. `scriptRef` — the manifest's answer — is
   * AUTHORITATIVE: when the row names a script, that script is the module, and a
   * `scriptRef` that resolves to nothing yields no plugins rather than falling
   * back to the name match. The fallback would silently restore precisely the
   * filename binding the reference model removes, and binding the wrong code is
   * worse than binding none.
   *
   * Without a `scriptRef` the two legacy resolvers run unchanged, and
   * deliberately so — both stay **case-sensitive** (K3). Normalising case here
   * would change which module an existing project resolves to, which is not a
   * compatibility path, it is a different behaviour wearing one.
   */
  private async findModuleWithPath(
    modelName: string,
    scriptRef: string | null,
  ): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    if (scriptRef) return this._findByScriptRef(scriptRef);
    return this._findByModelName(modelName);
  }

  private async _findByScriptRef(
    scriptRef: string,
  ): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    const ref = normalizeScriptRef(scriptRef);
    const lookup = `ref:${ref}`;
    const hit = this._cached(lookup);
    if (hit) return hit;

    for (const [path, importer] of Object.entries(this._importers)) {
      if (!moduleMatchesScriptRef(path, ref)) continue;
      try {
        return await this._loadModule(path, importer, [lookup]);
      } catch (e) {
        debugWarn('plugins', `Failed to load model plugins from ${path} (scriptRef "${ref}"): ${e}`);
        return null;
      }
    }
    // Nothing in this build carries that file. Stage 2b: the project may carry
    // it itself, compiled, next to the source — read it out of the project and
    // import it. Still no name fallback; the reference is still authoritative.
    const runtime = await this._findByRuntimeScript(ref, lookup);
    if (runtime) return runtime;

    debugWarn(
      'plugins',
      `scriptRef "${ref}" resolves to no bundled module and no runnable .js sibling in the `
      + 'project — this project\'s code is not in this build. No model plugins were loaded '
      + '(the name-based match is deliberately NOT used as a fallback).',
    );
    return null;
  }

  /**
   * The runtime resolver (§2.6 mode 2, stage 2b.1).
   *
   * Cached under `runtime:<scriptRef>` — a key that cannot collide with a glob
   * path, and which `invalidateScript` reaches through the `ref:` lookup index
   * it registers here. That is what makes "save a new version, the next load
   * picks it up" true (R13): the invalidation drops the entry, and the reload
   * builds a fresh Blob URL from the new bytes, which the browser's module map
   * has never seen.
   */
  private async _findByRuntimeScript(
    ref: string,
    lookup: string,
  ): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    let source: RuntimeScriptSource | null | undefined = null;
    try {
      source = this._runtimeScriptSource?.();
    } catch (e) {
      debugWarn('plugins', `Runtime script source unavailable for "${ref}": ${e}`);
      return null;
    }
    if (!source) return null;

    const loaded = await loadRuntimeScript(ref, {
      source,
      consent: this._runtimeScriptConsent,
    });
    if (!loaded) {
      const why = lastRuntimeScriptFailure();
      if (why === 'denied' || why === 'import-failed') {
        debugWarn('plugins', `Runtime script for "${ref}" was not loaded (${why}).`);
      }
      return null;
    }

    // Class, instance or namespace — all three arrive here as one object; what
    // decides is whether it can register plugins, not how it was exported.
    const mod = asModelPluginModule(loaded.value) ?? asModelPluginModule(loaded.namespace);
    if (!mod) {
      debugWarn(
        'plugins',
        `Runtime script "${loaded.jsRef}" exports no registerModelPlugins/unregisterModelPlugins `
        + 'pair — nothing to register.',
      );
      return null;
    }
    logInfo(`Model plugins for "${ref}" loaded from the project at runtime (v${loaded.version}).`);
    return this._loadModule(`runtime:${ref}`, () => Promise.resolve(mod), [lookup]);
  }

  private async _findByModelName(
    modelName: string,
  ): Promise<{ mod: ModelPluginModule; projectFolder: string | null } | null> {
    const lookup = `name:${modelName}`;
    const hit = this._cached(lookup);
    if (hit) return hit;

    // Try each importer — check folder name match first (fast path)
    for (const [path, importer] of Object.entries(this._importers)) {
      // Extract folder name from path: /src/plugins/models/DemoRealvirtualWeb/index.ts → DemoRealvirtualWeb
      const segments = path.replace(/\\/g, '/').split('/');
      const indexIdx = segments.findIndex(s => s.startsWith('index.'));
      const folderName = indexIdx > 0 ? segments[indexIdx - 1] : null;

      // For project paths, the folder before "plugins" is the project name
      const pluginsIdx = segments.indexOf('plugins');
      const projectName = pluginsIdx > 0 ? segments[pluginsIdx - 1] : null;

      // Quick match on folder/project name — case-sensitive, as it has always been.
      if (folderName === modelName || projectName === modelName) {
        try {
          return await this._loadModule(path, importer, [lookup]);
        } catch (e) {
          debugWarn('plugins', `Failed to load model plugins from ${path}: ${e}`);
          return null;
        }
      }
    }

    // Slow path: load all modules and check their `models` array. DEPRECATED —
    // `documents[].scriptRef` replaces it, and this path is read for one release
    // generation so an unmigrated project keeps working (F10/F5).
    for (const [path, importer] of Object.entries(this._importers)) {
      try {
        const mod = await importer();
        if (mod.models && mod.models.includes(modelName)) {
          logInfo(
            `Model plugins for '${modelName}' were matched through the deprecated `
            + `models[] declaration in ${path}. Set "scriptRef" on the document row `
            + 'in project.json instead — models[] is read for one more release.',
          );
          // Every name the module declares is a lookup that resolves to it, so a
          // switch between two of its models is one cached module, not two.
          return await this._loadModule(
            path,
            () => Promise.resolve(mod),
            [lookup, ...mod.models.map(name => `name:${name}`)],
          );
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

    // Find and load new model plugins. The manifest's answer first (§2.6).
    let scriptRef: string | null = null;
    try {
      scriptRef = this._scriptRefProvider?.({ modelUrl: resolveUrl, modelName }) ?? null;
    } catch (e) {
      // A provider that throws must not stop a model from loading — the
      // consequence of no reference is "no project code", which is a normal state.
      debugWarn('plugins', `scriptRef provider failed for '${modelName}': ${e}`);
    }
    const findResult = await this.findModuleWithPath(modelName, scriptRef);
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
