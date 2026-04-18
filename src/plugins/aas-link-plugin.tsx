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

import { useState, useEffect, useSyncExternalStore, useCallback } from 'react';
import { Box, Typography, CircularProgress, IconButton, Button, Tooltip as MuiTooltip } from '@mui/material';
import { OpenInNew, PictureAsPdf, Description, ShoppingCart } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { TooltipContentProps } from '../core/hmi/tooltip/tooltip-registry';
import type { TooltipData } from '../core/hmi/tooltip/tooltip-store';
import { tooltipRegistry } from '../core/hmi/tooltip/tooltip-registry';
import { registerCapabilities } from '../core/engine/rv-component-registry';
import { NodeRegistry } from '../core/engine/rv-node-registry';
import { ChartPanel } from '../core/hmi/ChartPanel';
import { RV_SCROLL_CLASS } from '../core/hmi/shared-sx';
import { loadIndex, loadAasxById, type AasParsedData } from './aas-link-parser';
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
}

// ─── AAS Button (left sidebar) ─────────────────────────────────────────

/** Collect all AASLink nodes in the scene. */
function getAasNodes(viewer: RVViewer): import('three').Object3D[] {
  const nodes: import('three').Object3D[] = [];
  viewer.scene.traverse(node => {
    if (node.userData?._rvAasLink) nodes.push(node);
  });
  return nodes;
}

/** Left sidebar button — highlights all AASLink nodes on click. */
function AasButton({ viewer }: UISlotProps) {
  const [active, setActive] = useState(false);

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

// ─── Plugin ─────────────────────────────────────────────────────────────

export class AasLinkPlugin implements RVViewerPlugin {
  readonly id = 'aas-link';

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: AasButton, order: 45 },
  ];

  private viewer: RVViewer | null = null;

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;

    // Read optional assetsBasePath from model config for project-specific AASX/PDF.
    // Falls back to viewer.projectAssetsPath (set via settings.json in private deploys).
    const aasConfig = result.modelConfig?.pluginConfig?.['aas-link'] as
      { assetsBasePath?: string; pdfLinks?: Record<string, string> } | undefined;
    const assetsBasePath = aasConfig?.assetsBasePath ?? viewer.projectAssetsPath;

    // Pre-fetch AASX index and pre-parse all AASX files for nodes with AASLink.
    // Stores searchable text (nameplate + technical data values) on each node's
    // _rvAasLink.searchText so the search resolver can find them synchronously.
    loadIndex(assetsBasePath).then(index => {
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
    // When assetsBasePath is set, PDF URLs are resolved relative to it.
    const configPdfLinks = aasConfig?.pdfLinks;
    if (configPdfLinks) {
      const entries = Object.entries(configPdfLinks);
      if (entries.length > 0) {
        viewer.scene.traverse(node => {
          const nodePath = NodeRegistry.computeNodePath(node);
          for (const [pathPattern, pdfUrl] of entries) {
            if (nodePath.endsWith(pathPattern) || nodePath.endsWith('/' + pathPattern)) {
              if (!node.userData._rvPdfLinks) node.userData._rvPdfLinks = [];
              // Resolve PDF URL: if assetsBasePath is set and URL is relative, prepend it
              const resolvedUrl = assetsBasePath && !pdfUrl.startsWith('http') && !pdfUrl.startsWith('/')
                ? `${assetsBasePath}${pdfUrl}`
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

  dispose(): void {
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
  const [error, setError] = useState('');

  useEffect(() => {
    if (!data.aasId) {
      setState('error');
      setError('No AAS ID');
      return;
    }

    setState('loading');
    let cancelled = false;

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
  }, [data.aasId]);

  // Header: use description from rv_extras, or product name from parsed data, or AAS ID
  const headerText = data.description
    || parsed?.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value
    || parsed?.idShort
    || data.aasId;

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
tooltipRegistry.registerDataResolver('aas', (node) => {
  const aas = node.userData?._rvAasLink as { aasId: string; description: string } | undefined;
  if (!aas?.aasId) return null;
  return { type: 'aas', aasId: aas.aasId, description: aas.description, nodePath: NodeRegistry.computeNodePath(node) };
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

/** Header action button for the AASLink component section in the PropertyInspector. */
export function AasDetailHeaderAction({ data }: { data: Record<string, unknown> }) {
  const aasId = (data.AASId ?? data.aasId ?? '') as string;
  const description = (data.Description ?? data.description ?? '') as string;

  const handleOpen = useCallback(() => {
    if (aasId) openAasDetail(aasId, description, '');
  }, [aasId, description]);

  if (!aasId) return null;

  return (
    <MuiTooltip title="Open AAS detail panel" placement="top">
      <IconButton size="small" onClick={handleOpen} sx={{ color: '#26a69a', p: 0.25, ml: 'auto' }}>
        <OpenInNew sx={{ fontSize: 13 }} />
      </IconButton>
    </MuiTooltip>
  );
}

/** Floating AAS detail panel — renders nameplate + technical data in a draggable ChartPanel. */
export function AasDetailPanel() {
  const state = useAasDetailState();
  const [parsed, setParsed] = useState<AasParsedData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!state.open || !state.aasId) { setParsed(null); return; }

    setLoading(true);
    setError('');
    let cancelled = false;

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
    <ChartPanel
      open={state.open}
      onClose={closeAasDetail}
      title={`AAS ${headerText}`}
      titleColor="#26a69a"
      subtitle={state.aasId}
      defaultWidth={460}
      defaultHeight={500}
      panelId="aas-detail"
      zIndex={1600}
    >
      <Box
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, overflow: 'auto', px: 1.5, py: 1 }}
      >
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
    </ChartPanel>
  );
}

// PDF viewer state is now in '../core/hmi/pdf-viewer-store.ts' (generic, shared across all tooltip types)
