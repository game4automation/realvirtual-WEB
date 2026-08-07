// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-import-provider.ts — Unified CAD import facade (plan-238).
 *
 * One provider registry in front of the previously siloed import paths
 * (GLB file, STEP, Unity Asset Manager, Onshape). Providers describe HOW a
 * source is browsed/resolved; the sink depends on the active workspace mode:
 *
 *   - **editor** → the AssetDocument's `importCad` op. Editor mode always edits
 *     ONE library object (untitled until saved) — it has no scene, so an import
 *     there is always an addition to the current asset.
 *   - **planner** → `importObject()` (rv-import-object.ts): places into the
 *     current scene via the layout planner (op log, undo/redo, autosave).
 *     NEVER calls `loadModel`/`clearModel`.
 *
 * GLB is the single source of truth: every provider resolves to GLB BYTES.
 * Non-GLB sources (STEP via occt, USD) tessellate/parse into a transient
 * Object3D, serialize it with `objectToGlb`, and hand over the bytes — which are
 * then cached by content hash (rv-cad-glb-cache) and parsed back. Import and
 * reload therefore see an identical tree, and no loader special path exists.
 *
 * The registry itself lives in the public core; commercial providers (STEP,
 * Asset Manager, Onshape) register from `@rv-private`. A public build without
 * the private repo therefore only carries the GLB-file provider.
 */

import type { ReactNode } from 'react';
import type { LibraryCatalogEntry } from '../../plugins/layout-planner/rv-layout-store';
import type { CADLinkExtras } from '../editor/rv-asset-ops';
import type { RVViewer } from '../rv-viewer';

// ─── Availability ───────────────────────────────────────────────────────

/**
 * Reactive availability state. Deliberately NOT a sync boolean: providers
 * with an async login/handshake (Onshape OAuth, Asset Manager credentials
 * check) report 'connecting' while in flight and notify via
 * {@link CadImportProvider.onAvailabilityChange} when the state settles.
 */
export type ProviderAvailability = 'ready' | 'needs-setup' | 'connecting';

// ─── Provider input / result ────────────────────────────────────────────

/** Input handed from a provider's config tab to its `resolve()`. */
export type ImportProviderInput =
  | { kind: 'file'; file: File }
  | { kind: 'files'; files: File[] }
  | { kind: 'entries'; entries: LibraryCatalogEntry[] }
  | { kind: 'custom'; data: unknown };

/** One successfully resolved import item. */
export type ImportResultItem =
  /**
   * Binary GLB bytes — the ONLY geometry form a provider may return. A local
   * `.glb` passes its bytes through; STEP/USD tessellate into a transient
   * Object3D and serialize it with `objectToGlb` before returning.
   *
   * `cadlink` carries the provenance of a converted source (original filename,
   * content hash of the ORIGINAL bytes, tessellation quality). The editor stamps
   * it onto the imported root as `userData.realvirtual.CADLink`, which is what
   * makes "Re-import…" and hash-addressed cache lookup work.
   */
  | { kind: 'glb'; bytes: ArrayBuffer; suggestedName: string; cadlink?: CADLinkExtras }
  /** Catalog entries with stable URLs (e.g. Asset Manager assets). */
  | { kind: 'catalog'; entries: LibraryCatalogEntry[] };

/**
 * Provider resolve result with partial success: a multi-item source (e.g.
 * an Onshape document with 5 parts) may deliver 3 ok + 2 failed — both are
 * surfaced to the UI instead of an all-or-nothing throw.
 */
export interface ImportProviderResult {
  ok: ImportResultItem[];
  failed: { id: string; error: string }[];
}

// ─── Progress ───────────────────────────────────────────────────────────

/**
 * One progress update from a running `resolve()`, rendered on the Import
 * dialog's own progress bar.
 *
 * `percent === null` means "no meaningful fraction to report" and the bar stays
 * indeterminate. A provider must never invent a number: tessellating a STEP file
 * has no measurable progress (occt exposes no callback), so the STEP provider
 * reports a *calibrated estimate* and says so in `detail` — see
 * `@rv-private/plugins/step-import/step-import-progress`.
 */
export interface ImportProgress {
  /** 0..1, or null while the work is genuinely unmeasurable. */
  percent: number | null;
  /** Headline for the current step, e.g. "Tessellating". */
  label: string;
  /** Secondary line, e.g. "42.1 MB · ~1 min 20 s remaining". */
  detail?: string;
}

export type ImportProgressListener = (p: ImportProgress) => void;

// ─── Provider contract ──────────────────────────────────────────────────

/**
 * A tab's local file picker, surfaced as a "Choose files…" button in the
 * dialog FOOTER (next to Cancel / Import) instead of inside the tab body.
 * `openPicker` clicks the tab's own hidden `<input type="file">`, so all
 * provider-specific onChange handling stays in the tab.
 */
export interface ImportFilePicker {
  /** Button label, e.g. "Choose files…". */
  label: string;
  /** Open the tab's hidden file input. */
  openPicker: () => void;
}

