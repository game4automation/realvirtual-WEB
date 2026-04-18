// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * InstructionLayer — React renderer for the unified Instruction Overlay.
 *
 * Consumes `useInstructions()` from `instruction-store.ts` and renders each
 * active instruction as an anchored card (banner / callout / toast / pill /
 * warning / info). Node-anchored cards track their 3D object's screen-space
 * projection every frame via `requestAnimationFrame`.
 *
 * Mounted ONCE in `App.tsx` next to `<TooltipLayer />` / `<ContextMenuLayer />`.
 * No props — uses `useViewer()` hook like its siblings.
 *
 * zIndex:
 *   - Layer root: 8600
 *   - KioskChrome banner (if present): 8500 (below this layer)
 *   - PDF viewer: 9000 (above this layer — PDF takes precedence)
 *   - WelcomeModal: 10000 (above everything)
 *
 * Error boundary: renders nothing on crash (fail-soft) to prevent HMI-wide
 * failure from a bad `content: ReactNode`.
 */

import {
  Component,
  memo,
  useEffect,
  useMemo,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { Box, Paper, Typography, Button, IconButton, useMediaQuery } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useViewer } from '../../hooks/use-viewer';
import { projectToScreen } from './tooltip/tooltip-utils';
import {
  hideInstruction,
  useInstructions,
  _warnOnce,
  type Instruction,
  type InstructionAnchor,
  type InstructionStyle,
  type InstructionAction,
} from './instruction-store';

// ─── Constants ──────────────────────────────────────────────────────────

const LAYER_ZINDEX = 8600;
const CARD_HEIGHT_PX = 56;   // nominal stacking height; v1.1 may measure via ResizeObserver
const STACK_GAP_PX = 8;

// ─── Error boundary (only class component in codebase — required by React) ──

/**
 * Error boundary around card rendering. React error boundaries CANNOT be
 * written as functional components (as of React 19): `getDerivedStateFromError`
 * and `componentDidCatch` have no hook equivalent. Accepted style exception.
 *
 * Fails soft: renders nothing on crash to prevent HMI-wide failure from a
 * bad user-provided `content: ReactNode`.
 */
class InstructionErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error): { error: Error } { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[instruction] InstructionCard render failed:', error, info);
  }
  render(): ReactNode {
    if (this.state.error) return null;
    return this.props.children;
  }
}

// ─── Safe callback invocation ───────────────────────────────────────────

/** @internal — defensive wrapper for user-provided callbacks. */
function safeInvoke(fn: (() => void) | undefined, label: string): void {
  if (!fn) return;
  try { fn(); } catch (e) { console.error(`[instruction] callback '${label}' threw:`, e); }
}

// ─── Stacking ───────────────────────────────────────────────────────────

/** @internal — Key for grouping instructions that collide at the same anchor. */
function stackGroupKey(a: InstructionAnchor): string {
  switch (a.kind) {
    case 'node':          return `node:${a.path}`;
    case 'hmi-element':   return `hmi:${a.elementId}`;
    case 'screen':        return `screen:${a.x},${a.y}`;
    case 'canvas-center': return 'canvas-center';
    case 'edge':          return `edge:${a.edge}`;
  }
}

/** @internal — Map of instruction id → vertical offset (px) within its stack group. */
function computeStackOffsets(instructions: readonly Instruction[]): Map<string, number> {
  const groups = new Map<string, Instruction[]>();
  for (const inst of instructions) {
    const key = stackGroupKey(inst.anchor);
    const arr = groups.get(key) ?? [];
    arr.push(inst);
    groups.set(key, arr);
  }
  const offsets = new Map<string, number>();
  for (const arr of groups.values()) {
    arr.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    arr.forEach((inst, i) => offsets.set(inst.id, i * (CARD_HEIGHT_PX + STACK_GAP_PX)));
  }
  return offsets;
}

// ─── Public: InstructionLayer ───────────────────────────────────────────

/**
 * Root React layer that renders all active instructions. Mount once in App.tsx
 * next to `<ContextMenuLayer />`. Follows the hook-based pattern (no props).
 *
 * @public @stable v1
 */
