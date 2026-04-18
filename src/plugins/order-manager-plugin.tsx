// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * order-manager-plugin.tsx — Order Manager (Warenkorb) for the realvirtual WebViewer.
 *
 * Allows users to add components with AAS data into an order cart,
 * adjust quantities, and export the cart as CSV, email, or online order.
 * The plugin is optional and must be explicitly registered via viewer.use().
 *
 * Follows the established annotation-plugin pattern:
 * - Module-level Pub/Sub store with subscribe/getSnapshot
 * - LeftPanel + NavButton for UI
 * - sessionStorage for persistence (per session, clears on tab close)
 */

import { useState, useSyncExternalStore, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Button,
  Divider,
  Snackbar,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@mui/material';
import {
  ShoppingCart,
  Delete,
  Add,
  Remove,
  Close,
  FileDownload,
  Email,
  Visibility,
} from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type {
  OrderItem,
  OrderSnapshot,
  OrderManagerPluginAPI,
  OrderManagerConfig,
} from '../core/types/plugin-types';
import { loadAasxById, type AasParsedData } from './aas-link-parser';
import { parseTags, extractAttr } from '../core/hmi/tooltip/MetadataTooltipContent';
import { NavButton } from '../core/hmi/NavButton';
import { LeftPanel } from '../core/hmi/LeftPanel';
import { ORDER_PANEL_WIDTH } from '../core/hmi/layout-constants';
import { RV_SCROLL_CLASS } from '../core/hmi/shared-sx';

// ── Constants ──────────────────────────────────────────────────────────

const SS_KEY = 'rv-order-cart';
const UNDO_TIMEOUT_MS = 3000;

// ── Module-level Store (Pub/Sub for React useSyncExternalStore) ───────

type Listener = () => void;

let _items: OrderItem[] = [];
const _listeners = new Set<Listener>();
let _snapshot: OrderSnapshot = { items: [], totalPositions: 0, totalQuantity: 0 };

/** Pending delete items: aasId -> { item, timerId } */
const _pendingDeletes = new Map<string, { item: OrderItem; timerId: ReturnType<typeof setTimeout> }>();

function _emitSnapshot(): void {
  _snapshot = {
    items: [..._items],
    totalPositions: _items.length,
    totalQuantity: _items.reduce((sum, it) => sum + it.quantity, 0),
  };
  for (const l of _listeners) l();
}

/** React hook support: subscribe to order store changes. */
export function subscribeOrderStore(listener: Listener): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** React hook support: get current snapshot (referentially stable until mutation). */
export function getOrderSnapshot(): OrderSnapshot {
  return _snapshot;
}

// ── sessionStorage helpers (try/catch for Safari Private Mode) ────────

function _saveToSession(): void {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify(_items));
  } catch {
    // SecurityError in Private Mode — gracefully ignore
  }
}

function _loadFromSession(): OrderItem[] {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (it: unknown): it is OrderItem =>
        typeof it === 'object' && it !== null &&
        typeof (it as OrderItem).aasId === 'string' &&
        typeof (it as OrderItem).quantity === 'number',
    );
  } catch {
    return [];
  }
}

function _clearSession(): void {
  try {
    sessionStorage.removeItem(SS_KEY);
  } catch {
    // SecurityError — ignore
  }
}

// ── AAS Data Extraction ──────────────────────────────────────────────

/**
 * Extract order-relevant fields from AAS parsed data.
 * Uses case-insensitive includes matching to handle label variations
 * across AAS V1/V2/V3 (e.g. "ManufacturerProductDesignation",
 * "Manufacturer Product Designation", etc.).
 */
