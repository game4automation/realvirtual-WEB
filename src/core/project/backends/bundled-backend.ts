// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bundled-backend — the read-only project that is always there.
 *
 * Its bytes come from the deploy root (`import.meta.env.BASE_URL`): the
 * models the build ships (`public/models/`, or the runtime `models.json`
 * manifest of a private deploy), the example scenes of the DemoRealvirtual project,
 * and — when the deploy has one — a `project.json` at the root.
 *
 * This is what makes "every scene lives in a project" true without a
 * filesystem API. A Safari user, an iPad, a Bunny/Firebase/CONNECT-embedded
 * customer build: all of them have this backend, so all of them have a
 * project. It carries no user data at all — the writable half is the browser
 * backend layered over it (§2.3, Phase 2).
 *
 * ## Sources are injected, discovery is not repeated
 *
 * `main.ts` already resolves the model list and the published-scene list
 * during boot, through several deploy-specific paths (build-time glob,
 * dev-only private-model endpoint, runtime `models.json`, curated
 * `scenes/index.json`). Re-deriving any of that here would mean two
 * discovery implementations that can disagree about what the build
 * contains. So they are passed in — which also makes this class testable
 * without a bundler.
 */

import {
  parsePublishedIndex,
  publishedScenePath,
  urlNameFromFile,
  type PublishedSceneEntry,
} from '../../hmi/scene/rv-published-scenes';
import type { RvScene } from '../../hmi/scene/rv-scene-types';
import { migrateManifest } from '../rv-project-storage';
import type {
  RvProject,
  RvProjectAssetEntry,
  RvProjectSceneEntry,
} from '../rv-project-types';
import { RV_PROJECT_SCHEMA_VERSION } from '../rv-project-types';
import {
  BackendNotWritableError,
  type ProjectBackend,
  type ResolvedBackendBlob,
} from './project-backend';

/**
 * Stable id of the demo project every build has.
 *
 * The literal stays `prj_sample`: it is written into `localStorage`
 * (last project) and into cache ownership markers by every build shipped so
 * far. Renaming the *display* name is free, renaming the id would orphan all
 * of that.
 */
export const DEMO_PROJECT_ID = 'prj_sample';
/** Display name of that project — the home of the realvirtual demos. */
export const DEMO_PROJECT_NAME = 'DemoRealvirtual';
/** Canonical (slug) name, used by `?project=` deep links. */
export const DEMO_PROJECT_SLUG = 'demorealvirtual';
/**
 * Conventional folder name of the demo project.
 *
 * The demo content itself is bundled (`public/`), so this is no longer a
 * repository path. It survives as the folder name `ProjectStore` looks for in a
 * user's local File System Access workspace.
 */
export const DEMO_PROJECT_FOLDER = 'demo-realvirtual';
/** Catalog of the realvirtual component library, relative to the deploy root. */
export const REALVIRTUAL_LIBRARY_PATH = 'library/catalog.json';

/** @deprecated Use {@link DEMO_PROJECT_ID}. */
export const SAMPLE_PROJECT_ID = DEMO_PROJECT_ID;
/** @deprecated Use {@link DEMO_PROJECT_NAME}. */
export const SAMPLE_PROJECT_NAME = DEMO_PROJECT_NAME;

export interface BundledModel {
  /** Absolute or base-relative URL of the GLB. */
  url: string;
  /** Display label — what the model selector shows today. */
  label: string;
}

export interface BundledBackendOptions {
  /** Deploy root. Defaults to `import.meta.env.BASE_URL`, or `/` outside a bundler. */
  baseUrl?: string;
  /** Models the build ships, as `main.ts` resolved them. */
  models?: BundledModel[];
  /** Example scenes of the DemoRealvirtual project, as `main.ts` resolved them. */
  publishedScenes?: PublishedSceneEntry[];
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Backend id. Defaults to `bundled:<baseUrl>`. */
  id?: string;
  /**
   * Discover models and example scenes from the base URL itself, rather than
   * having them injected (plan-700 Phase 7, F12).
   *
   * Opt-in and off by default, so the deploy-root instance behaves exactly as
   * it always has: `main.ts` resolves that list through four deploy-specific
   * paths and a second discovery here would eventually disagree with it. A
   * *foreign* base URL has no such resolver — nobody ran a build against it —
   * so for that case the two files a deploy always publishes, `models.json`
   * and `scenes/index.json`, are read directly.
   *
   * Discovery only ever FILLS IN: a `project.json` that lists its own
   * `models[]`/`scenes[]` keeps them.
   */
  discover?: boolean;
}

export class BundledBackend implements ProjectBackend {
  readonly kind = 'bundled' as const;
  readonly id: string;
  /** Never. A deploy root is HTTP; there is nothing to write to. */
  readonly writable = false;

  private readonly _baseUrl: string;
  private _models: BundledModel[];
  private _published: PublishedSceneEntry[];
  private readonly _fetch: typeof fetch | null;
  private readonly _discover: boolean;
  private _discovered = false;
  private _active = false;
  private _manifest: RvProject | null = null;
  private _manifestRead = false;
  private _hasDeployedManifest = false;
  private _library: RvProjectAssetEntry[] = [];
  private _libraryRead = false;

