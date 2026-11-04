// SPDX-License-Identifier: AGPL-3.0-only
import { registerMatrix } from './continuation-matrix-helpers';

// One scene per file: each file gets a fresh browser page (GLB memory) and its own 600 s budget.
registerMatrix(['AGVDemo']);
