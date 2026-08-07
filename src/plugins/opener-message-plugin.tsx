// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * OpenerMessagePlugin — per-model welcome/opener dialog.
 *
 * Shows a configurable message dialog every time a model finishes loading —
 * for customer showcases, demo disclaimers, or operator instructions.
 * Register it from a model plugin folder (src/plugins/models/<Model>/ or a
 * private project's plugins/) with a model-specific config:
 *
 *   viewer.use(new OpenerMessagePlugin({
 *     title: 'Welcome to the ACME line',
 *     subtitle: 'Prototype Demo',
 *     paragraphs: ['Explore the line in 3D …'],
 *     highlights: [{ label: 'OEE badges', description: 'click a badge …' }],
 *     footnote: 'All values are simulated.',
 *   }));
 *
 * Turning it off — two seams, both without touching the model plugin:
 *   - Programmatic (custom loaders / embeddings): call
 *     `setOpenerMessagesEnabled(false)` before or after model load — a
 *     pending or visible opener hides immediately, re-enabling shows it again.
 *   - Per deploy: `"disableOpenerMessages": true` in `public/settings.json`.
 *
 * Styling mirrors the global WelcomeModal (Glass Control Room, Instrument
 * Blue accent) so per-model openers feel native to the product. Rendered via
 * MUI Modal so it stacks correctly above plugin/HMI React roots, and deferred
 * while the global product WelcomeModal is open (first visit).
 */

import { useCallback, useSyncExternalStore } from 'react';
import { Modal, Paper, Box, Typography, Button } from '@mui/material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import { modeContext } from '../core/rv-mode-manager';
import { createStore, type Store } from '../core/hmi/create-store';
import {
  useMayShowStartupModal,
  useStartupModalRegistration,
} from '../core/hmi/startup-modal-coordinator';
import { getAppConfig } from '../core/rv-app-config';

/** One "what to try" bullet in the opener dialog. */
export interface OpenerHighlight {
  /** Short bold lead-in (e.g. 'OEE badges'). */
  label: string;
  /** One-sentence description shown after the label. */
  description: string;
}

/** Content + behavior of a per-model opener message. */
export interface OpenerMessageConfig {
  /** Dialog headline. */
  title: string;
  /** Small uppercase tagline under the title (e.g. 'Prototype Demo'). */
  subtitle?: string;
  /** Body paragraphs, rendered in order. */
  paragraphs?: string[];
  /** Optional "things to explore" bullet list. */
  highlights?: OpenerHighlight[];
  /** Heading above the highlights list. Default: 'Things to explore'. */
  highlightsTitle?: string;
  /** Small-print note at the bottom (demo disclaimer, data notice, …). */
  footnote?: string;
  /** Confirm button label. Default: 'Start exploring'. */
  buttonLabel?: string;
  /** Accent color for title/labels. Default: Instrument Blue #4fc3f7. */
  accentColor?: string;
  /** When false, the dialog is shown only for the first model load of the
   *  session (page reload resets it). Default: true — show on every load. */
  showOnEveryLoad?: boolean;
}

const ACCENT_DEFAULT = '#4fc3f7';

// ─── Global enable switch ─────────────────────────────────────────────────
//
// Module-level so custom loaders / host integrations can flip it without a
// reference to the plugin instance (they usually don't create it — the
// ModelPluginManager does). Reactive: a visible opener hides immediately.

const _enabled = createStore<boolean>(true);

/** Enable/disable all opener messages at runtime (custom-loader seam).
 *  Disabling hides a visible opener immediately; re-enabling shows a still-
 *  pending one again. */
export function setOpenerMessagesEnabled(enabled: boolean): void {
  _enabled.set(() => enabled);
}

/** Current global enable state (does not include the settings.json flag). */
export function areOpenerMessagesEnabled(): boolean {
  return _enabled.getSnapshot();
}

/** True when opener messages are suppressed for this deploy or session. */
function isSuppressed(): boolean {
  return !_enabled.getSnapshot() || getAppConfig().disableOpenerMessages === true;
}

// ─── Dialog ───────────────────────────────────────────────────────────────

/** The dialog itself — driven by the plugin's open-state store. */
function OpenerMessageModal({ store, config }: { store: Store<boolean>; config: OpenerMessageConfig }) {
  const open = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const enabled = useSyncExternalStore(_enabled.subscribe, _enabled.getSnapshot, _enabled.getSnapshot);
  const close = useCallback(() => store.set(() => false), [store]);
  const accent = config.accentColor ?? ACCENT_DEFAULT;

  // settings.json is loaded before React mounts, so reading it at render is safe.
  const deployDisabled = getAppConfig().disableOpenerMessages === true;
  const mayShow = useMayShowStartupModal('opener');
  const visible = open && enabled && !deployDisabled && mayShow;
  useStartupModalRegistration('opener', visible);

  return (
    <Modal
      open={visible}
      onClose={close}
      data-testid="opener-message-modal"
    >
      <Paper
        elevation={12}
        sx={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          borderRadius: 2,
          width: 520,
          maxWidth: '95vw',
          p: { xs: 2.5, sm: 4 },
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          maxHeight: '90dvh',
          overflow: 'auto',
          outline: 'none',
        }}
      >
        <Typography variant="h6" sx={{ fontWeight: 700, color: accent }}>
          {config.title}
        </Typography>
        {config.subtitle && (
          <Typography
            variant="caption"
            sx={{ color: 'rgba(255,255,255,0.45)', letterSpacing: 2, textTransform: 'uppercase', fontSize: 10, mt: -1.5 }}
          >
            {config.subtitle}
          </Typography>
        )}

        {config.paragraphs?.map((text, i) => (
          <Typography key={i} variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
            {text}
          </Typography>
        ))}

        {config.highlights && config.highlights.length > 0 && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="body2" sx={{ color: '#fff', fontWeight: 600 }}>
              {config.highlightsTitle ?? 'Things to explore'}
            </Typography>
            <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
              {config.highlights.map((h) => (
                <Typography key={h.label} component="li" variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
                  <strong style={{ color: '#fff' }}>{h.label}</strong> &mdash; {h.description}
                </Typography>
              ))}
            </Box>
          </Box>
        )}

        {config.footnote && (
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', lineHeight: 1.6 }}>
            {config.footnote}
          </Typography>
        )}

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.5 }}>
          <Button
            variant="contained"
            size="small"
            onClick={close}
            data-testid="opener-message-close"
            sx={{ textTransform: 'none', fontWeight: 600 }}
          >
            {config.buttonLabel ?? 'Start exploring'}
          </Button>
        </Box>
      </Paper>
    </Modal>
  );
}

