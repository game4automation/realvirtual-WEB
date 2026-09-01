// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-link-tools — `web_link_compose`, the deep-link composer (plan-437).
 *
 * MCP could open anything and hand out a link to nothing. Every other tool acts
 * on the viewer in place; none of them could answer "give me a URL that shows
 * somebody else what I am looking at". The knowledge required to write one by
 * hand is spread across ~400 lines of boot routing in `main.ts` — which
 * parameter wins, which one is an alias, which one is folded into the model URL
 * — and is not exported from anywhere.
 *
 * This tool closes that gap with two operating modes in one call:
 *
 *  1. **Snapshot** (no identity parameter) — reproduce what is open right now:
 *     the current `SceneBase` becomes `doc=` / `scene=` / `model=`, the active
 *     model URL yields `option=`, and the mode comes LIVE from
 *     {@link LinkEnv.activeMode}.
 *  2. **Compose** — validate the given parameters against the live catalogues
 *     and assemble a canonical URL.
 *
 * ## Three properties this file exists to guarantee
 *
 *  1. **It MIRRORS main.ts, it does not re-implement it.** The boot router is a
 *     side-effect-heavy block with no extracted precedence function and no
 *     behavioural tests; refactoring it for this feature would be the single
 *     largest risk here for zero functional gain. The mirror is held in step by
 *     a `?raw` source guard in `tests/rv-mcp-link-tools.test.ts` — the same
 *     established device `tests/rv-share-boot.test.ts` uses.
 *  2. **The parameter set is an ALLOWLIST, never a copy.** No code path in this
 *     file reads `window.location.search`. That is not tidiness: `?devkey=` and
 *     `?sharetoken=` are credentials, and a composed link is by definition
 *     something that gets mailed, bookmarked, logged and pasted into an LLM
 *     context. A blocklist would leak the NEXT token parameter somebody adds;
 *     an allowlist cannot.
 *  3. **`mode` is read live, never from the URL.** `ModeManager` writes no
 *     history entry (grep-verified: zero `history.*` calls in
 *     `rv-mode-manager.ts`), so the address bar keeps whatever mode the page was
 *     BOOTED with. Reading `?mode=` back out would silently produce links to the
 *     wrong workspace after any mode switch.
 *
 * It mints nothing. A `?glb=s:<id>` value is form-validated and passed through
 * ({@link parseGlbParam}), but no share is ever created — that backend belongs
 * to plan-386 and is deliberately out of scope.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { parseGlbParam } from '../../core/share/rv-share-target';
import { builtinSources } from '../../core/rv-model-catalog';
import { modelSupportsOption, optionIdFromUrl } from '../models/model-option-plugin';
import { getConnectEmbedSnapshot } from '../connect-embed/connect-embed-store';
import {
  PUBLISHED_ID_PREFIX,
  parsePublishedToken,
  resolvePublishedAlias,
} from '../../core/hmi/scene/rv-published-scenes';

// ─── Types ──────────────────────────────────────────────────────────────

/** Input. Every field is optional; no identity field at all = snapshot mode. */
export interface LinkComposeInput {
  /** Catalogue label, document name/id or model URL. */
  model?: string;
  /** Absolute GLB URL, or the opaque `s:<id>` share form (passed through, never minted). */
  glb?: string;
  /** Document id of the open project. */
  doc?: string;
  /** `empty` | `builtin:<file>` | `published:<name>` | a saved scene id. */
  scene?: string;
  /** A registered workspace mode (hmi / planner / des / …). */
  mode?: string;
  /** Model variant id, validated against the model's declared options. */
  option?: string;
  /** Base URL override; defaults to `location.origin + location.pathname`. */
  base?: string;
}

export interface LinkComposeResult {
  /** The canonical URL. */
  url: string;
  /** Exactly the parameters that were set, in canonical order. */
  params: Record<string, string>;
  /** Everything reconstructible that the caller should know. Never an error channel. */
  warnings: string[];
}

/**
 * The canonical parameter order (F5).
 *
 * Fixed so that identical input yields a byte-identical URL — bookmarks dedupe,
 * and the test can assert a whole string instead of parsing one back.
 *
 * Note the order is the DOCUMENTED one from plan-437 §2.3 and is *not* itself an
 * assertion about precedence: main.ts resolves `scene > doc > glb > model`, which
 * is what {@link PRECEDENCE_NOTE} tells the caller when several identity
 * parameters are set at once.
 */
