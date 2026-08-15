// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AasLinkPlugin — Links 3D scene objects to Asset Administration Shell data
 * from AASX files served from the viewer's public/aasx/ folder.
 *
 * Two parts:
 * 1. AasLinkPlugin class — Prefetches AASX index on model load.
 *    Hover/selection tooltip logic is handled by GenericTooltipController
 *    via the 'aas' data resolver registered at module load.
 * 2. AasTooltipContent — React component that renders Nameplate + TechnicalData
 *    rows inside the tooltip bubble. Self-registers in tooltipRegistry.
 */

import { resolveAssetsBase } from '../core/project/rv-project-assets-base';
import { getProjectStore } from '../core/project/project-store';
import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import { Box, Typography, CircularProgress, IconButton, Button, Tooltip as MuiTooltip } from '@mui/material';
import { OpenInNew, PictureAsPdf, Description, ShoppingCart, WarningAmber } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { TooltipContentProps } from '../core/hmi/tooltip/tooltip-registry';
import type { TooltipData } from '../core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../core/hmi/tooltip/tooltip-registry';
import { tooltipStore } from '../core/hmi/tooltip/tooltip-store';
import { Box3, Vector3, type Object3D } from 'three';
import type { ObjectHoverState } from '../hooks/use-hover';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { NodeRegistry } from '../core/engine/rv-node-registry';
import { FloatingPanel } from '../core/hmi/FloatingPanel';
import { RV_SCROLL_CLASS } from '../core/hmi/shared-sx';
import { loadIndex, loadAasxById, getIndexEntry, type AasParsedData, type AasIndexEntry } from './aas-link-parser';
import {
  beginAasLoadGeneration,
  getAasResolution,
  getAasResolutionVersion,
  isAasNodeVisible,
  isAasVisible,
  resolveAasSubtree,
  subscribeAasResolution,
  type AasResolution,
} from './aas-resolution';
import type { OrderManagerPluginAPI } from '../core/types/plugin-types';
import { useCustomBranding } from '../core/hmi/branding-store';
import { extractOrderData } from './order-manager-plugin';
import { NavButton } from '../core/hmi/NavButton';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { openPdfViewer, disposePdfViewer, type PdfLink } from '../core/hmi/pdf-viewer-store';

// ─── Capability Registration (side-effect at import time) ──────────────
// This runs when the plugin module is imported, BEFORE loadGLB() builds the BVH.
// Model plugin loading was moved to the pre-load phase in rv-viewer.ts to ensure this.
registerCapabilities('AASLink', {
  hoverable: true,
  selectable: true,
  inspectorVisible: true,
  hierarchyVisible: true,
  tooltipType: 'aas',
  badgeColor: '#26a69a',
  filterLabel: 'AAS',
  hoverEnabledByDefault: true,
  hoverPriority: 3,
  pinPriority: 3,
});

// ─── Types ──────────────────────────────────────────────────────────────

/** Tooltip data shape for AAS tooltips. */
export interface AasTooltipData extends TooltipData {
  type: 'aas';
  aasId: string;
  description: string;
  /** Node path for 3D highlight/focus from order manager. */
  nodePath?: string;
  /**
   * Resolution the node carried when the tooltip data was produced. The data
   * resolver already refuses unresolvable links, so this is a second, local
   * guard for callers that build tooltip data themselves (doc mode, tests).
   */
  resolution?: AasResolution;
}

// ─── AAS Button (left sidebar) ─────────────────────────────────────────

/**
 * Collect all AASLink nodes in the scene that can actually be shown. A link
 * whose AASX was never shipped (CONNECT embed) or whose id is unknown is not a
 * component the user can look at, so it must neither be counted nor highlighted.
 */
function getAasNodes(viewer: RVViewer): import('three').Object3D[] {
  const nodes: import('three').Object3D[] = [];
  viewer.scene.traverse(node => {
    if (node.userData?._rvAasLink && isAasNodeVisible(node)) nodes.push(node);
  });
  return nodes;
}

