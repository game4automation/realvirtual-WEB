// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect } from 'vitest';
import type { RVViewer } from '../../src/core/rv-viewer';
import { ensurePlannerCommandsRegistered } from '../../src/plugins/layout-planner/planner-commands';
import { ensureLibraryCommandsRegistered } from '../../src/core/library/library-commands';
import { ensureSignalBindCommandsRegistered } from '../../src/plugins/mcp-bridge/rv-mcp-signal-bind-tools';
import { ensureDesPlcCommandsRegistered } from '../../src/core/hmi/des-plc-commands';
import { ensureDiagnoseCommandsRegistered } from '../../src/core/diagnostics/diagnose-command-descriptors';
import { ensureQueryCommandsRegistered } from '../../src/core/hmi/query-commands';
import { McpCommandTools } from '../../src/plugins/mcp-bridge/rv-mcp-command-tools';

/** Exercise the read door while retaining assertions on the original JSON value. */
export async function queryCommand(viewer: RVViewer, command: string, args = {}): Promise<any> {
  ensurePlannerCommandsRegistered();
  ensureLibraryCommandsRegistered();
  ensureSignalBindCommandsRegistered();
  ensureDesPlcCommandsRegistered();
  ensureDiagnoseCommandsRegistered();
  // library.list / catalogList / catalogDescribe live in the query family (embed graph, plan-2007).
  ensureQueryCommandsRegistered();
  const result = JSON.parse(await new McpCommandTools(() => viewer).webQuery(command, JSON.stringify(args)));
  expect(result).toHaveProperty('value');
  return result.value;
}
