// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * display-wall/wall-fill-commands.ts — community stub for the COMMERCIAL display
 * wall fill command (plan-2233 F6).
 *
 * The implementation lives in the private sibling. Without it `@rv-private/*`
 * resolves here: no implementation, so `wall.fillFromBody` answers kind
 * `unavailable` instead of "unknown command" (tier-boundary 6).
 */

import type { CommandImpl } from '../../core/hmi/rv-command-registry';

export const impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>> = {};
