// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Hook for accessing KPI demo data from the KpiDemoPlugin.
 */

import { usePlugin } from './use-plugin';
import type { KpiDemoPlugin } from '../plugins/demo/kpi-demo-plugin';

export function useKpiData(): KpiDemoPlugin | undefined {
  return usePlugin<KpiDemoPlugin>('kpi-demo');
}