/** Left sidebar button — highlights all AASLink nodes on click. */
function AasButton({ viewer }: UISlotProps) {
  const [active, setActive] = useState(false);
  // Re-render when a resolution pass finishes so the badge count is never stale.
  useSyncExternalStore(subscribeAasResolution, getAasResolutionVersion, getAasResolutionVersion);

  const handleClick = useCallback(() => {
    if (active) {
      viewer.highlighter.clear();
      setActive(false);
    } else {
      const nodes = getAasNodes(viewer);
      if (nodes.length > 0) {
        viewer.highlighter.highlightMultiple(nodes);
        setActive(true);
      }
    }
  }, [active, viewer]);

  // Clear active state when something else clears the highlight
  useEffect(() => {
    if (!active) return;
    const off = viewer.on('object-hover', () => setActive(false));
    return off;
  }, [active, viewer]);

  return (
    <NavButton
      icon={<Description />}
      label="AAS Components"
      badge={getAasNodes(viewer).length || undefined}
      active={active}
      onClick={handleClick}
    />
  );
}

// ─── Documentation-mode motor hover (planner) ───────────────────────────
// In the planner, hover resolves to the WHOLE placement (the ancestor override),
// not to sub-drives, so a motor's datasheet can't be hit by normal resolution.
// This finds the gated-AAS drive node whose WORLD bounding box contains the 3D
// hit point — the motor actually under the cursor — using the GLB geometry's own
// bounds. No raycast / selection / planner surgery: the datasheet targets the
// motor and never appears for the whole-conveyor selection. Exported for tests.
const _docHoverBox = new Box3();
export function findGatedAasAtPoint(root: Object3D, point: Vector3): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => {
    if (found) return;
    const aas = n.userData?._rvAasLink as { gated?: boolean } | undefined;
    if (!aas?.gated) return;
    // An unresolvable datasheet is not a hit target — doc-mode hover and the
    // doc-mode detail tap both go through here.
    if (!isAasNodeVisible(n)) return;
    _docHoverBox.setFromObject(n);
    if (!_docHoverBox.isEmpty() && _docHoverBox.containsPoint(point)) found = n;
  });
  return found;
}

const _docHoverPoint = new Vector3();
/**
 * Show (or hide) the gated drive datasheet for the motor under the cursor, given
 * a hover event. Shared by the AasLinkPlugin (active in normal viewing modes) and
 * the layout-planner plugin (active in the planner), since model plugins — and
 * thus AasLinkPlugin — are NOT loaded while the planner is open.
 *
 * Gating: shown unless the planner is active AND documentation mode is off
 * (`planner.hideDriveDocs`). So in other modes it always shows; in the planner
 * only while documentation mode is on. Skips a hover whose node already carries a
 * gated link directly — the normal 'aas' resolver path renders that one.
 */
export function showDocModeDatasheet(viewer: RVViewer, hover: ObjectHoverState | null, tipId: string): void {
  const planner = viewer.getPlugin('layout-planner') as { hideDriveDocs?: boolean } | undefined;
  if (planner?.hideDriveDocs || !hover?.hitPoint || hover.node.userData?._rvAasLink) {
    tooltipStore.hide(tipId);
    return;
  }
  _docHoverPoint.set(hover.hitPoint[0], hover.hitPoint[1], hover.hitPoint[2]);
  // Search the WHOLE scene, not just hover.node's subtree: hover resolves to the
  // nearest hoverable ancestor (often a Drive sibling of the gated TransportSurface
  // node), which does not contain the gated node. The 3D hit point uniquely picks
  // the motor by its world bounding box regardless of which node was resolved.
  const node = findGatedAasAtPoint(viewer.scene, _docHoverPoint);
  if (!node) {
    tooltipStore.hide(tipId);
    return;
  }
  const aas = node.userData._rvAasLink as { aasId: string; description: string };
  const nodePath = NodeRegistry.computeNodePath(node);
  tooltipStore.show({
    id: tipId,
    lifecycle: 'hover',
    targetPath: nodePath,
    data: {
      type: 'aas',
      aasId: aas.aasId,
      description: aas.description,
      nodePath,
      resolution: getAasResolution(node),
    } as AasTooltipData,
    mode: 'cursor',
    cursorPos: { x: hover.pointer.x, y: hover.pointer.y },
    priority: 4,
  });
}

