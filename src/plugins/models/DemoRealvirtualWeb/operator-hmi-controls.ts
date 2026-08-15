// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * operator-hmi-controls.ts — Hides engineering simulation controls while the
 * operator HMI overlay is visible (the H-key "HMI mode") for the demo model.
 *
 * The TopBar's leading sim controls — Play/Pause + Reset (`sim-controller-toolbar`)
 * and the Realtime/DES mode toggle (`sim-mode-toggle`) — are engineering tools an
 * operator should not touch. This plugin bridges the `hmiVisible` store to the
 * `operator-hmi` UI context and registers a rule so those slots hide in it. When
 * the user presses H to leave HMI mode (engineering view), the controls return.
 */

import type { RVViewerPlugin } from '../../../core/rv-plugin';
import { registerUIElement, setContext, deactivateContext } from '../../../core/hmi/ui-context-store';
import { getHmiVisible, subscribeHmiVisible } from '../../../core/hmi/hmi-visibility-store';

/** Context active while the operator HMI overlay is shown. */
export const OPERATOR_HMI_CONTEXT = 'operator-hmi';

/** Slot visibilityIds hidden in operator HMI mode. */
export const OPERATOR_HMI_HIDDEN_SLOTS = ['sim-controller-toolbar', 'sim-mode-toggle'] as const;

export class OperatorHmiControlsPlugin implements RVViewerPlugin {
  readonly id = 'operator-hmi-controls';
  private off: (() => void) | null = null;

  onModelLoaded(): void {
    for (const id of OPERATOR_HMI_HIDDEN_SLOTS) {
      registerUIElement(id, { hiddenIn: [OPERATOR_HMI_CONTEXT] });
    }
    const sync = () => setContext(OPERATOR_HMI_CONTEXT, getHmiVisible());
    sync();
    this.off = subscribeHmiVisible(sync);
  }

  /**
   * plan-435: the `hmiVisible` subscription and the `operator-hmi` context
   * both live until `dispose()`, so the fallback would leave the engineering
   * controls hidden behind a switched-off plugin. Release both — no model
   * state is involved (invariant 3).
   */
  onDeactivate(): void {
    this.off?.();
    this.off = null;
    deactivateContext(OPERATOR_HMI_CONTEXT);
  }

  /** Re-bridge the store to the context. `registerUIElement` is idempotent. */
  onActivate(): void {
    this.onModelLoaded();
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    deactivateContext(OPERATOR_HMI_CONTEXT);
  }
}