export const LINK_PARAM_ORDER = ['doc', 'scene', 'glb', 'model', 'option', 'mode'] as const;

export type LinkParamKey = typeof LINK_PARAM_ORDER[number];

/** The identity parameters — the ones whose presence disables snapshot mode. */
export const IDENTITY_PARAMS = ['doc', 'scene', 'glb', 'model'] as const;

export type IdentityParamKey = typeof IDENTITY_PARAMS[number];

/** Mirrors the boot order in `main.ts`; pinned by the source guard test. */
export const PRECEDENCE_NOTE = 'scene > doc > glb > model';

/** A `SceneBase`, structurally — kept local so a mock needs no store import. */
export type LinkSceneBase =
  | { kind: 'empty' }
  | { kind: 'builtin'; url: string; label: string }
  //! `sceneId` is a DOCUMENT id — the name is the pre-716 one and the field is
  //! read as such by `applySnapshotIdentity`, which mints `?doc=` from it.
  | { kind: 'scene-glb'; sceneId: string; label: string };

/** The live catalogues a composed link is validated against. */
export interface LinkState {
  documents: { id: string; name: string; path: string }[];
  builtins: { url: string; label: string }[];
  /** The open workspace's base — the snapshot's identity source. */
  base: LinkSceneBase | null;
  /** Document id of the open workspace, when it is a project document. */
  documentId: string | null;
  /** Unsaved work in the open document (F7). */
  dirty: boolean;
}

/** Live viewer facts. Deliberately NOT sourced from `location.search`. */
export interface LinkEnv {
  /** `location.origin + location.pathname` — the default base (F6). */
  defaultBase: string;
  /** The ACTIVE mode, straight from ModeManager. Never parsed out of a URL. */
  activeMode: string | null;
  /** Is this mode id registered in this deployment? */
  hasMode: (id: string) => boolean;
  /** The loaded model URL — carries the folded `?option=`. */
  currentModelUrl: string | null;
  /** True in a CONNECT-embed deployment, which ignores URL model/mode boot. */
  connectEmbed: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function clean(v: string | undefined | null): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

/** Case- and separator-insensitive match key — the same rule the open tools use. */
function matchKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Filename of a model URL, without query, fragment or `.glb`. */
export function baseLabelOfUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const file = url.split('#')[0].split('?')[0].split('/').pop();
  if (!file) return null;
  return file.replace(/\.glb$/i, '');
}

/**
 * Drop a folded `?option=` from a model URL.
 *
 * `option` is a TOP-LEVEL parameter in a composed link, and main.ts folds it
 * into the model URL on boot. Emitting both spellings would put the same fact in
 * the link twice and let them disagree after a hand edit.
 */
export function stripOptionParam(url: string): string {
  const qi = url.indexOf('?');
  if (qi < 0) return url;
  const hashAt = url.indexOf('#', qi);
  const head = url.slice(0, qi);
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const query = url.slice(qi + 1, hashAt >= 0 ? hashAt : undefined);
  const params = new URLSearchParams(query);
  params.delete('option');
  const rest = params.toString();
  return rest ? `${head}?${rest}${hash}` : `${head}${hash}`;
}

function findBuiltin(state: LinkState, wanted: string) {
  const key = matchKey(wanted);
  return state.builtins.find((b) =>
    b.url === wanted
    || matchKey(b.label) === key
    || matchKey(b.url) === key
    || matchKey(baseLabelOfUrl(b.url) ?? '') === key
    || b.url.endsWith(`/${wanted}`));
}

function findDocument(state: LinkState, wanted: string) {
  const key = matchKey(wanted);
  return state.documents.find((d) =>
    d.id === wanted || d.path === wanted || matchKey(d.name) === key || matchKey(d.path) === key);
}

function looksAbsolute(value: string): boolean {
  return /^https?:\/\//i.test(value) || value.startsWith('/');
}

// ─── The composer (pure) ────────────────────────────────────────────────

/**
 * Compose the canonical link. Pure: everything live arrives in `state`/`env`,
 * which is what makes the security property testable rather than merely claimed.
 */