/**
 * Open the full AAS detail panel (nameplate + technical data + PDF documents) for
 * the gated motor whose world bounding box contains a 3D click point. Used by the
 * planner where hover/click resolve to the whole placement (not the motor) and the
 * hover augmenter is hover-only — so a tap needs an explicit "open detail" path.
 * Returns true when a motor was hit and the panel opened.
 */
export function openDocModeDetailAtPoint(viewer: RVViewer, hitPoint: [number, number, number] | null | undefined): boolean {
  const planner = viewer.getPlugin('layout-planner') as { hideDriveDocs?: boolean } | undefined;
  if (planner?.hideDriveDocs || !hitPoint) return false;
  _docHoverPoint.set(hitPoint[0], hitPoint[1], hitPoint[2]);
  const node = findGatedAasAtPoint(viewer.scene, _docHoverPoint);
  if (!node) return false;
  const aas = node.userData._rvAasLink as { aasId: string; description: string };
  openAasDetail(aas.aasId, aas.description, node.name);
  return true;
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class AasLinkPlugin implements RVViewerPlugin {
  readonly id = 'aas-link';

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: AasButton, order: 45 },
  ];

  private viewer: RVViewer | null = null;
  private hoverOff: (() => void) | null = null;
  private unhoverOff: (() => void) | null = null;
  private readonly docHoverTipId = 'tooltip-hover:aas-docmode';
  /** plan-435 §2.10 abort generation — bumped by `onDeactivate`, checked by
   *  the async AASX indexing before it writes anything into the scene. */
  private _generation = 0;

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    const generation = this._generation;

    // Motor datasheet on hover (normal viewing modes — this plugin is not loaded
    // in the planner; the layout-planner plugin runs the same augmenter there).
    this.hoverOff?.();
    this.unhoverOff?.();
    this.hoverOff = viewer.on('object-hover', (h: ObjectHoverState | null) => showDocModeDatasheet(viewer, h, this.docHoverTipId));
    this.unhoverOff = viewer.on('object-unhover', () => tooltipStore.hide(this.docHoverTipId));

    // Read optional assetsBasePath from model config for project-specific AASX/PDF.
    // Falls back to viewer.projectAssetsPath (set via settings.json in private deploys).
    const aasConfig = result.modelConfig?.pluginConfig?.['aas-link'] as
      { assetsBasePath?: string; pdfLinks?: Record<string, string> } | undefined;
    // plan-372 Phase 14: the active project's aasx/ directory wins over the
    // deployment-wide fallback, so switching project cannot keep serving the
    // previous project's submodels. An explicit per-model path still wins.
    const assetsBasePath = resolveAssetsBase({
      explicit: aasConfig?.assetsBasePath,
      project: getProjectStore().getProject(),
      kind: 'aasx',
      fallbackBase: viewer.projectAssetsPath,
    });

    // Decide ONCE whether each AAS link can be resolved, and mark the nodes.
    // Runs on the load result's own root — not `viewer.scene` — so a model switch
    // during the index fetch cannot classify the new model against the old base
    // path; the load generation drops the stale completion (plan-373 F1/F2b).
    void resolveAasSubtree(result.root, assetsBasePath, beginAasLoadGeneration());

    // Pre-fetch AASX index and pre-parse all AASX files for nodes with AASLink.
    // Stores searchable text (nameplate + technical data values) on each node's
    // _rvAasLink.searchText so the search resolver can find them synchronously.
    loadIndex(assetsBasePath).then(index => {
      // Abort guard (plan-435 §2.10): the user switched the plugin off while
      // the index was in flight — nothing below may touch the scene any more.
      if (generation !== this._generation) return;
      if (Object.keys(index).length === 0) return;

      // Collect unique AAS IDs from the scene
      const aasNodes = new Map<string, import('three').Object3D[]>();
      viewer.scene.traverse(node => {
        const aas = node.userData?._rvAasLink as { aasId: string } | undefined;
        if (!aas?.aasId) return;
        const existing = aasNodes.get(aas.aasId) ?? [];
        existing.push(node);
        aasNodes.set(aas.aasId, existing);
      });

      // Pre-parse each unique AASX and store searchable text + PDF links on nodes
      for (const [aasId, nodes] of aasNodes) {
        loadAasxById(aasId, assetsBasePath).then(parsed => {
          // Combine all property values into one searchable string
          const values = [
            ...parsed.nameplate.map(p => p.value),
            ...parsed.technicalData.map(p => p.value),
            parsed.idShort,
          ].filter(Boolean);
          const searchText = values.join(' ');

          for (const node of nodes) {
            const aasData = node.userData._rvAasLink as Record<string, unknown>;
            if (aasData) aasData.searchText = searchText;

            // Populate generic _rvPdfLinks from AASX documents
            if (parsed.documents.length > 0) {
              if (!node.userData._rvPdfLinks) node.userData._rvPdfLinks = [];
              const existing = node.userData._rvPdfLinks as PdfLink[];
              for (const doc of parsed.documents) {
                existing.push({
                  title: doc.title,
                  source: { type: 'blob', aasId, zipPath: doc.zipPath, basePath: assetsBasePath },
                });
              }
            }
          }
        }).catch(() => { /* AASX not available — search just won't include it */ });
      }
    });

    // --- Standalone PDF matching ---
    // Read pdfLinks from model config: { "Robot/Arm": "pdf/robot-arm-manual.pdf" }
    // When a docs base applies, PDF URLs are resolved relative to it.
    // Datasheets are DOCS, not AAS submodels, so they resolve against the
    // project's docs/ directory rather than its aasx/ one (plan-372 Phase 14).
    // An explicit per-model assetsBasePath still wins, which is what keeps the
    // existing private deploys resolving exactly as before.
    const docsBasePath = resolveAssetsBase({
      explicit: aasConfig?.assetsBasePath,
      project: getProjectStore().getProject(),
      kind: 'docs',
      fallbackBase: viewer.projectAssetsPath,
    });
    const configPdfLinks = aasConfig?.pdfLinks;
    if (configPdfLinks) {
      const entries = Object.entries(configPdfLinks);
      if (entries.length > 0) {
        viewer.scene.traverse(node => {
          const nodePath = NodeRegistry.computeNodePath(node);
          for (const [pathPattern, pdfUrl] of entries) {
            if (nodePath.endsWith(pathPattern) || nodePath.endsWith('/' + pathPattern)) {
              if (!node.userData._rvPdfLinks) node.userData._rvPdfLinks = [];
              // Resolve PDF URL: if a docs base applies and the URL is
              // relative, prepend it. Absolute URLs are left untouched.
              const resolvedUrl = docsBasePath && !pdfUrl.startsWith('http') && !pdfUrl.startsWith('/')
                ? `${docsBasePath}${pdfUrl}`
                : pdfUrl;
              (node.userData._rvPdfLinks as PdfLink[]).push({
                title: pdfUrl.split('/').pop()?.replace(/\.pdf$/i, '') ?? pdfUrl,
                source: { type: 'url', url: resolvedUrl },
              });
            }
          }
        });
      }
    }
  }

  /**
   * plan-435: the hover subscriptions live until `dispose()`, so the fallback
   * would leave the datasheet tooltip alive behind a switched-off plugin.
   * Detach them and cancel the in-flight AASX indexing (§2.10). The scene
   * markings written by a completed index are model data owned by
   * `onModelCleared`-style teardown, not by this hook (invariant 3).
   */
  onDeactivate(): void {
    this._generation++;
    this.hoverOff?.();
    this.unhoverOff?.();
    this.hoverOff = null;
    this.unhoverOff = null;
    tooltipStore.hide(this.docHoverTipId);
  }

  /** Re-attach the hover augmenter for the model that is still loaded. */
  onActivate(viewer: RVViewer): void {
    const result = viewer.lastLoadResult;
    if (result) this.onModelLoaded(result, viewer);
  }

  dispose(): void {
    this._generation++;
    this.hoverOff?.();
    this.unhoverOff?.();
    this.hoverOff = null;
    this.unhoverOff = null;
    tooltipStore.hide(this.docHoverTipId);
    disposePdfViewer();
    this.viewer = null;
  }
}