export function extractOrderData(parsed: AasParsedData): Partial<OrderItem> {
  /**
   * Find a nameplate property by matching candidate labels against the
   * property label. Normalizes both sides by removing spaces/underscores
   * and comparing case-insensitively. This handles AAS V1/V2/V3 label
   * variations (e.g. "ManufacturerName" vs "Manufacturer Name" vs
   * "manufacturer_name").
   */
  const normalize = (s: string): string => s.replace(/[\s_-]/g, '').toLowerCase();

  const get = (labels: string[]): string => {
    for (const l of labels) {
      const nl = normalize(l);
      const match = parsed.nameplate.find(p => normalize(p.label).includes(nl));
      if (match) return match.value;
    }
    return '';
  };

  return {
    aasId: parsed.aasId,
    displayName: get(['ProductDesignation', 'Designation']) || parsed.idShort,
    manufacturer: get(['ManufacturerName']),
    articleNumber: get(['ArticleNumber', 'OrderCode', 'PartNumber']),
  };
}

// ── Metadata Order Data Extraction ──────────────────────────────────

const DEFAULT_ARTICLE_LABELS = ['Article', 'ArticleNumber', 'OrderCode', 'PartNumber'];
const DEFAULT_DESCRIPTION_LABELS = ['English', 'Description', 'Designation'];
const DEFAULT_MANUFACTURER_LABELS = ['Manufacturer', 'ManufacturerName'];

/**
 * Extract order-relevant fields from RuntimeMetadata content string.
 * Parses `<value label="...">text</value>` tags and matches against
 * configurable label lists (case-insensitive).
 *
 * Returns null if no article number is found (component is not orderable).
 */
export function extractMetadataOrderData(
  content: string,
  nodeName: string,
  articleLabels: string[] = DEFAULT_ARTICLE_LABELS,
  descriptionLabels: string[] = DEFAULT_DESCRIPTION_LABELS,
  manufacturerLabels: string[] = DEFAULT_MANUFACTURER_LABELS,
): Partial<OrderItem> | null {
  const tags = parseTags(content);
  const normalize = (s: string): string => s.replace(/[\s_-]/g, '').toLowerCase();

  const getByLabels = (candidates: string[]): string => {
    for (const candidate of candidates) {
      const nc = normalize(candidate);
      for (const t of tags) {
        if (t.tag !== 'value') continue;
        const label = extractAttr(t.attributes, 'label') ?? '';
        if (normalize(label).includes(nc)) return t.text;
      }
    }
    return '';
  };

  const articleNumber = getByLabels(articleLabels);
  if (!articleNumber) return null; // No article = not orderable

  // Use <name> tag as fallback display name
  const nameTag = tags.find(t => t.tag === 'name');
  const displayName = getByLabels(descriptionLabels) || nameTag?.text || nodeName;
  const manufacturer = getByLabels(manufacturerLabels);

  return {
    aasId: articleNumber, // Use article number as unique ID
    displayName,
    manufacturer,
    articleNumber,
  };
}

/**
 * Check if a node's RuntimeMetadata content has an article number
 * (i.e. is orderable).
 */
export function hasMetadataArticle(
  node: import('three').Object3D,
  articleLabels: string[] = DEFAULT_ARTICLE_LABELS,
): boolean {
  const meta = node.userData?._rvMetadata as { content: string } | undefined;
  if (!meta?.content) return false;
  const tags = parseTags(meta.content);
  const normalize = (s: string): string => s.replace(/[\s_-]/g, '').toLowerCase();
  for (const candidate of articleLabels) {
    const nc = normalize(candidate);
    for (const t of tags) {
      if (t.tag !== 'value') continue;
      const label = extractAttr(t.attributes, 'label') ?? '';
      if (normalize(label).includes(nc)) return !!t.text;
    }
  }
  return false;
}

// ── Store mutation functions ──────────────────────────────────────────

function _addItem(
  aasId: string,
  displayName: string,
  manufacturer: string,
  articleNumber: string,
  nodePath?: string,
): void {
  // Cancel pending delete if same aasId is re-added (undo)
  const pending = _pendingDeletes.get(aasId);
  if (pending) {
    clearTimeout(pending.timerId);
    _pendingDeletes.delete(aasId);
    // Restore the item
    _items.push(pending.item);
    _emitSnapshot();
    _saveToSession();
    return;
  }

  // Duplicate check: same aasId -> increment quantity
  const existing = _items.find(it => it.aasId === aasId);
  if (existing) {
    existing.quantity += 1;
  } else {
    _items.push({
      aasId,
      displayName,
      manufacturer,
      articleNumber,
      quantity: 1,
      addedAt: Date.now(),
      nodePath,
    });
  }
  _emitSnapshot();
  _saveToSession();
}

