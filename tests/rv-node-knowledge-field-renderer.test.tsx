// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-431 — the Property Inspector view of a `NodeKnowledge` note.
 *
 * Two things in here are load-bearing and neither is obvious from the feature
 * description.
 *
 * **The component under test is never imported directly.** It is fetched out of
 * `fieldRendererRegistry` after `App.tsx` has been imported, i.e. through the
 * same bootstrap path production uses. A field renderer that is built, tested
 * and never side-effect-imported by `App.tsx` registers itself in NO running
 * application while a test that imports the module stays green — the exact gap
 * the second review round flagged as a blocker. Sourcing the component from the
 * registry makes that gap impossible to miss: the whole file goes red.
 *
 * **Read-only must NOT come from the schema.** `updateOverlayField` uses the
 * same `isFieldDisplayReadonly` predicate as the inspector's editability gate,
 * and `web_knowledge_set` writes all five fields through it. Measured during
 * Phase 1: `readonly: true` on `Note` alone turns 20 of 31
 * `mcp-knowledge-tools` tests red. So the fields are made non-editable by not
 * rendering an editor (`HIDDEN_FIELDS_PER_TYPE` + this renderer), and 9.5a below
 * pins the schema side of that bargain.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { Object3D } from 'three';
import type { ComponentType } from 'react';
import appSource from '../src/core/hmi/App.tsx?raw';
import {
  fieldRendererRegistry,
  type FieldRendererProps,
} from '../src/core/hmi/rv-field-renderer-registry';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import {
  HIDDEN_FIELDS_PER_TYPE,
  isFieldHidden,
} from '../src/core/hmi/rv-inspector-helpers';
import {
  getFieldDescriptor,
  isFieldDisplayReadonly,
} from '../src/core/engine/rv-component-registry';
import {
  NODE_KNOWLEDGE_FIELDS,
  NODE_KNOWLEDGE_PROVENANCE_FIELDS,
  NODE_KNOWLEDGE_TYPE,
  readNodeKnowledge,
} from '../src/core/engine/rv-node-knowledge';
import {
  __setMarkdownLoader,
  type MarkdownModule,
} from '../src/core/hmi/rv-markdown-lazy';
import { McpKnowledgeTools } from '../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { RvExtrasEditorPlugin } from '../src/core/hmi/rv-extras-editor';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import type { RVViewer } from '../src/core/rv-viewer';

/** The App module graph is large; importing it once costs ~25 s in the browser
 *  runner. Worth it — see the file note. */
const BOOTSTRAP_TIMEOUT = 180_000;

let Renderer: ComponentType<FieldRendererProps>;

beforeAll(async () => {
  await import('../src/core/hmi/App');

  // Warm the markdown chunk ONCE. Not a convenience: the browser runner
  // transforms `react-markdown` and its ~90 micromark modules on first request,
  // which takes longer than a `findBy*` default wait — so whichever test hits it
  // first would fail on timing rather than on behaviour. Loading it here also
  // makes the injected-loader tests (9.3) the only place where load TIMING is
  // under test, which is where it belongs.
  await Promise.all([import('react-markdown'), import('remark-gfm')]);

  const found = fieldRendererRegistry.getRenderer(NODE_KNOWLEDGE_TYPE, 'Note');
  if (!found) {
    throw new Error(
      'NodeKnowledge.Note has no field renderer after importing App.tsx — the ' +
      "side-effect import `import './rv-node-knowledge-field-renderer'` is missing.",
    );
  }
  Renderer = found;
}, BOOTSTRAP_TIMEOUT);

