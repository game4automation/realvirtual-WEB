// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-document-info-tools — `web_document_info_get` / `web_document_info_set`
 * (plan-506 F9).
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * `rv-mcp-instances.ts`, the one list of delegates).
 *
 * ## Document-scoped, not node-scoped
 *
 * `web_knowledge_set` writes through the node overlay of the OPEN model, which
 * is right for a note on a node. A description belongs to a DOCUMENT of the
 * project, open or not — an agent asked to "describe every model in this
 * folder" must not have to open each one. So these tools resolve a document
 * the way `web_document_update` does (id or project-relative path) and write
 * through `ProjectStore.setDocumentInfo`: the GLB's JSON chunk first
 * (compare-and-swap), then the manifest cache — the same path the dashboard
 * editor uses, never a second one.
 *
 * ## The answer is state, not intent
 *
 * `set` answers with the block READ BACK from the store after the write, and
 * `persistedTo: 'glb'` only because the write that just resolved put it there
 * (the discipline of `rv-mcp-knowledge-tools`). When the same document is open
 * in the asset editor it says so (`openInEditor: true`): a later editor Save
 * writes the block the editor LOADED, which would undo this write — a known,
 * documented gap of this plan (the editor-session lock is a follow-up), so the
 * agent is warned rather than refused.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import {
  MAX_DESCRIPTION_CHARS,
  MAX_SUMMARY_CHARS,
  parseDocumentInfo,
  type DocumentInfo,
} from '../../core/project/rv-document-info';

function err(message: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({ error: message, ...extra });
}

/** Path spellings an agent hands over: backslashes, a leading `./` or `/`. */
function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
}

interface DocumentRowLike {
  id: string;
  path: string;
  name: string;
  tier?: string;
  documentInfo?: DocumentInfo;
}

