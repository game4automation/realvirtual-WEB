// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for vite-plugin-features-json.mjs (plan-646 Phase 2). */

import type { Plugin } from 'vite';

export const FEATURES_JSON_SOURCE: string;
export const FEATURES_JSON_OUTPUT: string;
export function featuresJsonPlugin(rootDir: string): Plugin;
