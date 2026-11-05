// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AasLinkPlugin — Links 3D scene objects to Asset Administration Shell data
 * from AASX files: the open project's `aasx/` folder over the deploy-wide
 * `public/aasx/` (plan-596, `getActiveAasSource()`).
 *
 * Two parts:
 * 1. AasLinkPlugin class — reads the AASX index on model load (metadata only;
 *    archives are opened on demand by tooltip / detail panel / PDF viewer).
 *    Hover/selection tooltip logic is handled by GenericTooltipController
 *    via the 'aas' data resolver registered at module load.
 * 2. AasTooltipContent — React component that renders Nameplate + TechnicalData
 *    rows inside the tooltip bubble. Self-registers in tooltipRegistry.
 */

import { resolveAssetsBase } from '../core/project/rv-project-assets-base';
import { getProjectStore } from '../core/project/project-store';
import {
  getActiveAasSource,
  getAasSourcesVersion,
  lookupAas,
  subscribeAasSources,
  type AasSource,
} from '../core/aas/rv-aas-source';
import { useState, useEffect, useSyncExternalStore, useCallback, useMemo } from 'react';
import { Box, Typography, CircularProgress, IconButton, Button, Tooltip as MuiTooltip } from '@mui/material';
import { OpenInNew, PictureAsPdf, Description, ShoppingCart, WarningAmber, ExpandMore, ChevronRight } from '@mui/icons-material';
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
import { prefetchAasDocumentMirrorFor } from '../core/aas/rv-aas-document-mirror';
import { loadIndex, loadAasDetail, type AasParsedData, type AasIndexEntry, type AasDocument } from './aas-link-parser';
import {
  getAasResolution,
  getAasResolutionVersion,
  isAasNodeVisible,
  isAasVisible,
  collectAasNodes,
  subscribeAasResolution,
  type AasResolution,
} from './aas-resolution';
import { useCartAvailable } from '../core/hmi/cart-gate';
import { AasModeController, type AasModeState } from './aas-mode';
import { displayTitle, groupDocuments, summarizeDocuments, uiLanguages } from './aas-tooltip-groups';
import type { OrderManagerPluginAPI } from '../core/types/plugin-types';
import { useCustomBranding } from '../core/hmi/branding-store';
import { extractOrderData } from './order-manager-plugin';
import { NavButton } from '../core/hmi/NavButton';
import { modeContext } from '../core/rv-mode-manager';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { openPdfViewer, disposePdfViewer, type PdfLink } from '../core/hmi/pdf-viewer-store';