/**
 * Immediately remove an item from the visible list and start an undo timer.
 * Returns the removed item (or null if not found) for undo display.
 */
function _removeItem(aasId: string): OrderItem | null {
  const idx = _items.findIndex(it => it.aasId === aasId);
  if (idx < 0) return null;

  const removed = _items.splice(idx, 1)[0];
  _emitSnapshot();
  _saveToSession();

  return removed;
}

function _updateQuantity(aasId: string, qty: number): void {
  const item = _items.find(it => it.aasId === aasId);
  if (!item) return;
  // Guard: NaN, Infinity, < 1
  const safeQty = Number.isFinite(qty) ? Math.max(1, Math.round(qty)) : 1;
  item.quantity = safeQty;
  _emitSnapshot();
  _saveToSession();
}

function _clear(): void {
  // Cancel all pending deletes
  for (const pending of _pendingDeletes.values()) {
    clearTimeout(pending.timerId);
  }
  _pendingDeletes.clear();
  _items = [];
  _emitSnapshot();
  _saveToSession();
}

function _exportCsv(): string {
  const escapeField = (val: string): string => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const header = 'ArticleNumber,Description,Manufacturer,Quantity';
  const rows = _items.map(it =>
    [
      escapeField(it.articleNumber),
      escapeField(it.displayName),
      escapeField(it.manufacturer),
      String(it.quantity),
    ].join(','),
  );
  return [header, ...rows].join('\n');
}

// ── Plugin Class ─────────────────────────────────────────────────────

