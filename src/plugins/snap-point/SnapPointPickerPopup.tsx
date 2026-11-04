// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SnapPointPickerPopup — React portal popup that lists library assets
 * compatible with the currently hovered snap point.
 *
 * Opens on click (driven by SnapPointController), closes on ESC, outside
 * click, or after a successful placement.
 *
 * plan-628 8.4 (G3): at a free `path`-typed snap (a path end, or a `path` port
 * of a placement) the picker also offers a "Path blocks" section — Straight,
 * Curve L/R, Branch, Merge, Stub — placed through the path network UI
 * (`layout.path.place` / `layout.path.junction`, one undo step, chained and
 * tangent-true). Conveyor and other snaps are unchanged.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactElement } from 'react';
import { Box, Paper, Typography, CircularProgress, ButtonBase } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import type { LibraryCatalogEntry } from '../layout-planner/rv-layout-store';
import type { LayoutPlannerPlugin } from '../layout-planner';
import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { SNAP_ATTACH_KEY } from '../layout-planner/planner-commands';
import { useSnapHoverState, snapHoverStore } from './snap-hover-store';
import { findCompatibleLibraryAssets } from './library-snap-index';
import { oppositeDirection } from './snap-name-parser';
import { PATH_END_SNAP_TYPE_ID } from './path-snap-source';
import type { SnapPointPlugin } from './index';
import { t } from './strings';
import { useMobileLayout } from '../../hooks/use-mobile-layout';

interface CompatibleEntry {
  entry: LibraryCatalogEntry;
  ownSnapName: string;
}

/** Header of the path-block section (8.4). */
const PATH_BLOCKS_LABEL = 'Path blocks';

/** The slice of the path network UI the picker uses (structural: no module import of the plugin). */
interface PathPickerHost {
  subscribeInteraction?: (cb: () => void) => () => void;
  readonly interaction: {
    pickerEntries(): readonly { id: string; label: string }[];
    placeAtSnap(entryId: string, snapId: string): Promise<{ ok: boolean; reason?: string }>;
  } | null;
}

const subscribeNothing = (): (() => void) => () => {};

