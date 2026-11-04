// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/solidcraft-sync/solidcraft-commands.ts — community stub for the COMMERCIAL
 * SolidCraft live sync (plan-621).
 *
 * The implementations live in the private sibling. Without it `@rv-private/*`
 * resolves here: no implementations, so every `solidcraft.*` descriptor answers
 * `ERR_EDITOR_UNAVAILABLE` instead of "unknown command".
 */

import type { CommandImpl } from '../../../core/hmi/rv-command-registry';

export const impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>> = {};