// ─── Capability Registration (side-effect at import time) ──────────────
// This runs when the plugin module is imported, BEFORE loadGLB() builds the BVH.
// Model plugin loading was moved to the pre-load phase in rv-viewer.ts to ensure this.
registerCapabilities('AASLink', {
  pick: 'select',
  ui: { tooltip: 'aas', badge: '#26a69a', filter: 'AAS', category: 'info', priority: 3 },
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
  return collectAasNodes(viewer.scene);
}

const NO_AAS_MODE: AasModeState = { on: false, count: 0 };
const noSubscribe = () => () => {};

/**
 * Left sidebar button — the AAS mode switch (plan-682 F6). Badge = number of
 * resolvable AAS parts; no button at all while there is none (F2).
 */
function AasButton({ viewer }: UISlotProps) {
  const mode = viewer.getPlugin<AasLinkPlugin>('aas-link')?.aasMode ?? null;
  // Re-render when a resolution pass finishes so the count is never stale even
  // before the plugin's mode controller exists (tests, early boot).
  useSyncExternalStore(subscribeAasResolution, getAasResolutionVersion, getAasResolutionVersion);
  const state = useSyncExternalStore(mode?.subscribe ?? noSubscribe, mode?.getSnapshot ?? (() => NO_AAS_MODE));
  // Live count (cheap traversal, re-run on every resolution pass): also right
  // for content that arrived without a resolution notification.
  const count = getAasNodes(viewer).length;

  const handleClick = useCallback(() => { mode?.toggle(); }, [mode]);

  if (count === 0) return null;

  return (
    <NavButton
      icon={<Description />}
      label="AAS Components"
      badge={count}
      active={state.on}
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
  /**
   * plan-682: a core plugin, registered once in main.ts. `core` keeps it in
   * selective mode (`rv_plugins`) — its UI gates itself on resolvable AAS links,
   * so a document without any never shows a trace of it.
   */
  readonly core = true;

  readonly slots: UISlotEntry[] = [
    // Thomas 2026-11-04: the documents button belongs to the operating views, not to the
    // authoring ones (editor, planner, DES). AAS parts stay hoverable everywhere.
    {
      slot: 'button-group', component: AasButton, order: 45,
      visibilityRule: { hiddenIn: [modeContext('editor'), modeContext('planner'), modeContext('des')] },
    },
  ];

  private viewer: RVViewer | null = null;
  private hoverOff: (() => void) | null = null;
  private unhoverOff: (() => void) | null = null;
  private sourcesOff: (() => void) | null = null;
  private readonly docHoverTipId = 'tooltip-hover:aas-docmode';
  /** plan-435 §2.10 abort generation — bumped by `onDeactivate` and
   *  `onModelCleared`, checked by every deferred / async model step. */
  private _generation = 0;
  /** The load result whose `model-loaded` event has already fired (replay marker). */
  private _emittedResult: LoadResult | null = null;
  private _emittedOff: (() => void) | null = null;
  private _clearedOff: (() => void) | null = null;
  /** One-shot `model-loaded` listener of a load still in progress. */
  private _pendingOff: (() => void) | null = null;
  /** The AAS mode of this viewer (plan-682 Phase 2), created in `init`. */
  aasMode: AasModeController | null = null;

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    // Replay marker: `onModelLoaded` arrives during a load (BEFORE the event,
    // model packs' AAS rewriters still to come) or as a replay of a finished
    // load (`onActivate`, late registration). The event tells them apart.
    // Registered after a load already finished: that load counts as emitted.
    this._emittedResult = viewer.lastLoadResult ?? null;
    this._emittedOff = viewer.on('model-loaded', (payload: { result?: LoadResult }) => {
      this._emittedResult = payload?.result ?? null;
    });
    this._clearedOff = viewer.on('model-cleared', () => { this._emittedResult = null; });
    this.aasMode = new AasModeController(viewer);
  }

  /** Keeps AAS-mode badges on moving parts (no-op while the mode is off). */
  onRender(): void {
    this.aasMode?.update();
  }

  /**
   * plan-682 §2.1: the hook stays (it is what puts the plugin into the viewer's
   * `_modelLoadedIds`, and so what delivers `onModelCleared`), but the model work
   * runs AFTER `model-loaded` — that event fires only after every plugin's
   * `onModelLoaded`, i.e. after model packs rewrote or attached AAS links (demo
   * supplier swap, a CAD-import showcase model attach). Packs register after the core plugins, so
   * running here directly would read the links before they are final.
   */
  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this._pendingOff?.();
    this._pendingOff = null;
    const generation = this._generation;
    if (this._emittedResult === result) {
      // Replay of a finished load: everything is final already.
      this._initForModel(result, viewer, generation);
      return;
    }
    const off = viewer.on('model-loaded', (payload: { result?: LoadResult }) => {
      if (payload?.result !== result) return;
      off();
      if (this._pendingOff === off) this._pendingOff = null;
      if (generation !== this._generation) return;
      this._initForModel(result, viewer, generation);
    });
    this._pendingOff = off;
  }

  /**
   * The model work proper. Resolvability is NOT decided here:
   * `installAasResolution(viewer)` (main.ts) owns it, and its `model-loaded`
   * listener is registered before this plugin exists, so it runs first.
   */
  private _initForModel(result: LoadResult, viewer: RVViewer, generation: number): void {
    if (generation !== this._generation) return;
    _activeViewer = viewer;
    // The AAS document mirror (docs/aas/mirror.json) is NOT probed here: it is
    // loaded when an AAS detail with an external document is read
    // (loadActiveAas), so a project without a mirror never requests it.

    // Motor datasheet on hover. In the layout planner the planner plugin runs
    // the same augmenter with its own placement-aware gate — skip there, or the
    // motor would get two tooltips.
    this.hoverOff?.();
    this.unhoverOff?.();
    this.hoverOff = viewer.on('object-hover', (h: ObjectHoverState | null) => {
      if (viewer.modes?.activeMode === 'planner') { tooltipStore.hide(this.docHoverTipId); return; }
      showDocModeDatasheet(viewer, h, this.docHoverTipId);
    });
    this.unhoverOff = viewer.on('object-unhover', () => tooltipStore.hide(this.docHoverTipId));

    const aasConfig = result.modelConfig?.pluginConfig?.['aas-link'] as
      { assetsBasePath?: string; pdfLinks?: Record<string, string> } | undefined;

    // Search text from the INDEX metadata (idShort, product name, manufacturer)
    // only. No archive is opened at model start (plan-596 SOL #8): the package
    // is read when a tooltip or the detail panel asks for it.
    this._applyIndexMetadata(viewer, generation);
    this.sourcesOff?.();
    this.sourcesOff = subscribeAasSources(() => this._applyIndexMetadata(viewer, this._generation));

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
              const links = node.userData._rvPdfLinks as PdfLink[];
              // Resolve PDF URL: if a docs base applies and the URL is
              // relative, prepend it. Absolute URLs are left untouched.
              const resolvedUrl = docsBasePath && !pdfUrl.startsWith('http') && !pdfUrl.startsWith('/')
                ? `${docsBasePath}${pdfUrl}`
                : pdfUrl;
              // Idempotent: a replay (onActivate) must not add the link twice.
              if (links.some(l => l.source.type === 'url' && l.source.url === resolvedUrl)) continue;
              links.push({
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
   * Write the index metadata of every linked AAS id onto its nodes as search
   * text, and drop AAS-generated PDF links of ids the index no longer knows.
   * Results of an older source revision are discarded.
   */
  private _applyIndexMetadata(viewer: RVViewer, generation: number): void {
    const source = getActiveAasSource();
    const revision = source.revision;
    loadIndex(source).then(index => {
      // Abort guard (plan-435 §2.10): switched off while the index was in flight.
      if (generation !== this._generation) return;
      // The index changed meanwhile; the change notification re-runs this.
      if (source.revision !== revision || getActiveAasSource() !== source) return;
      viewer.scene.traverse(node => {
        const aas = node.userData?._rvAasLink as Record<string, unknown> | undefined;
        const aasId = aas?.aasId as string | undefined;
        if (!aas || !aasId) return;
        const entry = index[aasId];
        if (!entry) {
          delete aas.searchText;
          replaceAasPdfLinks(node, aasId, [], null);
          return;
        }
        aas.searchText = [entry.productName, entry.manufacturer, entry.idShort].filter(Boolean).join(' ');
      });
    }).catch(() => { /* index unavailable: search just won't include it */ });
  }

  /** Detach everything bound to the current model (clear / deactivate / dispose). */
  private _detachModel(): void {
    this._generation++;
    this._pendingOff?.();
    this._pendingOff = null;
    this.sourcesOff?.();
    this.sourcesOff = null;
    this.hoverOff?.();
    this.unhoverOff?.();
    this.hoverOff = null;
    this.unhoverOff = null;
    tooltipStore.hide(this.docHoverTipId);
  }

  onModelCleared(): void {
    this._detachModel();
    this.aasMode?.reset();
  }

  /**
   * plan-435: switched off — detach the hover augmenter, drop a pending deferred
   * init and cancel the in-flight AASX indexing (§2.10). The scene markings
   * written by a completed index are model data owned by `onModelCleared`-style
   * teardown, not by this hook (invariant 3).
   */
  onDeactivate(): void {
    this._detachModel();
    this.aasMode?.reset();
  }

  /** Re-attach the model work for the model that is still loaded (a replay). */
  onActivate(viewer: RVViewer): void {
    const result = viewer.lastLoadResult;
    if (result) this.onModelLoaded(result, viewer);
  }

  dispose(): void {
    this._detachModel();
    this.aasMode?.dispose();
    this.aasMode = null;
    this._emittedOff?.();
    this._clearedOff?.();
    this._emittedOff = null;
    this._clearedOff = null;
    disposePdfViewer();
    if (_activeViewer === this.viewer) _activeViewer = null;
    this.viewer = null;
  }
}

// ─── Index-driven helpers (plan-596) ────────────────────────────────────

/** The viewer of the last model load — the detail panel has no viewer prop. */
let _activeViewer: RVViewer | null = null;

/** Marker on PDF links generated from an AASX, so they can be replaced. */
interface AasPdfLink extends PdfLink { aasGenerated?: string }

/**
 * Replace the AAS-generated PDF links of `node` for `aasId` with `docs`
 * (plan-596 SOL #6). Links of other ids and links from other origins
 * (`pluginConfig.pdfLinks`, docs index) stay untouched.
 */
export function replaceAasPdfLinks(node: Object3D, aasId: string, docs: readonly AasDocument[], sourceKey: string | null): void {
  const existing = (node.userData._rvPdfLinks as AasPdfLink[] | undefined) ?? [];
  const kept = existing.filter(l => l.aasGenerated !== aasId);
  const added: AasPdfLink[] = docs.map(doc => ({
    title: doc.title,
    source: doc.url ? { type: 'external', url: doc.url } : { type: 'blob', aasId, zipPath: doc.zipPath, ...(sourceKey ? { sourceKey } : {}) },
    aasGenerated: aasId,
  }));
  const next = [...kept, ...added];
  if (next.length > 0) node.userData._rvPdfLinks = next;
  else if (node.userData._rvPdfLinks) delete node.userData._rvPdfLinks;
}

/** Apply the documents of a loaded detail to every node linking `aasId`. */
function applyAasPdfLinks(viewer: RVViewer | null | undefined, aasId: string, docs: readonly AasDocument[], sourceKey: string): void {
  const scene = viewer?.scene;
  if (!scene) return;
  scene.traverse(node => {
    const aas = node.userData?._rvAasLink as { aasId?: string } | undefined;
    if (aas?.aasId === aasId) replaceAasPdfLinks(node, aasId, docs, sourceKey);
  });
}

/** Re-render on every AAS source change (useSyncExternalStore). */
function useAasSourcesVersion(): number {
  return useSyncExternalStore(subscribeAasSources, getAasSourcesVersion, getAasSourcesVersion);
}

/**
 * Load the index entry and the detail of `aasId` from the active source:
 * lookup first (entry + the source that holds it), then the detail from
 * exactly that source. Calls `onEntry`/`onDetail` unless cancelled or the
 * source revision moved on.
 */
function loadActiveAas(
  aasId: string,
  isCancelled: () => boolean,
  handlers: {
    onEntry: (entry: AasIndexEntry | null) => void;
    onDetail: (parsed: AasParsedData, source: AasSource) => void;
    onError: (message: string) => void;
  },
): void {
  const source = getActiveAasSource();
  const revision = source.revision;
  const stale = () => isCancelled() || source.revision !== revision;
  lookupAas(source, aasId)
    .then(async (lookup) => {
      if (stale()) return;
      handlers.onEntry(lookup?.entry ?? null);
      if (!lookup) throw new Error(`AAS ID not found in index: ${aasId}`);
      const parsed = await loadAasDetail(lookup, aasId);
      if (stale()) return;
      // An AAS that links an external document needs the project's mirror
      // mapping before the first click; one without such a link never reads it.
      void prefetchAasDocumentMirrorFor((parsed.documents ?? []).map((d) => d.url));
      handlers.onDetail(parsed, lookup.source);
    })
    .catch((err) => {
      if (stale()) return;
      handlers.onError(err instanceof Error ? err.message : String(err));
    });
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

// ─── Grouped documents (plan-682 Phase 3) ───────────────────────────────

/** Where a document opens: external address in a new tab, package entry in the PDF viewer. */
function documentSource(doc: AasDocument, aasId: string, sourceKey: string | null): PdfLink['source'] {
  return doc.url
    ? { type: 'external', url: doc.url }
    : { type: 'blob', aasId, zipPath: doc.zipPath, ...(sourceKey ? { sourceKey } : {}) };
}

function openDocument(doc: AasDocument, aasId: string, sourceKey: string | null): void {
  openPdfViewer(displayTitle(doc), documentSource(doc, aasId, sourceKey));
}

/** Small language chip; clickable when it opens a translation. */
function LangChip({ lang, active, onClick }: { lang: string; active: boolean; onClick?: () => void }) {
  return (
    <Box
      component={onClick ? 'button' : 'span'}
      onClick={onClick ? (e: React.MouseEvent) => { e.stopPropagation(); onClick(); } : undefined}
      title={onClick ? `Open the ${lang} version` : undefined}
      sx={{
        font: 'inherit', fontSize: 9, fontWeight: 700, lineHeight: '14px', px: 0.5, borderRadius: 0.5,
        border: '1px solid', borderColor: active ? 'rgba(79,195,247,0.6)' : 'rgba(255,255,255,0.25)',
        color: active ? '#4fc3f7' : 'rgba(255,255,255,0.6)', bgcolor: 'transparent',
        cursor: onClick ? 'pointer' : 'default', flexShrink: 0,
        '&:hover': onClick ? { borderColor: '#4fc3f7', color: '#4fc3f7' } : undefined,
      }}
    >
      {lang}
    </Box>
  );
}

/**
 * Documents grouped by kind, every group collapsed by default with its count in
 * the header ("Application description (7)"); translations of one document are
 * one row in the UI language with the other languages as chips.
 */
export function AasDocumentGroups({ docs, aasId, sourceKey, large = false }: {
  docs: readonly AasDocument[];
  aasId: string;
  sourceKey: string | null;
  large?: boolean;
}) {
  const groups = useMemo(() => groupDocuments(docs, uiLanguages()), [docs]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  if (groups.length === 0) return null;
  const fs = large ? 12 : 10;
  const toggle = (key: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  return (
    <Box data-testid="aas-document-groups">
      <SectionHeader text="Documents" />
      {groups.map((g) => {
        const expanded = open.has(g.key);
        return (
          <Box key={g.key} data-testid={`aas-doc-group:${g.key}`}>
            <Box
              component="button"
              onClick={() => toggle(g.key)}
              aria-expanded={expanded}
              sx={{
                all: 'unset', boxSizing: 'border-box', width: '100%', display: 'flex', alignItems: 'center', gap: 0.5,
                cursor: 'pointer', py: 0.25, borderRadius: 0.5, color: 'rgba(255,255,255,0.85)',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
              }}
            >
              {expanded ? <ExpandMore sx={{ fontSize: fs + 4 }} /> : <ChevronRight sx={{ fontSize: fs + 4 }} />}
              <Typography component="span" sx={{ fontSize: fs, fontWeight: 600, flex: 1 }}>
                {g.label} ({g.entries.length})
              </Typography>
            </Box>
            {expanded && g.entries.map((e, i) => {
              const primaryLang = (e.primary.language ?? '').toUpperCase();
              return (
                <Box
                  key={`${g.key}-${i}`}
                  onClick={() => openDocument(e.primary, aasId, sourceKey)}
                  sx={{
                    display: 'flex', alignItems: 'center', gap: 0.5, pl: 2, py: 0.25,
                    cursor: 'pointer', borderRadius: 0.5,
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
                  }}
                >
                  <PictureAsPdf sx={{ fontSize: fs + 2, color: '#ef5350', flexShrink: 0 }} />
                  <Typography component="span" sx={{ color: '#fff', fontSize: fs, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                    {e.title}
                  </Typography>
                  {e.primary.version && (
                    <Typography component="span" sx={{ color: 'rgba(255,255,255,0.4)', fontSize: fs - 1, flexShrink: 0 }}>
                      v{e.primary.version}
                    </Typography>
                  )}
                  {primaryLang && <LangChip lang={primaryLang} active />}
                  {e.alternates.map((alt, j) => (
                    <LangChip
                      key={j}
                      lang={(alt.language ?? '?').toUpperCase()}
                      active={false}
                      onClick={() => openDocument(alt, aasId, sourceKey)}
                    />
                  ))}
                </Box>
              );
            })}
          </Box>
        );
      })}
    </Box>
  );
}

/** Hover tooltip: one compact line, never the list (plan-682 F12). */
function AasDocumentSummary({ docs }: { docs: readonly AasDocument[] }) {
  const text = useMemo(() => summarizeDocuments(groupDocuments(docs, uiLanguages())), [docs]);
  if (!text) return null;
  return (
    <Typography
      variant="caption"
      sx={{ color: 'rgba(255,255,255,0.45)', fontSize: 10, mt: 0.5, display: 'flex', alignItems: 'center', gap: 0.5 }}
    >
      <PictureAsPdf sx={{ fontSize: 10, color: '#ef5350' }} />
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
  const [docSourceKey, setDocSourceKey] = useState<string | null>(null);
  // plan-682 §2.7: the same gate as the cart panel (hidden in `mode:viewer`).
  const cartAvailable = useCartAvailable();
  // The data resolver already refuses an unresolvable link; this repeats the gate
  // for tooltip data built by other callers. Hooks stay above the early return.
  const hidden = data.resolution !== undefined && !isAasVisible(data.resolution);

  // A source change (scan, import) re-runs the load against the new revision.
  const sourcesVersion = useAasSourcesVersion();

  useEffect(() => {
    if (hidden) return;
    if (!data.aasId) {
      setState('error');
      setError('No AAS ID');
      return;
    }

    setState('loading');
    let cancelled = false;

    // The archive is opened here, on demand (plan-596 SOL #8), from the source
    // that listed the id (SOL #4).
    loadActiveAas(data.aasId, () => cancelled, {
      onEntry: (entry) => setIndexEntry(entry),
      onDetail: (result, source) => {
        setParsed(result);
        setDocSourceKey(source.key);
        setState('success');
        applyAasPdfLinks(viewer, data.aasId, result.documents, source.key);
      },
      onError: (message) => {
        setError(message);
        setState('error');
      },
    });

    return () => { cancelled = true; };
  }, [data.aasId, hidden, sourcesVersion, viewer]);

  // Header: description from rv_extras, else the product name (index metadata
  // first, it is there before the archive is read), else idShort, else the id.
  const headerText = data.description
    || indexEntry?.productName
    || parsed?.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value
    || parsed?.idShort
    || indexEntry?.idShort
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
            {/* plan-682 F10/F12: documents grouped by kind (pinned), one summary line (hover). */}
            {isPinned
              ? <AasDocumentGroups docs={parsed.documents} aasId={data.aasId} sourceKey={docSourceKey} />
              : <AasDocumentSummary docs={parsed.documents} />}
          </Box>
        );
      })()}

      {/* ── "Add to Cart" full-width button at bottom (pinned only — hover tooltips have no pointer events) ── */}
      {isPinned && cartAvailable && (() => {
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

  const [sourceKey, setSourceKey] = useState<string | null>(null);
  const sourcesVersion = useAasSourcesVersion();

  useEffect(() => {
    if (!state.open || !state.aasId) { setParsed(null); setIndexEntry(null); setSourceKey(null); return; }

    setLoading(true);
    setError('');
    let cancelled = false;

    loadActiveAas(state.aasId, () => cancelled, {
      onEntry: (entry) => setIndexEntry(entry),
      onDetail: (result, source) => {
        setParsed(result);
        setSourceKey(source.key);
        setLoading(false);
        applyAasPdfLinks(_activeViewer, state.aasId, result.documents, source.key);
      },
      onError: (message) => { setError(message); setLoading(false); },
    });

    return () => { cancelled = true; };
  }, [state.open, state.aasId, sourcesVersion]);

  const headerText = state.description
    || indexEntry?.productName
    || parsed?.nameplate.find(p => p.label === 'Manufacturer Product Designation')?.value
    || parsed?.idShort
    || indexEntry?.idShort
    || state.aasId;

  return (
    <FloatingPanel
      open={state.open}
      onClose={closeAasDetail}
      title={`AAS ${headerText}`}
      panelId="aas-link"
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
              <AasDocumentGroups docs={parsed.documents} aasId={state.aasId} sourceKey={sourceKey} large />
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
