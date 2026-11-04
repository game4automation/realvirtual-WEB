// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * React view of the dev test API capability (see `../rv-dev-api.ts`).
 *
 * The hook kicks the probe on first mount and then renders its snapshot. It
 * never blocks: the first render returns `null` (the delivered-build state),
 * and a dev server's answer arrives a tick later through the subscription.
 */

import { useSyncExternalStore, useEffect } from 'react';
import {
  getDevTestApi,
  probeDevTestApi,
  subscribeDevTestApi,
  type DevTestApi,
} from '../rv-dev-api';

export function useDevTestApi(): DevTestApi | null {
  useEffect(() => { void probeDevTestApi(); }, []);
  return useSyncExternalStore(subscribeDevTestApi, getDevTestApi, () => null);
}