// ─── Plugin ───────────────────────────────────────────────────────────────

/** Per-model welcome/opener dialog plugin — see module doc above. */
export class OpenerMessagePlugin implements RVViewerPlugin {
  readonly id = 'opener-message';
  readonly slots: UISlotEntry[];

  /** Open-state store — exposed for tests and programmatic re-open. */
  readonly openStore = createStore<boolean>(false);

  private readonly _config: OpenerMessageConfig;
  private _shownOnce = false;

  constructor(config: OpenerMessageConfig) {
    this._config = config;
    const store = this.openStore;
    this.slots = [
      {
        slot: 'overlay',
        component: function OpenerMessageHost() {
          return <OpenerMessageModal store={store} config={config} />;
        },
        order: 95,
        // A MODAL welcome dialog — the one thing a spectator link must never
        // open by itself (plan-387 F4). SlotRenderer evaluates a rule only when
        // a `visibilityId` is set, so without the id below the rule would be
        // silently ignored.
        visibilityId: 'opener-message',
        visibilityRule: { hiddenIn: [modeContext('viewer')] },
      },
    ];
  }

  /** Show the dialog on every model load (also fires retroactively when the
   *  plugin is registered after the model — the ModelPluginManager case). */
  onModelLoaded(): void {
    if (isSuppressed()) return;
    if (this._config.showOnEveryLoad === false && this._shownOnce) return;
    this._shownOnce = true;
    this.openStore.set(() => true);
  }

  onModelCleared(): void {
    this.openStore.set(() => false);
  }
}