// ─── Tooltip Content Renderer (React) ───────────────────────────────────

/** Row helper: label on left, value right-aligned in monospace. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, minHeight: 18 }}>
      <Typography
        variant="caption"
        sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, whiteSpace: 'nowrap', flexShrink: 0 }}
      >
        {label}
      </Typography>
      <Typography
        variant="caption"
        sx={{
          color: '#fff',
          fontSize: 10,
          fontFamily: 'monospace',
          textAlign: 'right',
          fontWeight: 600,
          wordBreak: 'break-word',
        }}
      >
        {value}
      </Typography>
    </Box>
  );
}

/** Default warning text when an AAS is flagged demoOnly without a custom note. */
const DEFAULT_DEMO_NOTE = 'Demo only — not validated by the supplier.';

/**
 * Resolve whether an AAS should display the demo warning.
 * Priority: qualifier on the AssetAdministrationShell > index.json fallback.
 * Returns the note text when a warning should be shown, otherwise null.
 */
function resolveDemoNote(parsed: AasParsedData | null, entry: AasIndexEntry | null): string | null {
  // Qualifier wins — travels with the AASX, semantically correct location.
  // Convention: <Qualifier type="DemoOnly" value="true"/> flips the flag,
  // optional <Qualifier type="DemoNote" value="custom text"/> overrides the message.
  const flag = parsed?.qualifiers?.find(q => /^demoonly$/i.test(q.type));
  if (flag && /^(true|1|yes)$/i.test(flag.value)) {
    const note = parsed?.qualifiers?.find(q => /^demonote$/i.test(q.type));
    return note?.value || DEFAULT_DEMO_NOTE;
  }
  // Fallback: index.json demoOnly flag — for AASX files we cannot modify.
  if (entry?.demoOnly) return entry.demoNote ?? DEFAULT_DEMO_NOTE;
  return null;
}

