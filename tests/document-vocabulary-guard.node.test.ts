// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-777 §9.1 — one document vocabulary, kept that way.
 *
 * plan-716 made every stored item one kind of thing — a DOCUMENT (one GLB, one
 * `project.json` row). The old words outlived it and misled a later plan into a
 * scene/asset split that does not exist, so this guard pins the cleanup:
 *
 *  - **rule 1** — the legacy entry types are migration input only:
 *    `LegacyProjectSceneEntry` / `LegacyProjectAssetEntry` appear in exactly the
 *    files of {@link LEGACY_TYPE_FILES} (comment-stripped code), and the old
 *    names `RvProjectSceneEntry` / `RvProjectAssetEntry` nowhere;
 *  - **rule 2** (source half) — `ProjectSnapshot` and `ResolvedActiveProject`
 *    carry no `models` / `scenes` member. The runtime half (a fresh store's
 *    snapshot keys) is a browser test: `tests/project-store.test.ts`;
 *  - **rule 3** — the phrases "scene document", "asset document", "scene save",
 *    "asset save" are absent from `src/**\/*.ts{,x}` (comments included) and from
 *    the WEB-root `doc-*.md` outside history paragraphs, with a per-file
 *    allowlist that may not go stale;
 *  - **emit pin** — `document-saved` is emitted in ONE place,
 *    `src/core/editor/rv-finish-document-save.ts`;
 *  - **P1 pin** — the persisted / shared names keep their exact strings.
 *
 * Scope: WEB `src/**` and WEB-root `doc-*.md` only. `tests/**`, fixtures,
 * PRIVATE and `Documentation/web` are out on purpose.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'src');

function walk(dir: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, re));
    else if (re.test(name)) out.push(abs);
  }
  return out;
}

/** Repo-relative, forward slashes. */
const rel = (abs: string): string => relative(REPO, abs).replace(/\\/g, '/');

/** UTF-8 text; NUL bytes (rv-save-document.ts carries some) are harmless to every regex here. */
const read = (abs: string): string => readFileSync(abs, 'utf8');

/**
 * Comments removed, line structure kept (so line numbers still point at the
 * source). Crude on purpose, like `scene-removal-guard`: a `//` inside a string
 * costs a false negative on one line, never a false positive.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '');
}

const SOURCES = walk(SRC, /\.(ts|tsx)$/).map((abs) => ({ abs, path: rel(abs), text: read(abs) }));
const DOCS = readdirSync(REPO)
  .filter((f) => f.startsWith('doc-') && f.endsWith('.md'))
  .map((f) => ({ path: f, text: read(join(REPO, f)) }));

/** Every `line:text` of `text` matching `re` (1-based). */
function hitsIn(text: string, re: RegExp): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  text.split('\n').forEach((line, i) => { if (re.test(line)) out.push({ line: i + 1, text: line.trim() }); });
  return out;
}

describe('the scan is real', () => {
  it('sees a plausible number of source files and docs', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
    expect(DOCS.length).toBeGreaterThan(10);
    expect(SOURCES.some((s) => s.path === 'src/core/editor/rv-finish-document-save.ts')).toBe(true);
  });
});

// ─── Rule 1: legacy entry types are migration input only ───────────────

/**
 * The files that may name the legacy entry types: the defining file and the
 * migration / legacy-lift modules. Exactly the set that does — a new reader
 * fails here, and so does a file that stops needing its entry.
 *
 * `rv-workspace-migration.ts` is a migration module too and would be allowed by
 * the same rule (plan-777 F1), but it reads no legacy ENTRY type today, so it is
 * not listed: an allowlist entry that hits nothing is a stale entry.
 */
const LEGACY_TYPE_FILES = [
  'src/core/project/rv-project-documents-migration.ts',
  'src/core/project/rv-project-documents.ts',
  'src/core/project/rv-project-types.ts',
];

describe('rule 1 — LegacyProject*Entry only in the migration modules (plan-777 F1)', () => {
  it('the legacy types are named in exactly the allowed files', () => {
    const re = /\bLegacyProject(Scene|Asset)Entry\b/;
    const users = SOURCES.filter((s) => re.test(stripComments(s.text))).map((s) => s.path).sort();
    const outside = users.filter((p) => !LEGACY_TYPE_FILES.includes(p));
    expect(outside, `${outside.join(', ')} — use RvDocumentEntry; the legacy types are migration input only`).toEqual([]);
    expect(users, 'an allowed file no longer names a legacy type — drop it from LEGACY_TYPE_FILES').toEqual(LEGACY_TYPE_FILES);
  });

  it('the pre-777 names RvProjectSceneEntry / RvProjectAssetEntry are gone from code', () => {
    const offenders = SOURCES.flatMap((s) =>
      hitsIn(stripComments(s.text), /\bRvProject(Scene|Asset)Entry\b/)
        .map((h) => `${s.path}:${h.line}: ${h.text} — use RvDocumentEntry (or LegacyProject…Entry in a migration module)`));
    expect(offenders).toEqual([]);
  });
});

