// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * UsdLiveLinkPlugin — USD button (Export / Import / Sync) and the one-way live
 * link into NVIDIA Isaac Sim / any Kit app (plan-637).
 *
 * This module is the ENTRY-side shell: plugin registration, the store and the
 * two UI slots. The live link itself (`UsdLiveLinkSession`: Kit client, wire
 * protocol, runtime stage export, tracker) is a separate chunk, loaded by
 * dynamic `import()` on the first Sync click — a viewer that never syncs never
 * downloads it. Session lifecycle and the reset / staleness rules are
 * documented in `usd-live-link-session.ts`.
 *
 * Until the session is loaded the shell keeps what the session will need: the
 * current model (handed over on creation) and the user's intent (Sync on; an
 * off before the chunk arrived cancels the start).
 *
 * Switch semantics (plan-637 Phase 7): OFF always ends in status `off` with
 * every message cleared — whatever state the link was in, session or not. ON
 * without a stored access token keeps the switch on in status `needs-token`;
 * committing a token ({@link UsdLiveLinkPlugin.commitToken}) then connects.
 */

import type { ComponentType } from 'react';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import { PLUGIN_ORDER } from '../../core/rv-plugin-order';
import { LIVE_LINK_TOKEN_MISSING, LiveLinkStore } from './live-link-store';
import { UsdToolButton } from './UsdToolButton';
import { LiveLinkPill } from './LiveLinkPill';
import type {
  LiveLinkModel,
  UsdLiveLinkSession,
  UsdLiveLinkSessionOptions,
} from './usd-live-link-session';

export type { LiveLinkModel } from './usd-live-link-session';

/** Plugin id (also `viewer.getPlugin` key). */
export const USD_LIVE_LINK_PLUGIN_ID = 'usd-live-link';

/** The lazily loaded session module. */
export type UsdLiveLinkSessionModule = typeof import('./usd-live-link-session');

/** Seams for tests. */
export interface UsdLiveLinkPluginOptions extends UsdLiveLinkSessionOptions {
  store?: LiveLinkStore;
  /**
   * The session module, already loaded: the session is then created
   * synchronously on the first Sync click (tests). Without it the module is
   * fetched by dynamic `import()`.
   */
  sessionModule?: UsdLiveLinkSessionModule;
  /** Loader override for the lazy path (tests). */
  loadSessionModule?: () => Promise<UsdLiveLinkSessionModule>;
}

const loadSessionModuleDefault = (): Promise<UsdLiveLinkSessionModule> => import('./usd-live-link-session');

export class UsdLiveLinkPlugin implements RVViewerPlugin {
  readonly id = USD_LIVE_LINK_PLUGIN_ID;
  readonly core = true;
  /** Late in the post tick: drives, transport and grips have all run. */
  readonly order = PLUGIN_ORDER.LIVE_LINK;
  readonly slots: UISlotEntry[] = [
    {
      // Activity bar, lower group (next to Problems / Multiuser).
      slot: 'activity-bar',
      component: UsdToolButton as ComponentType<UISlotProps>,
      order: 65,
      placement: 'bottom',
      // Visible in every workspace including the editor and the planner;
      // only the kiosk hides it.
      visibilityRule: { hiddenIn: ['kiosk'] },
    },
    {
      slot: 'toolbar-status',
      component: LiveLinkPill as ComponentType<UISlotProps>,
      order: 30,
      visibilityRule: { hiddenIn: ['kiosk'] },
    },
  ];

  readonly store: LiveLinkStore;

  private model: LiveLinkModel | null = null;
  private session: UsdLiveLinkSession | null = null;
  private loading: Promise<UsdLiveLinkSession> | null = null;
  /** Sync requested while the session chunk is still loading. */
  private pendingSync = false;
  /** Sync switched on without a token: waits for {@link commitToken}. */
  private tokenPending = false;
  private offReset: (() => void) | null = null;
  private readonly opts: UsdLiveLinkPluginOptions;

  constructor(opts: UsdLiveLinkPluginOptions = {}) {
    this.opts = opts;
    this.store = opts.store ?? new LiveLinkStore();
  }

  // ── Plugin lifecycle ──

  init(viewer: RVViewer): void {
    this.offReset = viewer.on('simulation-reset', () => this.session?.onSimulationReset());
  }

  onModelLoaded(result: LoadResult): void {
    this.model = result;
    this.session?.onModelLoaded(result);
  }

