// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-export-provider — the generic document EXPORT seam (plan-764 §2.3).
 *
 * The mirror image of `ImportProviderRegistry` (`core/import/rv-import-provider.ts`):
 * a format that is not GLB registers a provider here, and the document card
 * and the MCP bridge offer it — without the public core knowing the format.
 * The USD provider (commercial, `@rv-private`) is the first user; a public
 * build without the private sibling has an empty registry, no menu entries and
 * an MCP answer `usd-export-unavailable`.
 *
 * GLB export is NOT a provider and stays where it is (`ActiveDocumentActions.exportGlb`):
 * its embed/flat choice, its estimate and its test ids predate this seam and
 * do not change.
 *
 * A provider works on the AUTHORED document bytes (`documentGlb()` = the
 * non-embedding scene export, `SceneStore.exportSceneGlb({ embedReferences: false })`),
 * never on the live tree: the live tree is the baked render template and lacks
 * up to half of the authored nodes (plan-764 spike S5).
 */

import type { ReplaceResult } from '../../plugins/mcp-bridge/rv-document-replace';

// ─── Contract ────────────────────────────────────────────────────────────

/**
 * Result of the plan-527 replace sequence (`rv-document-replace.ts`), passed
 * through unchanged — `ok`, `reason` on a refusal, `reloaded` /
 * `reloadSkipped: 'document-switched'` (LOP #180) on a success.
 */
export type { ReplaceResult };

/** What a provider may know about — and do to — the open document. */
export interface DocumentExportContext {
  /** Stable identity of the open project ('' when none is open). */
  projectId: string;
  /** Stable identity of the open document ('' for an unsaved draft). */
  documentId: string;
  /** Display name, also the stem of suggested file names. */
  documentName: string;
  /** Revision of the document's FILE as this session last saw it, or null when unknown. */
  documentRevision(): string | null;
  /** The authored document bytes (non-embedding export). Export source and apply target. */
  documentGlb(): Promise<Uint8Array>;
  /** Cheap JSON-only source for preflight. Never bakes or invokes an exporter.
   * Throws when current edits cannot be represented without serialising the authored tree. */
  documentJson?(): Promise<Record<string, unknown>>;
  /** True when the document carries `rvUsdPrimPath` stamps from a USD import (overlay export). */
  hasUsdPrimPaths(): boolean;
  /**
   * Replace the document's FILE with `bytes` through the plan-527 replace
   * sequence (replace lock, draft / dirty check, `expectedRevision`, full parse,
   * camera-keeping reload, restore on failure) and pass its result through.
   * `target` pins the identity the caller checked (the apply's preview token);
   * without it the context's current `projectId` / `documentId` are used.
   * Optional in the type because not every writer can replace (a stub context,
   * the asset editor); an apply without it refuses instead of guessing.
   */
  replaceDocument?(
    bytes: Uint8Array,
    expectedRevision: string,
    target?: { projectId: string; documentId: string },
  ): Promise<ReplaceResult>;
}

/** One way a provider can export, e.g. "Standalone (.usdz)". */
export interface DocumentExportMode {
  id: string;
  label: string;
  /** Visible explanation of the file's contents and limitations. */
  description?: string;
  /** When set, this mode cannot run; UI and MCP show this same reason. */
  disabledReason?: string;
  /** Suggested download / project file name, extension included. */
  fileName: string;
  /** MIME type of the produced bytes. */
  mime: string;
}

/** What one export run produced. */
export interface DocumentExportResult {
  bytes: Uint8Array;
  fileName: string;
  mime: string;
  /**
   * Counters the caller reports. Known keys the card renders:
   * `referencesWithoutGeometry` (placements written as empty prims),
   * `colorsApproximated` (colours the target format can only approximate).
   */
  stats: Record<string, number>;
}

/** Cheap counters available before a user starts the actual export. */
export interface DocumentExportPreflight {
  referencesWithoutGeometry: number;
}

