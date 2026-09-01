// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-713 T6 — the unified document guard, and T7's breadcrumb half.
 *
 * Three things are pinned here, and the third is the one that would rot
 * silently:
 *
 *  1. `requireDocument('editor')` refuses outside the editor, and the MIRROR
 *     case `requireDocument('scene')` refuses inside it. The mirror is the
 *     newly reachable failure — before 711 there was no scene projection of the
 *     same document to be wrong about.
 *  2. Origin: an ASSET-lineage op offered from a SCENE projection is refused in
 *     words. `RV_OP_ORIGIN` is the source of that verdict, so the test reads the
 *     table rather than restating which kinds are which — a kind that changes
 *     lineage must not need this file edited.
 *  3. ALIAS PARITY: `requireEditor` and `requireDocument('editor')` produce the
 *     same three sentences. `rv-mcp-editor-guard.test.ts` still asserts those
 *     sentences directly against `requireEditor`; this asserts the two are one
 *     implementation, which is what makes that file's continued passing mean
 *     something after the move.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  ERR_EDITOR_ACTIVATING,
  ERR_NOT_EDITOR,
  ERR_NO_VIEWER,
  isGuardError,
  originOf,
  requireDocument,
  requireOpOrigin,
} from '../src/plugins/mcp-bridge/rv-mcp-doc-guard';
import { requireEditor } from '../src/plugins/mcp-bridge/rv-mcp-editor-guard';
import {
  setActiveAssetContext,
  type ActiveAssetContext,
} from '../src/core/editor/active-asset-store';

/** The store has one setter and `null` is its clear — named for readability. */
const clearActiveAssetContext = (): void => setActiveAssetContext(null);
import { RV_OP_KINDS, RV_OP_ORIGIN, type RvOpKind } from '../src/core/ops/rv-unified-ops';
import type { RVViewer } from '../src/core/rv-viewer';

/** A viewer stub that only has to answer `modes.activeMode`. */
function viewerIn(mode: string): RVViewer {
  return { modes: { activeMode: mode } } as unknown as RVViewer;
}

/** The smallest thing the guard treats as a document context. */
function fakeContext(id = 'doc_1'): ActiveAssetContext {
  return { doc: { id, name: 'Fixture' }, viewer: viewerIn('editor') } as unknown as ActiveAssetContext;
}

afterEach(() => { clearActiveAssetContext(); });

// ─── T6.1 — the two directions ──────────────────────────────────────────

describe('T6 — requireDocument refuses in both directions', () => {
  it('refuses with no viewer at all, whatever is needed', () => {
    for (const need of ['editor', 'scene', 'any'] as const) {
      const r = requireDocument(undefined, need);
      expect(isGuardError(r)).toBe(true);
      if (isGuardError(r)) expect(r.error).toBe(ERR_NO_VIEWER);
    }
  });

  it("need='editor' outside editor mode gives the editor gate's own sentence", () => {
    const r = requireDocument(viewerIn('planner'), 'editor');
    expect(isGuardError(r)).toBe(true);
    if (isGuardError(r)) expect(r.error).toBe(ERR_NOT_EDITOR);
  });

  it("need='editor' in editor mode before a document exists says so distinctly", () => {
    clearActiveAssetContext();
    const r = requireDocument(viewerIn('editor'), 'editor');
    expect(isGuardError(r)).toBe(true);
    // Not the same refusal as "wrong mode": an agent must be able to tell
    // "retry in a moment" apart from "you are in the wrong place".
    if (isGuardError(r)) expect(r.error).toBe(ERR_EDITOR_ACTIVATING);
  });

  it('the MIRROR case — need=\'scene\' while the editor is open — is refused', () => {
    setActiveAssetContext(fakeContext());
    const r = requireDocument(viewerIn('editor'), 'scene');
    expect(isGuardError(r)).toBe(true);
    if (isGuardError(r)) {
      expect(r.error).toContain('asset editor');
      // Actionable, per the guard practice: it names the way out.
      expect(r.error).toContain('web_editor_close');
    }
  });

  it("need='editor' resolves to the editor projection when one is open", () => {
    setActiveAssetContext(fakeContext('doc_x'));
    const r = requireDocument(viewerIn('editor'), 'editor');
    expect(isGuardError(r)).toBe(false);
    if (!isGuardError(r)) {
      expect(r.projection).toBe('editor');
      expect(r.editor).not.toBeNull();
      expect(r.documentKey).toBe('doc_x');
    }
  });

  it("need='any' follows the active mode and REPORTS which projection answered", () => {
    setActiveAssetContext(fakeContext());
    expect((requireDocument(viewerIn('editor'), 'any') as { projection: string }).projection)
      .toBe('editor');
    expect((requireDocument(viewerIn('planner'), 'any') as { projection: string }).projection)
      .toBe('scene');
  });

  it("need='scene' with nothing open refuses with an opening verb, not a mode complaint", () => {
    clearActiveAssetContext();
    const r = requireDocument(viewerIn('planner'), 'scene');
    expect(isGuardError(r)).toBe(true);
    if (isGuardError(r)) expect(r.error).toContain('web_document_open');
  });
});

