// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-900 fixture — runs inside vitest.perfile.config.mjs: the file that hangs IN ITS MODULE
// BODY, never reaching a test. This is the shape of the five plan-900 hangers: `file-start`
// (onTestModuleQueued) arrives, `onTestModuleStart` never does, and no test timeout can help
// because the hang is before the collection. The per-file limit must name THIS file.
import { it } from 'vitest';

await new Promise(() => {}); // never resolves — the run is ended by the wrapper

it('is never reached', () => {});