  onModelCleared(): void {
    this.model = null;
    this.session?.onModelCleared();
  }

  onFixedUpdatePost(dt: number): void {
    this.session?.onFixedUpdatePost(dt);
  }

  /** Feature-matrix OFF: end the session (the model reference stays — invariant 3). */
  onDeactivate(): void {
    this.setSyncEnabled(false);
  }

  /** Feature-matrix ON: nothing to rebuild — sync waits for the user's click (F7). */
  onActivate(): void { /* intentionally empty */ }

  dispose(): void {
    this.setSyncEnabled(false);
    this.offReset?.();
    this.offReset = null;
  }

  // ── Public API (UI) ──

  /** True while the user has sync switched on (also while the link is loading or waits for a token). */
  get syncEnabled(): boolean {
    if (this.tokenPending) return true;
    return this.session ? this.session.syncEnabled : this.pendingSync;
  }

  /** Switch the live link on or off. ON must come from a user gesture (F7). */
  setSyncEnabled(on: boolean): void {
    if (!on) {
      this.tokenPending = false;
      this.pendingSync = false;
      this.session?.setSyncEnabled(false);
      // Always `off`, also from `error` / `needs-token` where no session runs.
      this.store.set({
        status: 'off', message: undefined, sentHz: 0, appliedHz: undefined, attempt: undefined,
        texturesSkipped: undefined, extensionNotice: undefined,
      });
      return;
    }
    if (!this.store.settings.token.trim()) {
      // Nothing to load for a link that cannot start: the switch stays on and
      // the link starts once a token is committed.
      this.tokenPending = true;
      this.store.set({ status: 'needs-token', message: LIVE_LINK_TOKEN_MISSING, sentHz: 0, attempt: undefined });
      return;
    }
    this.tokenPending = false;
    if (this.session) { this.session.setSyncEnabled(true); return; }
    if (this.opts.sessionModule) {
      this.createSession(this.opts.sessionModule).setSyncEnabled(true);
      return;
    }
    if (this.pendingSync) return;
    this.pendingSync = true;
    this.store.set({ status: 'connecting', message: 'Loading the live link…', sentHz: 0 });
    this.loading ??= (this.opts.loadSessionModule ?? loadSessionModuleDefault)().then((m) => this.createSession(m));
    this.loading.then(
      (session) => {
        if (!this.pendingSync) return; // switched off while loading
        this.pendingSync = false;
        session.setSyncEnabled(true);
      },
      (e: unknown) => {
        this.loading = null;
        if (!this.pendingSync) return;
        this.pendingSync = false;
        this.store.set({ status: 'error', message: `The live link could not be loaded: ${e instanceof Error ? e.message : String(e)}` });
      },
    );
  }

  /**
   * Store the access token (a commit in the settings — blur / Enter — i.e. a
   * user gesture). Waiting for a token (`needs-token`) or stopped by an error,
   * a changed non-empty token (re)starts the link; an unchanged one does not.
   */
  commitToken(token: string): void {
    const next = token.trim();
    const changed = next !== this.store.settings.token;
    if (changed) this.store.updateSettings({ token: next });
    if (!next) return;
    const status = this.store.state.status;
    if (this.tokenPending || (changed && status === 'error')) this.setSyncEnabled(true);
  }

  /**
   * Store the port (a commit in the settings, i.e. a user gesture). A changed
   * port restarts a link that is switched on or stopped by an error (e.g.
   * "port used by another program"), so the new port is tried right away.
   */
  setPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    const changed = port !== this.store.settings.port;
    this.store.updateSettings({ port });
    if (!changed) return;
    if (this.syncEnabled || this.store.state.status === 'error') {
      this.setSyncEnabled(false);
      this.setSyncEnabled(true);
    }
  }

  /** Change the sample rate (10–60 Hz); applies immediately. */
  setRateHz(hz: number): void {
    this.store.updateSettings({ rateHz: hz });
    this.session?.applyRateHz(this.store.settings.rateHz);
  }

  // ── Session ──

  private createSession(m: UsdLiveLinkSessionModule): UsdLiveLinkSession {
    if (this.session) return this.session;
    const { exportStage, compress, createClient, now } = this.opts;
    const session = new m.UsdLiveLinkSession(this.store, { exportStage, compress, createClient, now });
    if (this.model) session.onModelLoaded(this.model);
    this.session = session;
    return session;
  }
}
