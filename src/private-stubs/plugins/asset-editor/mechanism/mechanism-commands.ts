// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/mechanism/mechanism-commands.ts — community stub for the COMMERCIAL asset editor (plan-434, plan-504).
 *
 * The rigid-body mechanism command implementations live in the private
 * sibling. Without it `@rv-private/*` resolves here: no implementations, so
 * every mechanism descriptor answers `ERR_EDITOR_UNAVAILABLE` instead of
 * "unknown command". The snap-listing helpers are inert — the only caller
 * (`web_editor_mechanism_snap_list`) refuses before it reaches them, because
 * the mechanism bridge is absent in a community build.
 */

import type { CommandImpl } from '../../../../core/hmi/rv-command-registry';

export const impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>> = {};

export const recordSnapListing: any = () => [];
export const clearSnapListing: any = () => undefined;
export const commitMechanismPlan: any = async () => undefined;