// ─── Rule 2: no models / scenes views on the store ─────────────────────

/** The body of `export interface <name> { … }` in `text`, or null. Brace-counted. */
function interfaceBody(text: string, name: string): string | null {
  const start = text.search(new RegExp(`export interface ${name}\\b[^{]*\\{`));
  if (start < 0) return null;
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(text.indexOf('{', start) + 1, i);
  }
  return null;
}

describe('rule 2 — the store hands out documents only (plan-777 F3/F4)', () => {
  const store = stripComments(read(join(SRC, 'core/project/project-store.ts')));
  for (const name of ['ProjectSnapshot', 'ResolvedActiveProject']) {
    it(`${name} has no \`models\` / \`scenes\` member`, () => {
      const body = interfaceBody(store, name);
      expect(body, `${name} not found in project-store.ts`).not.toBeNull();
      expect(body!).toMatch(/^\s*documents\s*:/m);
      const views = hitsIn(body!, /^\s*(models|scenes)\s*\??\s*:/)
        .map((h) => `project-store.ts ${name}: ${h.text} — read \`documents\``);
      expect(views).toEqual([]);
    });
  }
});

// ─── Rule 3: the phrases that implied two document kinds ───────────────

/**
 * Whole words only: "scene saves" and "asset documents" are caught, "the scene
 * saved" and "assets documented" are ordinary English and are not. The bare
 * words stay legal — "scene" for the 3D scene graph, "asset" for a library
 * catalog entry (plan-777 #3).
 */
const PHRASE = /\b(scene|asset)\s+(documents?|saves?)\b/i;

const REPLACEMENT: Record<string, string> = {
  'scene document': 'document (or "the planner\'s document")',
  'asset document': 'document (or "the document open in the editor")',
  'scene save': 'planner save',
  'asset save': 'editor save',
};

/** Same markers as `docs-architecture-drift.node.test.ts`: a paragraph that says it is history. */
const HISTORY_MARKERS = [
  'deleted', 'Deleted', 'DELETED',
  'removed', 'Removed',
  'no longer', 'used to', 'is gone', 'are gone', 'went with',
  'History', 'history', 'historic',
  'until Phase', 'Phase 1c', 'Phase 4b',
  'stale', 'was ', 'were ', 'had ',
  'Plans 745', 'plan-745', 'plan-752',
];

interface PhraseHit { file: string; line: number; phrase: string; text: string }

/** An allowed phrase in one file — e.g. a P1 persisted shape quoted verbatim. */
interface PhraseAllowance { file: string; phrase: string; why: string }

/**
 * Per-file allowlist for persisted shapes (plan-777 P1). Empty today: every P1
 * name is camelCase or a key string (`sceneDocument`, `rv-scenes/…`) that the
 * phrase rule does not match. An entry is admitted only with a reason, and only
 * while it still hits.
 */
const PHRASE_ALLOWLIST: PhraseAllowance[] = [];

function phraseOf(match: RegExpMatchArray): string {
  return `${match[1]!.toLowerCase()} ${match[2]!.toLowerCase().replace(/s$/, '')}`;
}

function sourcePhraseHits(): PhraseHit[] {
  const out: PhraseHit[] = [];
  for (const s of SOURCES) {
    s.text.split('\n').forEach((line, i) => {
      const m = line.match(PHRASE);
      if (m) out.push({ file: s.path, line: i + 1, phrase: phraseOf(m), text: line.trim() });
    });
  }
  return out;
}

function docPhraseHits(docs: ReadonlyArray<{ path: string; text: string }>): PhraseHit[] {
  const out: PhraseHit[] = [];
  for (const doc of docs) {
    const lines = doc.text.split('\n');
    let start = 0;
    const flush = (end: number): void => {
      const paragraph = lines.slice(start, end);
      if (paragraph.some((l) => HISTORY_MARKERS.some((h) => l.includes(h)))) return;
      paragraph.forEach((line, k) => {
        const m = line.match(PHRASE);
        if (m) out.push({ file: doc.path, line: start + k + 1, phrase: phraseOf(m), text: line.trim() });
      });
    };
    lines.forEach((line, i) => {
      if (line.trim() === '') { flush(i); start = i + 1; }
    });
    flush(lines.length);
  }
  return out;
}

/** Hits the allowlist does not cover, and allowlist entries that cover nothing. */
function judge(hits: PhraseHit[], allowlist: PhraseAllowance[]): { offenders: string[]; stale: string[] } {
  const covered = (h: PhraseHit) => allowlist.some((a) => a.file === h.file && a.phrase === h.phrase);
  const offenders = hits.filter((h) => !covered(h))
    .map((h) => `${h.file}:${h.line}: "${h.phrase}" → say ${REPLACEMENT[h.phrase] ?? 'document'} — ${h.text.slice(0, 120)}`);
  const stale = allowlist.filter((a) => !hits.some((h) => h.file === a.file && h.phrase === a.phrase))
    .map((a) => `${a.file}: "${a.phrase}" no longer occurs — remove the allowlist entry (${a.why})`);
  return { offenders, stale };
}

