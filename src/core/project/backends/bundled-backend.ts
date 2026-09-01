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
 * `main.ts` already resolves the model list during boot, through several
 * deploy-specific paths (build-time glob, dev-only private-model endpoint,
 * runtime `models.json`). Re-deriving any of that here would mean two discovery
 * implementations that can disagree about what the build contains. So it is
 * passed in — which also makes this class testable without a bundler.
 *
 * ## It never invents a project (plan-735)
 *
 * A deploy root without a readable `project.json` used to be answered with a
 * synthetic demo project assembled from a build-time glob. Every channel
 * publishes a real manifest now — the public demo, the CONNECT bundle, the
 * customer workspace, and the projectless standard delivery, which generates
 * one — so a missing manifest is a broken deploy. `readManifest()` returns
 * `null` and says why, and the `scenes/index.json` catalogue that only the
 * synthetic manifest ever read is gone with it.
 */

import { migrateManifest } from '../rv-project-storage';
import { assertReadableScenePath } from '../rv-legacy-format';
import {
  isValidProjectV2,
  type RvProject,
  type RvProjectAssetEntry,
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
import type { RvDocumentEntry } from '../rv-project-types';
import {
  glbSceneRecord,
  type SceneRecord,
} from '../rv-scene-record';
import {
  BackendNotWritableError,
  type ProjectBackend,
  type ResolvedBackendBlob,
} from './project-backend';
import type { TreeCatalogEntryInput } from '../rv-project-tree-sources';

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
  /** Injectable for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Backend id. Defaults to `bundled:<baseUrl>`. */
  id?: string;
  /**
   * Discover models from the base URL itself, rather than having them injected
   * (plan-700 Phase 7, F12).
   *
   * Opt-in and off by default, so the deploy-root instance behaves exactly as
   * it always has: `main.ts` resolves that list through several deploy-specific
   * paths and a second discovery here would eventually disagree with it. A
   * *foreign* base URL has no such resolver — nobody ran a build against it —
   * so for that case `models.json`, the file every deploy publishes, is read
   * directly. (`scenes/index.json` was read here too until plan-735; a foreign
   * deploy's scenes are `documents[]` rows of its manifest now.)
   *
   * Discovery only ever FILLS IN: a `project.json` that lists its own models
   * keeps them. It never substitutes for a manifest — a host without a
   * `project.json` has no project, `models.json` or not (plan-735 R1).
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
    this._fetch = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this._discover = opts.discover === true;
    this.id = opts.id ?? `bundled:${this._baseUrl}`;
  }

  /** The deploy root this backend reads from. Always ends in `/`. */
  get baseUrl(): string { return this._baseUrl; }

  get isActive(): boolean { return this._active; }

  // ─── Read ─────────────────────────────────────────────────────────────

  /**
   * The deploy's own `project.json` — or `null`, audibly (plan-735 F6/F7).
   *
   * A customer deploy already carries `project.json` at the root — the same
   * file `scripts/_bunny-lib.mjs` reads. It is a *deploy* manifest with a
   * different schema, so it goes through `migrateManifest()` exactly like a
   * folder manifest does.
   *
   * ## There is no invented project behind this any more
   *
   * Until plan-735 a deploy root without a readable manifest was answered with
   * a SYNTHETIC one, assembled from the build-time glob over
   * `/public/models/*.glb`. That made "every deploy has a project" true by
   * making the viewer imagine one, and it hid every real failure behind it: a
   * 404, a CORS rejection, a CDN error page and a corrupt manifest all produced
   * the same cheerful demo project. Since plan-735 every channel publishes a
   * real `project.json` — including the projectless standard-customer delivery,
   * which now generates one — so a missing manifest is a broken deploy and is
   * reported as one.
   *
   * The three causes below are deliberately reported TOGETHER: `_fetchJson()`
   * cannot tell them apart. A 404, a CORS-blocked cross-origin read and a
   * `file://` reject all surface as `deployed === null`, because the first is a
   * `!resp.ok` and the other two are a thrown `fetch`. Naming all three in one
   * sentence is honest; pretending to have diagnosed one of them would not be.
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
    // ── The V2 gate (plan-726 F11b) ────────────────────────────────────
    //
    // It used to be missing entirely, and that was not a small gap: the only
    // validation on this path is `migrateManifest()`'s, which calls
    // `isValidProjectV1()` — and V1 does not look at `documents[]` at all. A
    // deploy whose manifest declared a document with no `id`, or `documents`
    // as an object, was adopted without a word and then showed an empty
    // project. Since plan-726 the root `project.json` is the boot SSOT of the
    // public demo, so "adopted silently and wrong" is the worst of the three
    // possible answers.
    //
    // Checked AFTER `withDerivedDocuments()` on purpose: a legitimate
    // pre-phase-6 customer manifest carries `models[]`/`scenes[]` and no
    // `documents[]`, and it is that derivation — not the file on disk — that
    // this build actually consumes. Validating the raw bytes would reject
    // every unmigrated deploy that works perfectly well.
    //
    // The warning is the other half. This file carried ZERO `console.*` calls,
    // which is why every failure here (404, HTML error page, corrupt JSON,
    // invalid schema) looked identical from the outside: the synthetic demo
    // project, quietly. The fallback is still the right behaviour — a broken
    // manifest must not be a white page — but it has to be audible.
    // One shape has to be judged on the RAW bytes, before derivation:
    // `documents` present but not an array. `withDerivedDocuments()` treats
    // that as "no document list" and derives an EMPTY one from the (absent)
    // legacy arrays, so the manifest would pass the V2 gate below as a valid
    // project with zero documents — adopted in silence, showing nothing. That
    // is the exact failure F11b exists to end, and it is distinguishable only
    // here, while the original field is still visible.
    const rawDocuments = (deployed as { documents?: unknown } | null)?.documents;
    const shapeOk = rawDocuments === undefined || Array.isArray(rawDocuments);
    const valid = migrated !== null && shapeOk && isValidProjectV2(migrated);
    // Two different failures, two different sentences — and NEITHER is silent
    // any more (plan-735 4c). `deployed !== null` means the file was there and
    // parsed as JSON, so the manifest is wrong rather than absent.
    if (deployed !== null && !valid) {
      console.warn(
        `[bundled] ${this._url('project.json')} is not a valid v2 project manifest `
        + '(schemaVersion/id/name, or a documents[] entry without id or path). '
        + 'This deploy root has no project — the viewer will not invent one.',
      );
    } else if (deployed === null) {
      // The line plan-735 exists to add. The old comment here said "a deploy
      // root without a project.json is the normal, supported shape"; since
      // plan-735 that sentence is false on every channel, so the silence goes
      // with it.
      console.warn(
        `[bundled] ${this._url('project.json')} could not be read — it is missing (404), `
        + 'blocked by CORS, or unreachable from this origin (a file:// page cannot fetch it). '
        + 'This deploy root has no project; nothing will be shown until it publishes one.',
      );
    }
    this._hasDeployedManifest = valid;
    this._manifest = valid ? this._withDiscoveredModels(migrated) : null;
    return this._manifest;
  }

  /**
   * True when the base URL actually served a readable, valid `project.json`.
   *
   * Since plan-735 this is exactly `readManifest() !== null` — the synthetic
   * fallback that used to make the two differ is gone. It stays as a named
   * predicate because that is what its callers read it as: `project-store.ts`
   * uses it to decide whether a deploy has SAID what its project is, and
   * `diagnoseKioskBoot()` (plan-721 F8) uses it as the appliance's boot verdict,
   * where "no project served" and "project served but empty" must remain two
   * different answers. Meaningful after `readManifest()` has been awaited.
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
   * Fill a FOREIGN host's `models` section from its own `models.json`.
   *
   * ## What this used to be, and why the rest of it is gone (plan-735)
   *
   * `_withBundledSections()` folded the build's discovered models AND the
   * `scenes/index.json` catalogue into any manifest that declared neither. The
   * scenes half went with plan-731; the models half went here, and it was the
   * more dangerous of the two — it ran on EVERY valid manifest, so a customer
   * project that simply did not list its models was silently completed from
   * whatever the build-time glob had found. That is Vektor B of plan-735 §2.2:
   * remove the glob and those projects boot to an empty viewport. Every private
   * manifest declares its own models since plan-735 Phase 2, so the fill is not
   * needed for OUR manifests and is not offered to them.
   *
   * What survives is the half that is not a fill at all but a READ at a system
   * boundary: a foreign deploy root reached through `discover` publishes
   * `models.json`, that file is the host's own statement about its models, and
   * folding it in is how `plan-700 F12` reads someone else's deploy. It runs
   * ONLY with `discover: true`, and only when the manifest declares no models
   * of its own — a host that lists them keeps its own order and labels.
   */
  private _withDiscoveredModels(project: RvProject): RvProject {
    if (!this._discover || this._models.length === 0) return project;
    const declared = readDocuments(project) ?? [];
    const missing = (section: DocumentSection) =>
      !declared.some(d => sectionOfDocument(d) === section);
    if (!missing('models')) return project;
    const added = documentsFromLists({
      models: this._models.map(m => ({ path: m.url, label: m.label })),
    });
    if (added.length === 0) return project;
    return { ...project, documents: [...declared, ...added] };
  }

  /**
   * Fill `models` from the base URL when nothing was injected.
   *
   * Only runs with `discover: true`, and only when the caller left the list
   * empty — a caller that passed one is the authority on it. `models.json` is a
   * `string[]` of GLB filenames (the format every deploy has published since
   * `stagePrivateProject` first wrote it). It not being there is the normal case
   * for a bare deploy, and it is not an error.
   *
   * The `scenes/index.json` read is GONE (plan-735 3b). It fed
   * `_publishedEntries()`, which fed the synthetic manifest, which no longer
   * exists — so the whole foreign-example-catalogue chain, moved into this file
   * by plan-731, had no consumer left. A foreign deploy's example scenes are
   * `documents[]` rows of its `project.json`, exactly like ours.
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
    let resp: Response;
    try {
      // `no-cache`, not `no-store` (plan-726 §8). Both guarantee freshness;
      // only one of them lets the CDN answer `304 Not Modified` against the
      // ETag, and this file is on the critical path of every single boot —
      // `readManifest()` is awaited before the SceneStore even exists. Under
      // `no-store` the whole manifest came down again on every reload; under
      // `no-cache` an unchanged one costs a conditional request. What must NOT
      // happen is the third option — caching it like a hashed build asset — so
      // this stays an explicit revalidation and never `immutable`.
      resp = await this._fetch(this._url(relPath), { cache: 'no-cache' });
    } catch {
      // Offline, CORS-blocked, or a host that is not there. A missing optional
      // file is the normal case here, not an error.
      return null;
    }
    if (!resp.ok) return null;
    try {
      return await resp.json();
    } catch (e) {
      // The server ANSWERED and the body is not JSON — a truncated upload, an
      // HTML error page served with 200, a hand-edit that lost a brace. That is
      // a broken deploy artefact, not an absent optional file, and staying
      // silent about it is what made a corrupt `project.json` indistinguishable
      // from having none (plan-726 F11b).
      console.warn(`[bundled] ${this._url(relPath)} is not valid JSON:`, e);
      return null;
    }
  }
}

// ─── The foreign example catalogue is GONE (plan-735 3b) ─────────────────
//
// `PublishedSceneEntry`, `parsePublishedIndex()`, `publishedScenePath()` and
// `publishedSceneId()` lived here since plan-731 moved them out of
// `rv-published-scenes` (which became the `published:` ALIAS and stopped being
// a catalogue). Their only consumer was `_publishedEntries()`, and its only
// consumer was the synthetic manifest — so removing that removed the last
// reader of the `scenes/index.json` format anywhere in the app.
//
// A deploy's example scenes are `documents[]` rows of its `project.json`, ours
// and a foreign one alike. `src/core/hmi/scene/rv-published-scenes.ts` still
// owns the `published:` id alias, which is a different thing: an ADDRESS for a
// document, not a second catalogue of what exists.

// ─── The built-in demo catalog (plan-445 F6) ────────────────────────────

/** Provider/source id and label of the read-only built-in demos root. */
export const BUILTIN_CATALOG_PROVIDER_ID = 'builtin';
export const BUILTIN_CATALOG_SOURCE_ID = 'demos';
export const BUILTIN_CATALOG_LABEL = 'Built-in demos';

/**
 * The demo models a build ships, as rows of a read-only catalog root.
 *
 * ## Why an adapter and not a `LibrarySource`
 *
 * `library-source-registry` has had `kind: 'bundled'` in its union since it was
 * written and has never instantiated one, because a demo model is not a library
 * asset: it is a whole scene, it is opened rather than dropped into one, and it
 * has no thumbnail, no collections and no category. Registering a source would
 * have meant inventing all three. Translating the listing the bundled backend
 * ALREADY produces into `TreeCatalogEntryInput` costs nothing and invents none
 * of it — the root is `writable: false`, and every refusal follows from that
 * one flag through `canMoveInTree` / `canRenameInTree`.
 *
 * `assetId` carries the model's **URL**, because that is what opening one needs
 * (`sceneStore.openBuiltin`, the `?model=` deep link's own call) and the bundled
 * manifest already stores models by URL. `path` is the bare file name, so the
 * catalog reads as one flat list of demos rather than as somebody's deploy
 * folder structure.
 */
export async function bundledCatalogEntries(
  backend: Pick<ProjectBackend, 'listModels'>,
): Promise<TreeCatalogEntryInput[]> {
  let models: RvProjectAssetEntry[];
  try {
    models = await backend.listModels();
  } catch {
    // A deploy that cannot answer has no demos — never a broken dashboard.
    return [];
  }
  const out: TreeCatalogEntryInput[] = [];
  for (const model of models) {
    const url = typeof model.path === 'string' ? model.path.trim() : '';
    if (url === '') continue;
    const file = bundledFileNameOf(url);
    out.push({
      assetId: url,
      name: (model.label?.trim() || file).replace(/\.(glb|gltf)$/i, ''),
      path: file,
    });
  }
  return out;
}

/**
 * Drop the demos the OPEN project already carries (plan-445 Phase 5).
 *
 * A developer checkout has `DemoRealvirtualWeb.glb` sitting in the project
 * folder AND shipped as a built-in, and two rows for one file is worse than
 * either row alone. The project row wins: it is the writable one, and it is the
 * copy an edit would actually change. Matched on the FILE NAME, because the two
 * sides agree on nothing else — one is a deploy URL, the other a project path.
 */
export function dedupeBundledEntries(
  entries: readonly TreeCatalogEntryInput[],
  projectPaths: readonly string[],
): TreeCatalogEntryInput[] {
  const taken = new Set(projectPaths.map(p => bundledFileNameOf(p).toLowerCase()));
  return entries.filter(e => !taken.has(bundledFileNameOf(e.path ?? e.assetId).toLowerCase()));
}

/** Last path segment of a URL or a relative path, query and hash removed. */
function bundledFileNameOf(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0];
  return withoutQuery.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? withoutQuery;
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

