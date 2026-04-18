// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Public types for the Kiosk Mode tour authoring API.
 *
 * Tours are authored as plain async TypeScript functions — no JSON schema
 * required. Each tour receives a `TourApi` helper and an `AbortSignal` for
 * cancellation. `if / while / for` and shared state (closures) are all
 * native — no schema extensions needed.
 *
 * An optional declarative `TourDefinition` JSON schema is also exported as a
 * secondary surface for tours that ship embedded in a GLB's `rv_extras.kiosk`.
 * GLB-embedded tours are limited to non-`custom` primitives and get executed
 * by an internal converter that produces a `TourFn`.
 *
 * @public @stable v1 — once shipped, adding new primitives or action types
 *   is additive; renaming/removing is a breaking change (major version bump).
 */

import type { ReactNode } from 'react';
import type {
  InstructionAnchor,
  InstructionAction,
  InstructionStyle,
} from '../core/hmi/instruction-store';
import type { PdfSource } from '../core/hmi/pdf-viewer-store';
import type { RVViewer } from '../core/rv-viewer';

// ─── Code-first (primary) ──────────────────────────────────────────────

/** A tour is an async function. Stop via `signal.aborted` check after each await. @public @stable v1 */
export type TourFn = (t: TourApi, signal: AbortSignal) => Promise<void>;

/** Primitives bound to viewer + current cancellation signal. @public @stable v1 */
export interface TourApi {
  readonly viewer: RVViewer;
  readonly signal: AbortSignal;

  // Camera animation + dwell (awaits until camera settles OR timeout OR abort)
  camera(opts: {
    position: [number, number, number];
    target: [number, number, number];
    duration?: number;            // seconds; 0 = instant cut; honours prefers-reduced-motion
  }): Promise<void>;

  // Highlights (scene-graph overlay)
  highlight(paths: string[], clearOthers?: boolean): void;
  clearHighlights(): void;

  // Instruction overlay (Plan 151)
  instruction(
    textOrContent: string | { content: ReactNode },
    opts?: {
      anchor?: InstructionAnchor;
      style?: InstructionStyle;
      id?: string;
      priority?: number;
      actions?: InstructionAction[];
      autoClearAfterMs?: number;
    },
  ): void;
  hideInstruction(id: string): void;

  // PDF viewer (reuses core openPdfViewer — supports URL or AASX blob)
  pdf(title: string, source: PdfSource): void;
  closePdf(): void;

  // Side-panel failure message (TileCard)
  message(opts: {
    title: string;
    subtitle?: string;
    severity: 'info' | 'warning' | 'error';
    componentPath?: string;       // click focuses this node + exits kiosk
    autoClearAfterMs?: number;
  }): void;

  // Left-panel filter (hierarchy)
  filter(opts: {
    typeFilter?: 'all' | 'drives' | 'sensors' | 'signals' | 'logic';
    searchTerm?: string;
    panelWidth?: number;          // default 320
  }): void;
  closeFilter(): void;

  // Inspector via selectionManager.select
  focus(path: string): void;
  clearFocus(): void;

  // Chart overlays (oee / parts / cycleTime / energy)
  chart(kind: ChartKind): void;
  closeChart(kind?: ChartKind): void;

  // Timing
  dwell(seconds: number): Promise<void>;
  cycleEnd(): void;               // increments cycle counter (for cycleLimit)
}

export type ChartKind = 'oee' | 'parts' | 'cycleTime' | 'energy';

// ─── Declarative (secondary, optional) ─────────────────────────────────

/**
 * Optional declarative tour schema for `rv_extras.kiosk` embedded tours.
 * Limited to non-`custom` primitives (sandboxed — no arbitrary code).
 *
 * TypeScript tours via `KioskPlugin.registerTour()` are preferred for
 * rich tours with conditionals / loops / shared state.
 *
 * @public @stable v1
 */
export interface TourDefinition {
  schemaVersion: 1;
  name: string;
  loopForever?: boolean;
  cycleLimit?: number;
  shuffleAfterFirstCycle?: boolean;
  steps: TourStep[];
}

export interface TourStep {
  id: string;
  title?: string;
  description?: string;
  actions: TourAction[];
  dwellSeconds: number;
}

export type TourAction =
  | { type: 'camera'; position: [number, number, number]; target: [number, number, number]; duration?: number }
  | { type: 'highlight'; paths: string[]; clearOthers?: boolean }
  | { type: 'pdf'; title: string; source: PdfSource }
  | { type: 'message'; title: string; subtitle?: string; severity: 'info' | 'warning' | 'error'; componentPath?: string; autoClearAfterMs?: number }
  | { type: 'filter'; typeFilter?: 'all' | 'drives' | 'sensors' | 'signals' | 'logic'; searchTerm?: string; panelWidth?: number }
  | { type: 'inspector'; path: string }
  | { type: 'chart'; chart: ChartKind }
  | { type: 'instruction'; text: string; anchor?: InstructionAnchor; style?: InstructionStyle; id?: string; priority?: number; autoClearAfterMs?: number };