export function InstructionLayer(): ReactNode {
  const viewer = useViewer();
  const instructions = useInstructions();

  // useMemo prevents useEffect re-trigger when non-node instructions change.
  // instructions is already reference-stable from useSyncExternalStore + _snapshot cache.
  const nodeAnchored = useMemo(
    () => instructions.filter(i => i.anchor.kind === 'node'),
    [instructions],
  );

  const stackOffsets = useMemo(() => computeStackOffsets(instructions), [instructions]);

  // Per-frame reprojection only when node-anchored instructions are active
  useEffect(() => {
    if (nodeAnchored.length === 0) return;
    let frame = 0;
    const tick = (): void => {
      for (const inst of nodeAnchored) {
        const el = document.getElementById(`inst-${inst.id}`);
        if (!el) continue;
        const anchor = inst.anchor as Extract<InstructionAnchor, { kind: 'node' }>;
        const node = viewer.registry?.getNode(anchor.path);
        if (!node) {
          el.style.visibility = 'hidden';
          _warnOnce(
            'missing-node',
            inst.id,
            `[instruction] '${inst.id}' → node '${anchor.path}' not in registry`,
          );
          continue;
        }
        const screen = projectToScreen(node, viewer.camera, viewer.renderer);
        if (!screen.visible) {
          el.style.visibility = 'hidden';
          continue;
        }
        el.style.visibility = '';
        const dx = anchor.offset?.[0] ?? 0;
        const dy = (anchor.offset?.[1] ?? 0) + (stackOffsets.get(inst.id) ?? 0);
        el.style.left = `${screen.x + dx}px`;
        el.style.top = `${screen.y + dy}px`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [viewer, nodeAnchored, stackOffsets]);

  return (
    <Box
      role="status"
      aria-live="polite"
      sx={{
        position: 'fixed',
        inset: 0,
        pointerEvents: 'none',
        zIndex: LAYER_ZINDEX,
      }}
    >
      <InstructionErrorBoundary>
        {instructions.map(inst => (
          <InstructionCard
            key={inst.id}
            instruction={inst}
            stackOffset={stackOffsets.get(inst.id) ?? 0}
          />
        ))}
      </InstructionErrorBoundary>
    </Box>
  );
}

// ─── InstructionCard (memoized) ─────────────────────────────────────────

/**
 * @internal — Memoized per instruction object identity.
 *
 * Identity check is safe because `showInstruction()` always REPLACES via
 * `Map.set(id, normalizedObj)` — never mutates in place. When a caller updates
 * an instruction (same id, new content), Map.set swaps the object reference
 * and memo correctly re-renders.
 *
 * ARIA role nesting:
 *   - The parent `InstructionLayer` has `role="status" aria-live="polite"`
 *     (non-interrupting announcements).
 *   - Cards with `style === 'warning'` set `role="alert"` (interrupting).
 *   - Per ARIA 1.2 spec, the INNER role takes precedence. Warnings are
 *     announced as alerts; info/banner/toast/pill inherit the parent's
 *     polite live region.
 */
const InstructionCard = memo(
  function InstructionCard({
    instruction,
    stackOffset,
  }: {
    instruction: Instruction;
    stackOffset: number;
  }): ReactNode {
    const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const anchor = instruction.anchor;
    const style: InstructionStyle = instruction.style ?? 'info';

    // ─── Anchor-based positioning (node anchor is handled by rAF in layer) ───
    const posSx = computePositionSx(anchor, stackOffset);

    // ─── Style-based variant ───
    const variantSx = computeVariantSx(style);

    const isWarning = style === 'warning';

    return (
      <Paper
        elevation={style === 'pill' || style === 'toast' ? 2 : 4}
        id={`inst-${instruction.id}`}
        data-instruction-id={instruction.id}
        data-instruction-source={instruction.source ?? ''}
        data-instruction-style={style}
        role={isWarning ? 'alert' : undefined}
        sx={{
          position: 'fixed',
          pointerEvents: 'none',   // card body does not block canvas clicks
          userSelect: 'none',
          ...(reducedMotion ? {} : { transition: 'opacity 0.2s, transform 0.2s' }),
          ...posSx,
          ...variantSx,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
          {style === 'warning' && (
            <WarningAmberIcon fontSize="small" sx={{ color: 'warning.main', mt: 0.25 }} />
          )}
          {style === 'info' && anchor.kind === 'canvas-center' && (
            <InfoOutlinedIcon fontSize="small" sx={{ color: 'info.main', mt: 0.25 }} />
          )}
          <Box sx={{ flexGrow: 1, minWidth: 0 }}>
            {instruction.content ? (
              instruction.content
            ) : (
              <Typography variant={style === 'banner' ? 'body1' : 'body2'} sx={{ fontWeight: style === 'banner' ? 600 : 400 }}>
                {instruction.text}
              </Typography>
            )}
          </Box>
          {instruction.dismissible && (
            <IconButton
              aria-label="Dismiss instruction"
              size="small"
              onClick={() => {
                safeInvoke(instruction.onDismiss, 'onDismiss');
                hideInstruction(instruction.id);
              }}
              sx={{ pointerEvents: 'auto', ml: 0.5, mt: -0.5 }}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        {instruction.actions && instruction.actions.length > 0 && (
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, mt: 1 }}>
            {instruction.actions.map((action: InstructionAction, i: number) => (
              <Button
                key={i}
                size="small"
                variant={action.variant === 'primary' ? 'contained' : 'text'}
                onClick={() => safeInvoke(action.onClick, `action:${action.label}`)}
                sx={{ pointerEvents: 'auto', textTransform: 'none' }}
              >
                {action.label}
              </Button>
            ))}
          </Box>
        )}
      </Paper>
    );
  },
  (prev, next) =>
    prev.instruction === next.instruction && prev.stackOffset === next.stackOffset,
);

// ─── Styling helpers ────────────────────────────────────────────────────

function computePositionSx(anchor: InstructionAnchor, stackOffset: number): Record<string, unknown> {
  switch (anchor.kind) {
    case 'canvas-center':
      return {
        left: '50%',
        top: `calc(40% + ${stackOffset}px)`,
        transform: 'translateX(-50%)',
        maxWidth: 'min(80vw, 640px)',
      };
    case 'edge': {
      const base: Record<string, unknown> = { maxWidth: 'min(80vw, 640px)' };
      if (anchor.edge === 'top')    return { ...base, top: `${16 + stackOffset}px`, left: '50%', transform: 'translateX(-50%)' };
      if (anchor.edge === 'bottom') return { ...base, bottom: `${16 + stackOffset}px`, left: '50%', transform: 'translateX(-50%)' };
      if (anchor.edge === 'left')   return { left: `${16 + stackOffset}px`, top: '50%', transform: 'translateY(-50%)' };
      /* right */
      return { right: `${16 + stackOffset}px`, top: '50%', transform: 'translateY(-50%)' };
    }
    case 'screen':
      return { left: `${anchor.x}px`, top: `${anchor.y + stackOffset}px` };
    case 'hmi-element': {
      // Resolved via querySelector at render time (best-effort; silently hides if missing)
      const target = document.querySelector(`[data-instruction-anchor="${anchor.elementId}"]`);
      if (!target) {
        return { visibility: 'hidden' };
      }
      const rect = (target as HTMLElement).getBoundingClientRect();
      const place = anchor.placement ?? 'right';
      if (place === 'above')  return { left: `${rect.left}px`, top: `${rect.top - 8 - CARD_HEIGHT_PX + stackOffset}px` };
      if (place === 'below')  return { left: `${rect.left}px`, top: `${rect.bottom + 8 + stackOffset}px` };
      if (place === 'left')   return { left: `${Math.max(8, rect.left - 260)}px`, top: `${rect.top + stackOffset}px` };
      /* right */
      return { left: `${rect.right + 8}px`, top: `${rect.top + stackOffset}px` };
    }
    case 'node':
      // Position updated per frame by rAF in InstructionLayer; initial position off-screen
      return { left: '-9999px', top: '-9999px' };
  }
}

function computeVariantSx(style: InstructionStyle): Record<string, unknown> {
  switch (style) {
    case 'banner':
      return { px: 2.5, py: 1.5, bgcolor: 'background.paper' };
    case 'callout':
      return { px: 2, py: 1.25, bgcolor: 'background.paper' };
    case 'toast':
      return { px: 2, py: 1, bgcolor: 'background.paper', opacity: 0.95 };
    case 'pill':
      return { px: 1.5, py: 0.5, borderRadius: 999, fontSize: '0.75rem', bgcolor: 'background.paper' };
    case 'warning':
      return { px: 2, py: 1.25, bgcolor: 'warning.light', borderLeft: '3px solid', borderColor: 'warning.main' };
    case 'info':
      return { px: 2, py: 1.25, bgcolor: 'background.paper' };
  }
}
