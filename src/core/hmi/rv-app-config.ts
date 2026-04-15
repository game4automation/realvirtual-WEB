// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Re-export barrel — rv-app-config moved to core/rv-app-config.ts.
 * This file exists for backward compatibility during migration.
 * Import from '../rv-app-config' or '../../core/rv-app-config' instead.
 */
export {
  type UIContextConfig,
  type SettingsTabId,
  type RVAppConfig,
  setAppConfig,
  getAppConfig,
  isSettingsLocked,
  isTabLocked,
  fetchAppConfig,
} from '../rv-app-config';
