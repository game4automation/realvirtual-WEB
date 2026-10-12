// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-instances — THE list of decorated delegate instances (plan-713 Phase 1).
 *
 * Decorator metadata lives per prototype, so the `web_*` catalogue is spread
 * over a dozen classes and has to be merged at discover time. Which classes take
 * part used to be written down in FOUR places — `McpBridgePlugin._sendDiscover`,
 * `tests/helpers/mcp-schemas.ts` and two test files that rebuild the dispatcher
 * by hand — and they drifted exactly the way four copies of a list drift:
 * `McpProjectTools` was announced and linted by nothing until plan-716 found it,
 * and `McpSignalBindTools` is still missing from one of the test copies.
 *
 * There is one list now, and it is production code rather than a test helper on
 * purpose: the announcement is what must be right, and the tests should be
 * reading it, not maintaining a parallel guess at it.
 *
 * The plugin itself is NOT in here — it owns its own root tools and prepends
 * itself (see `McpBridgePlugin.mcpToolInstances`).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpViewTools } from './rv-mcp-view-tools';
import { McpObserveTools } from './rv-mcp-observe-tools';
import { McpEditorTools } from './rv-mcp-editor-tools';
import { McpSignalBindTools } from './rv-mcp-signal-bind-tools';
import { McpSignalAutoMapTools } from './rv-mcp-signal-automap-tools';
import { McpSignalUsageTools } from './rv-mcp-signal-usage-tools';
import { McpKnowledgeTools } from './rv-mcp-knowledge-tools';
import { McpDocumentInfoTools } from './rv-mcp-document-info-tools';
import { McpProjectTools } from './rv-mcp-project-tools';
import { McpDescribeTool } from './rv-mcp-describe-tool';
import { McpLinkTools } from './rv-mcp-link-tools';
import { McpHelpTool } from './rv-mcp-help-tool';
import { McpComponentSchemaTool } from './rv-mcp-component-schema-tool';
import { McpRuntimeTools } from './rv-mcp-runtime-tools';
import { McpSceneTools } from './rv-mcp-scene-tools';
import { McpDesPlcTools } from './rv-mcp-desplc-tools';
import { McpPromptTools } from './rv-mcp-prompt-tools';
import { McpGroupsTools } from './rv-mcp-groups-tools';
import { McpCollisionTools } from './rv-mcp-collision-tools';
import { McpSimModeTool } from './rv-mcp-sim-mode-tool';
import { McpVideoTools } from './rv-mcp-video-tools';

/** Accessor the delegates share; `undefined` before a viewer is bound. */
export type ViewerAccessor = () => RVViewer | undefined;

/**
 * Delegate instances, keyed by class name.
 *
 * A record rather than an array so a census ("how many tools does each delegate
 * contribute?") can name its rows — the Phase-0 baseline stores exactly that,
 * and an array of anonymous objects makes the numbers unattributable.
 */
export function createMcpDelegates(getViewer: ViewerAccessor): Record<string, object> {
  return {
    McpViewTools: new McpViewTools(getViewer),
    McpObserveTools: new McpObserveTools(getViewer),
    McpEditorTools: new McpEditorTools(getViewer),
    McpSignalBindTools: new McpSignalBindTools(getViewer),
    // plan-545: model PLC signals -> S7 / PLCSIM interface signals (check / apply).
    McpSignalAutoMapTools: new McpSignalAutoMapTools(getViewer),
    // plan-566: the signal cross-reference list (web_signal_usage).
    McpSignalUsageTools: new McpSignalUsageTools(getViewer),
    McpKnowledgeTools: new McpKnowledgeTools(getViewer),
    McpDocumentInfoTools: new McpDocumentInfoTools(getViewer),
    McpProjectTools: new McpProjectTools(getViewer),
    McpDescribeTool: new McpDescribeTool(getViewer),
    McpLinkTools: new McpLinkTools(getViewer),
    McpRuntimeTools: new McpRuntimeTools(getViewer),
    McpSceneTools: new McpSceneTools(getViewer),
    McpDesPlcTools: new McpDesPlcTools(getViewer),
    // plan-486: the prompt queue. No viewer accessor — the queue belongs to the
    // browser tab, not to a loaded model.
    McpPromptTools: new McpPromptTools(),
    McpGroupsTools: new McpGroupsTools(getViewer),
    McpCollisionTools: new McpCollisionTools(getViewer),
    McpSimModeTool: new McpSimModeTool(getViewer),
    // plan-537: deterministic MP4 recording of the 3D canvas.
    McpVideoTools: new McpVideoTools(getViewer),
    McpHelpTool: new McpHelpTool(),
    McpComponentSchemaTool: new McpComponentSchemaTool(),
  };
}
