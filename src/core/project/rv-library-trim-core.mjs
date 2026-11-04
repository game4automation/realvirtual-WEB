// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-library-trim-core.mjs — which parts of which library projects a project
 * needs, computed ONCE for every channel (plan-778 Phase 4, F15).
 *
 * A project A names its libraries by id (`project.json.libraries[]`); its
 * placements name a library document by `AssetReference { providerId:
 * 'library-projects', sourceId: <library project id>, assetId: <document id> }`.
 * A delivery (hosted deploy, customer workspace, CONNECT embed) and the
 * browser's "Pack with libraries" ship A together with TRIMMED copies of those
 * library projects under `libraries/<projectId>/`: the same project id, the same
 * document ids, only the documents A uses — transitively, because a used
 * library document may itself place documents of another library — plus their
 * thumbnails and a `project.json` that is an ALLOWLIST of the library's manifest
 * (`TRIMMED_MANIFEST_FIELDS`: schemaVersion, id, name, canonicalName, kind,
 * libraries, documents) — every other field (code, provenance, settings, ...)
 * is dropped because it would leak into the delivery. Document bytes are never touched (a signed GLB stays signed).
 *
 * Deliberately WITHOUT imports and without Node or DOM APIs beyond
 * `TextDecoder` (both have it): the Node delivery scripts
 * (`scripts/lib/rv-library-trim.mjs`) and the browser pack
 * (`src/core/project/rv-library-pack.ts`) load this very file — one algorithm,
 * the pattern of `src/core/engine/rv-node-id-seed.mjs`. File access is the
 * caller's: this module only decides.
 *
 * Rules (binding, plan-778 Entscheidungs-Log 5/5b + F15):
 *  - The realvirtual library (`prj_realvirtual_library`) is never trimmed — it is
 *    public and ships app-level `/library/` in every build. References into it
 *    are checked against that app-level manifest when the caller supplies it.
 *  - A qualified reference resolves STRICTLY in its library (canonical document
 *    id; aliases answer only unqualified refs — F4/F5).
 *  - Every library a shipped manifest lists (A's `libraries[]` and, transitively,
 *    each shipped library's) is shipped, even when none of its documents is used:
 *    the viewer loads every listed library, and an absent one is a Problems row.
 *  - An unqualified (legacy) reference is attributed only inside its own project
 *    (a library document placing a sibling of the same library); anything else is
 *    REPORTED, never guessed and never fatal.
 *  - Nesting deeper than 16 libraries is an error; cycles are harmless (dedupe).
 */

export const LIBRARY_PROJECTS_PROVIDER_ID = 'library-projects';
export const OPEN_PROJECT_PROVIDER_ID = 'project';
export const REALVIRTUAL_LIBRARY_PROJECT_ID = 'prj_realvirtual_library';
export const DELIVERED_LIBRARIES_FOLDER = 'libraries';
export const MAX_LIBRARY_DEPTH = 16;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
/** Bytes of the GLB header plus the JSON chunk header. */
export const GLB_JSON_CHUNK_OFFSET = 20;

// ─── Small pure helpers ────────────────────────────────────────────────────

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Forward slashes, no leading `./`. */
export function normalizeLibraryPath(path) {
  return String(path ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
}

/** A relative path that stays inside its project (no scheme, no root, no `..`). */
export function isContainedPath(path) {
  if (typeof path !== 'string') return false;
  const raw = path.trim();
  if (raw === '') return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return false;
  if (raw.startsWith('/') || raw.startsWith('\\')) return false;
  return !normalizeLibraryPath(raw).split('/').includes('..');
}

/**
 * Why a library project id is unusable, or null. An id becomes a folder name
 * (`libraries/<id>/`), so it must never be able to name a path.
 */
export function libraryProjectIdProblem(projectId) {
  if (typeof projectId !== 'string' || projectId.trim() === '') return 'empty projectId';
  if (projectId !== projectId.trim()) return 'projectId has surrounding whitespace';
  if (/[\\/]/.test(projectId)) return `projectId "${projectId}" contains a path separator`;
  if (projectId.includes('..')) return `projectId "${projectId}" contains ".."`;
  if (projectId === '.') return 'projectId "." is not an id';
  if (!LIBRARY_ID_PATTERN.test(projectId)) return `projectId "${projectId}" has characters outside A-Z a-z 0-9 _ - .`;
  if (WINDOWS_RESERVED_NAME.test(projectId)) return `projectId "${projectId}" is a reserved Windows device name`;
  if (/[. ]$/.test(projectId)) return `projectId "${projectId}" ends with a dot or space`;
  return null;
}

/** An id is a folder name: letters, digits, `_`, `-`, `.` (never a leading `.`). */
const LIBRARY_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** CON, NUL, PRN, AUX, COM1-9, LPT1-9 — with or without an extension. */
const WINDOWS_RESERVED_NAME = /^(con|nul|prn|aux|com[1-9]|lpt[1-9])(\.|$)/i;

/** The hint a delivered copy carries: relative to the delivered project root. */
export function deliveredLibraryHint(projectId) {
  return `${DELIVERED_LIBRARIES_FOLDER}/${projectId}/project.json`;
}

/** `libraries[]` of a manifest as `{projectId?, url?, hint?, …}` objects (bare strings = url). */
export function libraryEntriesOf(manifest) {
  const raw = isObject(manifest) && Array.isArray(manifest.libraries) ? manifest.libraries : [];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ url: item.trim() });
      continue;
    }
    if (isObject(item)) out.push(item);
  }
  return out;
}

