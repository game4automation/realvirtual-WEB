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
import { arrayBufferOf } from '../../core/project/rv-scene-record';
import type { DocumentRefField } from '../../core/project/rv-project-refs';
import { builtinSources } from '../../core/rv-model-catalog';
import { sceneReadyFields } from './rv-mcp-scene-ready';
import {
  publishedUrlNameOf,
  resolvePublishedAlias,
  resolvePublishedSceneParam,
} from '../../core/hmi/scene/rv-published-scenes';

/**
 * The folder field every document row of these tools reports.
 *
 * `folder` is the first path segment — `''` at the project root — read off the
 * path and nowhere else (plan-736 F7).
 *
 * The `section` alias that travelled beside it for one release is GONE
 * (plan-744 F9). It was already carrying the identical value, so nothing an
 * agent could read changes; what goes is the suggestion that the two are
 * different questions. Before it was removed, `rg` found no consumer outside
 * this repo — not in CONNECT's C#, not in `unity_mcp_server.py`.
 */
export function folderFields(path: unknown): { folder: string } {
  const p = typeof path === 'string' ? path : '';
  return { folder: p.includes('/') ? p.slice(0, p.indexOf('/')) : '' };
}

/**
 * What `web_document_bind` accepts for `field` (plan-479 Phase 6).
 *
 * The manifest names are the truth and are listed first; the short aliases
 * exist because an agent reading the UI sees CONNECT, PLUGIN and KNOWLEDGE on
 * the card and would otherwise have to guess that the third one is spelled
 * `scriptRef`. A wrong spelling is answered with the full list rather than
 * silently mapped to a default — binding the wrong field is worse than failing.
 */
