// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * _rv-manifest — reading a project manifest's `documents[]` from Node
 * (plan-413 phase 6; hardcut completed by plan-703 phase 9).
 *
 * ## Why the delivery pipeline needed this at all
 *
 * Until phase 6 a `project.json` carried the same content twice: `documents[]`
 * was authoritative and `scenes[]` / `models[]` / `library[]` were derived from
 * it on every write, so the eleven Node scripts of plan-700/701 could keep
 * reading the three arrays they had always read. Phase 6 removes that mirror —
 * `documents[]` is the only list — and everything that used to reach for
 * `manifest.scenes` has to come through here instead.
 *
 * ## The Node half of the hardcut (plan-703 phase 9, decision 20)
 *
 * Phase 6 cut the *browser*: `mergeManifest` writes `documents[]` alone and
 * `withoutLegacyArrays()` strips the three arrays on the way to disk. The Node
 * side kept deriving *additively* — it lifted the arrays into `documents[]` and
 * left them lying there — on the stated grounds that "the browser's mirror
 * re-derives them from documents[] on every write". That sentence stopped being
 * true the day the mirror was removed, and an additive Node migrator therefore
 * writes exactly the second, staler answer the hardcut existed to delete.
 *
 * So this module now owns both halves, as Node twins of
 * `src/core/project/rv-project-documents.ts`:
 *
 * - `deriveDocuments()` — the WRITE side. `documents[]` is the **source**: an
 *   entry already there is authoritative and is never rewritten; the legacy
 *   arrays are read only for files `documents[]` does not already speak for.
 * - `withDerivedDocuments()` / `withoutLegacyArrays()` — the READ side, twins of
 *   the functions of the same name in the TypeScript. They derive nothing onto
 *   disk and mint no marker; they exist so that a genuinely unmigrated customer
 *   manifest presents one document list to the publish path (`loadProject()`),
 *   which is what lets the publish path stop carrying its own `scenes[]`
 *   fallback.
 *
 * ## Sections survive the mirror
 *
 * A document still says which of the three surfaces holds its bytes
 * (`section: 'scenes' | 'models' | 'library'`), because that is a real property
 * and not mirror bookkeeping: it decides whether a document is opened as a
 * scene or referenced as an asset, and — in the browser backend — it is the
 * only thing that can say so, since a scene's `path` there is a bare id with no
 * folder prefix to read it off. What went away is the *duplication*, not the
 * distinction.
 *
 * Kept deliberately tiny and dependency-free: this is imported by the
 * validator, the deploy library, the offline migrator and their tests, and a
 * shared helper that grows features is how four call sites drift apart again.
 * It is the Node twin of `sectionOfDocument()` in
 * `src/core/project/rv-project-documents.ts`; the two must agree, and
 * `tests/publish-manifest.node.test.ts` pins the agreement.
 */

/** The three surfaces a document's bytes can live on. */
export const DOCUMENT_SECTIONS = Object.freeze(['scenes', 'models', 'library']);

/**
 * The section a document belongs to.
 *
 * Recorded value first; the path prefix is the honest guess for a foreign
 * manifest that has `documents[]` without our bookkeeping, and `library` is the
 * fallback — a document of unknown provenance is a referenceable artefact, not
 * something a deploy would publish as an example.
 */
