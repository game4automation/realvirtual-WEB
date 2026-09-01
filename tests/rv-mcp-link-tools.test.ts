// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-437 §9 — `web_link_compose`.
 *
 * Three of these tests are the reason the feature is allowed to exist at all:
 *
 *  - **the allowlist** (`link_NeverLeaksTokens_AllowlistOnly`): a composed link
 *    gets mailed, bookmarked, logged and pasted into an LLM context. `?devkey=`
 *    and `?sharetoken=` are credentials. The test prepares a page URL that has
 *    one and asserts it cannot reach the result — a property that is trivially
 *    true today and would be silently lost the first time somebody "helpfully"
 *    carries the current query over.
 *  - **the live mode** (`link_Snapshot_ReadsModeLiveNotFromUrl`): `ModeManager`
 *    never writes to the address bar, so a URL-derived mode is stale the moment
 *    the user touches the workspace dropdown.
 *  - **the source guard** (`link_MirrorsBootPrecedence_SourceGuard`): the
 *    composer MIRRORS main.ts rather than calling into it. The mirror is only
 *    honest while something notices main.ts moving — the same device
 *    `rv-share-boot.test.ts` uses for the same block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import mainSource from '../src/main.ts?raw';
import {
  McpLinkTools,
  composeLink,
  stripOptionParam,
  baseLabelOfUrl,
  LINK_PARAM_ORDER,
  type LinkEnv,
  type LinkState,
} from '../src/plugins/mcp-bridge/rv-mcp-link-tools';
import {
  registerModelOptionModules,
  resetModelOptionRegistry,
} from '../src/plugins/models/model-option-plugin';

// ── Fixtures ────────────────────────────────────────────────────────────

const BASE = 'https://host.example.org/app/';

function makeState(over: Partial<LinkState> = {}): LinkState {
  return {
    documents: [
      { id: 'doc_a', name: 'Cell A', path: 'models/CellA.glb' },
      { id: 'doc_b', name: 'Cell B', path: 'scenes/CellB.glb' },
      // The example a legacy `published:sorter` link addresses. It is a
      // DOCUMENT ROW since plan-731 — there is no second list to put it in.
      { id: 'doc_sorter', name: 'Sorter Line', path: 'scenes/sorter.glb' },
    ],
    builtins: [
      { url: '/models/DemoRealvirtualWeb.glb', label: 'DemoRealvirtualWeb' },
      { url: '/models/Empty.glb', label: 'Empty' },
    ],
    base: null,
    documentId: null,
    dirty: false,
    ...over,
  };
}

function makeEnv(over: Partial<LinkEnv> = {}): LinkEnv {
  return {
    defaultBase: BASE,
    activeMode: null,
    hasMode: (id) => ['hmi', 'planner', 'des'].includes(id),
    currentModelUrl: null,
    connectEmbed: false,
    ...over,
  };
}

/** A viewer stub carrying only what readLinkEnv/the tool touch. */
function makeViewer(over: { mode?: string | null; modelUrl?: string | null } = {}) {
  return {
    modes: {
      activeMode: over.mode ?? null,
      has: (id: string) => ['hmi', 'planner', 'des'].includes(id),
    },
    currentModelUrl: over.modelUrl ?? null,
  } as never;
}

afterEach(() => resetModelOptionRegistry());

// ── Compose mode ────────────────────────────────────────────────────────