export function composeLink(
  input: LinkComposeInput,
  state: LinkState,
  env: LinkEnv,
): LinkComposeResult {
  const warnings: string[] = [];
  const values: Partial<Record<LinkParamKey, string>> = {};

  const inDoc = clean(input.doc);
  const inScene = clean(input.scene);
  const inGlb = clean(input.glb);
  const inModel = clean(input.model);
  const inOption = clean(input.option);
  const inMode = clean(input.mode);
  const base = clean(input.base) ?? env.defaultBase;

  const givenIdentity = [inDoc, inScene, inGlb, inModel].filter((v) => v !== null);
  const snapshotMode = givenIdentity.length === 0;

  // ── Identity ──────────────────────────────────────────────────────────
  if (snapshotMode) {
    applySnapshotIdentity(values, state, env, warnings);
  } else {
    if (givenIdentity.length > 1) {
      const named: Record<IdentityParamKey, string | null> = {
        doc: inDoc, scene: inScene, glb: inGlb, model: inModel,
      };
      warnings.push(
        `Several identity parameters were given (${
          IDENTITY_PARAMS.filter((k) => named[k] !== null).join(', ')
        }). All are set, but the viewer resolves only the first that matches — boot precedence is `
        + `${PRECEDENCE_NOTE}.`,
      );
    }

    if (inDoc) {
      if (!findDocument(state, inDoc)) {
        warnings.push(
          `doc "${inDoc}" is not a document of the open project — the recipient will get a `
          + '"document not found" notice unless it exists in THEIR project.',
        );
      }
      values.doc = inDoc;
    }

    if (inScene) {
      validateScene(inScene, state, warnings);
      values.scene = inScene;
    }

    if (inGlb) {
      try {
        parseGlbParam(inGlb);
      } catch (e) {
        warnings.push(
          `glb "${inGlb}" is not a well-formed share target (${
            e instanceof Error ? e.message : String(e)
          }). Expected an absolute http(s) URL or the opaque "s:<id>" form.`,
        );
      }
      values.glb = inGlb;
    }

    if (inModel) {
      const known = findBuiltin(state, inModel) || findDocument(state, inModel);
      if (!known && !looksAbsolute(inModel)) {
        warnings.push(
          `model "${inModel}" matches no built-in, document or absolute URL in this deployment — `
          + 'check web_document_list.',
        );
      }
      values.model = inModel;
    }
  }

  // ── option ────────────────────────────────────────────────────────────
  // The label the option is validated against is whatever model this link will
  // actually open — the composed one when given, the loaded one in snapshot mode.
  const optionBaseLabel = baseLabelOfUrl(values.model ?? null)
    ?? builtinLabelOfSceneValue(values.scene ?? null, state)
    ?? baseLabelOfUrl(env.currentModelUrl);

  if (inOption) {
    if (!modelSupportsOption(optionBaseLabel, inOption)) {
      warnings.push(
        `option "${inOption}" is not declared by model "${optionBaseLabel ?? '(unknown)'}" — it is `
        + 'set in the link, but the viewer will ignore it on boot.',
      );
    }
    values.option = inOption;
  }

  // ── mode (ALWAYS live, never from the address bar) ────────────────────
  if (inMode) {
    if (!env.hasMode(inMode)) {
      warnings.push(
        `mode "${inMode}" is not a registered workspace in this deployment — the recipient's `
        + 'viewer will boot its default mode instead.',
      );
    }
    values.mode = inMode;
  } else if (env.activeMode) {
    // F4, applied to the mode too: the boot falls back to the RECIPIENT's
    // localStorage when `?mode=` is absent, so an implicit mode makes the link
    // mean different things to different people.
    values.mode = env.activeMode;
  }

  // ── Deployment caveats ────────────────────────────────────────────────
  if (env.connectEmbed) {
    warnings.push(
      'CONNECT embed deployments boot deliberately model-empty and ignore URL model/scene/mode '
      + 'parameters — this link reproduces the state only on a standard realvirtual WEB deployment.',
    );
  }

  // ── Build (allowlist only — location.search is never read) ────────────
  const params = new URLSearchParams();
  for (const key of LINK_PARAM_ORDER) {
    const value = values[key];
    // URLSearchParams owns ALL encoding. Never concatenate, never
    // encodeURIComponent: mixing the two is what turns a `?glb=` URL that has
    // its own query string into a broken link.
    if (value !== undefined) params.set(key, value);
  }
  const query = params.toString();

  return {
    url: query ? `${base}?${query}` : base,
    params: Object.fromEntries(params) as Record<string, string>,
    warnings,
  };
}

/** The built-in label a `scene=builtin:<file>` value points at, for option validation. */
function builtinLabelOfSceneValue(scene: string | null, state: LinkState): string | null {
  if (!scene || !scene.startsWith('builtin:')) return null;
  const wanted = decodeURIComponent(scene.slice('builtin:'.length));
  const hit = findBuiltin(state, wanted);
  return baseLabelOfUrl(hit?.url ?? wanted);
}