export function SnapPointPickerPopup({ viewer }: UISlotProps): ReactElement | null {
  const hover = useSnapHoverState();
  const isMobile = useMobileLayout();
  const popupRef = useRef<HTMLDivElement | null>(null);

  // Library entries (subscribed)
  const planner = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const layoutStore = planner?.store;
  const layoutSnap = useSyncExternalStore(
    layoutStore?.subscribe ?? (() => () => {}),
    layoutStore?.getSnapshot ?? (() => null),
  );
  const allEntries = useMemo<LibraryCatalogEntry[]>(() => {
    if (!layoutSnap) return [];
    const out: LibraryCatalogEntry[] = [];
    for (const cat of layoutSnap.catalogs.values()) {
      out.push(...cat.entries);
    }
    return out;
  }, [layoutSnap]);

  const [items, setItems] = useState<CompatibleEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [isPlacing, setIsPlacing] = useState(false);
  // plan-628 8.4: path blocks at a path-typed snap (null = no path network UI here).
  const plugin = viewer.getPlugin<PathPickerHost & { id: string }>('path-network-ui');
  const getInteraction = useCallback(() => plugin?.interaction ?? null, [plugin]);
  const pathUi = useSyncExternalStore(plugin?.subscribeInteraction ?? subscribeNothing, getInteraction);
  const pathEntries = useMemo(
    () => (pathUi && hover.pickerAnchor?.typeId === PATH_END_SNAP_TYPE_ID ? pathUi.pickerEntries() : []),
    [pathUi, hover.pickerAnchor],
  );

  // Load compatible items whenever the picker opens
  useEffect(() => {
    if (!hover.pickerOpen || !hover.pickerAnchor) {
      setItems([]);
      setStatus('idle');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setErrorMsg('');

    const target = hover.pickerAnchor;
    // Direction is no longer a hard filter — pass it as a preference so the
    // picker shows the natural same-axis-opposite option first when an asset
    // exposes both, but cross-axis options remain listed. Flow is a HARD
    // filter (in↔out, bidi↔any; rejects in↔in / out↔out).
    const preferred = oppositeDirection(target.dir);
    findCompatibleLibraryAssets(allEntries, target.typeId, preferred, target.flow)
      .then((found) => {
        if (cancelled) return;
        // Procedural path blocks have their own section (8.4), never a GLB row.
        setItems(found.filter((f) => !f.entry.pathBlock));
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(String(e));
        setStatus('error');
      });

    return () => { cancelled = true; };
  }, [hover.pickerOpen, hover.pickerAnchor, allEntries]);

  // Outside-click close
  useEffect(() => {
    if (!hover.pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (popupRef.current && !popupRef.current.contains(t)) {
        snapHoverStore.closePicker();
      }
    };
    // Defer one tick so the opening click itself does not close us
    const tid = window.setTimeout(() => {
      window.addEventListener('mousedown', onDown);
    }, 0);
    return () => {
      window.clearTimeout(tid);
      window.removeEventListener('mousedown', onDown);
    };
  }, [hover.pickerOpen]);

  if (!hover.pickerOpen || !hover.pickerAnchor || !hover.pickerScreenPos) {
    return null;
  }

  const onPickEntry = async (item: CompatibleEntry): Promise<void> => {
    if (isPlacing) return;
    if (!planner) return;
    const snapPlugin = viewer.getPlugin<SnapPointPlugin>('snap-point');
    if (!snapPlugin) return;
    const registry = snapPlugin.getRegistry();
    if (!registry) return;

    const target = hover.pickerAnchor;
    if (!target) return;
    if (target.occupied) {
      setErrorMsg(t('error.occupied'));
      return;
    }

    setIsPlacing(true);
    try {
      // plan-499 follow-up: the picker entry is a VIEW of `layout.snapAttach` —
      // same rule, same refusal text and the same ONE undo step as
      // `web_layout_snap_attach`. The command addresses the target by
      // placement id + snap name, so it serves every snap that lives on a
      // planner placement under a name unique on that placement.
      const targetId = planner.findPlacedIdByRoot(target.ownerRoot);
      const snapName = target.object3D.name;
      const nameIsUnique = registry.getByOwnerRoot(target.ownerRoot)
        .filter((sp) => sp.object3D.name === snapName).length === 1;
      if (targetId && nameIsUnique) {
        const r = await commandRegistry.execute(
          'layout.snapAttach',
          { targetId, catalogId: item.entry.id, targetSnapName: snapName },
          { origin: 'ui', buttonKey: SNAP_ATTACH_KEY, viewer },
        );
        if (r.ok) snapHoverStore.closePicker();
        else setErrorMsg(r.reason);
        return;
      }
      // A snap the command cannot address (it lives on the main model, not on
      // a planner placement, or its name is ambiguous there): the planner's
      // snap placement directly, exactly as before the command existed.
      const id = await planner.placeAtSnap(item.entry, target, item.ownSnapName);
      if (id) snapHoverStore.closePicker();
      else setErrorMsg('Placement rejected');
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setIsPlacing(false);
    }
  };

  const onPickPathBlock = async (entryId: string): Promise<void> => {
    if (isPlacing || !pathUi) return;
    const target = hover.pickerAnchor;
    if (!target) return;
    if (target.occupied) {
      setErrorMsg(t('error.occupied'));
      return;
    }
    setIsPlacing(true);
    try {
      const r = await pathUi.placeAtSnap(entryId, target.id);
      if (r.ok) snapHoverStore.closePicker();
      else setErrorMsg(r.reason ?? 'Placement rejected');
    } catch (e) {
      setErrorMsg(String(e));
    } finally {
      setIsPlacing(false);
    }
  };

  const left = hover.pickerScreenPos.x + 12;
  const top = hover.pickerScreenPos.y + 12;

  return (
    <Paper
      ref={popupRef}
      elevation={6}
      data-testid="snap-picker-popup"
      sx={{
        position: 'fixed',
        zIndex: 2500,
        overflow: 'auto',
        p: 1.25,
        pointerEvents: 'auto',
        // Desktop: anchored next to the clicked snap point. Mobile: docked above
        // the bottom toolbars, horizontally centered, height-capped so the whole
        // list stays visible (scrolls internally) instead of being clipped.
        ...(isMobile
          ? {
              left: '50%',
              transform: 'translateX(-50%)',
              bottom: 'calc(56px + env(safe-area-inset-bottom, 0px))',
              width: 'calc(100vw - 16px)',
              maxWidth: 360,
              maxHeight: 'calc(100dvh - 130px)',
            }
          : {
              left,
              top,
              minWidth: 280,
              maxWidth: 360,
              maxHeight: 360,
            }),
      }}
    >
      <Box sx={{ pb: 0.5, mb: 0.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
        <Typography variant="subtitle2">
          {t('picker.title')} <strong>{hover.pickerAnchor.typeId}</strong>
        </Typography>
      </Box>

      {pathEntries.length > 0 && (
        <Box data-testid="snap-picker-path-blocks" sx={{ pb: 0.75, mb: 0.75, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <Typography variant="caption" sx={{ display: 'block', opacity: 0.7, mb: 0.5 }}>{PATH_BLOCKS_LABEL}</Typography>
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0.5 }}>
            {pathEntries.map((pe) => (
              <ButtonBase
                key={pe.id}
                data-testid={`snap-picker-path-${pe.id}`}
                disabled={isPlacing}
                onClick={() => { void onPickPathBlock(pe.id); }}
                sx={{
                  py: 0.75, px: 0.5, borderRadius: 1, justifyContent: 'center',
                  border: '1px solid rgba(255,255,255,0.12)',
                  '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
                }}
              >
                <Typography variant="body2">{pe.label}</Typography>
              </ButtonBase>
            ))}
          </Box>
        </Box>
      )}

      {status === 'loading' && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="body2">{t('picker.loading')}</Typography>
        </Box>
      )}

      {status === 'error' && (
        <Typography variant="body2" color="error">{errorMsg || 'Error'}</Typography>
      )}

      {status === 'ready' && items.length === 0 && pathEntries.length === 0 && (
        <Typography variant="body2" sx={{ py: 1, opacity: 0.7 }}>
          {t('picker.empty')}
        </Typography>
      )}

      {status === 'ready' && items.map((item) => (
        <ButtonBase
          key={item.entry.id}
          data-testid="library-item"
          disabled={isPlacing}
          onClick={() => { void onPickEntry(item); }}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            width: '100%',
            justifyContent: 'flex-start',
            p: 0.75,
            borderRadius: 1,
            '&:hover': { backgroundColor: 'rgba(255,255,255,0.06)' },
          }}
        >
          {item.entry.thumbnailUrl ? (
            <img
              src={item.entry.thumbnailUrl}
              width={36}
              height={36}
              alt=""
              style={{ objectFit: 'cover', borderRadius: 4 }}
            />
          ) : (
            <Box
              sx={{
                width: 36, height: 36, borderRadius: 1,
                backgroundColor: 'rgba(255,255,255,0.08)',
              }}
            />
          )}
          <Box sx={{ textAlign: 'left' }}>
            <Typography variant="body2">{item.entry.name}</Typography>
            <Typography variant="caption" sx={{ opacity: 0.6 }}>
              {item.entry.category}
            </Typography>
          </Box>
        </ButtonBase>
      ))}

      {errorMsg && status !== 'error' && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
          {errorMsg}
        </Typography>
      )}

      <Box sx={{ mt: 1, opacity: 0.5 }}>
        <Typography variant="caption">{t('picker.cancel')}</Typography>
      </Box>
    </Paper>
  );
}