/**
 * Warning banner shown when an AAS is flagged as demo-only via either
 * a `DemoOnly` qualifier inside the AASX or `demoOnly: true` in index.json.
 * Renders nothing if neither flag is set.
 */
function DemoBanner({ parsed, entry }: { parsed: AasParsedData | null; entry: AasIndexEntry | null }) {
  const note = resolveDemoNote(parsed, entry);
  if (!note) return null;
  return (
    <Box
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.75,
        bgcolor: 'rgba(255, 167, 38, 0.12)',
        border: '1px solid rgba(255, 167, 38, 0.4)',
        borderRadius: 0.5,
        px: 0.75, py: 0.5,
        mt: 0.5, mb: 0.5,
      }}
    >
      <WarningAmber sx={{ fontSize: 14, color: '#ffa726', flexShrink: 0 }} />
      <Typography sx={{ color: '#ffcc80', fontSize: 10, lineHeight: 1.3 }}>
        {note}
      </Typography>
    </Box>
  );
}

/** Section header. */
function SectionHeader({ text }: { text: string }) {
  return (
    <Typography
      variant="caption"
      sx={{ color: '#26a69a', fontSize: 10, fontWeight: 700, mt: 0.75, mb: 0.25, display: 'block', textTransform: 'uppercase', letterSpacing: 0.5 }}
    >
      {text}
    </Typography>
  );
}

/** Max rows shown in hover mode (non-pinned). Pinned shows all with scroll. */
const HOVER_MAX_ROWS = 5;