describe('rule 3 — no "scene/asset document/save" in src or the docs (plan-777 F9)', () => {
  it('src/**/*.ts{,x}, comments included', () => {
    const { offenders } = judge(sourcePhraseHits(), PHRASE_ALLOWLIST.filter((a) => a.file.startsWith('src/')));
    expect(offenders).toEqual([]);
  });

  it('WEB-root doc-*.md, outside history paragraphs', () => {
    const { offenders } = judge(docPhraseHits(DOCS), PHRASE_ALLOWLIST.filter((a) => !a.file.startsWith('src/')));
    expect(offenders).toEqual([]);
  });

  it('no allowlist entry is stale', () => {
    const { stale } = judge([...sourcePhraseHits(), ...docPhraseHits(DOCS)], PHRASE_ALLOWLIST);
    expect(stale).toEqual([]);
  });

  it('self-test: the matcher is live and a stale allowlist entry fails', () => {
    // The phrase rule catches the forms that misled plan-776, and spares English.
    expect('the open asset document').toMatch(PHRASE);
    expect('Scene saves are queued').toMatch(PHRASE);
    expect('a scene saved earlier').not.toMatch(PHRASE);
    expect('`sceneDocument`').not.toMatch(PHRASE);
    // A history paragraph keeps its phrase; a plain one does not.
    const synthetic = [{ path: 'doc-x.md', text: 'The scene save used to run here.\n\nThe scene save runs here.\n' }];
    expect(docPhraseHits(synthetic).map((h) => h.line)).toEqual([3]);
    // A synthetic allowlist entry that hits nothing is reported stale.
    const { stale, offenders } = judge(
      [{ file: 'src/a.ts', line: 1, phrase: 'scene save', text: 'x' }],
      [
        { file: 'src/a.ts', phrase: 'scene save', why: 'covers the hit' },
        { file: 'src/b.ts', phrase: 'asset document', why: 'nothing left' },
      ],
    );
    expect(offenders).toEqual([]);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('src/b.ts');
  });
});

// ─── Emit pin: one document-saved emit ──────────────────────────────────

describe('emit pin — document-saved has ONE emit site (plan-777 P4)', () => {
  it('only rv-finish-document-save.ts emits it', () => {
    const re = /emit\??\.?\(\s*['"]document-saved['"]/;
    const offenders = SOURCES.flatMap((s) => hitsIn(s.text, re).map((h) => ({ path: s.path, ...h })))
      .filter((h) => h.path !== 'src/core/editor/rv-finish-document-save.ts')
      .map((h) => `${h.path}:${h.line}: ${h.text} — use announceDocumentSaved/finishDocumentSave`);
    expect(offenders).toEqual([]);
    const own = read(join(SRC, 'core/editor/rv-finish-document-save.ts'));
    expect(hitsIn(own, re)).toHaveLength(1);
  });
});

// ─── P1 pin: persisted names keep their exact strings ──────────────────

describe('P1 pin — persisted / shared names are not renamed (plan-777 P1)', () => {
  const pins: Array<[string, string]> = [
    ['src/core/hmi/scene/rv-scene-storage.ts', "const LS_KEY_INDEX = 'rv-scenes-index';"],
    ['src/core/hmi/scene/rv-scene-storage.ts', "const LS_KEY_ACTIVE = 'rv-scenes/active';"],
    ['src/core/hmi/scene/rv-scene-storage.ts', "const LS_KEY_DRAFT_PREFIX = 'rv-scenes/draft/';"],
    ['src/core/hmi/scene/rv-scene-storage.ts', "const LS_KEY_SCENE_DRAFT_PREFIX = 'rv-scenes/scene-draft/';"],
    ['src/core/project/rv-workspace-migration.ts', "export const LS_KEY_SCENES_RETIRED_PREFIX = 'rv-scenes-retired/';"],
    ['src/core/hmi/settings/ModelTab.tsx', "'rv-scenes-cleared-legacy'"],
    ['src/core/hmi/rv-storage-keys.ts', "'rv-scene-active'"],
    ['src/core/project/rv-doc-alias.ts', "export const LS_KEY_DOC_ALIAS_PREFIX = 'rv-doc-alias/';"],
    ['src/core/hmi/scene/rv-scene-live-sync.ts', "const CHANNEL_NAME = 'rv-scene-writes';"],
    ['src/core/project/rv-project-types.ts', 'activeSceneId?: string | null;'],
    ['src/main.ts', "params.get('scene')"],
    ['src/main.ts', "params.get('model')"],
    ['src/core/editor/rv-asset-draft-storage.ts', "{ kind: 'sceneDocument'; sceneId: string; sceneName: string }"],
    ['src/core/hmi/projects/projects-dashboard-store.ts', "| { kind: 'scenes' }"],
    ['src/core/hmi/projects/projects-dashboard-store.ts', "| { kind: 'models' }"],
  ];
  for (const [file, literal] of pins) {
    it(`${file} keeps ${literal}`, () => {
      expect(read(join(REPO, file))).toContain(literal);
    });
  }
});
