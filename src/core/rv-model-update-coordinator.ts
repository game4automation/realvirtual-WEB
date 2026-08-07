// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-model-update-coordinator — the single place that decides what a published
 * model means for this browser tab (plan-365 §2.3).
 *
 * **Why one coordinator and not one handler per transport.** A page can hold
 * three independent WebSocket clients that all hear the same announcement: the
 * `InterfaceManager`'s interface (`main.ts`), a second one owned per model by
 * the `ConnectPlugin`, and `CtrlXInterface`, which inherits the handler. Left to
 * themselves they would each act on it — three catalogue updates, and in the bad
 * case three concurrent reloads of the same model. The transports therefore only
 * *report* a typed event; this class decides, once, and deduplicates by
 * canonical URL **and** revision.
 *
 * The rule it implements:
 *
 * | Published model | What happens |
 * |---|---|
 * | new | appears in the model selection; nothing else |
 * | the one currently open | its geometry is reloaded, the view is kept |
 * | a different one | nothing at all |
 * | the open one, but there is unsaved work | a hint, never an automatic load |
 * | nothing is open | the catalogue is updated; nothing is opened |
 *
 * The last row is deliberate. "No model loaded" is not the same as "first
 * visit": it is also what `loadEmptyScene()` leaves behind, i.e. a decision the
 * user made. Opening something there would override the user, and the binding
 * decision for this feature is that the user wins.
 */

import {
  canonicalModelUrl,
  isSameModelUrl,
  mergeModelCatalog,
  modelLabel,
  setModelRevision,
  type ModelCatalogEntry,
} from './rv-model-catalog';

/** A gateway announced that a model was published. */
export interface ModelChangedEvent {
  /** File name as reported by the gateway, e.g. `Fuellstation.glb`. */
  name?: string;
  /** URL the gateway actually serves the model under, relative to the site root. */
  url?: string;
  /** Per-model counter. Absent from gateways older than plan-365. */
  revision?: string;
  /** Which transport heard it — logging only. */
  source?: string;
}

/** What the coordinator needs from the running application. */
export interface ModelUpdateHost {
  /** Deploy base path, e.g. `/` or `/webviewer/`. */
  readonly baseUrl: string;
  /** The model catalogue as it stands. */
  getCatalog(): readonly ModelCatalogEntry[];
  /** Replace the catalogue and notify everything that renders it. */
  setCatalog(entries: ModelCatalogEntry[]): void;
  /** Canonical URL of the model on screen, or null when none is loaded. */
  getCurrentModelUrl(): string | null;
  /** True when the scene or the asset editor holds unsaved work. */
  hasUnsavedChanges(): boolean;
  /** Reload the open model's geometry, keeping scene edits and the view. */
  reloadCurrentModel(): Promise<void>;
  /** Offer the choice instead of loading — never a modal, never auto-dismissed. */
  showReloadHint(hint: ModelReloadHint): void;
  /** Injectable clock (tests). */
  now?(): number;
}

/** The prompt shown when unsaved work blocks an automatic reload. */
export interface ModelReloadHint {
  /** Display name of the model that was published. */
  label: string;
  /** Canonical URL of that model. */
  url: string;
  /** Load the new version, discarding the unsaved changes. */
  onReload: () => void;
  /** Keep the unsaved changes and stay on the current geometry. */
  onKeep: () => void;
}

/**
 * How long an announcement WITHOUT a revision blocks an identical repeat.
 * With revisions the comparison is exact; without one, all three transports
 * report the same publish as indistinguishable messages, and a short window is
 * the only thing that separates "the same event, heard three times" from "the
 * engineer published twice".
 */
const NO_REVISION_DEDUP_WINDOW_MS = 2000;

interface AppliedRecord {
  revision: string | undefined;
  at: number;
}

export class RVModelUpdateCoordinator {
  private readonly host: ModelUpdateHost;
  private readonly applied = new Map<string, AppliedRecord>();
  private reloading = false;
  /** Set while a reload runs, so a newer announcement is honoured afterwards. */
  private pendingReload: string | null = null;

  constructor(host: ModelUpdateHost) {
    this.host = host;
  }

  /** Entry point for every transport. Never throws into the caller. */
  handleModelChanged(event: ModelChangedEvent): void {
    try {
      void this.process(event);
    } catch (e) {
      console.warn('[model-update] failed to handle model_changed', e);
    }
  }

  /** Forget what has been applied (tests / teardown). */
  reset(): void {
    this.applied.clear();
    this.reloading = false;
    this.pendingReload = null;
  }