/** Context handed to a provider's config tab by the Unified Import Dialog. */
export interface ImportProviderContext {
  viewer: RVViewer;
  /** Close the dialog (e.g. after a provider-driven flow finished). */
  close(): void;
  /** Publish the user's current selection; `null` clears it (disables Import). */
  setInput(input: ImportProviderInput | null): void;
  /**
   * Register the tab's file picker so the dialog renders the "Choose files…"
   * button in its footer. Call with `null` on unmount. Tabs without a local
   * file source (Asset Manager, Onshape) never call it.
   */
  registerFilePicker?(picker: ImportFilePicker | null): void;
}

/**
 * A single import source behind the unified facade.
 *
 * Well-known ids: 'glb-file' (core), 'step', 'unity-asset-manager',
 * 'onshape' (plan-237 registers itself here once implemented).
 */
export interface CadImportProvider {
  readonly id: 'step' | 'glb-file' | 'onshape' | 'unity-asset-manager' | (string & {});
  readonly label: string;
  /** Tab order in the dialog (lower = further left). Default 100. */
  readonly order?: number;
  /** Hint shown instead of the form while availability() !== 'ready'. */
  readonly setupHint?: string;

  /** Reactive availability — see {@link ProviderAvailability}. */
  availability(): ProviderAvailability;
  /** Subscribe to availability changes; returns an unsubscribe. */
  onAvailabilityChange(cb: () => void): () => void;

  /** Render the dialog tab content (file picker, login, asset browser …). */
  renderConfigTab(ctx: ImportProviderContext): ReactNode;

  /**
   * Resolve the user's input into import items. May throw — callers should
   * go through {@link resolveProviderSafe}.
   *
   * `onProgress` drives the dialog's progress bar. Providers whose work is short
   * or unmeasurable may ignore it; the bar then stays indeterminate.
   *
   * `signal` lets the dialog's Cancel button abort a long resolve (e.g. a
   * minutes-long server-side conversion). Providers that can honour it should
   * pass it to their fetch/worker; short or unabortable providers may ignore it.
   */
  resolve(
    input: ImportProviderInput,
    onProgress?: ImportProgressListener,
    signal?: AbortSignal,
  ): Promise<ImportProviderResult>;
}

// ─── Registry ───────────────────────────────────────────────────────────

/**
 * Registry for import providers. Module-level singleton
 * ({@link importProviderRegistry}) following the `componentActionRegistry` /
 * `fieldRendererRegistry` self-registration pattern.
 */
export class ImportProviderRegistry {
  private _providers = new Map<string, CadImportProvider>();
  private _listeners = new Set<() => void>();

  /**
   * Register a provider. Registering an id twice REPLACES the previous
   * provider (deterministic last-wins) and logs a warning — this keeps HMR /
   * repeated plugin init idempotent instead of throwing.
   */
  register(provider: CadImportProvider): void {
    if (this._providers.has(provider.id)) {
      console.warn(`[ImportProviders] provider "${provider.id}" already registered — replacing`);
    }
    this._providers.set(provider.id, provider);
    this._notify();
  }

  /** Remove a provider by id. No-op if absent. */
  unregister(id: string): void {
    if (this._providers.delete(id)) this._notify();
  }

  /** All providers, sorted by `order` (default 100), then label. */
  list(): CadImportProvider[] {
    return [...this._providers.values()].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100) || a.label.localeCompare(b.label),
    );
  }

  get(id: string): CadImportProvider | undefined {
    return this._providers.get(id);
  }

  /** Subscribe to registry changes (register/unregister). Returns unsubscribe. */
  onChange(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => { this._listeners.delete(cb); };
  }

  private _notify(): void {
    for (const l of this._listeners) {
      try { l(); } catch (e) { console.error('[ImportProviders] listener error:', e); }
    }
  }
}

/** The global import provider registry (one per app). */
export const importProviderRegistry = new ImportProviderRegistry();

// ─── Safe resolve wrapper ───────────────────────────────────────────────

/**
 * Run `provider.resolve(input)` and normalize every failure mode into the
 * `{ ok, failed }` shape — a throwing provider must never silently lose an
 * import or crash the dialog (plan-238 F6).
 */
export async function resolveProviderSafe(
  provider: CadImportProvider,
  input: ImportProviderInput,
  onProgress?: ImportProgressListener,
  signal?: AbortSignal,
): Promise<ImportProviderResult> {
  try {
    const result = await provider.resolve(input, onProgress, signal);
    return {
      ok: result?.ok ?? [],
      failed: result?.failed ?? [],
    };
  } catch (e) {
    // A user cancel is not a failure — surface nothing so the dialog just resets.
    if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) {
      return { ok: [], failed: [] };
    }
    return {
      ok: [],
      failed: [{ id: provider.id, error: e instanceof Error ? e.message : String(e) }],
    };
  }
}
