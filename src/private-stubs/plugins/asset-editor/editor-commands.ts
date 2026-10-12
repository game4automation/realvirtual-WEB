// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/editor-commands.ts — community stub for the COMMERCIAL asset editor (plan-434, plan-499).
 *
 * The editor's command implementations live in the private sibling. Without it
 * `@rv-private/*` resolves here: no implementations, so every editor command
 * descriptor answers "unavailable" instead of "unknown command".
 */

import type { CommandImpl } from '../../../core/hmi/rv-command-registry';

export const impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>> = {};
