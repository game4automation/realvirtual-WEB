// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-export-tools — MCP tools for non-GLB document exports (plan-764).
 *
 * `web_export_usd` runs the SAME bound export the document card offers: it
 * reads `actions.exports` of the active document view, so there is no second
 * route into the provider and no second context to keep in sync. The provider
 * itself is commercial (`@rv-private`, registration `usd-export`); a public
 * build has none and answers `usd-export-unavailable`.
 *
 * The result goes into the OPEN project (`exports/<name>.usdz|.rv.usda`)
 * through the one project write path (`backend.writeDocument`), never back to
 * the agent as bytes.
 *
 * `mode: "animated"` (plan-2229 Phase 3) is the shortcut "record N seconds
 * deterministically, then export": it dispatches ONE command,
 * `usd.export.animated` with `mode: "record-and-export"`, through the generic
 * command wrapper (`web_execute`). That command's `timeoutMs` is above 120 s, so
 * the wrapper answers with a `jobId` at once and the job owns recording AND
 * export — `web_macro_cancel` aborts both, the export starts only after the
 * recording finished (Re-Gate #5).
 *
 * `web_import_usd_extras` / `_commit` (plan-764 Phase 2) are the card's
 * "Apply USD extras…" as two calls — the SAME bound `apply.preview` /
 * `apply.commit` of the active view: the preview changes nothing and hands out
 * the token, only the commit replaces the document (plan-527 sequence).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { resolveActiveDocumentView, type ActiveDocumentFileExport } from '../../core/editor/active-document-view';
import type { ApplyPreview } from '../../core/export/rv-export-provider';
/** Command the `mode: "animated"` shortcut dispatches (record-and-export as one job). */
export const USD_ANIMATED_EXPORT_COMMAND = 'usd.export.animated';

/** Error code when no USD export provider is registered (public build, kill-switch). */
export const USD_EXPORT_UNAVAILABLE = 'usd-export-unavailable';

/** Project folder the export tools write into. */
export const EXPORTS_FOLDER = 'exports';

/** A file name an agent may pass, reduced to a safe stem (extension stripped). */
export function exportFileStem(name: string): string {
  return name.trim()
    .replace(/\.(usdz|rv\.usda|usda|usd)$/i, '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export class McpExportTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  @McpTool(
    'Export the open document as OpenUSD with every realvirtual extra 1:1 as customData.realvirtual in an own sublayer. '
    + 'mode standalone = .usdz (root + rv layer + geometry); overlay = bare .rv.usda on the prim paths of the USD the document came from; '
    + 'animated = record `seconds` of simulation deterministically at `fps` and export an animated .usdz (runs as a job: poll web_macro_status). '
    + 'Writes exports/<name> into the open project; returns path, size, prim counts, referencesWithoutGeometry.',
    { readOnly: false, timeoutMs: 120_000 },
  )
  async webExportUsd(
    @McpParam('mode', 'standalone (default) | overlay | animated.', 'string', false) mode?: string,
    @McpParam('name', 'File name without extension (default: document name).', 'string', false) name?: string,
    @McpParam('fps', 'animated: 24 | 30 (default) | 60.', 'number', false) fps?: number,
    @McpParam('seconds', 'animated: simulation seconds to record (1-600, required).', 'number', false) seconds?: number,
  ): Promise<string> {
    const modeId = (mode ?? 'standalone').trim().toLowerCase() || 'standalone';
    if (modeId === 'animated') return this.exportAnimated(name, fps, seconds);
    const view = resolveActiveDocumentView(this.getViewer()?.modes?.activeMode ?? null);
    if (!view) return JSON.stringify({ error: 'No document is open.' });
    const exp = view.actions.exports?.find((e) => e.id === 'usd');
    if (!exp) {
      return JSON.stringify({
        error: USD_EXPORT_UNAVAILABLE,
        message: 'No USD export provider is registered (public build, or disabled with localStorage rv.export.usd = off), '
          + 'or the open document offers no exports in this mode.',
      });
    }
    let modes;
    try {
      modes = exp.modes();
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
    const selectedMode = modes.find((m) => m.id === modeId);
    if (!selectedMode) {
      return JSON.stringify({
        error: `Mode "${modeId}" is not available for this document.`,
        availableModes: modes.map((m) => m.id),
      });
    }
    if (selectedMode.disabledReason) {
      return JSON.stringify({ error: selectedMode.disabledReason });
    }

    let result;
    try {
      result = await exp.run(modeId);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      return JSON.stringify({
        error: e instanceof Error ? e.message : String(e),
        ...(typeof code === 'string' ? { code } : {}),
      });
    }

    const stem = name ? exportFileStem(name) : '';
    const extension = result.fileName.endsWith('.rv.usda') ? '.rv.usda' : result.fileName.slice(result.fileName.lastIndexOf('.'));
    const fileName = stem ? `${stem}${extension}` : result.fileName;
    const summary = { mode: modeId, sizeBytes: result.bytes.byteLength, mime: result.mime, ...result.stats };

    const { getProjectStore } = await import('../../core/project/project-store');
    const backend = getProjectStore().getBackend();
    if (!backend?.writable) {
      return JSON.stringify({
        error: 'The open project is not writable — nothing was saved. Use the document card (Export USD…) to download the file.',
        fileName,
        ...summary,
      });
    }
    const relPath = `${EXPORTS_FOLDER}/${fileName}`;
    try {
      await backend.writeDocument(relPath, result.bytes, { expectedRevision: 'any' });
    } catch (e) {
      return JSON.stringify({
        error: `Could not write "${relPath}": ${e instanceof Error ? e.message : String(e)}`,
        ...summary,
      });
    }
    return JSON.stringify({ path: relPath, fileName, ...summary });
  }

  /**
   * `mode: "animated"` — one `usd.export.animated` command through the generic
   * wrapper (never a direct registry dispatch): its `timeoutMs` makes it a job
   * that owns recording and export.
   */
  private async exportAnimated(name: string | undefined, fps: number | undefined, seconds: number | undefined): Promise<string> {
    if (seconds == null) return JSON.stringify({ error: 'seconds is required for mode "animated" (simulation seconds, 1-600).' });
    const args = {
      mode: 'record-and-export',
      target: 'project',
      durationSec: seconds,
      ...(fps != null ? { fps } : {}),
      ...(name ? { name } : {}),
    };
    // Lazy: core `document-commands` imports this file eagerly; the descriptors ride with the bridge.
    const [{ McpCommandTools }, { ensureUsdRecordCommandsRegistered }] = await Promise.all([
      import('./rv-mcp-command-tools'),
      import('../../core/hmi/commands/usd-record-commands'),
    ]);
    ensureUsdRecordCommandsRegistered();
    return new McpCommandTools(this.getViewer).webExecute(USD_ANIMATED_EXPORT_COMMAND, JSON.stringify(args));
  }

  /** The bound USD apply of the active view, or the JSON refusal to answer with. */
  usdApply(): { apply: NonNullable<ActiveDocumentFileExport['apply']> } | { error: string } {
    const view = resolveActiveDocumentView(this.getViewer()?.modes?.activeMode ?? null);
    if (!view) return { error: JSON.stringify({ error: 'No document is open.' }) };
    const exp = view.actions.exports?.find((e) => e.id === 'usd');
    if (!exp?.apply) {
      return {
        error: JSON.stringify({
          error: USD_EXPORT_UNAVAILABLE,
          message: 'No USD apply is registered (public build, or disabled with localStorage rv.export.usd = off), '
            + 'or the open document offers none in this mode.',
        }),
      };
    }
    return { apply: exp.apply };
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryImportUsdExtras(
    path: string,
  ): Promise<string> {
    const bound = this.usdApply();
    if ('error' in bound) return bound.error;
    const relPath = String(path ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relPath) return JSON.stringify({ error: 'path is required (project-relative).' });
    const { getProjectStore } = await import('../../core/project/project-store');
    const backend = getProjectStore().getBackend();
    if (!backend) return JSON.stringify({ error: 'No project is open.' });
    let bytes: Uint8Array;
    try {
      const rec = await backend.readDocument(relPath);
      if (!rec) return JSON.stringify({ error: `"${relPath}" is not in the open project.` });
      bytes = rec.bytes;
    } catch (e) {
      return JSON.stringify({ error: `Could not read "${relPath}": ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      const preview = await bound.apply.preview({ name: relPath.split('/').pop() ?? relPath, bytes });
      return JSON.stringify({ path: relPath, ...capPreview(preview) });
    } catch (e) {
      return JSON.stringify(errorPayload(e));
    }
  }

  /** Operation body shared by the registry command (plan-2007). */
  async commitUsdExtras(
    previewToken: string,
    acceptExtrasLoss?: boolean,
    confirmExtrasLost?: boolean,
  ): Promise<string> {
    const bound = this.usdApply();
    if ('error' in bound) return bound.error;
    try {
      const result = await bound.apply.commit(String(previewToken ?? '').trim(), {
        ...(acceptExtrasLoss === true ? { acceptExtrasLoss: true } : {}),
        ...(confirmExtrasLost === true ? { confirmExtrasLost: true } : {}),
      });
      return JSON.stringify(result);
    } catch (e) {
      return JSON.stringify(errorPayload(e));
    }
  }
}

/** How many entries of a preview list the MCP answer carries (the counts are always complete). */
export const MCP_PREVIEW_LIST_LIMIT = 50;

/** A preview for the agent: lists capped, their full lengths reported. */
function capPreview(preview: ApplyPreview): Record<string, unknown> {
  const cap = (items: string[]) => items.slice(0, MCP_PREVIEW_LIST_LIMIT);
  return {
    ...preview,
    unmatchedPrims: cap(preview.unmatchedPrims),
    ambiguous: cap(preview.ambiguous),
    extrasLost: cap(preview.extrasLost),
    counts: {
      unmatchedPrims: preview.unmatchedPrims.length,
      ambiguous: preview.ambiguous.length,
      extrasLost: preview.extrasLost.length,
    },
  };
}

/** An error as the agent needs it: message plus the guard's code, file, layer and prim. */
function errorPayload(e: unknown): Record<string, unknown> {
  const err = e as { message?: unknown; code?: unknown; file?: unknown; layer?: unknown; primPath?: unknown } | null;
  const out: Record<string, unknown> = { error: e instanceof Error ? e.message : String(e) };
  for (const key of ['code', 'file', 'layer', 'primPath'] as const) {
    if (typeof err?.[key] === 'string') out[key] = err[key];
  }
  return out;
}