describe('web_link_compose — compose mode', () => {
  it('link_ComposeDoc_CanonicalOrderAndEncoding', async () => {
    const tools = new McpLinkTools(
      () => makeViewer(),
      async () => makeState(),
      () => makeEnv(),
    );
    const res = JSON.parse(await tools.webLinkCompose(
      '', '', 'doc_a', '', 'planner', '', BASE,
    ));

    expect(res.url).toBe('https://host.example.org/app/?doc=doc_a&mode=planner');
    expect(res.warnings).toEqual([]);
    expect(res.params).toEqual({ doc: 'doc_a', mode: 'planner' });
  });

  it('canonical order is fixed regardless of argument order', () => {
    const res = composeLink(
      { mode: 'planner', option: 'bosch', model: '/models/X.glb', doc: 'doc_a' },
      makeState(),
      makeEnv(),
    );
    // doc, scene, glb, model, option, mode — the documented order (F5).
    const keys = Object.keys(res.params);
    expect(keys).toEqual(['doc', 'model', 'option', 'mode']);
    expect(keys).toEqual([...LINK_PARAM_ORDER].filter((k) => keys.includes(k)));
  });

  it('the same input yields a byte-identical URL (F5)', () => {
    const input = { doc: 'doc_a', mode: 'planner', base: BASE };
    const a = composeLink(input, makeState(), makeEnv());
    const b = composeLink(input, makeState(), makeEnv());
    expect(a.url).toBe(b.url);
  });

  it('base defaults to the env base and is overridable (F6)', () => {
    expect(composeLink({ doc: 'doc_a' }, makeState(), makeEnv()).url)
      .toBe(`${BASE}?doc=doc_a`);
    expect(composeLink({ doc: 'doc_a', base: 'https://other/x/' }, makeState(), makeEnv()).url)
      .toBe('https://other/x/?doc=doc_a');
  });

  it('URLSearchParams owns the encoding — a glb URL with its own query survives', () => {
    const glb = 'https://cdn.example.org/a b/part.glb?v=2&t=x';
    const res = composeLink({ glb }, makeState(), makeEnv());
    // Round-tripping is the assertion that matters: whatever the escaping, the
    // value must come back out unchanged.
    expect(new URL(res.url).searchParams.get('glb')).toBe(glb);
    expect(res.warnings).toEqual([]);
    // And no manual concatenation crept in.
    expect(res.url).not.toContain(' ');
  });

  it('link_UnknownOption_WarnsButComposes', () => {
    registerModelOptionModules([
      { baseModel: 'DemoRealvirtualWeb', modelOptions: [{ id: 'sew', label: 'SEW' }] },
    ]);
    const res = composeLink(
      { model: '/models/DemoRealvirtualWeb.glb', option: 'nope' },
      makeState(),
      makeEnv(),
    );
    expect(res.params.option).toBe('nope');
    expect(res.warnings.some((w) => w.includes('option "nope"'))).toBe(true);

    // The declared one composes clean.
    const ok = composeLink(
      { model: '/models/DemoRealvirtualWeb.glb', option: 'sew' },
      makeState(),
      makeEnv(),
    );
    expect(ok.warnings).toEqual([]);
  });

  it('an unknown mode warns but is still set', () => {
    const res = composeLink({ doc: 'doc_a', mode: 'invented' }, makeState(), makeEnv());
    expect(res.params.mode).toBe('invented');
    expect(res.warnings.some((w) => w.includes('mode "invented"'))).toBe(true);
  });

  it('an unknown document warns but is still set', () => {
    const res = composeLink({ doc: 'doc_missing' }, makeState(), makeEnv());
    expect(res.params.doc).toBe('doc_missing');
    expect(res.warnings.some((w) => w.includes('doc "doc_missing"'))).toBe(true);
  });

  it('conflicting identity parameters all get set, with the precedence spelled out', () => {
    const res = composeLink(
      { doc: 'doc_a', scene: 'empty', model: '/models/Empty.glb' },
      makeState(),
      makeEnv(),
    );
    expect(res.params.doc).toBe('doc_a');
    expect(res.params.scene).toBe('empty');
    expect(res.params.model).toBe('/models/Empty.glb');
    expect(res.warnings.some((w) => w.includes('scene > doc > glb > model'))).toBe(true);
  });

  it('a malformed glb warns; a well-formed s:<id> passes through unminted (F8)', () => {
    const bad = composeLink({ glb: 'ftp://nope/x.glb' }, makeState(), makeEnv());
    expect(bad.params.glb).toBe('ftp://nope/x.glb');
    expect(bad.warnings.some((w) => w.includes('well-formed'))).toBe(true);

    const opaque = composeLink({ glb: 's:abc123' }, makeState(), makeEnv());
    expect(opaque.params.glb).toBe('s:abc123');
    expect(opaque.warnings).toEqual([]);
  });

  it('a legacy published: value validates against DOCUMENTS now (plan-731 2c)', () => {
    // The READ half survives forever: a human can still hand this tool an old
    // link, and it deserves the same verdict the boot would reach. What moved
    // is the authority — `documents[]`, not a second catalogue.
    expect(composeLink({ scene: 'published:sorter' }, makeState(), makeEnv()).warnings).toEqual([]);
    expect(composeLink({ scene: 'builtin:DemoRealvirtualWeb.glb' }, makeState(), makeEnv()).warnings)
      .toEqual([]);
    expect(composeLink({ scene: 'empty' }, makeState(), makeEnv()).warnings).toEqual([]);

    const ghost = composeLink({ scene: 'published:ghost' }, makeState(), makeEnv());
    expect(ghost.warnings.length).toBeGreaterThan(0);
    // The warning points the caller at the address form that is not legacy.
    expect(ghost.warnings.some((w) => w.includes('?doc='))).toBe(true);
  });

  it('a CONNECT embed deployment says so instead of promising a working link (F7)', () => {
    const res = composeLink({ doc: 'doc_a' }, makeState(), makeEnv({ connectEmbed: true }));
    expect(res.warnings.some((w) => w.includes('CONNECT embed'))).toBe(true);
  });

  it('no viewer is an error object, never a throw', async () => {
    const tools = new McpLinkTools(() => undefined);
    expect(JSON.parse(await tools.webLinkCompose('', '', '', '', '', '', ''))).toEqual({
      error: 'No viewer',
    });
  });
});