/** AAS tooltip content provider. Self-registers in tooltipRegistry at module load. */
export function AasTooltipContent({ data, isPinned, viewer }: TooltipContentProps<AasTooltipData>) {
  const branding = useCustomBranding();
  const accentColor = branding?.primaryColor ?? '#26a69a';
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [parsed, setParsed] = useState<AasParsedData | null>(null);
  const [indexEntry, setIndexEntry] = useState<AasIndexEntry | null>(null);
  const [error, setError] = useState('');
  // The data resolver already refuses an unresolvable link; this repeats the gate
  // for tooltip data built by other callers. Hooks stay above the early return.
  const hidden = data.resolution !== undefined && !isAasVisible(data.resolution);

  useEffect(() => {
    if (hidden) return;
    if (!data.aasId) {
      setState('error');
      setError('No AAS ID');
      return;
    }

    setState('loading');
    let cancelled = false;

    getIndexEntry(data.aasId)
      .then((entry) => { if (!cancelled) setIndexEntry(entry ?? null); })
      .catch(() => { /* index unavailable — skip demo banner */ });

    loadAasxById(data.aasId)
      .then((result) => {
        if (!cancelled) {
          setParsed(result);
          setState('success');
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setState('error');
        }
      });

    return () => { cancelled = true; };
  }, [data.aasId, hidden]);

  // Header: use description from rv_extras, or product name from parsed data, or AAS ID
  const headerText = data.description
    || parsed?.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value
    || parsed?.idShort
    || data.aasId;

  // The whole tile goes — header, error text and "Add to Cart" alike. A tile with
  // no data behind it and an order button is worse than no tile (plan-373 F2).
  if (hidden) return null;

  return (
    <>
      {/* Header with optional expand button */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography
          variant="subtitle2"
          sx={{ color: '#26a69a', fontWeight: 700, fontSize: 12, lineHeight: 1.2, flex: 1 }}
        >
          AAS {headerText}
        </Typography>
        {isPinned && data.aasId && (
          <>
            <MuiTooltip title="Open AAS detail panel" placement="top">
              <IconButton
                size="small"
                onClick={() => {
                  openAasDetail(data.aasId, data.description, headerText);
                  // Deselect to close the pinned tooltip
                  viewer.selectionManager?.clear();
                }}
                sx={{ color: '#26a69a', p: 0.25 }}
              >
                <OpenInNew sx={{ fontSize: 13 }} />
              </IconButton>
            </MuiTooltip>
          </>
        )}
      </Box>

      {/* Demo-only warning banner (renders nothing if entry is not flagged) */}
      <DemoBanner parsed={parsed} entry={indexEntry} />

      {/* Loading state */}
      {state === 'loading' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }}>
          <CircularProgress size={12} sx={{ color: 'rgba(255,255,255,0.5)' }} />
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
            Loading AAS...
          </Typography>
        </Box>
      )}

      {/* Error state */}
      {state === 'error' && (
        <Typography variant="caption" sx={{ color: '#f44336', fontSize: 11 }}>
          {error}
        </Typography>
      )}

      {/* Success: Nameplate + TechnicalData */}
      {state === 'success' && parsed && (() => {
        // Combine all rows, then limit for hover mode
        const allRows = [
          ...parsed.nameplate.map((p, i) => ({ ...p, key: `np-${i}`, section: 'nameplate' as const })),
          ...parsed.technicalData.map((p, i) => ({ ...p, key: `td-${i}`, section: 'technical' as const })),
        ];
        const visibleRows = isPinned ? allRows : allRows.slice(0, HOVER_MAX_ROWS);
        const hiddenCount = allRows.length - visibleRows.length;
        let lastSection = '';

        return (
          <Box sx={isPinned ? {
            maxHeight: 300, overflowY: 'auto', overflowX: 'hidden', mr: -0.5, pr: 0.5,
            '&::-webkit-scrollbar': { width: 4 },
            '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(255,255,255,0.2)', borderRadius: 2 },
          } : undefined}>
            {visibleRows.map((row) => {
              const showHeader = row.section !== lastSection;
              lastSection = row.section;
              return (
                <Box key={row.key}>
                  {showHeader && <SectionHeader text={row.section === 'nameplate' ? 'Nameplate' : 'Technical Data'} />}
                  <Row label={row.label} value={row.value} />
                </Box>
              );
            })}
            {hiddenCount > 0 && (
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.3)', fontSize: 10, mt: 0.5, display: 'block' }}>
                +{hiddenCount} more (click to expand)
              </Typography>
            )}
          </Box>
        );
      })()}

      {/* ── "Add to Cart" full-width button at bottom (pinned only — hover tooltips have no pointer events) ── */}
      {isPinned && (() => {
        const orderPlugin = viewer.getPlugin<OrderManagerPluginAPI>('order-manager');
        if (!orderPlugin) return null;
        return (
          <Button
            variant="outlined"
            size="small"
            startIcon={<ShoppingCart sx={{ fontSize: 14 }} />}
            onClick={() => {
              const orderData = parsed ? extractOrderData(parsed) : {};
              orderPlugin.addItem(
                orderData.aasId ?? data.aasId,
                headerText,
                orderData.manufacturer ?? '',
                orderData.articleNumber ?? '',
                data.nodePath,
              );
            }}
            sx={{
              mt: 1,
              width: '100%',
              color: accentColor,
              borderColor: `${accentColor}80`,
              fontSize: 11,
              fontWeight: 600,
              textTransform: 'none',
              py: 0.5,
              '&:hover': { borderColor: accentColor, bgcolor: `${accentColor}1a` },
            }}
          >
            Add to Cart
          </Button>
        );
      })()}
    </>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'aas',
  component: AasTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('aas', (node, viewer) => {
  const aas = node.userData?._rvAasLink as { aasId: string; description: string; gated?: boolean } | undefined;
  if (!aas?.aasId) return null;
  // Single gate for hover tooltip, pinned tooltip and the "Add to Cart" button
  // inside it: an id the shipped index cannot resolve produces no tooltip at all
  // rather than a red error over every motor (plan-373 F2/F3).
  const resolution = getAasResolution(node);
  if (!isAasVisible(resolution)) return null;
  // Library-attached drive datasheets are gated: hidden while the layout planner
  // is active and documentation mode is off. Authored AAS links (no `gated`
  // flag) and all other viewing modes are always shown.
  if (aas.gated) {
    const planner = viewer?.getPlugin?.('layout-planner') as { hideDriveDocs?: boolean } | undefined;
    if (planner?.hideDriveDocs) return null;
  }
  return {
    type: 'aas',
    aasId: aas.aasId,
    description: aas.description,
    nodePath: NodeRegistry.computeNodePath(node),
    resolution,
  };
});