afterEach(() => {
  cleanup();
  __setMarkdownLoader();
  setActiveEditTarget(null);
  vi.restoreAllMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────────

const ISO = '2026-08-12T08:00:00.000Z';

const TABLE_NOTE = [
  '# Upper arm axis',
  '',
  'Pivot (world): (0.331, 1.219, 0).',
  '',
  '| Arm | Pivot | Elbow |',
  '| --- | ----- | ----- |',
  '| 0 deg | 0.331 | 0.864 |',
].join('\n');

interface Fixture {
  viewer: RVViewer;
  node: Object3D;
  nodes: Record<string, Object3D>;
  tools: McpKnowledgeTools;
}

/** `Cell/Axis1` with a NodeKnowledge entry, wired to the REAL editor plugin so
 *  the update tests can go through the real `web_knowledge_set` write path. */
function makeFixture(entry?: Partial<Record<string, unknown>>): Fixture {
  const root = new Object3D();
  root.name = 'Cell';
  const axis = new Object3D();
  axis.name = 'Axis1';
  root.add(axis);
  if (entry) {
    axis.userData.realvirtual = {
      [NODE_KNOWLEDGE_TYPE]: {
        Note: '',
        UpdatedAt: ISO,
        Author: 'agent',
        Confidence: 'observed',
        NodeIdAtWrite: 'a1b2c3d4e5f60718',
        ...entry,
      },
    };
  }

  const byPath: Record<string, Object3D> = { Cell: root, 'Cell/Axis1': axis };
  const pathByNode = new Map(Object.entries(byPath).map(([p, n]) => [n, p]));
  const registry = {
    getNode: (path: string) => byPath[path] ?? null,
    getPathForNode: (n: Object3D) => pathByNode.get(n) ?? null,
    getReferencesTo: () => [],
  };

  const editor = new RvExtrasEditorPlugin();
  const viewer = {
    registry,
    currentModelRoot: root,
    scene: root,
    getPlugin: <T,>(id: string): T | undefined =>
      (id === 'rv-extras-editor' ? (editor as unknown as T) : undefined),
  } as unknown as RVViewer;
  (editor as unknown as { _viewer: RVViewer })._viewer = viewer;

  return { viewer, node: axis, nodes: byPath, tools: new McpKnowledgeTools(() => viewer) };
}

/** An edit target that accepts and records ops (mirrors mcp-knowledge-tools). */
function recordingEditTarget() {
  const ops: Array<{ kind: string; field?: string }> = [];
  const target: EditTarget = {
    available: true,
    persistsTo: 'asset',
    setField: (_p, _c, field) => { ops.push({ kind: 'setField', field }); },
    unsetField: (_p, _c, field) => { ops.push({ kind: 'unsetField', field }); },
    withTransaction: async (label, fn) => { ops.push({ kind: `transaction:${label}` }); await fn(); },
  };
  return { target, ops };
}

/** Render just the field renderer, as the section would. */
function renderNote(fx: Fixture, value?: unknown) {
  const note = value ?? readNodeKnowledge(fx.node)?.Note ?? '';
  return render(
    <Renderer
      value={note}
      fieldName="Note"
      componentType={NODE_KNOWLEDGE_TYPE}
      nodePath="Cell/Axis1"
      viewer={fx.viewer}
      signalStore={null}
    />,
  );
}

/** Render the whole NodeKnowledge section the way the inspector builds it for a
 *  real (non-virtual) rv_extras component: `readOnlyLive` deliberately unset. */
function renderSection(fx: Fixture, overrides?: { readOnlyLive?: boolean; width?: number }) {
  const data = (fx.node.userData.realvirtual as Record<string, Record<string, unknown>>)[NODE_KNOWLEDGE_TYPE];
  const onFieldEdit = vi.fn();
  const view = render(
    <div style={{ width: overrides?.width ?? 320, overflowX: 'auto' }} data-testid="panel">
      <ComponentSection
        nodePath="Cell/Axis1"
        componentType={NODE_KNOWLEDGE_TYPE}
        data={data}
        overriddenFields={new Set()}
        consumedOnly={false}
        readOnlyLive={overrides?.readOnlyLive}
        onFieldEdit={onFieldEdit}
        onFieldReset={() => {}}
        onResetComponent={() => {}}
        viewer={fx.viewer}
        signalStore={null}
      />
    </div>,
  );
  return { ...view, onFieldEdit };
}

/** A never-settling loader — the pending state, held open on purpose. */
function pendingLoader() {
  let resolve!: (m: MarkdownModule) => void;
  const promise = new Promise<MarkdownModule>((r) => { resolve = r; });
  __setMarkdownLoader(() => promise);
  return { resolve };
}

beforeEach(() => { localStorage.clear(); });

// ── 9.2b Production registration ──────────────────────────────────────────

describe('9.2b production registration', () => {
  it('registers NodeKnowledge.Note through the App bootstrap, not a module import', () => {
    // beforeAll already proved this by not throwing; assert it explicitly so the
    // failure names the contract instead of "Renderer is undefined".
    expect(fieldRendererRegistry.getRenderer(NODE_KNOWLEDGE_TYPE, 'Note')).not.toBeNull();
  });

  it('keeps the side-effect import in App.tsx', () => {
    // The line itself, named: it is one deletable line between a working
    // feature and a feature that exists only in tests.
    expect(appSource).toContain("import './rv-node-knowledge-field-renderer'");
  });

  it('does not register a renderer for the provenance fields', () => {
    for (const field of NODE_KNOWLEDGE_PROVENANCE_FIELDS) {
      expect(fieldRendererRegistry.getRenderer(NODE_KNOWLEDGE_TYPE, field)).toBeNull();
    }
  });
});

// ── 9.1 Rendering and provenance ──────────────────────────────────────────

describe('9.1 note rendering', () => {
  it('renders a GFM table from the note', async () => {
    const fx = makeFixture({ Note: TABLE_NOTE });
    renderNote(fx);
    const table = await screen.findByRole('table');
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('td').length).toBe(3);
    expect(screen.getByText('Upper arm axis')).toBeTruthy();
  });

  it('renders headings, lists, code and bold', async () => {
    const fx = makeFixture({ Note: '## Limits\n\n- **assumed** travel\n- `theta = 0`' });
    renderNote(fx);
    await screen.findByText('Limits');
    expect(screen.getByText('assumed').tagName.toLowerCase()).toBe('strong');
    expect(screen.getByText('theta = 0').tagName.toLowerCase()).toBe('code');
    expect(document.querySelectorAll('li').length).toBe(2);
  });

  it('shows the relative age, the author and the confidence', async () => {
    const fx = makeFixture({ Note: 'n', UpdatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    renderNote(fx);
    const header = screen.getByTestId('rv-knowledge-provenance');
    expect(header.textContent).toContain('2 hours ago');
    expect(header.textContent).toContain('agent');
    expect(header.textContent).toContain('observed');
  });

  it('exposes the exact timestamp as a tooltip, not as a row', async () => {
    const iso = new Date(Date.now() - 3 * 3600_000).toISOString();
    const fx = makeFixture({ Note: 'n', UpdatedAt: iso });
    renderNote(fx);
    fireEvent.mouseOver(screen.getByText('3 hours ago'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain(iso);
  });

  it('carries NodeIdAtWrite in that same tooltip and nowhere on screen', async () => {
    const fx = makeFixture({ Note: 'n' });
    renderNote(fx);
    // Not visible as text …
    expect(screen.queryByText(/a1b2c3d4e5f60718/)).toBeNull();
    expect(screen.queryByText('NodeIdAtWrite')).toBeNull();
    // … but reachable for the reader who needs it. One hover, ONE tooltip:
    // nested tooltips used to open together on this row.
    fireEvent.mouseOver(screen.getByTestId('rv-knowledge-stamp'));
    const tips = await screen.findAllByRole('tooltip');
    expect(tips.length).toBe(1);
    expect(tips[0].textContent).toContain('a1b2c3d4e5f60718');
  });

  it('sets an unverified note apart from an observed one (F3)', async () => {
    const fx = makeFixture({ Note: 'n', Confidence: 'unverified' });
    renderNote(fx);
    const warn = screen.getByText('unverified');
    const warnColor = getComputedStyle(warn).color;

    cleanup();
    const calm = makeFixture({ Note: 'n', Confidence: 'observed' });
    renderNote(calm);
    const neutralColor = getComputedStyle(screen.getByText('observed')).color;

    // A guess must not look like a measurement — same shape, different tone.
    expect(warnColor).not.toBe(neutralColor);
  });

  it('explains the confidence in plain language on hover', async () => {
    const fx = makeFixture({ Note: 'n', Confidence: 'unverified' });
    renderNote(fx);
    fireEvent.mouseOver(screen.getByText('unverified'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toMatch(/guess, not a measurement/);
  });

  it('renders NOTHING for a node without a NodeKnowledge entry (F8)', () => {
    const fx = makeFixture();               // no entry at all
    const { container } = renderNote(fx, '');
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('rv-knowledge-note')).toBeNull();
  });

  it('renders NOTHING for a whitespace-only note, without throwing (F8)', () => {
    const fx = makeFixture({ Note: '   \n\t ' });
    const { container } = renderNote(fx);
    expect(container.textContent).toBe('');
  });

  it('survives a note whose entry is missing but whose value is present', async () => {
    const fx = makeFixture();               // no entry …
    renderNote(fx, '# orphan value');       // … but the field still has a value
    await screen.findByText('orphan value');
    expect(screen.queryByTestId('rv-knowledge-provenance')).toBeNull();
  });
});

// ── 9.2 Section, field hiding, layout ─────────────────────────────────────

describe('9.2 section and layout', () => {
  it('hides the four provenance fields and keeps Note visible', () => {
    for (const field of NODE_KNOWLEDGE_PROVENANCE_FIELDS) {
      expect(isFieldHidden(NODE_KNOWLEDGE_TYPE, field)).toBe(true);
    }
    expect(isFieldHidden(NODE_KNOWLEDGE_TYPE, 'Note')).toBe(false);
  });

  it('renders the note through the custom renderer and NO row for any other field (F5, F6)', async () => {
    const fx = makeFixture({ Note: TABLE_NOTE });
    const { onFieldEdit } = renderSection(fx);

    await screen.findByRole('table');
    expect(screen.getByTestId('rv-knowledge-note')).toBeTruthy();

    // No label row for a provenance field …
    for (const field of NODE_KNOWLEDGE_PROVENANCE_FIELDS) {
      expect(screen.queryByText(field)).toBeNull();
    }
    // … and no editor anywhere in the section: not for the note, not for the
    // provenance. This is what "read-only" means here — there is no control.
    expect(document.querySelectorAll('input').length).toBe(0);
    expect(document.querySelectorAll('textarea').length).toBe(0);
    expect(screen.queryByText(/more field/)).toBeNull();
    expect(onFieldEdit).not.toHaveBeenCalled();
  });

  it('renders the note ONCE — the custom renderer wins over FieldRow', async () => {
    const fx = makeFixture({ Note: '# only once' });
    renderSection(fx);
    await screen.findByText('only once');
    expect(screen.getAllByTestId('rv-knowledge-note').length).toBe(1);
    // A FieldRow would have printed the field's own label next to the value.
    expect(screen.queryByText('Note')).toBeNull();
  });

  it('keeps a wide table inside its own scroller — the panel never scrolls sideways (F4)', async () => {
    const wide = [
      '| A | B | C | D | E | F |',
      '| - | - | - | - | - | - |',
      `| ${'wide-value '.repeat(4)} | b | c | d | e | f |`,
    ].join('\n');
    const fx = makeFixture({ Note: wide });
    renderSection(fx, { width: 320 });

    const table = await screen.findByRole('table');
    const scroller = table.parentElement!;
    expect(getComputedStyle(scroller).overflowX).toBe('auto');
    expect(table.scrollWidth).toBeGreaterThan(scroller.clientWidth);

    // The panel itself stays put: nothing widened it past its own box.
    const panel = screen.getByTestId('panel');
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1);
  });

  it('scrolls a long note vertically inside a fixed box (F4)', async () => {
    const fx = makeFixture({ Note: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n\n') });
    renderSection(fx);
    await screen.findByText('line 0');
    const box = screen.getByTestId('rv-knowledge-scrollbox');
    expect(getComputedStyle(box).overflowY).toBe('auto');
    // The ceiling is viewport-relative since the 2026-08-22 revision:
    // max(320px, 100vh - 340px). Assert against the same formula, not a literal.
    expect(box.clientHeight).toBeLessThanOrEqual(Math.max(320, window.innerHeight - 340));
    expect(box.scrollHeight).toBeGreaterThan(box.clientHeight);
  });

  /**
   * `readOnlyLive` is a short-circuit for EPHEMERAL virtual components: it skips
   * `isFieldHidden` AND the custom-renderer lookup and dumps every field as a
   * read-only row. A NodeKnowledge entry is a persisted rv_extras component and
   * must never take that branch — if it did, the four provenance rows would come
   * back and the note would render as one unreadable line.
   *
   * The property is asserted from both ends: the inspector only ever passes the
   * flag for its own `virtualComponents` list (source), and the branch really
   * would break the feature (behaviour).
   */
  it('never renders NodeKnowledge through the readOnlyLive branch', async () => {
    const fx = makeFixture({ Note: '# normal path' });
    renderSection(fx);                       // exactly the inspector's call shape
    await screen.findByText('normal path');
    expect(screen.getByTestId('rv-knowledge-note')).toBeTruthy();
    expect(screen.queryByText('NodeIdAtWrite')).toBeNull();

    cleanup();
    // What the wrong branch would look like, so the assertion above is not
    // vacuous: raw rows, the provenance back on screen, no renderer.
    renderSection(fx, { readOnlyLive: true });
    expect(screen.getByText('NodeIdAtWrite')).toBeTruthy();
    expect(screen.queryByTestId('rv-knowledge-note')).toBeNull();
  });
});

// ── 9.3 Lazy states ───────────────────────────────────────────────────────

describe('9.3 lazy markdown chunk', () => {
  it('shows the raw note while the chunk is in flight — never an empty box (F7)', async () => {
    pendingLoader();
    const fx = makeFixture({ Note: '# pending please' });
    renderNote(fx);

    const raw = await screen.findByTestId('rv-knowledge-raw');
    expect(raw.textContent).toContain('# pending please');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the raw note when the chunk REJECTS, and the section survives (F7)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    __setMarkdownLoader(() => Promise.reject(new Error('chunk 404')));

    const fx = makeFixture({ Note: '# rejected but readable' });
    renderNote(fx);

    // Suspense alone would not have caught this — the error boundary does.
    const raw = await screen.findByTestId('rv-knowledge-raw');
    expect(raw.textContent).toContain('rejected but readable');
    // The surrounding block is still standing, not blanked by the throw.
    expect(screen.getByTestId('rv-knowledge-note')).toBeTruthy();
  });

  it('does not re-parse the note when the inspector re-renders around it', async () => {
    // The inspector re-renders on its own live ticks. Re-parsing 2400 characters
    // of Markdown several times a second for an unchanged value is the kind of
    // cost that never shows up in a functional test — so it is asserted here, by
    // counting how often the loaded markdown component is actually invoked.
    let renders = 0;
    const [markdown, gfm] = await Promise.all([import('react-markdown'), import('remark-gfm')]);
    __setMarkdownLoader(async () => ({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ReactMarkdown: (props: any) => { renders++; return <markdown.default {...props} />; },
      remarkGfm: gfm.default,
    }));

    const fx = makeFixture({ Note: '# stable' });
    const show = () => (
      <Renderer value="# stable" fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />
    );
    const { rerender } = render(show());
    await screen.findByText('stable');
    const afterFirst = renders;
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) rerender(show());
    await waitFor(() => expect(screen.getByText('stable')).toBeTruthy());
    expect(renders).toBe(afterFirst);

    // …but a real change still gets through.
    rerender(
      <Renderer value="# moved on" fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />,
    );
    await screen.findByText('moved on');
    expect(renders).toBeGreaterThan(afterFirst);
  });

  it('renders a GFM table once the chunk resolves — remark-gfm rides along (§2.5)', async () => {
    const { resolve } = pendingLoader();
    const fx = makeFixture({ Note: TABLE_NOTE });
    renderNote(fx);
    await screen.findByTestId('rv-knowledge-raw');

    const [markdown, gfm] = await Promise.all([import('react-markdown'), import('remark-gfm')]);
    resolve({ ReactMarkdown: markdown.default, remarkGfm: gfm.default });

    // A table is the proof: without remark-gfm in the SAME chunk this stays a
    // paragraph of pipe characters.
    const table = await screen.findByRole('table');
    expect(table.querySelectorAll('th').length).toBe(3);
    await waitFor(() => expect(screen.queryByTestId('rv-knowledge-raw')).toBeNull());
  });
});

// ── 9.4 Live update, undo/redo, clear ─────────────────────────────────────

/**
 * F10 asks for one property: the view hangs off the editor state, never off a
 * snapshot the renderer took when it mounted. The inspector re-collects the
 * component object from `userData` on every editor notification and hands it
 * down — so "the state changed" reaches this component as a new `value` prop,
 * and that is what these tests drive.
 *
 * Undo/redo is exercised as state restoration through the same real
 * `web_knowledge_set` path rather than through a scene-store undo stack: the
 * section holds NO state of its own, so any mechanism that restores the value
 * arrives here identically. What the undo STACK does with a knowledge set is
 * observed (not prescribed) in the last case.
 */
describe('9.4 staying current', () => {
  it('shows a note written from outside, without a re-selection', async () => {
    const { target } = recordingEditTarget();
    setActiveEditTarget(target);
    const fx = makeFixture({ Note: '# first' });
    const { rerender } = renderNote(fx);
    await screen.findByText('first');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '# second');
    const fresh = readNodeKnowledge(fx.node)!.Note;
    rerender(
      <Renderer value={fresh} fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />,
    );

    await screen.findByText('second');
    expect(screen.queryByText('first')).toBeNull();
  });

  it('follows a restored (undone) and re-applied (redone) value', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    const fx = makeFixture({ Note: '# before' });
    const show = (v: string) => (
      <Renderer value={v} fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />
    );
    const { rerender } = render(show('# before'));
    await screen.findByText('before');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '# after');
    rerender(show(readNodeKnowledge(fx.node)!.Note));
    await screen.findByText('after');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '# before');       // undo
    rerender(show(readNodeKnowledge(fx.node)!.Note));
    await screen.findByText('before');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '# after');        // redo
    rerender(show(readNodeKnowledge(fx.node)!.Note));
    await screen.findByText('after');
  });

  it('refreshes the provenance even when the note text is unchanged', async () => {
    // The trap this pins: caching the entry on `nodePath` + `value` looks
    // harmless until someone re-states the SAME note with a different
    // confidence. Neither key moves, and the header would keep claiming
    // "observed" for a value that is now a guess.
    setActiveEditTarget(recordingEditTarget().target);
    const fx = makeFixture({ Note: '# same text', Confidence: 'observed' });
    const show = () => (
      <Renderer value="# same text" fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />
    );
    const { rerender } = render(show());
    expect(screen.getByTestId('rv-knowledge-provenance').textContent).toContain('observed');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '# same text', 'user', 'unverified');
    rerender(show());

    const header = screen.getByTestId('rv-knowledge-provenance');
    expect(header.textContent).toContain('unverified');
    expect(header.textContent).toContain('user');
  });

  it('makes the block disappear when the note is cleared', async () => {
    setActiveEditTarget(recordingEditTarget().target);
    const fx = makeFixture({ Note: '# temporary' });
    const { rerender } = renderNote(fx);
    await screen.findByText('temporary');

    await fx.tools.webKnowledgeSet('Cell/Axis1', '');
    expect(readNodeKnowledge(fx.node)).toBeNull();
    rerender(
      <Renderer value="" fieldName="Note" componentType={NODE_KNOWLEDGE_TYPE}
        nodePath="Cell/Axis1" viewer={fx.viewer} signalStore={null} />,
    );
    expect(screen.queryByTestId('rv-knowledge-note')).toBeNull();
  });

  it('OBSERVES that one knowledge set is per-field ops, not one transaction', async () => {
    // Purely descriptive (plan-431 §2.9): whether these writes should collapse
    // into one undo step is a question for plan-394, not for this plan. Recorded
    // here so a future change to it is visible rather than silent.
    const { target, ops } = recordingEditTarget();
    setActiveEditTarget(target);

    // A FIRST note on a bare node: all five fields change, so all five are
    // written. Five separate ops, no transaction around them.
    const fresh = makeFixture();
    await fresh.tools.webKnowledgeSet('Cell/Axis1', 'a new note');
    expect(ops.filter((o) => o.kind === 'setField').map((o) => o.field))
      .toEqual([...NODE_KNOWLEDGE_FIELDS]);
    expect(ops.some((o) => o.kind.startsWith('transaction:'))).toBe(false);

    // An OVERWRITE writes fewer: `updateOverlayField` drops a write whose value
    // is already there, so the undo depth of a knowledge set is not even a fixed
    // number — it depends on what changed.
    ops.length = 0;
    await fresh.tools.webKnowledgeSet('Cell/Axis1', 'a second note');
    const rewritten = ops.filter((o) => o.kind === 'setField').map((o) => o.field);
    expect(rewritten).toContain('Note');
    expect(rewritten.length).toBeLessThan(NODE_KNOWLEDGE_FIELDS.length);
  });
});