export class OrderManagerPlugin implements RVViewerPlugin, OrderManagerPluginAPI {
  readonly id = 'order-manager';
  readonly order = 60;

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: OrderManagerButton, order: 50 },
  ];

  private _config: OrderManagerConfig;
  private _viewer: RVViewer | null = null;
  private _undoTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: OrderManagerConfig = {}) {
    this._config = config;
  }

  // ── OrderManagerPluginAPI ──────────────────────────────────────────

  addItem(
    aasId: string,
    displayName: string,
    manufacturer: string,
    articleNumber: string,
    nodePath?: string,
  ): void {
    _addItem(aasId, displayName, manufacturer, articleNumber, nodePath);
    // Auto-open the order panel when an item is added
    if (this._viewer) {
      this._viewer.leftPanelManager.open('order-manager', ORDER_PANEL_WIDTH);
    }
  }

  removeItem(aasId: string): void {
    _removeItem(aasId);
  }

  updateQuantity(aasId: string, qty: number): void {
    _updateQuantity(aasId, qty);
  }

  clear(): void {
    _clear();
  }

  getItems(): readonly OrderItem[] {
    return [..._items];
  }

  exportCsv(): string {
    return _exportCsv();
  }

  orderOnline(): void {
    // Handled by UI — this is called from the panel
    // Actual POST/GET logic is in the OrderPanel component
  }

  get config(): OrderManagerConfig {
    return this._config;
  }

  // ── RVViewerPlugin Lifecycle ────────────────────────────────────────

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;

    // Restore from sessionStorage
    const restored = _loadFromSession();
    if (restored.length > 0) {
      _items = restored;
      _emitSnapshot();
    }

    // Register context menu
    const artLabels = this._config.metadataArticleLabels ?? DEFAULT_ARTICLE_LABELS;
    const descLabels = this._config.metadataDescriptionLabels ?? DEFAULT_DESCRIPTION_LABELS;
    const mfgLabels = this._config.metadataManufacturerLabels ?? DEFAULT_MANUFACTURER_LABELS;

    viewer.contextMenu.register({
      pluginId: 'order-manager',
      items: [
        {
          id: 'order-manager.add-to-cart',
          label: 'Add to Cart',
          order: 55,
          dividerBefore: true,
          condition: (target) => {
            // Show if node has AAS data OR RuntimeMetadata with article number
            const aas = target.node.userData?._rvAasLink as { aasId?: string } | undefined;
            if (aas?.aasId) return true;
            return hasMetadataArticle(target.node, artLabels);
          },
          action: (target) => {
            // Try AAS first
            const aas = target.node.userData?._rvAasLink as { aasId: string; description?: string } | undefined;
            if (aas?.aasId) {
              loadAasxById(aas.aasId).then(parsed => {
                const orderData = extractOrderData(parsed);
                this.addItem(
                  orderData.aasId ?? aas.aasId,
                  aas.description || orderData.displayName || target.path.split('/').pop() || 'Component',
                  orderData.manufacturer ?? '',
                  orderData.articleNumber ?? '',
                  target.path,
                );
              }).catch(() => {
                const displayName = aas.description || target.path.split('/').pop() || 'Component';
                this.addItem(aas.aasId, displayName, '', '', target.path);
              });
              return;
            }
            // Fallback: extract from RuntimeMetadata
            const meta = target.node.userData?._rvMetadata as { content: string } | undefined;
            if (meta?.content) {
              const nodeName = target.path.split('/').pop() || 'Component';
              const orderData = extractMetadataOrderData(meta.content, nodeName, artLabels, descLabels, mfgLabels);
              if (orderData) {
                this.addItem(
                  orderData.aasId ?? nodeName,
                  orderData.displayName ?? nodeName,
                  orderData.manufacturer ?? '',
                  orderData.articleNumber ?? '',
                  target.path,
                );
              }
            }
          },
        },
      ],
    });
  }

  onModelCleared(): void {
    // Cancel undo timers
    if (this._undoTimer) {
      clearTimeout(this._undoTimer);
      this._undoTimer = null;
    }
    for (const pending of _pendingDeletes.values()) {
      clearTimeout(pending.timerId);
    }
    _pendingDeletes.clear();

    // Clear items
    _items = [];
    _emitSnapshot();
    _clearSession();
  }

  dispose(): void {
    // Cancel all timers
    if (this._undoTimer) {
      clearTimeout(this._undoTimer);
      this._undoTimer = null;
    }
    for (const pending of _pendingDeletes.values()) {
      clearTimeout(pending.timerId);
    }
    _pendingDeletes.clear();
    this._viewer = null;
  }
}

// ── NavButton Component ──────────────────────────────────────────────

function OrderManagerButton({ viewer }: UISlotProps) {
  const snap = useSyncExternalStore(subscribeOrderStore, getOrderSnapshot);
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = panelSnap.activePanel === 'order-manager';

  const handleClick = useCallback(() => {
    lpm.toggle('order-manager', ORDER_PANEL_WIDTH);
  }, [lpm]);

  return (
    <NavButton
      icon={<ShoppingCart />}
      label="Order Cart"
      badge={snap.totalPositions > 0 ? snap.totalPositions : undefined}
      active={isActive}
      onClick={handleClick}
    />
  );
}

// ── OrderPanel Component ─────────────────────────────────────────────