  private async process(event: ModelChangedEvent): Promise<void> {
    const reported = event.url ?? event.name;
    if (!reported) {
      // Nothing identifiable. The pre-plan-365 answer was to reload the page —
      // which is what this plan removes, so the honest answer is to do nothing.
      console.info('[model-update] model_changed without a model URL — ignored');
      return;
    }

    const url = canonicalModelUrl(reported, this.host.baseUrl);
    if (!this.shouldApply(url, event.revision)) return;

    // Record the revision BEFORE anything downloads: every later fetch of this
    // model — the reload below, or a manual pick from the selector minutes
    // later — has to ask for the new bytes rather than the cached ones.
    setModelRevision(url, event.revision);

    // The catalogue is updated in every case, including the ones that stop
    // right after: a published model must be selectable even when it is not the
    // model on screen (F1), and the entries already there stay (F8).
    this.updateCatalog(url, event.name);

    const current = this.host.getCurrentModelUrl();
    if (!current) return;                          // nothing open — catalogue only
    if (!isSameModelUrl(current, url)) return;     // a different model — untouched (F3)

    if (this.host.hasUnsavedChanges()) {
      this.host.showReloadHint({
        label: event.name ? event.name.replace(/\.glb$/i, '') : modelLabel(url),
        url,
        onReload: () => { void this.runReload(url); },
        onKeep: () => { /* the user keeps the unsaved state; nothing to do */ },
      });
      return;
    }

    await this.runReload(url);
  }

  /**
   * Duplicate and out-of-order suppression. Three transports report the same
   * publish; two publishes in quick succession can reach them in either order,
   * because they are three independent sockets and only each one on its own
   * preserves ordering.
   */
  private shouldApply(url: string, revision: string | undefined): boolean {
    const now = this.host.now?.() ?? Date.now();
    const previous = this.applied.get(url);

    if (previous) {
      if (revision !== undefined && previous.revision !== undefined) {
        if (revision === previous.revision) return false;           // the same publish, heard twice
        const next = Number(revision);
        const prior = Number(previous.revision);
        // Revisions are counters, so "smaller" means "older" — an announcement
        // that lost the race must not undo the newer one it arrived after.
        if (Number.isFinite(next) && Number.isFinite(prior) && next < prior) {
          console.info(`[model-update] ignoring stale revision ${revision} for ${url} (have ${previous.revision})`);
          return false;
        }
      } else if (revision === undefined && previous.revision === undefined) {
        if (now - previous.at < NO_REVISION_DEDUP_WINDOW_MS) return false;
      }
    }

    this.applied.set(url, { revision, at: now });
    return true;
  }

  private updateCatalog(url: string, name: string | undefined): void {
    const label = name ? name.replace(/\.glb$/i, '') : modelLabel(url);
    const current = this.host.getCatalog();
    const merged = mergeModelCatalog(current, [{ url, label }]);
    // mergeModelCatalog is additive; an unchanged length means the model was
    // already known and there is nothing to notify about.
    if (merged.length !== current.length) this.host.setCatalog(merged);
  }

  private async runReload(url: string): Promise<void> {
    if (this.reloading) {
      // A reload is already running. Remember that another announcement came in
      // so the newest bytes win, instead of racing two loads into one viewer.
      this.pendingReload = url;
      return;
    }
    this.reloading = true;
    try {
      await this.host.reloadCurrentModel();
    } catch (e) {
      console.warn('[model-update] reloading the published model failed', e);
    } finally {
      this.reloading = false;
    }
    if (this.pendingReload) {
      this.pendingReload = null;
      await this.runReload(url);
    }
  }
}

// ── Process-wide instance ──────────────────────────────────────────────────
//
// The transports are constructed in three unrelated places and none of them has
// the viewer, the scene store or the catalogue. A module-level installation is
// what lets them report an event without knowing who acts on it — and what
// guarantees there is only ever ONE actor.

let _coordinator: RVModelUpdateCoordinator | null = null;

/** Install the single coordinator for this page. */
export function installModelUpdateCoordinator(
  coordinator: RVModelUpdateCoordinator | null,
): void {
  _coordinator = coordinator;
}

/** The installed coordinator, or null when the page never installed one. */
export function getModelUpdateCoordinator(): RVModelUpdateCoordinator | null {
  return _coordinator;
}

/**
 * Report a published model. A no-op when no coordinator is installed — which is
 * the correct behaviour for an embedded viewer or a unit test: an announcement
 * nobody is responsible for must not act on its own.
 */
export function emitModelChanged(event: ModelChangedEvent): void {
  _coordinator?.handleModelChanged(event);
}