export class McpDocumentInfoTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  /**
   * Resolve `document` (id or path) — or, when omitted, the document the viewer
   * shows — to a row of the open project. A string is the error answer.
   */
  private async _resolve(document: string | undefined): Promise<
    { row: DocumentRowLike; projectId: string } | { noProject: true } | string
  > {
    const [{ getProjectStore }, { getOpenDocumentBase }] = await Promise.all([
      import('../../core/project/project-store'),
      import('../../core/editor/active-asset-store'),
    ]);
    const snapshot = getProjectStore().getSnapshot();
    if (!snapshot.project) return { noProject: true };
    const rows = snapshot.documents as readonly DocumentRowLike[];

    const wanted = (document ?? '').trim();
    if (!wanted) {
      const base = getOpenDocumentBase() as { documentId?: unknown; path?: unknown } | null;
      const id = typeof base?.documentId === 'string' ? base.documentId : '';
      const path = typeof base?.path === 'string' ? base.path : '';
      const row = (id ? rows.find(r => r.id === id) : undefined)
        ?? (path ? rows.find(r => normalisePath(r.path) === normalisePath(path)) : undefined);
      if (!row) {
        return err('No document is open — pass document (id or project-relative path).', {
          hint: 'Use web_document_list for ids and paths.',
        });
      }
      return { row, projectId: snapshot.project.id };
    }
    const byId = rows.find(r => r.id === wanted);
    const byPath = byId ? undefined : rows.find(r => normalisePath(r.path) === normalisePath(wanted));
    const row = byId ?? byPath;
    if (!row) {
      return err(`No document "${wanted}" in the open project.`, {
        hint: 'Pass a documentId or a project-relative path from web_document_list.',
      });
    }
    return { row, projectId: snapshot.project.id };
  }

  @McpTool(
    'Read the DESCRIPTION of a document (summary + Markdown, stored in its GLB). document: id or '
    + 'project-relative path; omit for the open document. info null = no description (normal for '
    + 'Unity exports). source: "manifest" (project cache) or "glb" (loaded file, no project open).',
    { readOnly: true },
  )
  async webDocumentInfoGet(
    @McpParam('document', 'Document id or project-relative path; omit for the open document.', 'string', false)
    document?: string,
  ): Promise<string> {
    const resolved = await this._resolve(document);
    if (typeof resolved === 'string') return resolved;
    if ('noProject' in resolved) {
      if ((document ?? '').trim()) {
        return err('No project is open — only the loaded model can be read. Omit document.');
      }
      const root = this.viewer?.currentModelRoot;
      if (!root) return err('Nothing is loaded.');
      const rv = (root.userData as Record<string, unknown> | undefined)?.['realvirtual'];
      return JSON.stringify({ document: null, path: null, info: parseDocumentInfo(rv), source: 'glb' });
    }
    const { row } = resolved;
    return JSON.stringify({
      document: row.id, path: row.path, name: row.name,
      info: row.documentInfo ?? null, source: 'manifest',
    });
  }

  @McpTool(
    'Write the DESCRIPTION of any document of the open project into its GLB. Omitted field = kept, '
    + '"" = removed. summary: one line; description: Markdown. Say what the model IS, not session '
    + 'state. Read-only documents are refused. Returns the block read back; openInEditor:true '
    + 'warns that an editor Save of that document would restore its loaded text.',
    { readOnly: false },
  )
  async webDocumentInfoSet(
    @McpParam('document', 'Document id or project-relative path.') document: string,
    @McpParam('summary', `One line, max ${MAX_SUMMARY_CHARS} chars.`, 'string', false) summary?: string,
    @McpParam('description', `Markdown, max ${MAX_DESCRIPTION_CHARS} chars.`, 'string', false) description?: string,
  ): Promise<string> {
    if (summary === undefined && description === undefined) {
      return err('Pass summary and/or description — nothing to write.');
    }
    if (summary !== undefined && typeof summary !== 'string') return err('summary must be a string');
    if (description !== undefined && typeof description !== 'string') return err('description must be a string');
    if (summary !== undefined && summary.trim().length > MAX_SUMMARY_CHARS) {
      return err(`summary is ${summary.trim().length} characters, over the ${MAX_SUMMARY_CHARS} limit — nothing was written.`);
    }
    if (description !== undefined && description.trim().length > MAX_DESCRIPTION_CHARS) {
      return err(`description is ${description.trim().length} characters, over the ${MAX_DESCRIPTION_CHARS} limit — nothing was written.`);
    }
    if (!(document ?? '').trim()) return err('document is required (id or project-relative path).');

    const resolved = await this._resolve(document);
    if (typeof resolved === 'string') return resolved;
    if ('noProject' in resolved) return err('No project is open — open one with web_project_open.');
    const { row, projectId } = resolved;

    const [{ getProjectStore }, { getActiveAssetContext }] = await Promise.all([
      import('../../core/project/project-store'),
      import('../../core/editor/active-asset-store'),
    ]);
    const store = getProjectStore();
    if (row.tier === 'bundled' || !store.isWritable()) {
      return err(`"${row.name}" is read-only — its description cannot be changed.`, {
        hint: 'Duplicate it into a writable project first.',
      });
    }

    const current = row.documentInfo;
    const next: DocumentInfo = {
      v: 1,
      summary: summary !== undefined ? summary : current?.summary,
      description: description !== undefined ? description : current?.description,
    };
    try {
      await store.setDocumentInfo(row.id, next, { expectProjectId: projectId });
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e), { document: row.id, path: row.path });
    }

    // State, not intent: what the store holds NOW for this row.
    const after = store.getSnapshot().documents.find(d => d.id === row.id);
    const base = getActiveAssetContext()?.doc.getSnapshot().base as { kind?: string; documentId?: string } | undefined;
    const openInEditor = base?.kind === 'document' && base.documentId === row.id;
    return JSON.stringify({
      document: row.id,
      path: row.path,
      info: after?.documentInfo ?? null,
      persistedTo: 'glb',
      ...(openInEditor ? {
        openInEditor: true,
        warning: 'This document is open in the asset editor; saving it there writes the description it loaded.',
      } : {}),
    });
  }
}