export function OrderPanel() {
  const viewer = useViewer();
  const branding = useCustomBranding();
  const accentColor = branding?.primaryColor ?? undefined;
  const snap = useSyncExternalStore(subscribeOrderStore, getOrderSnapshot);
  const lpm = viewer.leftPanelManager;
  const isOpen = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot).activePanel === 'order-manager';
  const plugin = viewer.getPlugin('order-manager') as (OrderManagerPluginAPI & OrderManagerPlugin) | undefined;

  // Undo snackbar state
  const [undoItem, setUndoItem] = useState<OrderItem | null>(null);
  const [showUndo, setShowUndo] = useState(false);

  // Demo dialog state
  const [showDemoDialog, setShowDemoDialog] = useState(false);

  // Order success/error snackbar
  const [orderMsg, setOrderMsg] = useState('');
  const [showOrderMsg, setShowOrderMsg] = useState(false);

  const handleClose = useCallback(() => {
    lpm.close('order-manager');
  }, [lpm]);

  const handleDelete = useCallback((aasId: string) => {
    const removed = _removeItem(aasId);
    if (removed) {
      setUndoItem(removed);
      setShowUndo(true);

      // Start pending delete timer
      const timerId = setTimeout(() => {
        _pendingDeletes.delete(aasId);
        setShowUndo(false);
        setUndoItem(null);
      }, UNDO_TIMEOUT_MS);
      _pendingDeletes.set(aasId, { item: removed, timerId });
    }
  }, []);

  const handleUndo = useCallback(() => {
    if (!undoItem) return;
    const pending = _pendingDeletes.get(undoItem.aasId);
    if (pending) {
      clearTimeout(pending.timerId);
      _pendingDeletes.delete(undoItem.aasId);
      // Restore item
      _items.push(pending.item);
      _emitSnapshot();
      _saveToSession();
    }
    setShowUndo(false);
    setUndoItem(null);
  }, [undoItem]);

  const handleUndoClose = useCallback(() => {
    setShowUndo(false);
    setUndoItem(null);
  }, []);

  const handleCsvExport = useCallback(() => {
    const csv = _exportCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'order-request.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const handleEmailExport = useCallback(() => {
    const email = plugin?.config.orderEmail ?? '';
    const subject = encodeURIComponent('Order Request - realvirtual WebViewer');
    const lines = _items.map(
      it => `${it.articleNumber} | ${it.displayName} | ${it.manufacturer} | Qty: ${it.quantity}`,
    );
    const body = encodeURIComponent(
      'Order Request\n' +
      '=============\n\n' +
      'ArticleNumber | Description | Manufacturer | Quantity\n' +
      lines.join('\n') +
      '\n\nGenerated by realvirtual WebViewer',
    );
    window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_self');
  }, [plugin]);

  const handleOrderOnline = useCallback(async () => {
    if (!plugin) return;
    const cfg = plugin.config;

    if (!cfg.orderUrl) {
      setShowDemoDialog(true);
      return;
    }

    // Build payload
    const payload = {
      items: _items.map(it => ({
        articleNumber: it.articleNumber,
        description: it.displayName,
        manufacturer: it.manufacturer,
        quantity: it.quantity,
      })),
      timestamp: new Date().toISOString(),
      source: 'realvirtual-webviewer',
    };

    if (cfg.orderMethod === 'GET') {
      const qs = encodeURIComponent(JSON.stringify(payload.items));
      window.open(`${cfg.orderUrl}?items=${qs}`, '_blank');
      return;
    }

    // POST
    try {
      const resp = await fetch(cfg.orderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (resp.ok) {
        setOrderMsg('Order submitted successfully');
      } else {
        setOrderMsg(`Order failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err) {
      setOrderMsg(`Order failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setShowOrderMsg(true);
  }, [plugin]);

  const handleClear = useCallback(() => {
    _clear();
  }, []);

  if (!isOpen || !plugin) return null;

  const hasItems = snap.items.length > 0;

  const footer = hasItems ? (
    <Box sx={{ p: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
      <Button
        variant="contained"
        size="small"
        startIcon={<ShoppingCart />}
        onClick={handleOrderOnline}
        sx={{ fontSize: 11, textTransform: 'none',
          ...(accentColor ? { bgcolor: accentColor, '&:hover': { bgcolor: accentColor, filter: 'brightness(1.15)' } } : {}),
        }}
      >
        Order Online
      </Button>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={<FileDownload />}
          onClick={handleCsvExport}
          sx={{ fontSize: 10, textTransform: 'none', flex: 1,
            ...(accentColor ? { color: accentColor, borderColor: `${accentColor}80` } : {}),
          }}
        >
          CSV
        </Button>
        <Button
          variant="outlined"
          size="small"
          startIcon={<Email />}
          onClick={handleEmailExport}
          sx={{ fontSize: 10, textTransform: 'none', flex: 1,
            ...(accentColor ? { color: accentColor, borderColor: `${accentColor}80` } : {}),
          }}
        >
          Email
        </Button>
      </Box>
      <Button
        variant="text"
        size="small"
        startIcon={<Delete />}
        onClick={handleClear}
        sx={{ fontSize: 10, textTransform: 'none', color: 'text.secondary' }}
      >
        Clear Cart
      </Button>
    </Box>
  ) : undefined;

  return (
    <>
      <LeftPanel
        title={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ShoppingCart sx={{ fontSize: 14, color: accentColor ?? 'primary.main' }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.primary' }}>
              Order Cart
            </Typography>
          </Box>
        }
        onClose={handleClose}
        width={ORDER_PANEL_WIDTH}
        footer={footer}
      >
        {/* Summary line with "Show All in 3D" button */}
        {hasItems && (
          <>
            <Box sx={{ px: 1, py: 0.5, display: 'flex', alignItems: 'center' }}>
              <Typography sx={{ fontSize: 10, color: 'text.secondary', flex: 1 }}>
                {snap.totalPositions} position{snap.totalPositions !== 1 ? 's' : ''}, {snap.totalQuantity} item{snap.totalQuantity !== 1 ? 's' : ''}
              </Typography>
              <Button
                size="small"
                startIcon={<Visibility sx={{ fontSize: 12 }} />}
                onClick={() => {
                  const paths = snap.items.map(it => it.nodePath).filter(Boolean) as string[];
                  if (paths.length === 0) return;
                  // Resolve nodes for highlight + fit
                  const nodes = paths
                    .map(p => viewer.registry?.getNode(p))
                    .filter(Boolean) as import('three').Object3D[];
                  if (nodes.length === 0) return;
                  viewer.highlighter.highlightMultiple(nodes);
                  viewer.fitToNodes(nodes);
                }}
                sx={{
                  fontSize: 9,
                  textTransform: 'none',
                  color: '#26a69a',
                  minWidth: 0,
                  py: 0,
                  px: 0.75,
                }}
              >
                Show All
              </Button>
            </Box>
            <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)' }} />
          </>
        )}

        {/* Item list */}
        <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
          {!hasItems && (
            <Box sx={{ textAlign: 'center', py: 4, px: 2 }}>
              <ShoppingCart sx={{ fontSize: 32, color: 'rgba(255,255,255,0.15)', mb: 1 }} />
              <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', mb: 1 }}>
                Cart is empty
              </Typography>
              <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', lineHeight: 1.5 }}>
                Click the cart icon in the tooltip of a component with AAS data to add it.
              </Typography>
            </Box>
          )}
          {snap.items.map((item) => (
            <OrderItemCard
              key={item.aasId}
              item={item}
              onQuantityChange={(qty) => _updateQuantity(item.aasId, qty)}
              onDelete={() => handleDelete(item.aasId)}
              onHover={() => {
                if (item.nodePath) viewer.highlightByPath(item.nodePath, true);
              }}
              onHoverEnd={() => {
                viewer.clearHighlight();
              }}
              onClick={() => {
                if (item.nodePath) {
                  viewer.selectionManager?.select(item.nodePath);
                  viewer.focusByPath(item.nodePath);
                }
              }}
            />
          ))}
        </Box>
      </LeftPanel>

      {/* Undo Snackbar */}
      <Snackbar
        open={showUndo}
        autoHideDuration={UNDO_TIMEOUT_MS}
        onClose={handleUndoClose}
        message={undoItem ? `Removed "${undoItem.displayName}"` : ''}
        action={
          <Button color="primary" size="small" onClick={handleUndo}>
            Undo
          </Button>
        }
        sx={{ '& .MuiSnackbarContent-root': { fontSize: 11 } }}
      />

      {/* Order result Snackbar */}
      <Snackbar
        open={showOrderMsg}
        autoHideDuration={4000}
        onClose={() => setShowOrderMsg(false)}
        message={orderMsg}
        sx={{ '& .MuiSnackbarContent-root': { fontSize: 11 } }}
      />

      {/* Demo Dialog */}
      <OrderDemoDialog open={showDemoDialog} onClose={() => setShowDemoDialog(false)} />
    </>
  );
}

// We need this import here (after OrderPanel definition) to avoid circular issues
// The useViewer hook is used inside OrderPanel, so import at top-level of the module.
import { useViewer } from '../hooks/use-viewer';
import { useCustomBranding } from '../core/hmi/branding-store';

// ── OrderItemCard Component ──────────────────────────────────────────

function OrderItemCard({
  item,
  onQuantityChange,
  onDelete,
  onHover,
  onHoverEnd,
  onClick,
}: {
  item: OrderItem;
  onQuantityChange: (qty: number) => void;
  onDelete: () => void;
  onHover: () => void;
  onHoverEnd: () => void;
  onClick: () => void;
}) {
  return (
    <Box
      onMouseEnter={onHover}
      onMouseLeave={onHoverEnd}
      onClick={onClick}
      sx={{
        px: 1,
        py: 0.75,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'rgba(38,166,154,0.08)' },
      }}
    >
      {/* Display name */}
      <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.9)', lineHeight: 1.3 }}>
        {item.displayName || item.aasId}
      </Typography>

      {/* Manufacturer */}
      {item.manufacturer && (
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', lineHeight: 1.3 }}>
          {item.manufacturer}
        </Typography>
      )}

      {/* Article number */}
      {item.articleNumber && (
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace', lineHeight: 1.3 }}>
          Art: {item.articleNumber}
        </Typography>
      )}

      {/* Quantity stepper + delete */}
      <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, gap: 0.5 }}>
        <IconButton
          size="small"
          onClick={() => onQuantityChange(item.quantity - 1)}
          disabled={item.quantity <= 1}
          sx={{ p: 0.2, color: 'rgba(255,255,255,0.4)' }}
        >
          <Remove sx={{ fontSize: 14 }} />
        </IconButton>
        <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'rgba(255,255,255,0.8)', minWidth: 20, textAlign: 'center' }}>
          {item.quantity}
        </Typography>
        <IconButton
          size="small"
          onClick={() => onQuantityChange(item.quantity + 1)}
          sx={{ p: 0.2, color: 'rgba(255,255,255,0.4)' }}
        >
          <Add sx={{ fontSize: 14 }} />
        </IconButton>

        <Box sx={{ flex: 1 }} />

        <IconButton
          size="small"
          onClick={onDelete}
          sx={{ p: 0.2, color: 'rgba(255,255,255,0.3)', '&:hover': { color: '#ef5350' } }}
        >
          <Delete sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>

      <Divider sx={{ mt: 0.75, borderColor: 'rgba(255,255,255,0.05)' }} />
    </Box>
  );
}

