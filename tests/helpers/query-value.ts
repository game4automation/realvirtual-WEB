// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../../src/core/rv-viewer';
import { McpCommandTools } from '../../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ensureQueryCommandsRegistered } from '../../src/core/hmi/query-commands';
import { ensureMechanismCommandsRegistered } from '../../src/core/hmi/mechanism-command-descriptors';
import { ensureIkCommandsRegistered } from '../../src/plugins/mcp-bridge/rv-mcp-robot-tools';

import { ensureSimCommandsRegistered } from '../../src/plugins/sim-controller/sim-commands';
import { ensureSessionOverlayCommandsRegistered } from '../../src/core/hmi/session-overlay-commands';
import { ensureDocumentCommandsRegistered } from '../../src/core/hmi/document-commands';
import { ensureKnowledgeCommandsRegistered } from '../../src/plugins/mcp-bridge/rv-mcp-knowledge-tools';
import { ensureDocumentInfoCommandsRegistered } from '../../src/plugins/mcp-bridge/rv-mcp-document-info-tools';

/** Exercise the MCP read door, retaining the existing fixtures' JSON assertions. */
export async function queryValue(viewer: RVViewer, command: string, args: Record<string, unknown> = {}): Promise<string> {
  ensureQueryCommandsRegistered();
  ensureSimCommandsRegistered();
  ensureSessionOverlayCommandsRegistered();
  ensureDocumentCommandsRegistered();
  ensureKnowledgeCommandsRegistered();
  ensureDocumentInfoCommandsRegistered();
  ensureMechanismCommandsRegistered();
  ensureIkCommandsRegistered();
  const answer = JSON.parse(await new McpCommandTools(() => viewer).webQuery(command, JSON.stringify(args)));
  return JSON.stringify(answer.value ?? answer);
}
