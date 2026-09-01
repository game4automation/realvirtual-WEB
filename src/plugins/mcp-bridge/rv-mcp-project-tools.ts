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
import {
  publishedUrlNameOf,
  resolvePublishedAlias,
  resolvePublishedSceneParam,
} from '../../core/hmi/scene/rv-published-scenes';

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
    'List the DOCUMENTS of the open project — THE one list. Asset, model and scene are the same '
    + 'thing: a GLB document; the folder (`section`: scenes/models/library) is a storage place, '
    + 'not a type. Each row: id, name, path, section, sizeBytes, modified. `builtins` are '
    + 'read-only SOURCES, not documents: opening one and saving materialises a new document. '
    + '`published` lists the DEV-ONLY documents (`devOnly: true` in the manifest) — repo '
    + 'fixtures that no delivered channel ships; they are ordinary rows of `documents` too. '
    + 'filter matches name or path (case-insensitive substring); withNodeCount '
    + 'reads each GLB header to add nodeCount (slower). Pass an id, name or path to '
    + 'web_document_open, or its path to web_document_update / web_editor_open(source=library). '
    + 'Note the difference from web_project_list: a PROJECT decides what project-relative paths '
    + 'resolve against, a DOCUMENT is what is loaded in the viewport.',
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
    // "what can I open" must not be shown a third of the answer. Since the
    // web_library_assets merge, size/mtime and the unadopted library files come
    // from the SAME call: the manifest rows carry identity, `statDocuments()`
    // carries bytes on disk, and `listLibrary()` sees a GLB dropped into the
    // folder by hand before anything adopts it. Neither alone is the whole list.
    interface DocumentRow {
      id: string | null; name: string; path: string; section: string | null;
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
        section: documents.sectionOfDocument(d),
        sizeBytes: d.sizeBytes ?? stat?.size ?? null,
        modified: d.modifiedAt ?? (stat?.mtime ? new Date(stat.mtime).toISOString() : null),
      });
    }
    const libEntries = typeof backend?.listLibrary === 'function'
      ? await backend.listLibrary().catch(() => []) : [];
    for (const e of libEntries) {
      if (byPath.has(e.path)) continue;
      const stat = statByPath.get(e.path);
      const file = e.path.split('/').pop() ?? e.path;
      byPath.set(e.path, {
        id: e.id ?? null,
        name: e.label || file.replace(/\.glb$/i, ''),
        path: e.path,
        section: 'library',
        sizeBytes: e.sizeBytes ?? stat?.size ?? null,
        modified: stat?.mtime ? new Date(stat.mtime).toISOString() : null,
      });
    }

    const rows = [...byPath.values()]
      .filter((r) => listing.matchesAssetFilter({ name: r.name, relPath: r.path }, filter))
      .sort((a, b) => a.path.localeCompare(b.path));

    if (withNodeCount === true && backend) {
      const { readGlbJson, glbNodeCensus } = await import('../../core/import/rv-glb-inspect');
      for (const row of rows) {
        try {
          const bytes = await backend.readBlobBytes(row.path);
          // Header-only: `readGlbJson` -> `parseGlbChunks`, which locates the BIN
          // chunk and never decodes it. The full `parseGlbSubtree*` path is
          // forbidden here (plan-713 F2).
          if (bytes) row.nodeCount = glbNodeCensus(readGlbJson(bytes)).nodeCount;
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
    + 'path) bound to the previous file — call web_editor_close first.',
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
        section: documents.sectionOfDocument(aliased),
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
}
