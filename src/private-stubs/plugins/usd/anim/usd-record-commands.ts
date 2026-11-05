// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/usd/anim/usd-record-commands.ts — community stub for the COMMERCIAL
 * animated USD export (plan-2229).
 *
 * The implementations live in the private sibling. Without it `@rv-private/*`
 * resolves here: no implementations, so every `usd.record.*` / `usd.export.animated`
 * descriptor answers kind `unavailable` ("USD animation export is a commercial
 * module (realvirtual Commercial)") instead of "unknown command" (tier-boundary 6).
 */

import type { CommandImpl } from '../../../../core/hmi/rv-command-registry';

export const impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>> = {};
