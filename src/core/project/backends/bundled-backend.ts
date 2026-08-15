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
import { migrateManifest } from '../rv-project-storage';
import { assertReadableScenePath } from '../rv-legacy-format';
import type {
  RvProject,
  RvProjectAssetEntry,
  RvProjectSceneEntry,
} from '../rv-project-types';
import {
  assetDocumentsOf,
  documentsFromLists,
  readDocuments,
  sceneDocumentsOf,
  sectionOfDocument,
  withDerivedDocuments,
  type DocumentSection,
  type DocumentStat,
} from '../rv-project-documents';
import {
  RV_PROJECT_SCHEMA_VERSION,
  type RvDocumentEntry,
} from '../rv-project-types';
import {
  glbSceneRecord,
  type SceneRecord,
} from '../rv-scene-record';
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
/**
 * Catalog of the realvirtual component library, relative to the deploy root.
 * NOT read by any boot path — a deploy manifest must reference it explicitly
 * (`libraries[]`) for the library to exist at runtime.
 */
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
    const parsed = deployed ? migrateManifest(deployed) : null;
    // A deploy manifest is FOREIGN: nobody ran the folder conversion over it,
    // so it may still carry only the legacy arrays. Derive its documents on the
    // way in, or a customer deploy built before phase 6 would show nothing.
    const migrated = parsed ? withDerivedDocuments(parsed) : null;
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

  /**
   * Read a shipped scene. GLB bytes, and nothing else (plan-413 phase 6).
   *
   * A deploy is read-only, so there is no precondition to honour here — but it
   * still has to be able to *serve* a GLB scene, or a project published after
   * the plan-397 migration would not open from its own deploy root.
   *
   * A foreign deploy built before phase 3 still publishes `.scene.json`
   * examples. Those now get the F10 refusal instead of a JSON branch: the
   * remedy is to rebuild that deploy, and saying so is more use than silently
   * serving a format nothing downstream understands.
   */
  async readScene(relPath: string): Promise<SceneRecord | null> {
    assertReadableScenePath(relPath);
    const bytes = await this._fetchBytes(relPath);
    if (!bytes) return null;
    const meta = sceneDocumentsOf(await this.readManifest()).find(e => e.path === relPath);
    return glbSceneRecord(bytes, { ...meta, path: relPath });
  }

  async readSettings(relPath?: string): Promise<unknown | null> {
    return this._fetchJson(relPath ?? 'settings/project-settings.json');
  }

  // ─── Listing ──────────────────────────────────────────────────────────

  async listModels(): Promise<RvProjectAssetEntry[]> {
    return assetDocumentsOf(await this.readManifest(), 'models');
  }

  /**
   * Only what the manifest declares — nothing is discovered.
   *
   * The deploy catalog (`library/catalog.json`) is deliberately NOT read as a
   * fallback anymore: a library exists only when it was explicitly referenced,
   * either as `library[]` contents or as a `libraries[]` subscription in a
   * deployed manifest. A deploy without such a declaration has no library.
   */
  async listLibrary(): Promise<RvProjectAssetEntry[]> {
    return assetDocumentsOf(await this.readManifest(), 'library');
  }

  /**
   * The one list (plan-413 §2.4), assembled from the three listings.
   *
   * Sequential, not `Promise.all`, and deliberately so: {@link readManifest}
   * sets its `_manifestRead` latch *before* awaiting the fetch, so a second
   * caller arriving while the first is still in flight is handed the field it
   * has not filled in yet — an empty project. Awaiting the manifest once up
   * front makes the three listings cache hits and side-steps it entirely. (The
   * latch itself is a pre-existing sharp edge; caching the in-flight promise
   * instead of the result would be the real fix, and belongs to whoever owns
   * that file next.)
   */
  async listDocuments(): Promise<RvDocumentEntry[]> {
    const manifest = await this.readManifest();
    const declared = readDocuments(manifest) ?? [];
    const scenes = sceneDocumentsOf(manifest);
    const models = await this.listModels();
    const library = await this.listLibrary();
    return documentsFromLists({ scenes, models, library }, declared);
  }

  /**
   * Never scanned — and that is a decision, not a gap (§2.5, SOL R1-7).
   *
   * Two reasons, either sufficient. `fetch` gives no `mtime` worth trusting
   * (a CDN's `Last-Modified` describes the cache entry, not the artefact), so
   * the pre-filter would never clear and every open would re-download every
   * GLB. And there is nothing to reconcile: a bundled deploy is read-only, so
   * its manifest cannot fall behind bytes that nobody can change. An empty
   * stat list is how a backend says "my manifest is authoritative".
   */
  async statDocuments(): Promise<DocumentStat[]> { return []; }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  /** Activation is bookkeeping only — there is no writer to bring up. */
  async activate(): Promise<void> { this._active = true; }
  async deactivate(): Promise<void> { this._active = false; }

  // ─── Write — all of it refused ────────────────────────────────────────

  async writeScene(): Promise<never> { throw new BackendNotWritableError(this.id, 'read-only'); }
  async deleteScene(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }
  /**
   * Refused before the precondition is even looked at (plan-709 §2.3).
   *
   * The parameters are deliberately absent: "read-only" outranks every
   * `expectedRevision`, so accepting them here would only invite a reader to
   * think a `null` ("create only") might get through. It does not.
   */
  async writeBlob(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }
  async deleteBlob(): Promise<void> { throw new BackendNotWritableError(this.id, 'read-only'); }

  async readBlobUrl(relPath: string): Promise<ResolvedBackendBlob | null> {
    // Nothing to revoke: a deploy URL is already loadable as it stands.
    return { url: this._url(relPath), release: () => {} };
  }

  async readBlobBytes(relPath: string): Promise<ArrayBuffer | null> {
    // No leak to close here — a deploy URL is not an object URL — but the
    // contract is one method for every backend, so a caller never branches on
    // `kind` to find out how to get bytes.
    const bytes = await this._fetchBytes(relPath);
    if (!bytes) return null;
    return bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
  }

  /** No queue, nothing to await. Present so callers need no `kind` check. */
  async flush(): Promise<void> {}

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * The demo project, assembled from what the deploy ships.
   *
   * It is the one project that legitimately carries the realvirtual demo
   * scenes and models — every other project starts empty (§2.3). It carries
   * NO library subscription: libraries appear only when explicitly referenced
   * (a deployed manifest's `libraries[]`, or one the user adds), never as a
   * synthesized default.
   */
  private _syntheticManifest(): RvProject {
    return {
      schemaVersion: RV_PROJECT_SCHEMA_VERSION,
      id: DEMO_PROJECT_ID,
      name: DEMO_PROJECT_NAME,
      canonicalName: DEMO_PROJECT_SLUG,
      documents: this._bundledDocuments(),
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
    const declared = readDocuments(project) ?? [];
    const missing = (section: DocumentSection) =>
      !declared.some(d => sectionOfDocument(d) === section);
    const added: RvDocumentEntry[] = [];
    if (missing('scenes')) {
      added.push(...documentsFromLists({ scenes: this._publishedEntries() }));
    }
    if (missing('models')) {
      added.push(...documentsFromLists({ models: this._modelEntries() }));
    }
    if (added.length === 0) return project;
    return { ...project, documents: [...declared, ...added] };
  }

  /** The demo project's own documents: the shipped examples plus the models. */
  private _bundledDocuments(): RvDocumentEntry[] {
    return documentsFromLists({
      scenes: this._publishedEntries(),
      models: this._modelEntries(),
    });
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
   *
   * The classification comes from the catalogue, not from the bytes, and that
   * is the correct direction here: §2.5 says a bundled deploy is never scanned
   * — it is read-only, so its manifest cannot go stale against files nobody can
   * change — and reading the level out of the GLBs would mean downloading every
   * example just to draw a list.
   */
  private _publishedEntries(): RvProjectSceneEntry[] {
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
      ...(e.level ? { classification: { v: 1 as const, level: e.level } } : {}),
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

  /** Same posture as {@link _fetchJson}, for a binary body. */
  private async _fetchBytes(relPath: string): Promise<Uint8Array | null> {
    if (!this._fetch) return null;
    try {
      const resp = await this._fetch(this._url(relPath), { cache: 'no-store' });
      if (!resp.ok) return null;
      return new Uint8Array(await resp.arrayBuffer());
    } catch {
      return null;
    }
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

