// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Demo plugins barrel — re-exports individual demo plugin classes.
 *
 * Demo plugins are no longer registered globally. They are loaded per-model
 * via src/plugins/models/DemoRealvirtualWeb/index.ts.
 * This barrel is kept for tests and other imports that reference individual classes.
 */

export { KpiDemoPlugin } from './kpi-demo-plugin';
export { DemoHMIPlugin } from './demo-hmi-plugin';
export { TestAxesPlugin } from './test-axes-plugin';
export { PerfTestPlugin } from './perf-test-plugin';
export { MachineControlPlugin } from './machine-control-plugin';
export { MaintenancePlugin } from './maintenance-plugin';