  constructor(opts: BundledBackendOptions = {}) {
    this._baseUrl = normaliseBase(opts.baseUrl ?? defaultBaseUrl());
    this._models = opts.models ?? [];
    this._published = opts.publishedScenes ?? [];
    this._fetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._discover = opts.discover === true;
    this.id = opts.id ?? `bundled:${this._baseUrl}`;
  }

  /** The deploy root this backend reads from. Always ends in `/`. */
  get baseUrl(): string { return this._baseUrl; }

  get isActive(): boolean { return this._active; }

  // ─── Read ─────────────────────────────────────────────────────────────

  /**
   * The deploy's own `project.json` when it has one, otherwise a synthetic
   * Sample manifest.
   *
   * A customer deploy already carries `project.json` at the root — the same
   * file `scripts/_bunny-lib.mjs` reads. It is a *deploy* manifest with a
   * different schema, so it goes through `migrateManifest()` exactly like a
   * folder manifest does; only if that yields nothing does the synthetic
   * Sample step in.
   */
  async readManifest(): Promise<RvProject | null> {
    if (this._manifestRead) return this._manifest;
    this._manifestRead = true;
    await this._discoverSources();
    const deployed = await this._fetchJson('project.json');
    const migrated = deployed ? migrateManifest(deployed) : null;
    this._hasDeployedManifest = !!migrated;
    this._manifest = migrated ? this._withBundledSections(migrated) : this._syntheticManifest();
    return this._manifest;
  }

  /**
   * True when the base URL actually served a readable `project.json`.
   *
   * `readManifest()` never returns null — a deploy root without a manifest
   * still yields the synthetic demo project, which is the right answer for
   * OUR deploy root and the wrong one for a foreign host. A caller pointing at
   * someone else's URL needs to tell "this host has a project" from "this host
   * answered 404 and I invented one", and only this flag says so.
   * Meaningful after `readManifest()` has been awaited.
   */
  hasDeployedManifest(): boolean { return this._hasDeployedManifest; }

  async readScene(relPath: string): Promise<RvScene | null> {
    const json = await this._fetchJson(relPath);
    return isSceneLike(json) ? (json as RvScene) : null;
  }