// ── Security: the allowlist ─────────────────────────────────────────────

describe('web_link_compose — the allowlist', () => {
  it('link_NeverLeaksTokens_AllowlistOnly', async () => {
    // A page URL carrying credentials, exactly as a remote-dev or share session
    // has it. Nothing in the composer may read this.
    const pageUrl = `${BASE}?devkey=SUPERSECRET&sharetoken=ONETIME&doc=doc_b&joinCode=42`;

    const tools = new McpLinkTools(
      () => makeViewer({ mode: 'hmi' }),
      async () => makeState({ documentId: 'doc_a' }),
      // The env stub mirrors readLinkEnv's contract: origin + pathname ONLY.
      () => makeEnv({ defaultBase: new URL(pageUrl).origin + new URL(pageUrl).pathname, activeMode: 'hmi' }),
    );

    const res = JSON.parse(await tools.webLinkCompose('', '', '', '', '', '', ''));

    for (const secret of ['devkey', 'SUPERSECRET', 'sharetoken', 'ONETIME', 'joinCode', '42']) {
      expect(res.url, `"${secret}" leaked into the composed link`).not.toContain(secret);
    }
    expect(Object.keys(res.params).every((k) => (LINK_PARAM_ORDER as readonly string[]).includes(k)))
      .toBe(true);
  });

  it('only allowlisted keys can ever appear, whatever is thrown at the composer', () => {
    const res = composeLink(
      { doc: 'doc_a', mode: 'hmi', option: 'x', glb: 's:1', scene: 'empty', model: '/m.glb' },
      makeState(),
      makeEnv(),
    );
    for (const key of Object.keys(res.params)) {
      expect(LINK_PARAM_ORDER as readonly string[]).toContain(key);
    }
  });

  it('the source carries no reference to the page query string', async () => {
    // The structural half of the guarantee: greping the module is what catches a
    // future "just carry the existing params over" convenience.
    const src = (await import('../src/plugins/mcp-bridge/rv-mcp-link-tools.ts?raw')).default;
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('location.search');
    expect(code).not.toContain('window.location.search');
  });
});

// ── Snapshot mode ───────────────────────────────────────────────────────