function validateScene(scene: string, state: LinkState, warnings: string[]): void {
  if (scene === 'empty') return;

  if (scene.startsWith('builtin:')) {
    const wanted = decodeURIComponent(scene.slice('builtin:'.length));
    if (!findBuiltin(state, wanted)) {
      warnings.push(
        `scene "builtin:${wanted}" matches no built-in model in this deployment — the viewer will `
        + 'fall through to its default model.',
      );
    }
    return;
  }

  if (scene.startsWith(PUBLISHED_ID_PREFIX)) {
    // A LEGACY address (plan-731 Phase 2). `published:<urlName>` was the second
    // document identity space; it survives only as an alias onto a manifest row,
    // so what decides here is `documents[]` and no longer a second catalogue.
    // Composing one is not possible any more — `applySnapshotIdentity` mints
    // `?doc=` — but validating one still is, because a human can hand this tool
    // an old link and deserves the same verdict the boot would reach.
    const wanted = parsePublishedToken(scene) ?? '';
    if (!resolvePublishedAlias(wanted, state.documents)) {
      warnings.push(
        `scene "published:${wanted}" matches no document of the open project — the viewer will `
        + 'fall through to its default model. `published:` is a legacy address; '
        + 'prefer ?doc=<documentId>.',
      );
    }
    return;
  }

  // A bare value is a document/scene id (a legacy pre-migration id is
  // alias-resolved by the boot, so an unknown one is a warning, not an error).
  if (!findDocument(state, scene)) {
    warnings.push(
      `scene "${scene}" matches no document of the open project. Legacy pre-migration scene ids `
      + 'still resolve through the alias map; anything else falls through to the default model.',
    );
  }
}

/**
 * Turn the open workspace into the identity half of a link.
 *
 * Mirrors what the boot would have to find to reproduce it — a document by id, a
 * built-in by filename, an empty scene, or (last resort) the raw model URL.
 *
 * It no longer mints `?scene=published:<name>` (plan-731 2c). That branch was
 * the WRITE half of the second identity space: it produced links in an address
 * form this build has stopped resolving natively, and it did so for exactly the
 * content that is now an ordinary document — so `state.documentId` answers for
 * it, one branch earlier and with the stronger id. The READ half keeps resolving
 * old `published:` links forever (`validateScene`, and the boot's alias branch);
 * only the minting stopped, which is the same asymmetry plan-720 established for
 * `scene-glb`.
 */
function applySnapshotIdentity(
  values: Partial<Record<LinkParamKey, string>>,
  state: LinkState,
  env: LinkEnv,
  warnings: string[],
): void {
  if (state.dirty) {
    warnings.push(
      'The open document has unsaved changes; they are not part of this link. Save first '
      + '(web_editor_save / scene save) if the recipient should see them.',
    );
  }

  // A document id is the strongest identity there is: it survives renames and is
  // exactly what `?doc=` takes (plan-716 §2.5).
  if (state.documentId) {
    values.doc = state.documentId;
  } else if (state.base?.kind === 'empty') {
    values.scene = 'empty';
  } else if (state.base?.kind === 'scene-glb') {
    // A scene-glb base IS a document — its `sceneId` is a document id, which is
    // what `?doc=` takes (plan-720 F4). Minting `?scene=` here was the last
    // place this generator still spelled a document the pre-716 way; the READ
    // side keeps resolving `?scene=<doc>` forever (rv-doc-alias), only the
    // minting moved. But only when it really resolves: an id with no document
    // behind it would produce a link that silently boots the recipient into the
    // deployment default, and a warning the sender can see beats that.
    if (findDocument(state, state.base.sceneId)) {
      values.doc = state.base.sceneId;
    } else {
      warnings.push(
        `The open scene's id "${state.base.sceneId}" matches no document of this project, so this `
        + 'link carries no identity — the recipient will get the deployment default. Save the '
        + 'scene into the project first, or pass doc/model explicitly.',
      );
    }
  } else if (state.base?.kind === 'builtin') {
    const file = state.base.url.split('#')[0].split('?')[0].split('/').pop();
    const known = findBuiltin(state, state.base.url);
    if (known && file) values.scene = `builtin:${file}`;
    else values.model = stripOptionParam(state.base.url);
  } else if (env.currentModelUrl) {
    values.model = stripOptionParam(env.currentModelUrl);
  } else {
    warnings.push(
      'Nothing is open, so this link carries no model — the recipient will get the deployment '
      + 'default. Open something first, or pass model/doc/scene explicitly.',
    );
  }

  // The variant travels with the model, and it is the ONE snapshot value that
  // does live in a URL — the loaded model url, not the page url.
  const option = optionIdFromUrl(env.currentModelUrl);
  if (option) values.option = option;
}

