// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * createTourApi — factory for the `TourApi` object passed to tour functions.
 *
 * Binds all TourApi primitives to:
 *  - the active RVViewer (for camera, registry, selection, left-panel)
 *  - the current AbortSignal (for cancellable awaits)
 *  - a shared `KioskOpenState` tracker (for cleanup on stop)
 *  - the KioskConfig (for maxConcurrentMessages, maxDwellMs, etc.)
 *  - a closeChartCb callback supplied by KioskPlugin
 *
 * All primitives are exception-safe at the dispatch site; if a primitive
 * throws (e.g. invalid camera coords), the tour function itself receives
 * the error and can catch/continue. The outer TourRunner also catches.
 */

import { Vector3 } from 'three';
import type { ReactNode } from 'react';
import type { RVViewer } from '../core/rv-viewer';
import {
  showInstruction,
  hideInstruction,
  type InstructionAnchor,
  type InstructionStyle,
  type InstructionAction,
} from '../core/hmi/instruction-store';
import { openPdfViewer, closePdfViewer } from '../core/hmi/pdf-viewer-store';
import type { TourApi, ChartKind } from './kiosk-tour-types';
import type { KioskConfig } from './kiosk-config';
import { validateCameraArgs, prefersReducedMotion } from './kiosk-config';
import { waitForCameraAndDwell } from './tour-utils';

/** Mutable state tracker of everything the kiosk opened — used for cleanup. */
export interface KioskOpenState {
  pdfOpen: boolean;
  openedPanels: Set<string>;
  openedCharts: Set<ChartKind>;
  kioskMessageIds: string[];         // FIFO queue of instruction ids used for messages
}

/** Construct a fresh empty KioskOpenState. */
export function makeKioskOpenState(): KioskOpenState {
  return {
    pdfOpen: false,
    openedPanels: new Set<string>(),
    openedCharts: new Set<ChartKind>(),
    kioskMessageIds: [],
  };
}

/** Auto-generated id counter for instructions without explicit ids. */
let _autoIdCounter = 0;

/**
 * Build a TourApi bound to the given viewer + signal + state + config.
 *
 * @param viewer        active RVViewer (already model-loaded)
 * @param signal        AbortSignal — primitives throw AbortError on abort in async paths
 * @param config        KioskConfig — read for timeouts + caps
 * @param state         shared mutable tracker populated on open-calls, drained on cleanup
 * @param openChartCb   callback invoked by `t.chart(kind)` (typically toggles KioskPlugin state)
 * @param closeChartCb  callback invoked by `t.closeChart(kind)`
 */