// ── Search resolver: AAS values are searchable (description, ID, and pre-parsed AASX content) ──
tooltipRegistry.registerSearchResolver('AASLink', (node) => {
  const aas = node.userData?._rvAasLink as { aasId: string; description: string; searchText?: string } | undefined;
  if (!aas) return [];
  const texts: string[] = [];
  if (aas.description) texts.push(aas.description);
  if (aas.aasId) texts.push(aas.aasId);
  // searchText is populated async by onModelLoaded after AASX pre-parse
  if (aas.searchText) texts.push(aas.searchText);
  return texts;
});

// ── Search display resolver: show AAS description (product name) in search results ──
tooltipRegistry.registerSearchDisplayResolver('AASLink', (node) => {
  const aas = node.userData?._rvAasLink as { description?: string } | undefined;
  return aas?.description || null;
});

// ─── Floating AAS Detail Panel ─────────────────────────────────────────
// Module-level store: tracks which AAS ID is shown in the floating panel.

interface AasDetailState {
  open: boolean;
  aasId: string;
  description: string;
  nodeName: string;
}

let _aasDetailState: AasDetailState = { open: false, aasId: '', description: '', nodeName: '' };
const _aasDetailListeners = new Set<() => void>();
let _aasDetailSnapshot = _aasDetailState;

function notifyAasDetail(): void {
  _aasDetailSnapshot = { ..._aasDetailState };
  for (const l of _aasDetailListeners) l();
}

/** Open the floating AAS detail panel for a given AAS ID. */
export function openAasDetail(aasId: string, description: string, nodeName: string): void {
  _aasDetailState = { open: true, aasId, description, nodeName };
  notifyAasDetail();
}

/** Close the floating AAS detail panel. */
export function closeAasDetail(): void {
  _aasDetailState = { ..._aasDetailState, open: false };
  notifyAasDetail();
}

function useAasDetailState(): AasDetailState {
  return useSyncExternalStore(
    (cb) => { _aasDetailListeners.add(cb); return () => { _aasDetailListeners.delete(cb); }; },
    () => _aasDetailSnapshot,
  );
}

/**
 * Header action button for the AASLink component section in the PropertyInspector.
 *
 * `data` is the raw rv_extras bucket and carries no node identity, so the caller
 * passes the node it belongs to — without it this surface could not read the
 * node-local resolution and would keep offering a detail panel for a link the
 * tooltip already hides (plan-373 F3).
 */