// ── 9.5a / 9.5c The core finding ──────────────────────────────────────────

describe('9.5a schema stays writable', () => {
  it('keeps every NodeKnowledge field writable through the shared readonly predicate', () => {
    for (const field of NODE_KNOWLEDGE_FIELDS) {
      // Read-only lives in the renderer, NEVER in the schema — plan-431 §2.1.
      // `readonly: true` here would make `updateOverlayField` refuse the write
      // and `web_knowledge_set` fail with "The write was refused for …".
      expect(isFieldDisplayReadonly(getFieldDescriptor(NODE_KNOWLEDGE_TYPE, field))).toBe(false);
    }
  });
});

describe('9.5c field parity', () => {
  it('hides exactly the provenance fields, and the header shows every one of them', async () => {
    const hidden = HIDDEN_FIELDS_PER_TYPE[NODE_KNOWLEDGE_TYPE];
    expect(hidden).toBeDefined();
    expect([...hidden!].sort()).toEqual([...NODE_KNOWLEDGE_PROVENANCE_FIELDS].sort());

    // Hidden ∪ {Note} must be the whole field set: a sixth field added to the
    // component without a decision about where it shows up fails HERE, instead
    // of quietly appearing as a raw row (or quietly vanishing).
    expect([...hidden!, 'Note'].sort()).toEqual([...NODE_KNOWLEDGE_FIELDS].sort());

    // And every hidden field is actually accounted for by the header.
    const fx = makeFixture({ Note: 'n', Author: 'user', Confidence: 'inferred' });
    renderNote(fx);
    const header = screen.getByTestId('rv-knowledge-provenance');
    expect(header.textContent).toContain('user');            // Author
    expect(header.textContent).toContain('inferred');        // Confidence
    expect(header.textContent).toMatch(/ago|just now/);      // UpdatedAt
    fireEvent.mouseOver(screen.getByTestId('rv-knowledge-stamp'));
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('a1b2c3d4e5f60718');   // NodeIdAtWrite
  });
});