const REF_FIELD_ALIASES: Readonly<Record<string, DocumentRefField>> = {
  connectref: 'connectRef', connect: 'connectRef',
  scriptref: 'scriptRef', script: 'scriptRef', plugin: 'scriptRef',
  knowledgeref: 'knowledgeRef', knowledge: 'knowledgeRef',
};

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
    'List the LINKED PROJECTS of this browser, plus which one is currently open. '
    + 'Each row: slug (the id web_project_open takes), name, folderName, id, and `current`. '
    + 'Use this to find out where you are and what you can switch to — every project-relative '
    + 'path (cad/, library/, knowledge/, models/) resolves against the OPEN project. Returns an '
    + 'empty list with a hint when no project folder has been linked yet.',
    { readOnly: true, timeoutMs: 60_000 },
  )
  async webProjectList(): Promise<string> {
    const [{ listLinkedProjects }, { getProjectStore }] = await Promise.all([
      import('../../core/project/rv-project-linked'),
      import('../../core/project/project-store'),
    ]);
    const store = getProjectStore();
    const open = store.getProject();
    const backend = store.getBackend();

    // A listing, so no permission is spent: an MCP call has no user gesture to
    // pay a browser dialog with. A row whose grant has lapsed is still listed —
    // web_project_open is where that shows up, with an actionable message.
    const linked = await listLinkedProjects();
    const projects = linked.map((p) => ({
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
      warnings: [],
      hint: projects.length === 0
        ? 'No linked projects. A project folder must be added once in the UI (Projects '
          + 'dashboard → Add); MCP cannot open the folder picker itself.'
        : 'Switch with web_project_open(project=<slug>). This switches IN PLACE — no page '
          + 'reload, so the bridge connection and this MCP session survive it.',
    });
  }

  @McpTool(
    'List the DOCUMENTS of the open project — THE one list. Asset, model and scene are one '
    + 'thing: a GLB document. Each row: id, name, path, folder, sizeBytes, modified. `folder` '
    + 'is the first path segment (`""` at the root) — a place, not a type. '
    + '`builtins` are read-only SOURCES; saving one '
    + 'materialises a new document. `published` lists the DEV-ONLY documents (`devOnly: true` '
    + 'in the manifest) — repo fixtures no delivered channel ships, and ordinary `documents` '
    + 'rows. filter: case-insensitive substring of name/path; withNodeCount adds nodeCount by '
    + 'reading each GLB header (slower). Pass id/name/path to web_document_open, path to '
    + 'web_document_update or web_editor_open(source=library).',
    { readOnly: true, timeoutMs: 60_000 },
  )
  async webDocumentList(
    @McpParam('filter', 'Case-insensitive substring of name or path', 'string', false)
    filter?: string,
    @McpParam('withNodeCount', 'Read each GLB header to report nodeCount (slower; default false)', 'boolean', false)
    withNodeCount?: boolean,
  ): Promise<string> {
    const [{ getSceneStore }, { getProjectStore }, documents, listing] = await Promise.all([
      import('../../core/hmi/scene/scene-store-singleton'),
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-documents'),
      import('./rv-mcp-asset-listing'),
    ]);
    const store = getSceneStore();
    if (!store) return JSON.stringify({ error: 'Scene store not available' });
    const viewer = this.viewer;
    const projectStore = getProjectStore();
    const backend = projectStore.getBackend();

    // plan-716 §2.7 — the ONE list, read where it lives. `listScenes()` was the
    // `scenes/`-section-shaped half of it and is gone (Phase 6); an agent asking
    // "what can I open" must not be shown a third of the answer.
    //
    // Since the web_library_assets merge, identity and bytes come from two
    // sources that are merged here: the manifest rows carry identity, and
    // `statDocuments()` carries what is on disk — including a GLB dropped into
    // the folder by hand before anything adopted it. That second half used to
    // be a third call, `listLibrary()`, which saw only `library/**` and is gone
    // with the method (plan-744 F1); `statDocuments()` already walks the whole
    // tree, so the unadopted rows below come from it instead and now include
    // the ones outside `library/`.
    interface DocumentRow {
      id: string | null; name: string; path: string;
      /** First path segment, '' at the project root. */
      folder: string;
      sizeBytes: number | null; modified: string | null; nodeCount?: number;
    }
    const byPath = new Map<string, DocumentRow>();
    const allRows = documents.documentsOf(projectStore.getProject());
    const stats = typeof backend?.statDocuments === 'function'
      ? await backend.statDocuments().catch(() => []) : [];
    const statByPath = new Map(stats.map((s) => [s.path, s]));
    for (const d of allRows) {
      const stat = statByPath.get(d.path);
      byPath.set(d.path, {
        id: d.id,
        name: d.name,
        path: d.path,
        ...folderFields(d.path),
        sizeBytes: d.sizeBytes ?? stat?.size ?? null,
        modified: d.modifiedAt ?? (stat?.mtime ? new Date(stat.mtime).toISOString() : null),
      });
    }
    // Files on disk the manifest does not (yet) list. Asset endings only — a
    // `*.knowledge.md` is a file, not a document, and `web_editor_project_files`
    // is where it belongs.
    for (const stat of stats) {
      if (byPath.has(stat.path)) continue;
      if (!/\.(glb|gltf|splat|ksplat|ply)$/i.test(stat.path)) continue;
      byPath.set(stat.path, {
        id: null,
        name: listing.glbStem(stat.path),
        path: stat.path,
        ...folderFields(stat.path),
        sizeBytes: stat.size ?? null,
        modified: stat.mtime ? new Date(stat.mtime).toISOString() : null,
      });
    }

    const rows = [...byPath.values()]
      .filter((r) => listing.matchesAssetFilter({ name: r.name, relPath: r.path }, filter))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (withNodeCount === true && backend) {
      const { readGlbJson, glbNodeCensus } = await import('../../core/import/rv-glb-inspect');
      for (const row of rows) {
        try {
          const bytes = (await backend.readDocument(row.path))?.bytes ?? null;
          // Header-only: `readGlbJson` -> `parseGlbChunks`, which locates the BIN
          // chunk and never decodes it. The full `parseGlbSubtree*` path is
          // forbidden here (plan-713 F2).
          if (bytes) row.nodeCount = glbNodeCensus(readGlbJson(arrayBufferOf(bytes))).nodeCount;
        } catch { /* an unreadable file simply reports no count */ }
      }
    }

    const { QUERY_RESULT_CAP } = await import('./rv-mcp-observe-tools');
    const capped = listing.capRows(rows, QUERY_RESULT_CAP, 'Narrow with the filter parameter.');
    return JSON.stringify({
      currentDocument: viewer?.currentModelUrl ?? null,
      projectOpen: projectStore.getProject() !== null,
      writable: backend?.writable === true,
      count: rows.length,
      documents: capped.rows,
      ...(capped.note ? { truncated: capped.note } : {}),
      builtins: builtinSources(viewer),
      // The MCP contract is an OUTER BOUNDARY: the field name stays, its source
      // moved (plan-731 2f). It used to carry the `scenes/index.json` catalogue
      // — the second identity space — and now carries the dev-only document
      // rows, which is what an external caller was actually looking at through
      // it on our own deploy. Two differently-named fields for the same thing
      // (`published` here, `availablePublished` below) is itself a symptom of
      // that space; unifying them is a customer-visible contract cut and has its
      // own plan.
      published: allRows.filter((d) => d.devOnly === true).map((d) => ({
        urlName: publishedUrlNameOf(d), label: d.name, file: d.path,
      })),
      hint: 'web_document_open(document=<id|name|path>), or document="empty" for an EMPTY '
        + 'viewport — which is what you want before authoring a new asset from a CAD import.',
    });
  }

  @McpTool(
    'LOAD a document into the viewer, or clear it. `document` matches an id, name, path, '
    + 'built-in label or url from web_document_list; the special value "empty" opens an '
    + 'EMPTY viewport. '
    + 'Open "empty" BEFORE authoring a new asset: with a document still loaded, opening the '
    + 'asset editor with source=new leaves it in the scene and web_editor_import_cad attaches '
    + 'the import UNDER it — the new document silently adopts the whole scene, and a save '
    + 'would write the demo scene plus your part. '
    + 'Refused while the asset editor is open: the editor keeps its document (and its save '
    + 'path) bound to the previous file — call web_editor_close first. '
    + '`placements.pending` > 0: references still loading.',
    { readOnly: false, timeoutMs: 180_000 },
  )
  async webDocumentOpen(
    @McpParam('document', 'Document id, name, path, built-in label or url from web_document_list, matched case- and separator-insensitively — or "empty" to clear the viewport (nodeCount then reports 1 instead of the whole scene).', 'string', true)
    document: string,
  ): Promise<string> {
    const wanted = (document ?? '').trim();
    if (!wanted) {
      return JSON.stringify({ error: 'document is required — call web_document_list, or pass "empty".' });
    }
    // The scene store swaps the scene WITHOUT telling the asset editor: the
    // editor's `AssetDocument.base` (and with it the save path reported by
    // web_editor_status) would keep naming the previous file, and a later
    // web_editor_save would write the NEW tree under the OLD document's path
    // (devtodo 2026-08-24). Refusing in words beats a swap that half-works.
    if (this.viewer?.modes?.activeMode === 'editor') {
      return JSON.stringify({
        error: 'The asset editor is open — refusing to swap the document under it.',
        reason: 'The editor keeps its document bound to the file it was opened on; the scene '
          + 'would show the new document while web_editor_save still wrote to the old path.',
        remedy: 'Close the editor first (web_editor_close), then repeat this call — or open '
          + 'the target for editing with web_editor_open.',
      });
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
          next: 'Empty viewport. Now web_editor_open(source=new), then web_editor_import_cad. '
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
          + 'web_editor_open(source=new).',
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
        ...(await sceneReadyFields(this.viewer)),
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
        ...folderFields(doc.path),
        ...(await sceneReadyFields(this.viewer)),
      });
    }

    // A LEGACY `published:<urlName>` address, or a bare example name, still
    // resolves — through the alias, onto a row of the SAME list the lookup above
    // walked (plan-731 2f). It is a second ADDRESS FORM, no longer a second
    // catalogue with a second open verb: what it finds is a document, and
    // `openDocument` opens it.
    const aliased = resolvePublishedSceneParam(wanted, rows)
      ?? resolvePublishedAlias(wanted, rows);
    if (aliased) {
      await store.openDocument(aliased.id);
      return JSON.stringify({
        opened: true,
        kind: 'document',
        id: aliased.id,
        name: aliased.name,
        path: aliased.path,
        ...folderFields(aliased.path),
        ...(await sceneReadyFields(this.viewer)),
        note: 'Resolved through the legacy published:<name> alias — prefer the document id.',
      });
    }

    return JSON.stringify({
      error: `No document or built-in matches "${wanted}".`,
      availableBuiltins: builtinSources(this.viewer).map((b) => b.label),
      availableDocuments: rows.map((d) => d.name),
      // Same boundary rule as `published` in web_document_list: the field name
      // stays, the source is the dev-only documents.
      availablePublished: rows.filter((d) => d.devOnly === true).map((d) => d.name),
      note: 'Pass "empty" for a blank viewport.',
    });
  }

  @McpTool(
    'OPEN a linked project IN PLACE — no page reload, so the MCP bridge connection '
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

    const [{ listLinkedProjects }, { getProjectStore }, { getFolderHandle, projectHandleKey }] =
      await Promise.all([
        import('../../core/project/rv-project-linked'),
        import('../../core/project/project-store'),
        import('../../core/engine/rv-local-filesystem'),
      ]);
    const store = getProjectStore();
    const linked = await listLinkedProjects();

    const key = matchKey(wanted);
    const entry = linked.find((p) =>
      matchKey(p.slug) === key
      || matchKey(p.name) === key
      || matchKey(p.folderName) === key
      || p.id === wanted);

    if (!entry) {
      return JSON.stringify({
        error: `No linked project matches "${wanted}".`,
        available: linked.map((p) => p.slug || p.name),
        warnings: [],
      });
    }

    const already = store.getProject();
    if (already && already.id === entry.id) {
      // Re-opening the OPEN project is the one MCP verb an agent has to pick up
      // out-of-band changes (files added or deleted on disk) without a page
      // reload — before this rescan, the in-memory registry simply never
      // refreshed and web_document_list kept listing deleted documents forever
      // (devtodo 2026-08-24). Rows whose file is gone leave via the adopt
      // quarantine rather than instantly; that is the store's own rule.
      await store.rescanDocuments?.();
      const backend = store.getBackend();
      return JSON.stringify({
        opened: true,
        unchanged: true,
        documentsRescanned: true,
        projectName: already.name,
        writable: backend?.writable === true,
        note: 'This project was already open; nothing was switched. The document registry was '
          + 're-scanned from disk — new files are listed now, rows for deleted files clear '
          + 'after the adopt quarantine.',
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

    // The folder handle is resolved HERE and without a prompt: an MCP call has
    // no user gesture, so a lapsed grant must become an actionable message
    // rather than a dialog nobody can answer.
    const dir = await getFolderHandle(projectHandleKey(entry.id), { prompt: false });
    if (!dir) {
      return JSON.stringify({
        error: `The folder grant for "${entry.name}" has lapsed — cannot open it from MCP.`,
        remedy: 'Open the project once in the Projects dashboard to renew the grant, then retry.',
      });
    }

    // skipPermissionRequest because the grant was just verified above, and
    // requesting write access outside a user gesture would silently degrade the
    // project to read-only.
    const ok = await store.openProjectFolder(dir, {
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
      ...(ok ? await sceneReadyFields(this.viewer) : {}),
      next: ok
        ? 'Project switched in place. Project-relative paths (cad/, library/, knowledge/) now '
          + 'resolve against it. Open a document with web_editor_open.'
        : 'Open failed — the folder had no readable project.json, or the grant was lost.',
    });
  }

  @McpTool(
    'Show the open project as a TREE — folders, documents and attachment files, nested, exactly '
    + 'as the Projects dashboard shows them. Each node: name, kind (folder/document/file/system), '
    + 'path (project-relative — what web_document_open / web_document_update / web_project_folder '
    + 'take), documentId for a GLB with a manifest row, and writable. Reserved machinery '
    + '(settings/connect/rag/thumbnails/.trash) is grouped under one read-only "System" node. '
    + 'Pass dir to start at a subfolder, maxDepth to limit nesting (childrenOmitted says what '
    + 'was cut). The flat alternative with sizes is web_document_list; files-with-glob is '
    + 'web_editor_project_files.',
    { readOnly: true, timeoutMs: 60_000 },
  )
  async webProjectTree(
    @McpParam('dir', 'Project-relative folder to start at (default: the project root).', 'string', false)
    dir?: string,
    @McpParam('maxDepth', 'Maximum nesting depth to render (default 6).', 'integer', false)
    maxDepth?: number,
  ): Promise<string> {
    const [{ getProjectStore }, tree] = await Promise.all([
      import('../../core/project/project-store'),
      import('./rv-mcp-project-tree'),
    ]);
    const loaded = await tree.loadProjectTree(getProjectStore());
    if ('error' in loaded) return JSON.stringify(loaded);

    const start = tree.nodeAtRelPath(loaded, dir ?? '');
    if (!start) {
      return JSON.stringify({
        error: `No folder at "${dir}" — pass a project-relative folder path from this tree.`,
      });
    }
    const depth = Number.isFinite(maxDepth) && (maxDepth as number) > 0 ? (maxDepth as number) : 6;
    return JSON.stringify({
      projectName: loaded.root.name,
      writable: loaded.writable,
      tree: tree.serializeTreeNode(start, depth),
      hint: 'Folders: web_project_folder(action=create|rename|move). Documents: '
        + 'web_document_new(name, folder) to create here, web_document_update to '
        + 'rename/move/delete, web_document_open to load.',
    });
  }

  @McpTool(
    'Create, rename or move a FOLDER of the open project — the same verdicts and the same write '
    + 'path as the dashboard tree, so a folder move repoints every contained manifest row and '
    + 'breaks no reference (document ids never change). action=create: path names the new folder '
    + '(parents may exist or not; an empty folder is a declared manifest entry). action=rename: '
    + 'path + newName. action=move: path + toFolder (destination folder, "" = project root). '
    + 'Reserved system folders and catalog rows are refused; documents are managed by '
    + 'web_document_update instead.',
    { readOnly: false, timeoutMs: 120_000 },
  )
  async webProjectFolder(
    @McpParam('action', 'create | rename | move') action: string,
    @McpParam('path', 'Project-relative folder path (from web_project_tree).') path: string,
    @McpParam('newName', 'New folder name (rename only).', 'string', false) newName?: string,
    @McpParam('toFolder', 'Destination folder, "" for the project root (move only).', 'string', false) toFolder?: string,
  ): Promise<string> {
    const verb = (action ?? '').trim().toLowerCase();
    if (verb !== 'create' && verb !== 'rename' && verb !== 'move') {
      return JSON.stringify({ error: `Unknown action "${action}". Use create, rename or move.` });
    }
    const [{ getProjectStore }, treeMod, rules] = await Promise.all([
      import('../../core/project/project-store'),
      import('./rv-mcp-project-tree'),
      import('../../core/project/rv-project-tree'),
    ]);
    const loaded = await treeMod.loadProjectTree(getProjectStore());
    if ('error' in loaded) return JSON.stringify(loaded);

    if (verb === 'create') {
      const made = await treeMod.declareFolder(loaded, path);
      if ('error' in made) return JSON.stringify(made);
      return JSON.stringify({
        created: true, path: made.path,
        next: `web_document_new(name, folder="${made.path}") creates a document here; `
          + 'web_project_tree shows the result.',
      });
    }

    const node = treeMod.nodeAtRelPath(loaded, path);
    if (!node || node.kind !== 'folder') {
      return JSON.stringify({
        error: `No folder at "${treeMod.normaliseRelPath(path)}" — see web_project_tree. `
          + '(For documents use web_document_update.)',
      });
    }

    let verdict;
    if (verb === 'rename') {
      const name = (newName ?? '').trim();
      if (!name) return JSON.stringify({ error: 'action=rename needs newName.' });
      verdict = rules.canRenameInTree(loaded.roots, node.path!, name);
    } else {
      if (toFolder === undefined) {
        return JSON.stringify({ error: 'action=move needs toFolder ("" = project root).' });
      }
      const destRel = treeMod.normaliseRelPath(toFolder);
      const dest = treeMod.nodeAtRelPath(loaded, destRel);
      if (!dest || (dest.kind !== 'folder' && dest.kind !== 'root')) {
        return JSON.stringify({ error: `No destination folder at "${destRel}" — see web_project_tree.` });
      }
      verdict = rules.canMoveInTree(loaded.roots, node.path!, dest.path!);
    }
    if (!verdict.ok) {
      return JSON.stringify({ error: treeMod.refusalSentence(verdict.reason, node.relPath) });
    }

    const outcome = await treeMod.performTreeEdit(loaded, node, verdict);
    return JSON.stringify({
      [verb === 'rename' ? 'renamed' : 'moved']: true,
      from: verdict.from,
      to: verdict.to,
      filesMoved: outcome.moved.length,
      manifestRowsRepointed: outcome.manifestRows,
      docsIndexRowsRepointed: outcome.docsIndexRows,
      refsRepointed: outcome.refRows,
      note: 'Document ids are unchanged — references keep resolving.',
    });
  }

  @McpTool(
    'BIND or UNBIND one reference field of a document — the project.json edit the dashboard\'s '
    + 'reference slots make. field=connectRef takes a *.connect.json, field=scriptRef a PLUGIN '
    + '(.ts/.tsx under plugins/, loaded with the document), field=knowledgeRef a *.md. ref="" '
    + 'clears it. document is a project-relative path, id or name (web_document_list). Touches '
    + 'no file and deletes nothing: writes the field, reads it back, reports the stored state. '
    + 'Refused for a read-only project, a bundled document, a ref leaving the project or a path '
    + 'the field\'s rule rejects. Renaming or deleting the FILES is web_document_update.',
    { readOnly: false, timeoutMs: 60_000 },
  )
  async webDocumentBind(
    @McpParam('document', 'Project-relative path, document id or name of the document to bind (from web_document_list).')
    document: string,
    @McpParam('field', 'connectRef | scriptRef | knowledgeRef (aliases: connect | plugin | knowledge)')
    field: string,
    @McpParam('ref', 'Project-relative path of the file to bind. Empty string (or omitted) clears the binding.', 'string', false)
    ref?: string,
  ): Promise<string> {
    const [{ getProjectStore }, refs, docs, listing] = await Promise.all([
      import('../../core/project/project-store'),
      import('../../core/project/rv-project-refs'),
      import('../../core/project/rv-project-documents'),
      import('./rv-mcp-asset-listing'),
    ]);

    // The check order of `webDocumentUpdate` (§2.2), and for the same reason:
    // each step is only answerable once the one before it held, so any other
    // order produces a message about the wrong problem.
    const store = getProjectStore();
    const backend = store.getBackend();
    if (!backend) {
      return JSON.stringify({ error: 'No project is open — open one with web_project_open.' });
    }
    if (!backend.writable) {
      return JSON.stringify({ error: 'This project is read-only — its bindings cannot be changed.' });
    }

    const resolvedField = REF_FIELD_ALIASES[(field ?? '').trim().toLowerCase()];
    if (!resolvedField) {
      return JSON.stringify({
        error: `Unknown field "${field}". Use ${refs.DOCUMENT_REF_FIELDS.join(', ')} `
          + '(aliases: connect, plugin, knowledge).',
      });
    }

    const wanted = (document ?? '').trim();
    const rows = docs.documentsOf(store.getProject());
    const row = rows.find(d => d.id === wanted)
      ?? rows.find(d => listing.samePath(d.path, wanted))
      ?? rows.find(d => (d.name ?? '') === wanted)
      ?? rows.find(d => matchKey(d.name ?? '') === matchKey(wanted));
    if (!row) {
      return JSON.stringify({
        error: `No document "${document}" in this project — see web_document_list.`,
      });
    }

    const value = (ref ?? '').trim();
    if (value !== '') {
      // The rule per field, stated as a REASON rather than as a bare refusal: a
      // caller told only "no" reaches for project.json again, which is the
      // habit this tool exists to end.
      const rule = {
        connectRef: {
          ok: refs.isConnectConfigPath,
          why: `a CONNECT configuration ends in "${refs.CONNECT_CONFIG_SUFFIX}"`,
        },
        scriptRef: {
          ok: refs.isProjectScriptPath,
          why: `a plugin is a ${refs.PROJECT_SCRIPT_SUFFIXES.join('/')} file under `
            + `"${refs.PROJECT_SCRIPT_FOLDER}/"`,
        },
        knowledgeRef: {
          ok: refs.isKnowledgeFilePath,
          why: `a knowledge file ends in "${refs.KNOWLEDGE_FILE_SUFFIX}" or `
            + `"${refs.MARKDOWN_FILE_SUFFIX}"`,
        },
      }[resolvedField];
      if (!rule.ok(value)) {
        return JSON.stringify({
          error: `"${value}" cannot be bound as ${resolvedField}: ${rule.why}.`,
        });
      }
      // Containment is enforced again inside the store, but a throw there would
      // reach the bridge as a stack trace instead of as an answer — so it is
      // asked here, where the refusal can be a sentence.
      if (!refs.isContainedRef(value)) {
        return JSON.stringify({
          error: `"${value}" leaves the project — a reference must be a project-relative path `
            + 'with no "..", no leading "/" and no URL scheme.',
        });
      }
    }

    const write = resolvedField === 'connectRef' ? store.setDocumentConnectRef
      : resolvedField === 'scriptRef' ? store.setDocumentScriptRef
        : store.setDocumentKnowledgeRef;
    try {
      await write.call(store, row.id, value === '' ? null : value);
    } catch (e) {
      // A bundled (read-only) document and a lost manifest both land here. The
      // store's own sentence is the good one; wrapping it would only bury it.
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }

    // Read the state BACK rather than echo the intent (the McpKnowledgeTools
    // rule): a write that was normalised, refused downstream or landed on a
    // different row must not be reported as the write that was asked for.
    const after = store.getSnapshot().documents.find(d => d.id === row.id) ?? null;
    const stored = after ? refs.readDocumentRef(after, resolvedField) : null;
    const fileInProject = stored === null ? null : await this.refExists(resolvedField, stored);
    return JSON.stringify({
      bound: stored !== null,
      document: row.name ?? row.path ?? row.id,
      documentId: row.id,
      field: resolvedField,
      ref: stored,
      fileInProject,
      note: stored === null
        ? 'The binding is cleared.'
        : fileInProject === false
          ? 'Written — but no file at that path is in the project yet, so the document reports a '
            + 'missing reference until one is.'
          : 'Written and read back from the manifest.',
    });
  }

  /**
   * Does the bound file actually exist in the project?
   *
   * `null` when the backend cannot say — a listing a backend does not implement
   * is an UNKNOWN, and reporting an unknown as "missing" would make the tool
   * warn about perfectly correct bindings in the bundled and browser backends.
   */
  private async refExists(
    field: DocumentRefField,
    ref: string,
  ): Promise<boolean | null> {
    const { getProjectStore } = await import('../../core/project/project-store');
    const backend = getProjectStore().getBackend();
    if (!backend) return null;
    const list = field === 'connectRef' ? backend.listConnectConfigs
      : field === 'scriptRef' ? backend.listProjectScripts
        : backend.listKnowledgeFiles;
    if (!list) return null;
    try {
      return (await list.call(backend)).includes(ref);
    } catch {
      return null;
    }
  }
}