export function AasDetailHeaderAction({ viewer, nodePath, data }: {
  viewer?: RVViewer;
  nodePath?: string | null;
  data: Record<string, unknown>;
}) {
  const aasId = (data.AASId ?? data.aasId ?? '') as string;
  const description = (data.Description ?? data.description ?? '') as string;
  // Re-render when a resolution pass finishes (the inspector can be open first).
  useSyncExternalStore(subscribeAasResolution, getAasResolutionVersion, getAasResolutionVersion);

  const handleOpen = useCallback(() => {
    if (aasId) openAasDetail(aasId, description, '');
  }, [aasId, description]);

  if (!aasId) return null;
  const node = nodePath ? viewer?.registry?.getNode(nodePath) : null;
  if (node && !isAasNodeVisible(node)) return null;

  return (
    <MuiTooltip title="Open AAS detail panel" placement="top">
      <IconButton size="small" onClick={handleOpen} sx={{ color: '#26a69a', p: 0.25, ml: 'auto' }}>
        <OpenInNew sx={{ fontSize: 13 }} />
      </IconButton>
    </MuiTooltip>
  );
}

/** Floating AAS detail panel — renders nameplate + technical data in a draggable FloatingPanel. */
export function AasDetailPanel() {
  const state = useAasDetailState();
  const [parsed, setParsed] = useState<AasParsedData | null>(null);
  const [indexEntry, setIndexEntry] = useState<AasIndexEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!state.open || !state.aasId) { setParsed(null); setIndexEntry(null); return; }

    setLoading(true);
    setError('');
    let cancelled = false;

    getIndexEntry(state.aasId)
      .then((entry) => { if (!cancelled) setIndexEntry(entry ?? null); })
      .catch(() => { /* index unavailable — skip demo banner */ });

    loadAasxById(state.aasId)
      .then((result) => { if (!cancelled) { setParsed(result); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); } });

    return () => { cancelled = true; };
  }, [state.open, state.aasId]);

  const headerText = state.description
    || parsed?.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value
    || parsed?.idShort
    || state.aasId;

  return (
    <FloatingPanel
      open={state.open}
      onClose={closeAasDetail}
      title={`AAS ${headerText}`}
      titleColor="#26a69a"
      subtitle={state.aasId}
      defaultWidth={460}
      defaultHeight={500}
      zIndex={1600}
    >
      <Box
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}
      >
        <DemoBanner parsed={parsed} entry={indexEntry} />
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 2 }}>
            <CircularProgress size={16} sx={{ color: 'rgba(255,255,255,0.5)' }} />
            <Typography sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>Loading AAS data...</Typography>
          </Box>
        )}
        {error && (
          <Typography sx={{ color: '#f44336', fontSize: 12, py: 2 }}>{error}</Typography>
        )}
        {!loading && !error && parsed && (
          <>
            {parsed.nameplate.length > 0 && (
              <>
                <SectionHeader text="Nameplate" />
                {parsed.nameplate.map((p, i) => <Row key={`np-${i}`} label={p.label} value={p.value} />)}
              </>
            )}
            {parsed.technicalData.length > 0 && (
              <>
                <SectionHeader text="Technical Data" />
                {parsed.technicalData.map((p, i) => <Row key={`td-${i}`} label={p.label} value={p.value} />)}
              </>
            )}
            {parsed.documents.length > 0 && (
              <>
                <SectionHeader text="Documents" />
                {parsed.documents.map((doc, i) => (
                  <Box
                    key={`doc-${i}`}
                    onClick={() => openPdfViewer(doc.title, { type: 'blob', aasId: state.aasId, zipPath: doc.zipPath })}
                    sx={{
                      display: 'flex', alignItems: 'center', gap: 1, py: 0.5, px: 0.5,
                      cursor: 'pointer', borderRadius: 0.5,
                      '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
                    }}
                  >
                    <PictureAsPdf sx={{ fontSize: 16, color: '#ef5350' }} />
                    <Typography sx={{ color: '#fff', fontSize: 12 }}>{doc.title}</Typography>
                  </Box>
                ))}
              </>
            )}
            {parsed.nameplate.length === 0 && parsed.technicalData.length === 0 && parsed.documents.length === 0 && (
              <Typography sx={{ color: 'rgba(255,255,255,0.4)', fontSize: 12, py: 2, textAlign: 'center' }}>
                No nameplate, technical data, or documents found
              </Typography>
            )}
          </>
        )}
      </Box>
    </FloatingPanel>
  );
}

// PDF viewer state is now in '../core/hmi/pdf-viewer-store.ts' (generic, shared across all tooltip types)