describe('web_link_compose — snapshot mode', () => {
  it('link_Snapshot_ReadsModeLiveNotFromUrl', async () => {
    const tools = new McpLinkTools(
      () => makeViewer({ mode: 'planner' }),
      async () => makeState({ documentId: 'doc_a' }),
      // defaultBase has NO ?mode= — the mode can only come from the manager.
      () => makeEnv({ activeMode: 'planner' }),
    );
    const res = JSON.parse(await tools.webLinkCompose('', '', '', '', '', '', ''));
    expect(res.url).toBe(`${BASE}?doc=doc_a&mode=planner`);
    expect(res.params.mode).toBe('planner');
  });

  it('link_Snapshot_DirtyDocument_Warns', () => {
    const res = composeLink({}, makeState({ documentId: 'doc_a', dirty: true }), makeEnv());
    expect(res.params.doc).toBe('doc_a');
    expect(res.warnings.some((w) => /unsaved/i.test(w))).toBe(true);
  });

  it('a clean snapshot warns about nothing', () => {
    const res = composeLink({}, makeState({ documentId: 'doc_a' }), makeEnv({ activeMode: 'hmi' }));
    expect(res.warnings).toEqual([]);
    expect(res.url).toBe(`${BASE}?doc=doc_a&mode=hmi`);
  });

  it('a built-in base becomes scene=builtin:<file>', () => {
    const builtin = composeLink({}, makeState({
      base: { kind: 'builtin', url: '/models/DemoRealvirtualWeb.glb', label: 'DemoRealvirtualWeb' },
    }), makeEnv());
    expect(builtin.params.scene).toBe('builtin:DemoRealvirtualWeb.glb');
  });

  it('an open example mints ?doc=, never ?scene=published: (plan-731 2c)', () => {
    // The WRITE half is gone. It used to mint `published:<name>` from a
    // `publishedName` marker on the snapshot — a link in an address form the
    // app had stopped minting anywhere else, for content that is now an
    // ordinary document. `documentId` answers for it one branch earlier, with
    // the stronger id.
    const res = composeLink({}, makeState({
      documentId: 'doc_sorter',
      base: { kind: 'builtin', url: '/scenes/sorter.glb', label: 'Sorter Line' },
    }), makeEnv());
    expect(res.params.doc).toBe('doc_sorter');
    expect(res.params.scene).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it('LinkState carries no second catalogue any more', () => {
    const state = makeState() as unknown as Record<string, unknown>;
    expect('published' in state).toBe(false);
    expect('publishedName' in state).toBe(false);
  });

  it('an empty scene round-trips as scene=empty — it has no document to name', () => {
    expect(composeLink({}, makeState({ base: { kind: 'empty' } }), makeEnv()).params.scene)
      .toBe('empty');
  });

  it('composeLink mints ?doc= for a scene-glb base, never ?scene= (plan-720 F4)', () => {
    // A scene-glb base IS a document. `?scene=<doc>` still RESOLVES forever via
    // rv-doc-alias; what moved is which form gets minted into a fresh link.
    const res = composeLink({}, makeState({
      base: { kind: 'scene-glb', sceneId: 'doc_b', label: 'Cell B' },
    }), makeEnv());
    expect(res.params.doc).toBe('doc_b');
    expect(res.params.scene).toBeUndefined();
    expect(res.warnings).toEqual([]);
  });

  it('warns instead of minting a dead ?doc= when the sceneId resolves to no document', () => {
    // The divergence case: an unsaved/foreign scene id would otherwise produce a
    // link that silently boots the recipient into the deployment default.
    const res = composeLink({}, makeState({
      base: { kind: 'scene-glb', sceneId: 'doc_nowhere', label: 'Stray' },
    }), makeEnv());
    expect(res.params.doc).toBeUndefined();
    expect(res.params.scene).toBeUndefined();
    expect(res.warnings.some((w) => /matches no document/i.test(w))).toBe(true);
  });

  it('an uncatalogued base falls back to model=, with the folded option lifted out', () => {
    registerModelOptionModules([
      { baseModel: 'Foreign', modelOptions: [{ id: 'bosch', label: 'Bosch' }] },
    ]);
    const url = 'https://cdn.example.org/Foreign.glb?option=bosch';
    const res = composeLink({}, makeState({
      base: { kind: 'builtin', url, label: 'Foreign' },
    }), makeEnv({ currentModelUrl: url }));

    // The option travels as the top-level parameter, exactly once.
    expect(res.params.model).toBe('https://cdn.example.org/Foreign.glb');
    expect(res.params.option).toBe('bosch');
    expect(res.warnings).toEqual([]);
  });

  it('nothing open says so rather than composing a link to the deployment default', () => {
    const res = composeLink({}, makeState(), makeEnv());
    expect(res.params.doc).toBeUndefined();
    expect(res.warnings.some((w) => /Nothing is open/i.test(w))).toBe(true);
  });

  it('an explicit identity parameter switches OFF snapshot mode', () => {
    // doc_b is passed although doc_a is open: the argument wins, unconditionally.
    const res = composeLink({ doc: 'doc_b' }, makeState({ documentId: 'doc_a', dirty: true }), makeEnv());
    expect(res.params.doc).toBe('doc_b');
    // …and the dirty warning belongs to the snapshot, so it is not emitted here.
    expect(res.warnings.some((w) => /unsaved/i.test(w))).toBe(false);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────

describe('link composer helpers', () => {
  it('stripOptionParam removes only the option key', () => {
    expect(stripOptionParam('/m.glb?option=a')).toBe('/m.glb');
    expect(stripOptionParam('/m.glb?v=2&option=a')).toBe('/m.glb?v=2');
    expect(stripOptionParam('/m.glb?v=2')).toBe('/m.glb?v=2');
    expect(stripOptionParam('/m.glb')).toBe('/m.glb');
    expect(stripOptionParam('/m.glb?option=a#frag')).toBe('/m.glb#frag');
  });

  it('baseLabelOfUrl yields the option-registry key', () => {
    expect(baseLabelOfUrl('/models/DemoRealvirtualWeb.glb?option=x')).toBe('DemoRealvirtualWeb');
    expect(baseLabelOfUrl(null)).toBeNull();
  });
});

// ── Source guard against main.ts ────────────────────────────────────────

describe('web_link_compose — main.ts mirror', () => {
  it('link_MirrorsBootPrecedence_SourceGuard: scene > doc > glb > model still holds', () => {
    const sceneBranch = mainSource.indexOf("const urlScene = params.get('scene')");
    const docBranch = mainSource.indexOf('if (!sceneRouted && urlDoc)');
    const glbBranch = mainSource.indexOf('if (!sceneRouted && urlGlb)');
    const modelBranch = mainSource.indexOf("const urlModel = params.get('model')");

    expect(sceneBranch, '?scene= resolution must exist').toBeGreaterThan(-1);
    expect(docBranch, '?doc= branch must exist and be guarded by !sceneRouted').toBeGreaterThan(-1);
    expect(glbBranch, '?glb= branch must exist and be guarded by !sceneRouted').toBeGreaterThan(-1);
    expect(modelBranch, '?model= resolution must exist').toBeGreaterThan(-1);

    // Ordering IS the precedence — and it is the sentence the composer puts into
    // its conflict warning, so the two cannot drift apart silently.
    expect(sceneBranch).toBeLessThan(docBranch);
    expect(docBranch).toBeLessThan(glbBranch);
    expect(glbBranch).toBeLessThan(modelBranch);

    const conflict = composeLink(
      { doc: 'doc_a', scene: 'empty' }, makeState(), makeEnv(),
    ).warnings.join(' ');
    expect(conflict).toContain('scene > doc > glb > model');
  });

  it('the four parameter names the composer emits are the four main.ts reads', () => {
    for (const p of ['scene', 'doc', 'glb', 'model', 'option', 'mode']) {
      expect(mainSource, `main.ts must still read ?${p}=`).toContain(`params.get('${p}')`);
    }
  });

  it('the option fold main.ts performs is still the top-level parameter we emit', () => {
    // `?option=` must stay a TOP-LEVEL key: folded into `scene=builtin:<file>`
    // it would break the boot's filename match (model-option-plugin header).
    expect(mainSource).toContain("const urlOption = params.get('option')");
    expect(mainSource).toMatch(/withOptionParam\(match\.url, label, params\.get\('option'\)\)/);
  });

  it('the mode boot still reads ?mode= and still writes nothing back', () => {
    expect(mainSource).toContain("const urlMode = params.get('mode')");
    expect(mainSource).toContain('viewer.modes.setMode(urlMode)');
  });
});