// ─── T6.2 — alias parity ────────────────────────────────────────────────

describe('T6 — requireEditor is an alias, not a second implementation', () => {
  it('produces the identical sentence in all three refusal cases', () => {
    const cases: Array<RVViewer | undefined> = [undefined, viewerIn('planner'), viewerIn('editor')];
    clearActiveAssetContext();
    for (const v of cases) {
      const viaAlias = requireEditor(v);
      const viaGuard = requireDocument(v, 'editor');
      expect(isGuardError(viaAlias)).toBe(true);
      expect(isGuardError(viaGuard)).toBe(true);
      if (isGuardError(viaAlias) && isGuardError(viaGuard)) {
        expect(viaAlias.error).toBe(viaGuard.error);
      }
    }
  });

  it('returns the very same context object on success', () => {
    const ctx = fakeContext('doc_same');
    setActiveAssetContext(ctx);
    const viaAlias = requireEditor(viewerIn('editor'));
    const viaGuard = requireDocument(viewerIn('editor'), 'editor');
    expect(isGuardError(viaAlias)).toBe(false);
    if (!isGuardError(viaAlias) && !isGuardError(viaGuard)) {
      // Identity, not equality: a copy would decouple the two over time.
      expect(viaAlias).toBe(ctx);
      expect(viaGuard.editor).toBe(ctx);
      expect(viaGuard.doc).toBe(ctx.doc);
    }
  });
});

// ─── T6.3 — origin (R6) ─────────────────────────────────────────────────

describe('T6 — op origin decides what a projection may write', () => {
  it('the four shared kinds pass in BOTH projections', () => {
    // Read from the table, not restated: a kind that gains or loses `both`
    // status must not need this test edited to stay honest.
    const shared = RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'both');
    expect(shared.length, 'plan §2.4 measured exactly four').toBe(4);
    for (const kind of shared) {
      expect(requireOpOrigin(kind, 'editor')).toBeNull();
      expect(requireOpOrigin(kind, 'scene')).toBeNull();
    }
  });

  it('every asset-lineage kind is refused from the scene projection, in words', () => {
    const assetOnly = RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'asset');
    expect(assetOnly.length).toBeGreaterThan(0);
    for (const kind of assetOnly) {
      expect(requireOpOrigin(kind, 'editor'), `${kind} must pass in the editor`).toBeNull();
      const refusal = requireOpOrigin(kind, 'scene');
      expect(refusal, `${kind} must be refused in the scene projection`).not.toBeNull();
      // The refusal has to say what to do, or an agent retries it unchanged.
      expect(refusal!.error).toContain(kind);
      expect(refusal!.error).toContain('web_editor_open');
    }
  });

  it('every scene-lineage kind is refused from the editor projection', () => {
    const sceneOnly = RV_OP_KINDS.filter((k) => RV_OP_ORIGIN[k] === 'scene');
    expect(sceneOnly.length).toBeGreaterThan(0);
    for (const kind of sceneOnly) {
      expect(requireOpOrigin(kind, 'scene')).toBeNull();
      expect(requireOpOrigin(kind, 'editor'), `${kind} must be refused in the editor`)
        .not.toBeNull();
    }
  });

  it('an unknown kind is refused rather than waved through', () => {
    // The dangerous default: a typo'd kind that returns null would be treated
    // as permitted everywhere.
    const refusal = requireOpOrigin('notAnOpKind' as RvOpKind, 'scene');
    expect(refusal).not.toBeNull();
    expect(refusal!.error).toContain('Unknown op kind');
  });

  it('originOf agrees with the table for every kind', () => {
    for (const kind of RV_OP_KINDS) expect(originOf(kind)).toBe(RV_OP_ORIGIN[kind]);
  });
});
