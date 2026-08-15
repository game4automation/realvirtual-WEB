// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-project-tools — MCP tools for the PROJECT level, one tier above the
 * asset editor.
 *
 * ## Why this file exists
 *
 * Every project-scoped path an agent uses — `cad/`, `library/`, `knowledge/`,
 * `models/` — is relative to the OPEN project. Until this file, MCP could only
 * ASK which project was open (`web_editor_project_info`, read-only) and never
 * change it. An agent whose browser sat in the wrong project was stuck: the
 * only way across was the `?project=<slug>` deep link, which reloads the page
 * into a NEW tab. That tab immediately takes bridge ownership (WebViewerBridge
 * `_active` is last-writer-wins and force-closes the previous socket), so the
 * reload costs the editor document, the selection and several seconds of boot
 * during which every 15 s call fails. Switching in place costs none of that.
 *
 * ## web_ping and the throttled-tab failure mode
 *
 * A hidden browser tab is throttled by Chrome: `setTimeout`/`requestAnimation-
 * Frame` are clamped to ≥1 s and, once the tab has been hidden a while, to once
 * per MINUTE. Tools that await a rendered frame or an internal `sleep()` then
 * blow through the bridge's 15 s default and surface as
 * `timed out ... outcome=unknown` — which reads like a broken CONNECT even
 * though CONNECT is healthy and `/health` answers instantly.
 *
 * {@link McpProjectTools.webPing} is the discriminator. It is deliberately
 * **free of timers, frames and dynamic imports**: WebSocket `onmessage` and
 * `send` are NOT throttled, so a strictly synchronous tool still answers from a
 * fully throttled tab and reports `hidden: true`. One call separates "tab is in
 * the background" from "browser is gone" from "CONNECT is down" — a distinction
 * that otherwise costs a filesystem inspection to make.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { builtinSources } from '../../core/rv-model-catalog';

/** Normalised match key: case- and separator-insensitive. */
function matchKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, '');
}