/** Preview of a re-import (plan-764 Phase 2, F7) — nothing is changed by it. */
export interface ApplyPreview {
  /** Binds projectId + documentId + revision + SHA-256 of the input file. */
  previewToken: string;
  targetRevision: string;
  matched: number;
  unmatchedPrims: string[];
  /** Non-empty → `blocked: 'ambiguous'`. */
  ambiguous: string[];
  /** F10 — commit needs `confirmExtrasLost`. */
  extrasLost: string[];
  warnings: string[];
  /** 'extras-wipe' can be overridden with `acceptExtrasLoss`, 'ambiguous' never. */
  blocked: null | 'extras-wipe' | 'ambiguous';
  /** The input file's name (what the dialog heads with). */
  fileName?: string;
  /** `rvSchemaVersion` read from the file (1 when it carries none — see `warnings`). */
  schemaVersion?: number;
  /** Document nodes (scene included) that carry `realvirtual` now — the wipe sentence's count. */
  documentNodesWithExtras?: number;
}

/** Outcome of an apply commit (plan-764 Phase 2, F7). */
export type ApplyCommitResult =
  | { ok: true; revision: string; replace: ReplaceResult }
  | { ok: false; code: 'stale-preview' | 'needs-confirmation' | 'extras-wipe' | 'ambiguous' }
  | { ok: false; code: 'replace-failed'; replace: ReplaceResult };

/** A non-GLB export format. */
export interface DocumentExportProvider {
  /** Stable id, e.g. 'usd'. Used in test ids (`document-card-verb-export-<id>`) and MCP. */
  id: string;
  /** Menu label, e.g. 'Export USD…'. */
  label: string;
  /** Sort key in the menu (default 100), then label. */
  order?: number;
  /** The modes this document offers right now (may depend on the context, e.g. overlay). */
  modes(ctx: DocumentExportContext): DocumentExportMode[];
  /** Optional, read-only check. Must not parse geometry, bake, or invoke an exporter. */
  preflight?(ctx: DocumentExportContext, modeId: string): Promise<DocumentExportPreflight>;
  /** Produce the bytes for one mode. Throws with a user-facing message. */
  run(ctx: DocumentExportContext, modeId: string): Promise<DocumentExportResult>;
  /**
   * Optional re-import, two-step (preview → commit); UI and MCP call exactly
   * these two. No code path may replace the document without a preview that
   * passed: `commit` takes only a token `preview` handed out.
   */
  apply?: {
    label: string;
    preview(ctx: DocumentExportContext, file: { name: string; bytes: Uint8Array }): Promise<ApplyPreview>;
    commit(
      ctx: DocumentExportContext,
      previewToken: string,
      confirm: { acceptExtrasLoss?: boolean; confirmExtrasLost?: boolean },
    ): Promise<ApplyCommitResult>;
  };
}

// ─── Registry ───────────────────────────────────────────────────────────

/**
 * Registry for export providers. Module-level singleton
 * ({@link exportProviderRegistry}), same last-wins / onChange shape as
 * `ImportProviderRegistry`.
 */
export class ExportProviderRegistry {
  private _providers = new Map<string, DocumentExportProvider>();
  private _listeners = new Set<() => void>();

  /** Register a provider. A second registration of the same id REPLACES the first (HMR-safe). */
  register(provider: DocumentExportProvider): void {
    if (this._providers.has(provider.id)) {
      console.warn(`[ExportProviders] provider "${provider.id}" already registered — replacing`);
    }
    this._providers.set(provider.id, provider);
    this._notify();
  }

  /** Remove a provider by id. No-op if absent. */
  unregister(id: string): void {
    if (this._providers.delete(id)) this._notify();
  }

  /** All providers, sorted by `order` (default 100), then label. */
  list(): DocumentExportProvider[] {
    return [...this._providers.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label),
    );
  }

  get(id: string): DocumentExportProvider | undefined {
    return this._providers.get(id);
  }

  /** Subscribe to registry changes (register/unregister). Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  private _notify(): void {
    for (const l of this._listeners) {
      try { l(); } catch (e) { console.error('[ExportProviders] listener error:', e); }
    }
  }
}

/** The global export provider registry (one per app). */
export const exportProviderRegistry = new ExportProviderRegistry();
