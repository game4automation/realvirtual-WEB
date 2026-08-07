// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * event-queue-overlay (PUBLIC STUB) — resolved via the `@rv-private` alias when
 * the private folder is absent. The DES Event Queue window is a private feature,
 * so the public build renders nothing (the DES toolbar button is hidden anyway
 * when no DES runner is registered).
 */

import type { UISlotProps } from '../../../../core/rv-ui-plugin';

export function EventQueueOverlay(_props: UISlotProps): null {
  return null;
}