export class McpProjectTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  @McpTool(
    'CHEAP LIVENESS + THROTTLE PROBE — the first call to make when other web_* tools time out. '
    + 'Strictly synchronous (no timers, no frame wait, no imports), so it answers even from a '
    + 'browser tab that Chrome has throttled, which is exactly the situation other tools cannot '
    + 'report. Returns visibilityState/hidden/hasFocus plus a `diagnosis` line. A hidden tab '
    + 'clamps setTimeout and requestAnimationFrame to >=1s (up to 60s once heavily throttled), '
    + 'which is what turns a normal call into "timed out, outcome=unknown" while CONNECT itself '
    + 'is perfectly healthy. If this answers with hidden:true, the fix is to bring the viewer tab '
    + 'to the foreground, NOT to restart anything.',
    { readOnly: true },
  )
  async webPing(): Promise<string> {
    // No await on any timer/frame and no dynamic import: this must stay
    // answerable from a throttled tab. See the module header.
    const doc = typeof document === 'undefined' ? null : document;
    const hidden = doc?.hidden === true;
    const visibilityState = doc?.visibilityState ?? 'unknown';
    let hasFocus: boolean | null = null;
    try { hasFocus = doc?.hasFocus() ?? null; } catch { hasFocus = null; }

    const viewer = this.viewer;
    const diagnosis = hidden
      ? 'Tab is HIDDEN — Chrome throttles setTimeout/requestAnimationFrame here. '
        + 'Tools that wait for a rendered frame or an internal delay will time out at the '
        + 'bridge default (15 s) even though the bridge and CONNECT are healthy. '
        + 'Bring the viewer tab to the foreground; do not restart CONNECT or reload the page.'
      : 'Tab is visible — no throttling expected. A timeout now means real work in flight '
        + '(large model/CAD import) or a genuine fault; check web_status and web_errors.';

    return JSON.stringify({
      alive: true,
      hidden,
      visibilityState,
      hasFocus,
      throttleRisk: hidden,
      viewerPresent: !!viewer,
      modelLoaded: !!viewer?.currentModelRoot,
      now: Math.round(performance.now()),
      diagnosis,
    });
  }

  @McpTool(
    'List the PROJECTS available in the configured workspace, plus which one is currently open. '
    + 'Each row: slug (the id web_project_open takes), name, folderName, id, and `current`. '
    + 'Use this to find out where you are and what you can switch to — every project-relative '
    + 'path (cad/, library/, knowledge/, models/) resolves against the OPEN project. Returns an '
    + 'empty list with a hint when no workspace folder has been granted.',
    { readOnly: true, timeoutMs: 60_000 },
  )
  async webProjectList(): Promise<string> {
    const [{ scanStoredWorkspace }, { getProjectStore }] = await Promise.all([
      import('../../core/project/rv-project-workspace'),
      import('../../core/project/project-store'),
    ]);
    const store = getProjectStore();
    const open = store.getProject();
    const backend = store.getBackend();

    // prompt:false — an MCP call has no user gesture to spend on a permission
    // dialog; an ungranted workspace must answer "nothing to list", not hang.
    const discovery = await scanStoredWorkspace({ prompt: false });
    const projects = discovery.projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      folderName: p.folderName,
      id: p.id,
      current: open != null && p.id === open.id,
    }));

    return JSON.stringify({
      current: open
        ? {
            name: open.name,
            id: open.id,
            kind: backend?.kind ?? null,
            writable: backend?.writable === true,
          }
        : null,
      projects,
      warnings: discovery.warnings,
      hint: projects.length === 0
        ? 'No workspace projects found. A workspace folder must be granted once in the UI '
          + '(Projects dashboard); MCP cannot open the folder picker itself.'
        : 'Switch with web_project_open(project=<slug>). This switches IN PLACE — no page '
          + 'reload, so the bridge connection and this MCP session survive it.',
    });
  }

  @McpTool(
    'List what can be loaded into the viewer. `documents` is THE one list — every GLB the open '
    + 'project owns, whichever folder holds it (`section`: scenes/models/library). There is no '
    + 'separate scene catalogue any more; `saved` is a deprecated alias of the same array. '
    + '`builtins` and `published` are read-only SOURCES, not documents: opening one and saving '
    + 'materialises a new document. Pass an id, name or url to web_model_open. Note the '
    + 'difference from web_project_list: a PROJECT decides what project-relative paths resolve '
    + 'against, a MODEL is what is loaded in the viewport.',
    { readOnly: true, timeoutMs: 30_000 },
  )
  async webModelList(): Promise<string> {
    const [{ getSceneStore }, { getProjectStore }, documents] = await Promise.all([
      import('../../core/hmi/scene/scene-store-singleton'),
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-documents'),
    ]);
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    const viewer = this.viewer;
    // plan-716 §2.7 — the ONE list, read where it lives. `listScenes()` was the
    // `scenes/`-section-shaped half of it and is gone (Phase 6); an agent asking
    // "what can I open" must not be shown a third of the answer.
    const rows = documents.documentsOf(getProjectStore().getProject()).map((d) => ({
      id: d.id,
      name: d.name,
      path: d.path,
      section: documents.sectionOfDocument(d),
    }));
    return JSON.stringify({
      currentModel: viewer?.currentModelUrl ?? null,
      documents: rows,
      /** @deprecated plan-716 — same array as `documents`; drop after one release. */
      saved: rows,
      builtins: builtinSources(viewer),
      published: store.listPublished().map((p) => ({ urlName: p.urlName, label: p.label, file: p.file })),
      hint: 'web_model_open(model=<id|name|url>), or model="empty" for an EMPTY viewport — '
        + 'which is what you want before authoring a new asset from a CAD import.',
    });
  }

  @McpTool(
    'LOAD a model/scene into the viewer, or clear it. `model` matches a label or url from '
    + 'web_model_list (case- and separator-insensitively); the special value "empty" opens an '
    + 'EMPTY viewport. '
    + 'Use "empty" BEFORE authoring a new asset: with a model loaded, opening the asset editor '
    + 'with source=empty still leaves that model in the scene, and web_editor_import_cad then '
    + 'attaches the import UNDER the loaded model — the document silently adopts the whole '
    + 'scene (nodeCount jumps from 1 to the scene size) and a save would write the demo scene '
    + 'plus your part. An empty viewport is the only clean starting point.',
    { readOnly: false, timeoutMs: 180_000 },
  )
  async webModelOpen(
    @McpParam('model', 'Document id, name, path, built-in label or url from web_model_list — or "empty" to clear the viewport.', 'string', true)
    model: string,
  ): Promise<string> {
    const wanted = (model ?? '').trim();
    if (!wanted) {
      return JSON.stringify({ error: 'model is required — call web_model_list, or pass "empty".' });
    }
    const { getSceneStore } = await import('../../core/hmi/scene/scene-store-singleton');
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });

    if (matchKey(wanted) === 'empty') {
      // An empty SCENE is not an empty VIEWPORT. `newEmpty()` clears the layout
      // but leaves the previously loaded MODEL in the Three.js scene, and the
      // asset editor then binds its document to that model: importing CAD lands
      // UNDER it and nodeCount jumps from 1 to the whole scene. Measured on the
      // demo model: 1 -> 681, with the import reported as
      // "DemoRealvirtualWebglb/3D-model_A_00808".
      //
      // Loading an empty MODEL is what actually clears it (same measurement:
      // nodeCount 53, rootPath "/3D-model_A_00808"). So prefer a built-in empty
      // GLB and fall back to newEmpty() only when the install has none.
      const emptyBuiltin = builtinSources(this.viewer).find((b) => matchKey(b.label) === 'empty');
      if (emptyBuiltin) {
        await store.openBuiltin(emptyBuiltin.url, emptyBuiltin.label);
        return JSON.stringify({
          opened: true,
          model: 'empty',
          kind: 'builtin',
          url: emptyBuiltin.url,
          currentModel: this.viewer?.currentModelUrl ?? null,
          next: 'Empty viewport. Now web_editor_open(source=empty), then web_editor_import_cad. '
            + 'Check web_editor_status: nodeCount must stay at the imported part count.',
        });
      }
      // newEmpty, not openEmpty: openEmpty RESUMES the autosaved empty draft,
      // which would silently bring a previous session's edits back into a
      // viewport whose whole point here is to be blank.
      await store.newEmpty();
      return JSON.stringify({
        opened: true,
        model: 'empty',
        kind: 'scene',
        currentModel: this.viewer?.currentModelUrl ?? null,
        warning: 'No built-in empty GLB in this install, so only the SCENE was cleared — a '
          + 'previously loaded model may still be in the viewport, and the asset editor would '
          + 'bind its document to it. Verify with web_editor_status that nodeCount is 1 after '
          + 'web_editor_open(source=empty).',
      });
    }

    const key = matchKey(wanted);
    const builtin = builtinSources(this.viewer).find((b) =>
      matchKey(b.label) === key || matchKey(b.url) === key || b.url === wanted);
    if (builtin) {
      await store.openBuiltin(builtin.url, builtin.label);
      return JSON.stringify({
        opened: true, kind: 'builtin', url: builtin.url, label: builtin.label,
        currentModel: this.viewer?.currentModelUrl ?? null,
      });
    }

    // THE one list (plan-716 §2.7): a name, an id or a project-relative path,
    // in ANY section. Listing every document and then refusing to open the ones
    // that are not in `scenes/` would be the split this plan removes.
    const [{ getProjectStore }, documents] = await Promise.all([
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-documents'),
    ]);
    const rows = documents.documentsOf(getProjectStore().getProject());
    const doc = rows.find((d) =>
      d.id === wanted || matchKey(d.name) === key || matchKey(d.path) === key || d.path === wanted);
    if (doc) {
      await store.openDocument(doc.id);
      return JSON.stringify({
        opened: true,
        kind: 'document',
        id: doc.id,
        name: doc.name,
        path: doc.path,
        section: documents.sectionOfDocument(doc),
      });
    }

    const published = store.listPublished().find((p) =>
      matchKey(p.label) === key || matchKey(p.urlName) === key || p.file === wanted);
    if (published) {
      // openPublishedExample takes the catalogue entry: it knows how to resolve
      // `file` under the deploy root and which mode the example wants.
      await store.openPublishedExample(published);
      return JSON.stringify({
        opened: true, kind: 'published', urlName: published.urlName, label: published.label,
      });
    }

    return JSON.stringify({
      error: `No document, built-in or example matches "${wanted}".`,
      availableBuiltins: builtinSources(this.viewer).map((b) => b.label),
      availableDocuments: rows.map((d) => d.name),
      availablePublished: store.listPublished().map((p) => p.label),
      note: 'Pass "empty" for a blank viewport.',
    });
  }

  @McpTool(
    'OPEN a project from the workspace IN PLACE — no page reload, so the MCP bridge connection '
    + 'survives (unlike the ?project= deep link, which reloads into a new tab and drops the '
    + 'editor document). `project` matches a slug, name or folder name from web_project_list, '
    + 'case- and separator-insensitively. Refuses when the current project has unsaved work '
    + 'unless force=true, because the underlying switch would otherwise raise a modal dialog '
    + 'that no agent can answer and the call would hang until it times out.',
    { readOnly: false, timeoutMs: 120_000 },
  )
  async webProjectOpen(
    @McpParam('project', 'Slug, name or folder name of the project to open (see web_project_list).', 'string', true)
    project: string,
    @McpParam('force', 'Discard the unsaved-work guard and switch anyway (default false).', 'boolean', false)
    force: boolean,
  ): Promise<string> {
    const wanted = (project ?? '').trim();
    if (!wanted) {
      return JSON.stringify({ error: 'project is required — call web_project_list for the available slugs.' });
    }

    const [{ scanStoredWorkspace }, { getProjectStore }] = await Promise.all([
      import('../../core/project/rv-project-workspace'),
      import('../../core/project/project-store'),
    ]);
    const store = getProjectStore();
    const discovery = await scanStoredWorkspace({ prompt: false });

    const key = matchKey(wanted);
    const entry = discovery.projects.find((p) =>
      matchKey(p.slug) === key
      || matchKey(p.name) === key
      || matchKey(p.folderName) === key
      || p.id === wanted);

    if (!entry) {
      return JSON.stringify({
        error: `No workspace project matches "${wanted}".`,
        available: discovery.projects.map((p) => p.slug),
        warnings: discovery.warnings,
      });
    }

    const already = store.getProject();
    if (already && already.id === entry.id) {
      const backend = store.getBackend();
      return JSON.stringify({
        opened: true,
        unchanged: true,
        projectName: already.name,
        writable: backend?.writable === true,
        note: 'This project was already open; nothing was switched.',
      });
    }

    // The store's own guard is a MODAL prompt. An agent cannot answer it, and a
    // call blocked on it just burns its timeout — so decide here instead and
    // hand back an actionable error.
    if (!force && store.hasUnpersistedWork()) {
      return JSON.stringify({
        error: 'The open project has unsaved work — refusing to switch.',
        remedy: 'Save it (web_editor_save / scene save), or repeat with force=true to discard.',
        currentProject: already?.name ?? null,
      });
    }

    // skipPermissionRequest mirrors the by-id path used for recent projects:
    // the workspace grant already covers this subfolder, and requesting write
    // access outside a user gesture would silently degrade to read-only.
    const ok = await store.openProjectFolder(entry.dir, {
      skipPermissionRequest: true,
      skipDirtyGuard: true,
    });

    const nowOpen = store.getProject();
    const backend = store.getBackend();
    return JSON.stringify({
      opened: ok,
      projectName: nowOpen?.name ?? null,
      projectKind: backend?.kind ?? null,
      writable: backend?.writable === true,
      forced: force === true,
      next: ok
        ? 'Project switched in place. Project-relative paths (cad/, library/, knowledge/) now '
          + 'resolve against it. Open a document with web_editor_open.'
        : 'Open failed — the folder had no readable project.json, or the grant was lost.',
    });
  }
}