// ── Demo Dialog ──────────────────────────────────────────────────────

function OrderDemoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <ShoppingCart sx={{ color: 'primary.main' }} />
        Demo Mode
      </DialogTitle>
      <DialogContent>
        <Typography sx={{ mb: 2, fontSize: 13 }}>
          Online ordering is not configured.
        </Typography>
        <Typography sx={{ mb: 2, fontSize: 13 }}>
          To enable, add an orderUrl to your Order Manager plugin configuration:
        </Typography>
        <Box
          component="pre"
          sx={{
            bgcolor: 'rgba(0,0,0,0.3)',
            p: 1.5,
            borderRadius: 1,
            fontSize: 11,
            fontFamily: 'monospace',
            overflow: 'auto',
            border: '1px solid rgba(255,255,255,0.1)',
          }}
        >
{`viewer.use(new OrderManagerPlugin({
  orderUrl: 'https://your-shop/api/order',
  orderEmail: 'orders@company.com'
}));`}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>OK</Button>
      </DialogActions>
    </Dialog>
  );
}

// ── Exports for tests ────────────────────────────────────────────────

/** @internal Reset store state (for testing only). */
export function _resetOrderStore(): void {
  for (const pending of _pendingDeletes.values()) {
    clearTimeout(pending.timerId);
  }
  _pendingDeletes.clear();
  _items = [];
  _snapshot = { items: [], totalPositions: 0, totalQuantity: 0 };
  // Notify so any subscribed components update
  for (const l of _listeners) l();
}