export function createTourApi(
  viewer: RVViewer,
  signal: AbortSignal,
  config: KioskConfig,
  state: KioskOpenState,
  openChartCb: (kind: ChartKind) => void,
  closeChartCb: (kind: ChartKind) => void,
  setHierarchyFilterCb: (opts: { typeFilter?: string; searchTerm?: string }) => void,
  onCycleEnd: () => void,
): TourApi {
  /** Throws AbortError if signal is aborted. Caller awaits at `await` points. */
  const assertNotAborted = (): void => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  };

  return {
    viewer,
    signal,

    async camera(opts) {
      assertNotAborted();
      const { position, target } = validateCameraArgs(opts.position, opts.target);
      const reqDuration = opts.duration ?? 2.0;
      const duration = prefersReducedMotion() && config.respectReducedMotion ? 0 : reqDuration;
      viewer.animateCameraTo(new Vector3(...position), new Vector3(...target), duration);
      await waitForCameraAndDwell(viewer, 0, config.cameraAnimationTimeoutMs, signal);
      assertNotAborted();
    },

    highlight(paths, clearOthers = true) {
      if (clearOthers) viewer.clearHighlight();
      for (const p of paths) viewer.highlightByPath(p, true);
    },

    clearHighlights() {
      viewer.clearHighlight();
    },

    instruction(textOrContent, opts = {}) {
      const id = opts.id ?? `kiosk-inst-auto-${++_autoIdCounter}`;
      const payload: { text?: string; content?: ReactNode } =
        typeof textOrContent === 'string'
          ? { text: textOrContent }
          : { content: textOrContent.content };
      const anchor: InstructionAnchor = opts.anchor ?? { kind: 'canvas-center' };
      const style: InstructionStyle = opts.style ?? 'banner';
      showInstruction({
        id,
        ...payload,
        anchor,
        style,
        priority: opts.priority,
        actions: opts.actions as InstructionAction[] | undefined,
        autoClearAfterMs: opts.autoClearAfterMs,
        source: 'kiosk',
      });
    },

    hideInstruction(id) {
      hideInstruction(id);
    },

    pdf(title, source) {
      openPdfViewer(title, source);
      state.pdfOpen = true;
    },

    closePdf() {
      closePdfViewer();
      state.pdfOpen = false;
    },

    message(opts) {
      // FIFO-evict oldest when cap exceeded
      while (state.kioskMessageIds.length >= config.maxConcurrentMessages) {
        const oldest = state.kioskMessageIds.shift();
        if (oldest) hideInstruction(oldest);
      }
      const id = `kiosk-msg-${++_autoIdCounter}`;
      state.kioskMessageIds.push(id);
      const severityStyle: InstructionStyle = opts.severity === 'error'
        ? 'warning'
        : opts.severity === 'warning' ? 'warning' : 'info';
      const actions: InstructionAction[] = [];
      if (opts.componentPath) {
        actions.push({
          label: 'Show',
          variant: 'primary',
          onClick: () => {
            viewer.selectionManager?.select(opts.componentPath!);
            viewer.highlightByPath(opts.componentPath!, true);
            // Clicking the message exits kiosk so user can explore (by convention)
            viewer.emit('kiosk-exit-requested' as string, undefined);
          },
        });
      }
      showInstruction({
        id,
        text: opts.subtitle ? `${opts.title}\n${opts.subtitle}` : opts.title,
        anchor: { kind: 'edge', edge: 'right' },
        style: severityStyle,
        actions: actions.length > 0 ? actions : undefined,
        autoClearAfterMs: opts.autoClearAfterMs,
        source: 'kiosk',
        dismissible: true,
      });
    },

    filter(opts) {
      const panelId = 'hierarchy';
      viewer.leftPanelManager?.open(panelId, opts.panelWidth ?? 320);
      setHierarchyFilterCb({
        typeFilter: opts.typeFilter,
        searchTerm: opts.searchTerm,
      });
      state.openedPanels.add(panelId);
    },

    closeFilter() {
      viewer.leftPanelManager?.close('hierarchy');
      state.openedPanels.delete('hierarchy');
    },

    focus(path) {
      viewer.selectionManager?.select(path);
      viewer.highlightByPath(path, true);
    },

    clearFocus() {
      viewer.selectionManager?.clear();
      viewer.clearHighlight();
    },

    chart(kind) {
      openChartCb(kind);
      state.openedCharts.add(kind);
    },

    closeChart(kind) {
      if (kind) {
        closeChartCb(kind);
        state.openedCharts.delete(kind);
      } else {
        for (const k of state.openedCharts) closeChartCb(k);
        state.openedCharts.clear();
      }
    },

    async dwell(seconds) {
      assertNotAborted();
      const ms = Math.max(0, Math.min(seconds * 1000, config.maxDwellMs));
      if (ms === 0) return;
      await new Promise<void>((resolve) => {
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (): void => {
          if (done) return;
          done = true;
          if (timer !== null) { clearTimeout(timer); timer = null; }
          signal.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = (): void => finish();
        signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(finish, ms);
      });
      assertNotAborted();
    },

    cycleEnd() {
      onCycleEnd();
    },
  };
}