  async readSettings(relPath?: string): Promise<unknown | null> {
    return this._fetchJson(relPath ?? 'settings/project-settings.json');
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  async listScenes(): Promise<RvProjectSceneEntry[]> {
    return (await this.readManifest())?.scenes ?? [];
  }

  async listModels(): Promise<RvProjectAssetEntry[]> {
    return (await this.readManifest())?.models ?? [];
  }

  /**
   * The library the deploy ships, read from its own catalog.
   *
   * There is no folder to walk over HTTP, so where a folder project enumerates
   * `library/`, this reads `library/catalog.json` — the file that enumerates it
   * for the planner anyway. Without this the Assets tab was empty on every
   * deploy and on the default boot, because the synthetic manifest declares
   * `libraries[]` (the subscription) and never `library[]` (the contents).
   *
   * A manifest that declares its own `library[]` wins: a customer deploy that
   * curated the list keeps it.
   */
  async listLibrary(): Promise<RvProjectAssetEntry[]> {
    const declared = (await this.readManifest())?.library;
    if (Array.isArray(declared) && declared.length > 0) return declared;
    if (this._libraryRead) return this._library;
    this._libraryRead = true;
    // One base: the library is bundled under `public/library/`, so the deploy
    // root serves it in dev and in a build alike.
    this._library = catalogAssets(await this._fetchJson(REALVIRTUAL_LIBRARY_PATH));
    return this._library;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Activation is bookkeeping only — there is no writer to bring up. */
  async activate(): Promise<void> { this._active = true; }
  async deactivate(): Promise<void> { this._active = false; }

  // ─── Write — all of it refused ────────────────────────────────────────

  async writeScene(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }
  async deleteScene(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }
  async writeBlob(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }
  async deleteBlob(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }

  async readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null> {
    // Nothing to revoke: a deploy URL is already loadable as it stands.
    return { url: this._url(relPath), release: () => {} };
  }

  /** No queue, nothing to await. Present so callers need no `kind` check. */
  async flush(): Promise<void> {}

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * The demo project, assembled from what the deploy ships.
   *
   * It is the one project that legitimately carries the realvirtual demo
   * scenes and models — every other project starts empty (§2.3). It is also
   * the only one subscribed to the shipped realvirtual component library, so
   * a customer's own project shows the customer's assets and nothing else.
   */
  private _syntheticManifest(): RvProject {
    return {
      schemaVersion: RV_PROJECT_SCHEMA_VERSION,
      id: DEMO_PROJECT_ID,
      name: DEMO_PROJECT_NAME,
      canonicalName: DEMO_PROJECT_SLUG,
      scenes: this._sceneEntries(),
      models: this._modelEntries(),
      libraries: [{ url: this._url(REALVIRTUAL_LIBRARY_PATH), label: 'realvirtual Library' }],
      activeSceneId: null,
    };
  }

  /**
   * Fold the build's models/examples into a deploy manifest.
   *
   * The deploy manifest is authoritative for what it does list; the bundled
   * discovery fills the sections it leaves empty. A deploy that enumerates
   * its own `models[]` therefore keeps its own order and labels.
   */
  private _withBundledSections(project: RvProject): RvProject {
    const merged: RvProject = { ...project };
    if (!Array.isArray(merged.models) || merged.models.length === 0) {
      merged.models = this._modelEntries();
    }
    if (!Array.isArray(merged.scenes) || merged.scenes.length === 0) {
      merged.scenes = this._sceneEntries();
    }
    return merged;
  }

  private _modelEntries(): RvProjectAssetEntry[] {
    return this._models.map(m => ({ path: m.url, label: m.label }));
  }

  /**
   * Example scenes as manifest entries.
   *
   * The id is derived from the file name (`published:<urlName>`) rather than
   * minted: it has to be the same on every boot and in every tab, because
   * the two-tier merge and the `hidden` list key off it.
   */
  private _sceneEntries(): RvProjectSceneEntry[] {
    // `publishedScenePath` answers for the LOCAL deploy — in dev it re-roots
    // onto the private-assets mount. A discovering backend reads from a foreign
    // base, where `_url()` does the rooting, so its paths must stay plain
    // `scenes/<file>` or they would be resolved against the wrong origin.
    const pathOf = this._discover
      ? (file: string) => `scenes/${file}`
      : publishedScenePath;
    return this._published.map(e => ({
      id: publishedSceneId(e.urlName ?? urlNameFromFile(e.file)),
      name: e.label,
      path: pathOf(e.file),
      baseKind: 'published',
      ...(e.mode ? { mode: e.mode } : {}),
    }));
  }

  /**
   * Fill `models`/`publishedScenes` from the base URL when nothing was injected.
   *
   * Only runs with `discover: true`, and only for the halves the caller left
   * empty — a caller that passed a list is the authority on it. `models.json`
   * is a `string[]` of GLB filenames (the format every deploy has published
   * since `stagePrivateProject` first wrote it); `scenes/index.json` is the
   * curated `[{file,name,mode}]` Examples catalogue. Neither being there is
   * the normal case for a bare deploy, and it is not an error.
   */
  private async _discoverSources(): Promise<void> {
    if (!this._discover || this._discovered) return;
    this._discovered = true;
    if (this._models.length === 0) {
      const listed = await this._fetchJson('models.json');
      if (Array.isArray(listed)) {
        this._models = listed
          .filter((f): f is string => typeof f === 'string' && f.length > 0)
          .map(filename => ({
            url: this._url(`models/${filename}`),
            label: filename.replace(/\.glb$/i, ''),
          }));
      }
    }
    if (this._published.length === 0) {
      const index = await this._fetchJson('scenes/index.json');
      this._published = parsePublishedIndex(index);
    }
  }

  private _url(relPath: string): string {
    if (/^(https?:)?\/\//i.test(relPath) || relPath.startsWith('blob:') || relPath.startsWith('data:')) {
      return relPath;
    }
    return `${this._baseUrl}${relPath.replace(/^\/+/, '')}`;
  }

  private async _fetchJson(relPath: string): Promise<unknown | null> {
    if (!this._fetch) return null;
    try {
      const resp = await this._fetch(this._url(relPath), { cache: 'no-store' });
      if (!resp.ok) return null;
      return await resp.json();
    } catch {
      // A missing optional file is the normal case here, not an error.
      return null;
    }
  }
}

/** Stable scene id for a bundled example. */
export function publishedSceneId(urlName: string): string {
  return `published:${urlName}`;
}

function defaultBaseUrl(): string {
  try {
    return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  } catch {
    return '/';
  }
}

function normaliseBase(base: string): string {
  const b = base || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/** The folder the library catalog sits in — `library` for `library/catalog.json`. */
const LIBRARY_ROOT = REALVIRTUAL_LIBRARY_PATH.replace(/\/[^/]*$/, '');

/**
 * Library catalog → manifest asset entries.
 *
 * A catalog entry's `glbUrl` is relative to the catalog itself
 * (`PalletHandling/Turntable.glb`), so it becomes a project path by prefixing
 * the library folder. Absolute URLs are kept as they are — a catalog may point
 * at assets hosted elsewhere.
 */
function catalogAssets(raw: unknown): RvProjectAssetEntry[] {
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: RvProjectAssetEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const glbUrl = typeof rec.glbUrl === 'string' ? rec.glbUrl.trim() : '';
    if (!glbUrl) continue;
    const path = /^(https?:)?\/\//i.test(glbUrl) ? glbUrl : `${LIBRARY_ROOT}/${glbUrl}`;
    const label = typeof rec.name === 'string' && rec.name ? rec.name : undefined;
    out.push(label ? { path, label } : { path });
  }
  return out;
}

function isSceneLike(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === 'string' && !!s.base;
}