export function sectionOfDocument(entry) {
  const section = entry && typeof entry.section === 'string' ? entry.section : '';
  if (DOCUMENT_SECTIONS.includes(section)) return section;
  const path = entry && typeof entry.path === 'string' ? entry.path : '';
  if (/^scenes\//i.test(path) || /\.scene\.glb$/i.test(path)) return 'scenes';
  if (/^models\//i.test(path)) return 'models';
  return 'library';
}

/**
 * Every well-formed entry of `documents[]`, in manifest order.
 *
 * A manifest with no `documents[]` yields an empty list rather than throwing:
 * an unmigrated project is a normal input for the offline migrator, and the
 * validator has its own, louder way of saying a manifest is unreadable.
 */
export function documentsOf(manifest) {
  const raw = manifest && Array.isArray(manifest.documents) ? manifest.documents : [];
  return raw.filter(e => !!e && typeof e === 'object' && !Array.isArray(e)
    && typeof e.path === 'string' && e.path !== '');
}

/** The documents of one section, in manifest order. */
export function documentsInSection(manifest, section) {
  return documentsOf(manifest).filter(e => sectionOfDocument(e) === section);
}

// ─── Reference fields (plan-718 §2.3, Node twin) ────────────────────────

/**
 * The three per-document reference fields.
 *
 * Node twin of `DOCUMENT_REF_FIELDS` in `src/core/project/rv-project-refs.ts`,
 * and it has to stay one (K11): the delivery pipeline sees a `project.json` ONLY
 * through this module, so a field the twin does not know is a binding a delivery
 * cannot see — and cannot carry, validate or repoint.
 */
export const DOCUMENT_REF_FIELDS = Object.freeze(['connectRef', 'scriptRef', 'knowledgeRef']);

/** One spelling: `/`-separated, no leading `./` or `/`, no trailing slash. */
export function normalizeRefPath(ref) {
  return String(ref ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
}

/**
 * Whether a reference stays inside the project — strict containment.
 *
 * Twin of `isContainedRef()`. Rejects the empty string, a URL scheme (`C:` with
 * it), an absolute path, and any `..` SEGMENT. `models/v..2/a.glb` is a
 * perfectly ordinary path and passes.
 */
export function isContainedRef(ref) {
  if (typeof ref !== 'string') return false;
  const raw = ref.trim();
  if (raw === '') return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return false;
  if (raw.startsWith('/') || raw.startsWith('\\')) return false;
  return !normalizeRefPath(raw).split('/').includes('..');
}

/** The normalised value of one reference field, or null. An escape reads as null. */
export function readDocumentRef(entry, field) {
  const raw = entry ? entry[field] : null;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return isContainedRef(raw) ? normalizeRefPath(raw) : null;
}

/** Every reference the manifest sets, well-formed ones and escapes alike. */
export function documentRefsOf(manifest) {
  const out = [];
  for (const entry of documentsOf(manifest)) {
    for (const field of DOCUMENT_REF_FIELDS) {
      const raw = entry[field];
      if (typeof raw !== 'string' || raw.trim() === '') continue;
      out.push({
        documentId: typeof entry.id === 'string' ? entry.id : '',
        documentPath: entry.path,
        field,
        ref: normalizeRefPath(raw),
        contained: isContainedRef(raw),
      });
    }
  }
  return out;
}

/** The project-wide CONNECT references, with the sidecar default filled in. */
export const DEFAULT_SECRETS_REF = 'connect/secrets.local.json';

export function projectConnectRefs(manifest) {
  const connect = manifest && typeof manifest.connect === 'object' && manifest.connect
    ? manifest.connect
    : {};
  const agents = typeof connect.agentsRef === 'string' ? connect.agentsRef : null;
  const secrets = typeof connect.secretsRef === 'string' ? connect.secretsRef : null;
  // `ragRef` has no default twin (stage 3.3): a project either ships a bundle or
  // it does not, and a default would invent a dead reference for every project
  // that ships none.
  const rag = typeof connect.ragRef === 'string' ? connect.ragRef : null;
  return {
    agentsRef: agents && isContainedRef(agents) ? normalizeRefPath(agents) : null,
    secretsRef: secrets && isContainedRef(secrets) ? normalizeRefPath(secrets) : DEFAULT_SECRETS_REF,
    ragRef: rag && isContainedRef(rag) ? normalizeRefPath(rag) : null,
  };
}

// ─── models[] → scriptRef, offline (plan-718 §2.7, Node twin) ───────────

/** Manifest key recording that a project's plugin declarations became references. */
export const SCRIPT_REF_MIGRATION_MARKER = 'rv-project/script-ref-migration';

/**
 * The model name a document path carries — the value `models[]` declared.
 *
 * Twin of `resolveModelName()` in `src/core/rv-model-plugin-manager.ts`: the
 * file stem without `.glb`. Case is preserved, because the matcher it feeds is
 * case-sensitive and a migration that quietly normalised it would rebind
 * projects rather than migrate them (K3).
 */
export function modelNameOfPath(path) {
  const file = String(path ?? '').split('?')[0].split('/').filter(Boolean).pop() ?? '';
  return file.replace(/\.glb$/i, '');
}

/**
 * Turn a module's `models: string[]` self-declaration into `scriptRef` on the
 * rows it named.
 *
 * Node twin of `migrateProjectScriptRefs()`. `modules` is
 * `[{ scriptRef, models }]` — project-relative script path plus what it declared.
 *
 * Two rules, both about not changing behaviour while changing shape:
 *  - a row that already has a `scriptRef` is left alone (the manifest wins over
 *    a declaration);
 *  - a declared name that matches a document only when case is ignored is
 *    **reported, not assigned**. The runtime matcher is case-sensitive, so such
 *    a declaration binds nothing today, and assigning it would be a repair
 *    wearing a migration's clothes.
 *
 * @returns `{ documents, assigned, caseMismatches, marker }`, or null when
 *          there is nothing to assign.
 */
export function deriveScriptRefs(manifest, modules, { now = new Date().toISOString() } = {}) {
  const documents = documentsOf(manifest);
  if (documents.length === 0 || !Array.isArray(modules) || modules.length === 0) return null;

  const byName = new Map();
  const byLowerName = new Map();
  for (const doc of documents) {
    const name = modelNameOfPath(doc.path);
    if (name === '') continue;
    if (!byName.has(name)) byName.set(name, doc);
    const lower = name.toLowerCase();
    if (!byLowerName.has(lower)) byLowerName.set(lower, doc);
  }

  const assigned = [];
  const caseMismatches = [];
  const next = documents.map(d => ({ ...d }));
  const rowOf = (doc) => next[documents.indexOf(doc)];

  for (const mod of modules) {
    const scriptRef = normalizeRefPath(mod && mod.scriptRef);
    if (!isContainedRef(scriptRef)) continue;
    for (const declared of Array.isArray(mod && mod.models) ? mod.models : []) {
      if (typeof declared !== 'string' || declared.trim() === '') continue;
      const exact = byName.get(declared);
      if (!exact) {
        const loose = byLowerName.get(declared.toLowerCase());
        if (loose) {
          caseMismatches.push({
            declared, scriptRef, documentId: loose.id, documentPath: loose.path,
          });
        }
        continue;
      }
      const row = rowOf(exact);
      if (typeof row.scriptRef === 'string' && row.scriptRef.trim() !== '') continue;
      row.scriptRef = scriptRef;
      assigned.push({ declared, scriptRef, documentId: row.id, documentPath: row.path });
    }
  }

  if (assigned.length === 0 && caseMismatches.length === 0) return null;
  return {
    documents: next,
    assigned,
    caseMismatches,
    marker: {
      at: now,
      schemaVersion: 2,
      assigned: assigned.length,
      assignedIds: assigned.map(a => a.documentId),
      caseMismatches,
    },
  };
}

// ─── Deriving documents[] offline ───────────────────────────────────────

/** Manifest key recording that a project has been given a `documents[]`. */
export const DOCUMENTS_MIGRATION_MARKER = 'rv-project/documents-migration';

/**
 * The id an id-less legacy entry is migrated to — derived from its path.
 *
 * Byte-for-byte the same rule as `stableDocumentId()` in
 * `src/core/project/rv-project-documents.ts`, and it has to be: a project
 * migrated here and then opened in a browser must not gain a second identity
 * for the same file. Duplicated rather than imported because this is Node and
 * that is browser TypeScript; `tests/migrate-project-manifest.node.test.ts`
 * pins the agreement against the TypeScript source.
 */
export function stableDocumentId(path) {
  const clean = (path ?? '').trim();
  const slug = clean
    .toLowerCase()
    .replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `doc_${slug || 'unnamed'}_${fnv32(clean).toString(36)}`;
}

/** Non-cryptographic 32-bit hash. Uniqueness suffix only — never a revision. */
function fnv32(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Display name for an asset entry with no name of its own. */
function assetNameOf(entry) {
  const label = typeof entry.label === 'string' ? entry.label.trim() : '';
  if (label !== '') return label;
  const path = typeof entry.path === 'string' ? entry.path : '';
  const file = path.split('/').filter(Boolean).pop() ?? path;
  return file.replace(/\.(scene\.)?(glb|gltf|json|splat|ksplat|ply)$/i, '') || path;
}

/** Lift one legacy array entry into a document. */
export function documentOfLegacyEntry(entry, section) {
  const id = typeof entry.id === 'string' && entry.id.trim() !== ''
    ? entry.id
    : stableDocumentId(entry.path);
  const name = section === 'scenes' && typeof entry.name === 'string' && entry.name !== ''
    ? entry.name
    : assetNameOf(entry);
  return { ...entry, id, name, path: entry.path, section };
}

/** The manifest keys a pre-phase-6 project carried and nothing maintains now. */
export const LEGACY_DOCUMENT_KEYS = Object.freeze([...DOCUMENT_SECTIONS, 'documentsBaseline']);

/** The path two entries have to share to be the same document. */
function documentKeyOf(path) {
  return String(path ?? '').trim().replace(/^\.?\//, '');
}

/** Whether a legacy array element can become a document at all. */
function usableLegacyEntry(entry) {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && typeof entry.path === 'string' && entry.path.trim() !== '';
}

/**
 * Drop what a pre-phase-6 manifest carried and this build no longer maintains.
 *
 * Node twin of `withoutLegacyArrays()` in `rv-project-documents.ts`, and it must
 * stay one: the browser strips these keys on every save, so a Node script that
 * kept them would put back, on the next delivery, precisely what the last
 * browser save removed.
 */
export function withoutLegacyArrays(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest;
  const out = { ...manifest };
  for (const key of LEGACY_DOCUMENT_KEYS) delete out[key];
  return out;
}

/**
 * Give a manifest its `documents[]` before anything READS it.
 *
 * Node twin of `withDerivedDocuments()` in `rv-project-documents.ts`: derive
 * from the legacy arrays when there is no document list, and drop the arrays
 * either way, so nothing downstream can read a second, older answer to the same
 * question. It mints no marker and writes nothing — a derivation, not a
 * migration.
 *
 * This is what makes the hardcut safe for a customer nobody has opened in a
 * current client: the publish path used to keep a private `scenes[]` fallback
 * for exactly that case, and a fallback per consumer is how two readers of the
 * same file drift apart. There is one derivation now, at the one read boundary
 * (`loadProject()`), and every consumer downstream sees `documents[]`.
 *
 * **One deliberate difference from the TypeScript twin.** That one returns
 * early when a `documents[]` is present (`rv-project-documents.ts:299`) and
 * therefore drops a half-migrated manifest's leftover array entries instead of
 * lifting them. Here they are lifted, because this is the *delivery* read: the
 * browser can afford the early return — its next save rewrites the manifest
 * from the live project either way — while a publish that silently dropped a
 * customer's entries would ship the loss. Completing is a superset of the
 * browser's answer, never a contradiction of it.
 */
export function withDerivedDocuments(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return manifest;
  const derived = deriveDocuments(manifest);
  const stripped = withoutLegacyArrays(manifest);
  return derived ? { ...stripped, documents: derived.documents } : stripped;
}

/**
 * The `documents[]` a manifest should carry, with `documents[]` as the SOURCE.
 *
 * Not a mirror in either direction. An entry already in `documents[]` is
 * authoritative and is carried through byte-for-byte — a name the user changed,
 * a `classification` a bake wrote, a key a newer client added. The three legacy
 * arrays are read **only** for files that `documents[]` does not already speak
 * for; `documentOfLegacyEntry` lifts those, and after this the caller drops the
 * arrays (plan-703 phase 9). Reading them for entries `documents[]` already has
 * would let a stale array overwrite the current list — the failure the hardcut
 * exists to make impossible.
 *
 * Completing a partial list matters precisely *because* the arrays are dropped
 * afterwards: before phase 9 a half-migrated manifest kept its legacy entries
 * alive in the arrays, so returning early cost nothing. Now an early return
 * would delete them.
 *
 * `documentsBaseline` is deliberately NOT written. It is a record of what a
 * *mirror* last derived, and nothing here mirrors; a missing baseline is read as
 * "no evidence" by `reconcileDocuments()`, which is the correct reading for a
 * `documents[]` that was just derived from the arrays it would be compared
 * against. The first browser save fills it in.
 *
 * @returns `{ documents, existing, marker }` — `existing` is how many of
 *          `documents` were already in the list, so a caller can report how
 *          many it lifted — or null when there is nothing to add. Note the
 *          changed meaning of null: it used to say "there is already a
 *          `documents[]`", it now says "the list is complete".
 */
export function deriveDocuments(manifest, { now = new Date().toISOString() } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;

  const documents = documentsOf(manifest);
  const existing = documents.length;
  const seen = new Set(documents.map(e => documentKeyOf(e.path)));

  const counts = {};
  let lifted = 0;
  for (const section of DOCUMENT_SECTIONS) {
    const list = Array.isArray(manifest[section]) ? manifest[section] : [];
    const usable = list.filter(usableLegacyEntry);
    for (const entry of usable) {
      const key = documentKeyOf(entry.path);
      if (seen.has(key)) continue;
      seen.add(key);
      documents.push(documentOfLegacyEntry(entry, section));
      lifted++;
    }
    counts[section] = usable.length;
  }
  if (lifted === 0) return null;
  return { documents, existing, marker: { at: now, schemaVersion: 2, counts } };
}