/** The library project ids a manifest lists, in manifest order, de-duplicated. */
export function listedLibraryIds(manifest) {
  const out = [];
  for (const entry of libraryEntriesOf(manifest)) {
    const id = typeof entry.projectId === 'string' ? entry.projectId.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** `documents[]` rows that carry a path, in manifest order. */
export function documentRowsOf(manifest) {
  const raw = isObject(manifest) && Array.isArray(manifest.documents) ? manifest.documents : [];
  return raw.filter((row) => isObject(row) && typeof row.path === 'string' && row.path !== '');
}

/**
 * The byte length of a GLB's JSON chunk from its first 20 bytes, or null when
 * the bytes are not a GLB header. Lets a caller read ONLY the JSON chunk of a
 * large model (a 900 MB CAD GLB carries a few hundred kB of JSON).
 */
export function glbJsonChunkLength(headerBytes) {
  const bytes = headerBytes instanceof Uint8Array ? headerBytes : new Uint8Array(headerBytes ?? []);
  if (bytes.length < GLB_JSON_CHUNK_OFFSET) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return null;
  if (view.getUint32(16, true) !== CHUNK_JSON) return null;
  const length = view.getUint32(12, true);
  return length > 0 ? length : null;
}

/**
 * The parsed glTF JSON of a GLB, or null when the bytes are no (readable) GLB.
 * Accepts the whole file or just its first `20 + jsonLength` bytes. Never throws.
 */
export function parseGlbJson(bytes) {
  const all = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const length = glbJsonChunkLength(all);
  if (length === null || all.length < GLB_JSON_CHUNK_OFFSET + length) return null;
  try {
    const text = new TextDecoder('utf-8').decode(all.subarray(GLB_JSON_CHUNK_OFFSET, GLB_JSON_CHUNK_OFFSET + length));
    const json = JSON.parse(text.replace(/[\s\0]+$/, ''));
    return isObject(json) ? json : null;
  } catch {
    return null;
  }
}

/**
 * Every placement reference a glTF JSON carries: `AssetReference` on any node
 * (and on the scenes, for a hand-authored file), and the splat placement
 * qualifier in `PlacementMeta`. Embedded references are content, not
 * references, and are skipped.
 *
 * @returns {{ assetId: string, providerId: string|null, sourceId: string|null, path: string|null, splat: boolean }[]}
 */
export function collectAssetReferences(json) {
  const out = [];
  const holders = [
    ...(Array.isArray(json?.nodes) ? json.nodes : []),
    ...(Array.isArray(json?.scenes) ? json.scenes : []),
  ];
  for (const holder of holders) {
    const rv = isObject(holder?.extras?.realvirtual) ? holder.extras.realvirtual : null;
    if (!rv) continue;
    const ref = isObject(rv.AssetReference) ? rv.AssetReference : null;
    if (ref && ref.embedded !== true) {
      const assetId = typeof ref.assetId === 'string' ? ref.assetId : '';
      const path = typeof ref.path === 'string' && ref.path ? ref.path : null;
      if (assetId || path) {
        out.push({
          assetId,
          providerId: typeof ref.providerId === 'string' && ref.providerId ? ref.providerId : null,
          sourceId: typeof ref.sourceId === 'string' && ref.sourceId ? ref.sourceId : null,
          path,
          splat: false,
        });
      }
    }
    const meta = isObject(rv.PlacementMeta) ? rv.PlacementMeta : null;
    if (meta && typeof meta.splatUrl === 'string' && meta.splatUrl) {
      out.push({
        assetId: typeof meta.catalogId === 'string' ? meta.catalogId : '',
        providerId: typeof meta.providerId === 'string' && meta.providerId ? meta.providerId : null,
        sourceId: typeof meta.sourceId === 'string' && meta.sourceId ? meta.sourceId : null,
        path: meta.splatUrl,
        splat: true,
      });
    }
  }
  return out;
}

/** True for a reference qualified to a library PROJECT (the strict form, F4). */
export function isLibraryQualified(ref) {
  return ref?.providerId === LIBRARY_PROJECTS_PROVIDER_ID && typeof ref.sourceId === 'string' && ref.sourceId !== '';
}

/** The row of `manifest` a same-project (unqualified) reference names: id, then path. */
function sameProjectRow(rows, ref) {
  if (ref.assetId) {
    const byId = rows.find((row) => row.id === ref.assetId);
    if (byId) return byId;
  }
  const path = ref.path ? normalizeLibraryPath(ref.path) : '';
  if (path && isContainedPath(path)) {
    const byPath = rows.find((row) => normalizeLibraryPath(row.path) === path);
    if (byPath) return byPath;
  }
  return null;
}

/** The files a used document row brings along: itself, its thumbnail, its settings sidecar. */
export function rowFiles(row) {
  const out = isContainedPath(row.path) ? [normalizeLibraryPath(row.path)] : [];
  for (const key of ['thumbnail', 'settingsPath']) {
    const value = row[key];
    if (isContainedPath(value)) out.push(normalizeLibraryPath(value));
  }
  return out;
}

/**
 * A manifest's `libraries[]` with the hint of every SHIPPED library rewritten to
 * its delivered location (`libraries/<id>/project.json`, relative to the
 * delivered project root). Every other entry and every other key is kept.
 * Returns the same object when nothing changes.
 */
export function withDeliveredLibraryHints(manifest, shippedIds) {
  if (!isObject(manifest) || !Array.isArray(manifest.libraries)) return manifest;
  const shipped = shippedIds instanceof Set ? shippedIds : new Set(shippedIds ?? []);
  let changed = false;
  const libraries = manifest.libraries.map((item) => {
    if (!isObject(item)) return item;
    const id = typeof item.projectId === 'string' ? item.projectId.trim() : '';
    if (!id || !shipped.has(id)) return item;
    const hint = deliveredLibraryHint(id);
    if (item.hint === hint) return item;
    changed = true;
    return { ...item, hint };
  });
  return changed ? { ...manifest, libraries } : manifest;
}

/**
 * The only manifest fields a trimmed library carries (allowlist, plan-778 D1).
 * Everything else (`code`, `provenance`, `settings`, `settingsRef`,
 * `lastPublished`, `activeSceneId`, `folders`, `demos`, …) is the library
 * author's own and never leaves with a customer's delivery.
 */
export const TRIMMED_MANIFEST_FIELDS = ['schemaVersion', 'id', 'name', 'canonicalName', 'kind', 'libraries', 'documents'];

/** Row pointer fields whose target files are NOT shipped with a trimmed row. */
const UNSHIPPED_ROW_POINTERS = ['scriptRef', 'connectRef', 'knowledgeRef', 'experiments'];

/** A used row as it ships: pointers to files that do not travel are dropped. */
function shippedRow(row) {
  const out = { ...row };
  for (const key of UNSHIPPED_ROW_POINTERS) delete out[key];
  for (const key of ['thumbnail', 'settingsPath']) if (key in out && !isContainedPath(out[key])) delete out[key];
  return out;
}

/** The trimmed manifest of a library: allowlisted fields only, `documents` = the used rows. */
export function trimmedLibraryManifest(manifest, usedRows, shippedIds) {
  const trimmed = {};
  for (const key of TRIMMED_MANIFEST_FIELDS) if (key in manifest) trimmed[key] = manifest[key];
  trimmed.documents = usedRows.map(shippedRow);
  return withDeliveredLibraryHints(trimmed, shippedIds);
}

/**
 * Is `url` the bundled realvirtual catalog URL (`library/catalog.json`, relative,
 * root-absolute, under a base path, or host-qualified on a realvirtual host)?
 * Node-side copy of `isBundledRealvirtualCatalogUrl` in
 * `src/core/library/library-origin.ts` (a .ts file, not importable from plain
 * Node) — keep in sync.
 */
export function isBundledCatalogUrl(url) {
  const bare = String(url ?? '').trim().split(/[?#]/)[0].replace(/\/+$/, '');
  if (!bare || /github(usercontent)?\.com/i.test(bare)) return false;
  if (!/(^|\/)library\/catalog\.json$/i.test(bare)) return false;
  if (!(/^[a-z][a-z0-9+.-]*:\/\//i.test(bare) || bare.startsWith('//'))) return true;
  let host;
  try { host = new URL(bare, 'https://invalid.invalid').hostname.toLowerCase(); } catch { return false; }
  return host === 'realvirtual.io' || host.endsWith('.realvirtual.io')
    || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}

/** Number of `libraries[]` URL entries naming the bundled catalog (they read as the realvirtual library). */
export function bundledCatalogEntryCount(manifest) {
  return libraryEntriesOf(manifest)
    .filter((e) => !(typeof e.projectId === 'string' && e.projectId.trim()) && isBundledCatalogUrl(e.url)).length;
}

// ─── The plan ──────────────────────────────────────────────────────────────

/**
 * Computes which library projects (and which of their documents) a project needs.
 *
 * ONE algorithm with two drivers: {@link planLibraryTrim} (async readers — the
 * browser pack) and {@link planLibraryTrimSync} (sync readers — the synchronous
 * Node staging helpers). The algorithm is a generator that yields every read it
 * needs; the driver performs it and hands the answer back.
 *
 * @param {object} input
 * @param {object} input.manifest  the project's own `project.json` (A)
 * @param {(path: string) => ({ json: object|null }|null)|Promise<{ json: object|null }|null>} input.readDocument
 *        A's document by manifest path: null = no such file, `json:null` = not a GLB
 * @param {(projectId: string) => (object|null)|Promise<object|null>} input.openLibrary
 *        a library project by id — `{ manifest, readDocument, …anything the caller needs to copy }` — or null
 * @param {object|null} [input.realvirtualLibrary] the app-level realvirtual library manifest, when known
 * @param {number} [input.maxDepth]
 */
export async function planLibraryTrim(input) {
  const steps = planSteps(input);
  let next = steps.next();
  while (!next.done) {
    let answer;
    try { answer = await next.value(); } catch { answer = null; }
    next = steps.next(answer);
  }
  return next.value;
}

/** {@link planLibraryTrim} for synchronous readers. */
export function planLibraryTrimSync(input) {
  const steps = planSteps(input);
  let next = steps.next();
  while (!next.done) {
    let answer;
    try { answer = next.value(); } catch { answer = null; }
    if (answer && typeof answer.then === 'function') {
      throw new Error('planLibraryTrimSync: a reader returned a Promise — use planLibraryTrim.');
    }
    next = steps.next(answer);
  }
  return next.value;
}

/** The algorithm. Yields a thunk per read; receives its answer (null on a throw). */
function* planSteps(input) {
  const manifest = isObject(input?.manifest) ? input.manifest : {};
  const rootId = typeof manifest.id === 'string' ? manifest.id : '';
  const maxDepth = Number.isInteger(input?.maxDepth) ? input.maxDepth : MAX_LIBRARY_DEPTH;
  const realvirtual = isObject(input?.realvirtualLibrary) ? input.realvirtualLibrary : null;

  const libraries = new Map();
  const errors = [];
  const legacyRefs = [];
  let realvirtualUsed = false;
  /** Work queue of documents whose references still have to be read. */
  const queue = [];
  const error = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  const ensureLibrary = (projectId, neededBy, depth) => {
    if (projectId === REALVIRTUAL_LIBRARY_PROJECT_ID) { realvirtualUsed = true; return null; }
    if (projectId === rootId) return null;
    const problem = libraryProjectIdProblem(projectId);
    if (problem) {
      error('library-id-invalid', `Library id refused: ${problem} (listed by ${neededBy}).`, { projectId, neededBy });
      return null;
    }
    let node = libraries.get(projectId);
    if (!node) {
      node = { projectId, depth, neededBy: [], state: 'pending', library: null, rows: [], used: new Map() };
      libraries.set(projectId, node);
    }
    if (neededBy && !node.neededBy.includes(neededBy)) node.neededBy.push(neededBy);
    return node;
  };

  // Breadth-first (plan-778 review D13): a library's depth is fixed when it is first seen, so the
  // first sighting must be along the SHORTEST chain — depth-first could refuse a library as too deep
  // that a shorter chain reaches within the limit.
  const openQueue = [];
  function* drainOpenQueue() {
    while (openQueue.length > 0) yield* openNode(openQueue.shift());
  }

  function* openNode(node) {
    if (node.state !== 'pending') return;
    if (node.depth > maxDepth) {
      node.state = 'invalid';
      error('library-depth', `Library nesting deeper than ${maxDepth} levels — "${node.projectId}" (needed by ${node.neededBy.join(', ')}).`,
        { projectId: node.projectId });
      return;
    }
    node.state = 'opening';
    const library = yield () => input.openLibrary(node.projectId);
    if (library && Array.isArray(library.ambiguous) && library.ambiguous.length > 0) {
      node.state = 'invalid';
      error('library-ambiguous', `Library "${node.projectId}" (needed by ${node.neededBy.join(', ')}) is held by ${library.ambiguous.length} folders in --projects-dir: `
        + `${library.ambiguous.join(', ')}. Name one with --library ${node.projectId}=<folder>.`, { projectId: node.projectId });
      return;
    }
    if (!library || !isObject(library.manifest)) {
      node.state = 'missing';
      error('library-unresolvable', `Library "${node.projectId}" (needed by ${node.neededBy.join(', ')}) was not found in any library source `
        + '(--projects-dir or --library <projectId>=<folder>).', { projectId: node.projectId, neededBy: [...node.neededBy] });
      return;
    }
    if (library.manifest.id !== node.projectId) {
      node.state = 'invalid';
      error('library-id-mismatch', `The source for library "${node.projectId}" holds project "${library.manifest.id}".`,
        { projectId: node.projectId });
      return;
    }
    node.state = 'ready';
    node.library = library;
    node.rows = documentRowsOf(library.manifest);
    for (const childId of listedLibraryIds(library.manifest)) {
      const child = ensureLibrary(childId, node.projectId, node.depth + 1);
      if (child) openQueue.push(child);
    }
  }

  const useDocument = (node, row) => {
    if (node.used.has(row.id)) return;
    if (row.devOnly === true) {
      error('document-dev-only', `Library "${node.projectId}": document "${row.id}" is marked devOnly and is not shipped.`,
        { projectId: node.projectId, assetId: row.id });
      return;
    }
    if (!isContainedPath(row.path)) {
      error('document-path-invalid', `Library "${node.projectId}": document "${row.id}" has a path that leaves the project ("${row.path}").`,
        { projectId: node.projectId, assetId: row.id });
      return;
    }
    node.used.set(row.id, row);
    queue.push({ owner: node.projectId, read: () => node.library.readDocument(normalizeLibraryPath(row.path)), label: `${node.projectId}:${row.path}`, rows: node.rows, node });
  };

  // A's own libraries[] — shipped whether used or not.
  for (const id of listedLibraryIds(manifest)) {
    const node = ensureLibrary(id, rootId || 'project', 1);
    if (node) openQueue.push(node);
  }
  yield* drainOpenQueue();

  // A's own documents.
  const rootRows = documentRowsOf(manifest);
  for (const row of rootRows) {
    queue.push({ owner: rootId, read: () => input.readDocument(normalizeLibraryPath(row.path)), label: row.path, rows: rootRows, node: null });
  }

  while (queue.length > 0) {
    const item = queue.shift();
    const doc = yield item.read;
    if (!doc) {
      if (item.node) {
        error('document-file-missing', `Library "${item.owner}": document file "${item.label.slice(item.owner.length + 1)}" is listed but not present.`,
          { projectId: item.owner, document: item.label });
      }
      continue;
    }
    if (doc.unreadable && (item.node || listedLibraryIds(manifest).length > 0)) {
      error('document-unreadable', `${item.label} exists but is not a readable GLB (unfetched Git LFS pointer or truncated file) — its library references cannot be known.`,
        { projectId: item.owner, document: item.label });
      continue;
    }
    if (!doc.json) continue;
    for (const ref of collectAssetReferences(doc.json)) {
      if (isLibraryQualified(ref)) {
        const target = ref.sourceId;
        if (target === rootId) continue;   // a library placing the delivered project's own document: A ships it anyway
        if (target === REALVIRTUAL_LIBRARY_PROJECT_ID) {
          realvirtualUsed = true;
          if (realvirtual && !documentRowsOf(realvirtual).some((r) => r.id === ref.assetId)) {
            error('document-unresolvable', `${item.label} places "${ref.assetId}" from library "${target}", which the delivered realvirtual library does not contain.`,
              { projectId: target, document: item.label, assetId: ref.assetId });
          }
          continue;
        }
        const node = item.node && target === item.owner ? item.node : libraries.get(target);
        if (!node) {
          error('library-not-listed', `${item.label} places "${ref.assetId}" from library "${target}", but no shipped project lists that library in libraries[].`,
            { projectId: target, document: item.label, assetId: ref.assetId });
          continue;
        }
        if (node.state !== 'ready') {
          error('document-unresolvable', `${item.label} places "${ref.assetId}" from library "${target}", which is not available.`,
            { projectId: target, document: item.label, assetId: ref.assetId });
          continue;
        }
        const row = node.rows.find((r) => r.id === ref.assetId);
        if (!row) {
          error('document-unresolvable', `${item.label} places "${ref.assetId}" from library "${target}", which has no such document.`,
            { projectId: target, document: item.label, assetId: ref.assetId });
          continue;
        }
        useDocument(node, row);
        continue;
      }
      // Unqualified / legacy: attributed inside its own project only.
      if (ref.providerId === null || ref.providerId === OPEN_PROJECT_PROVIDER_ID) {
        const own = sameProjectRow(item.rows, ref);
        if (own) {
          if (item.node) useDocument(item.node, own);
          continue;
        }
      }
      // A legacy id of the realvirtual library resolves through it at runtime
      // (Decision C: always resolvable) — so it still needs the app-level library.
      const realvirtualRow = realvirtual && ref.assetId
        ? documentRowsOf(realvirtual).find((r) => r.id === ref.assetId
          || (Array.isArray(r.aliases) && r.aliases.includes(ref.assetId)))
        : null;
      if (realvirtualRow) realvirtualUsed = true;
      legacyRefs.push({
        document: item.label, assetId: ref.assetId, providerId: ref.providerId, sourceId: ref.sourceId, path: ref.path,
        ...(realvirtualRow ? { resolvesIn: REALVIRTUAL_LIBRARY_PROJECT_ID } : {}),
      });
    }
  }

  const shippedIds = new Set([...libraries.values()].filter((n) => n.state === 'ready').map((n) => n.projectId));
  const out = [...libraries.values()]
    .filter((n) => n.state === 'ready')
    .sort((a, b) => (a.projectId < b.projectId ? -1 : a.projectId > b.projectId ? 1 : 0))
    .map((n) => {
      // Rows keep the library's own manifest order.
      const usedRows = n.rows.filter((row) => n.used.has(row.id));
      const files = [];
      for (const row of usedRows) for (const f of rowFiles(row)) if (!files.includes(f)) files.push(f);
      return {
        projectId: n.projectId,
        neededBy: [...n.neededBy],
        manifest: trimmedLibraryManifest(n.library.manifest, usedRows, shippedIds),
        documentIds: usedRows.map((row) => row.id),
        files,
        source: n.library,
      };
    });

  return {
    projectId: rootId,
    manifest: withDeliveredLibraryHints(manifest, shippedIds),
    libraries: out,
    realvirtualLibraryUsed: realvirtualUsed || bundledCatalogEntryCount(manifest) > 0,
    legacyRefs,
    errors,
  };
}

/** One line per error, for a CLI or an exception message. */
export function formatLibraryTrimErrors(errors) {
  return (errors ?? []).map((e) => `  - ${e.message}`).join('\n');
}