// ── 9.6 Security ──────────────────────────────────────────────────────────

describe('9.6 untrusted note text', () => {
  it('does not turn HTML in the note into HTML', async () => {
    const fx = makeFixture({
      Note: '# safe\n\n<script>window.__rv_pwned = 1</script>\n\n<img src=x onerror="window.__rv_pwned = 1">',
    });
    const { container } = renderNote(fx);
    await screen.findByText('safe');

    // Scoped to the rendered subtree — the page itself carries the runner's own
    // <script> tags, which would make a document-wide query meaningless.
    // No rehype-raw: the markup arrives as text, not as nodes.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<script>');
    expect((window as unknown as Record<string, unknown>).__rv_pwned).toBeUndefined();
  });

  it('refuses javascript: links in every spelling', async () => {
    const fx = makeFixture({
      Note: [
        '[plain](javascript:alert(1))',
        '[mixed](JaVaScRiPt:alert(1))',
        '[encoded](java&#115;cript:alert(1))',
      ].join('\n\n'),
    });
    renderNote(fx);
    await screen.findByText('plain');

    for (const a of Array.from(document.querySelectorAll('a'))) {
      const href = a.getAttribute('href') ?? '';
      expect(href.toLowerCase().replace(/\s/g, '').startsWith('javascript:')).toBe(false);
    }
  });

  it('opens an external link in a new tab without handing it this window', async () => {
    const fx = makeFixture({ Note: '[docs](https://doc.realvirtual.io/x)' });
    renderNote(fx);
    const link = await screen.findByText('docs');
    expect(link.getAttribute('href')).toBe('https://doc.realvirtual.io/x');
    expect(link.getAttribute('target')).toBe('_blank');
    const rel = link.getAttribute('rel') ?? '';
    expect(rel).toContain('noopener');
    expect(rel).toContain('noreferrer');
  });
});
