// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * three-utils.ts — Layout Planner re-export of the shared disposal helper.
 * The canonical implementation lives in core (rv-traverse-utils) so all
 * plugins share ONE dispose semantics (shared-resource double-dispose guard).
 */

export { disposeSubtree } from '../../core/engine/rv-traverse-utils';