// ─── Live-state readers ─────────────────────────────────────────────────

/** Read the live catalogues. Never throws — a partial link beats no link. */
export async function readLinkState(viewer: RVViewer | undefined): Promise<LinkState> {
  const state: LinkState = {
    documents: [],
    builtins: builtinSources(viewer),
    base: null,
    documentId: null,
    dirty: false,
  };

  try {
    const [{ getSceneStore }, { getProjectStore }, documents] = await Promise.all([
      import('../../core/hmi/scene/scene-store-singleton'),
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-documents'),
    ]);

    state.documents = documents.documentsOf(getProjectStore().getProject())
      .map((d) => ({ id: d.id, name: d.name, path: d.path }));

    const store = getSceneStore();
    if (store) {
      const snap = store.getSnapshot();
      if (snap.builtins.length > 0) state.builtins = snap.builtins.map((b) => ({ url: b.url, label: b.label }));
      state.base = (snap.draft?.base ?? null) as LinkSceneBase | null;
      state.dirty = snap.dirty === true;
      const identity = store.documentIdentity();
      state.documentId = identity && identity.kind === 'document' ? identity.documentId : null;
    }
  } catch {
    // Storage layers are optional in an embed or a half-booted page.
  }

  return state;
}

/** Live viewer facts. `mode` comes from the ModeManager — see the module header. */
export function readLinkEnv(viewer: RVViewer | undefined): LinkEnv {
  let connectEmbed = false;
  try { connectEmbed = getConnectEmbedSnapshot().enabled === true; } catch { connectEmbed = false; }
  return {
    defaultBase: typeof location !== 'undefined'
      ? location.origin + location.pathname
      : '/',
    activeMode: viewer?.modes?.activeMode ?? null,
    hasMode: (id: string) => viewer?.modes?.has(id) === true,
    currentModelUrl: viewer?.currentModelUrl ?? null,
    connectEmbed,
  };
}

// ─── Tool ───────────────────────────────────────────────────────────────

export class McpLinkTools {
  constructor(
    private readonly getViewer: () => RVViewer | undefined,
    /** Injected in tests; production always reads the real stores. */
    private readonly readState: (v: RVViewer | undefined) => Promise<LinkState> = readLinkState,
    private readonly readEnv: (v: RVViewer | undefined) => LinkEnv = readLinkEnv,
  ) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  @McpTool(
    'Compose a canonical, shareable deep link into the viewer — the one thing MCP could not do: '
    + 'open anything, then hand out a URL to it. Called with NO arguments it snapshots what is '
    + 'open right now (document or model, active workspace mode, model option) into a link that '
    + 'reproduces it. Called with model/glb/doc/scene/mode/option it validates each against the '
    + 'live catalogues and composes the URL. Returns {url, params, warnings}: an unknown value is '
    + 'a warning and still gets set, never a hard error. Read-only, mints no share, and copies '
    + 'nothing from the current address bar — access keys and share tokens can never leak into a '
    + 'composed link.',
    { readOnly: true, timeoutMs: 30_000 },
  )
  async webLinkCompose(
    @McpParam('model', 'Model URL, built-in label or document name from web_document_list (the ?model= URL param).', 'string', false)
    model: string,
    @McpParam('glb', 'Absolute GLB URL, or an existing "s:<id>" share value. Never minted here.', 'string', false)
    glb: string,
    @McpParam('doc', 'Document id of the open project (see web_document_list).', 'string', false)
    doc: string,
    @McpParam('scene', 'empty | builtin:<file.glb> | published:<name> | a saved scene id.', 'string', false)
    scene: string,
    @McpParam('mode', 'Workspace mode to boot into: hmi, planner, des, … Defaults to the ACTIVE mode.', 'string', false)
    mode: string,
    @McpParam('option', 'Model variant id, validated against the model\'s declared options.', 'string', false)
    option: string,
    @McpParam('base', 'Base URL override. Defaults to this page\'s origin + path.', 'string', false)
    base: string,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });

    try {
      const state = await this.readState(v);
      const env = this.readEnv(v);
      return JSON.stringify(composeLink({ model, glb, doc, scene, mode, option, base }, state, env));
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }
}
