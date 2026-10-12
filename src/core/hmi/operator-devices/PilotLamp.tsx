// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PilotLamp — an indicator lamp as an operator device (plan-542 F5), plus the
 * lamp primitives every operator device shares: the lamp state, its words, the
 * lamp RING (solid lit / unlit, flashing at 2 Hz, dashed under reduced motion,
 * dotted when nothing drives it), the light a lit lamp emits (F10) and the
 * reduced-motion hook.
 *
 * Operator devices are the "Operator Device exception" of the private
 * DESIGN.md: flat drawings of IEC control-box devices — no bevels, no glow, no
 * shadows — whose colours come from `IEC_CAP` / `IEC_LAMP` and only from there.
 * The one exception is light: a lit lamp glows (F10), an unlit one never.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { IEC_LAMP, IEC_LAMP_OFF, type IecLampColor } from '../shared-sx';

// ─── Lamp state ─────────────────────────────────────────────────────────

/** An indicator lamp as wired: its colour and what its output currently says. */
export interface LampState {
  color: IecLampColor;
  on: boolean;
  /** Flash at 2 Hz (an acknowledgeable fault). Dashed and steady under reduced motion. */
  flash?: boolean;
  /**
   * False when nothing drives this lamp in the current mode (the virtual PLC does
   * not write it). An unlit undriven lamp is drawn dotted, so "off" and "not
   * driven" never look the same. Default true.
   */
  driven?: boolean;
}

/** How a lamp ring is drawn — exposed as `data-lamp` for tests and tooling. */
export type LampLook = 'on' | 'off' | 'flash' | 'not-driven';

export const NOT_DRIVEN_HINT = 'not driven in Simulation';

export function lampLook(lamp: LampState): LampLook {
  if (lamp.flash) return 'flash';
  if (lamp.on) return 'on';
  if (lamp.driven === false) return 'not-driven';
  return 'off';
}

/** The lamp state in words — part of every device's accessible name (never colour alone). */
export function lampWords(lamp: LampState): string {
  switch (lampLook(lamp)) {
    case 'flash': return 'lamp flashing';
    case 'on': return 'lamp on';
    case 'not-driven': return `lamp ${NOT_DRIVEN_HINT}`;
    default: return 'lamp off';
  }
}

// ─── Reduced motion ─────────────────────────────────────────────────────

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readReducedMotion(): boolean {
  try {
    return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

/** Live `prefers-reduced-motion: reduce`. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReducedMotion);
  useEffect(() => {
    let mql: MediaQueryList | undefined;
    try { mql = window.matchMedia?.(REDUCED_MOTION_QUERY); } catch { mql = undefined; }
    if (!mql) return;
    const onChange = () => setReduced(mql!.matches);
    mql.addEventListener?.('change', onChange);
    return () => mql!.removeEventListener?.('change', onChange);
  }, []);
  return reduced;
}

// ─── Lamp light (plan-542 F10) ──────────────────────────────────────────
//
// A LIT lamp emits light — the one glow the design system allows (private
// DESIGN.md, Operator Device exception): a soft halo in the lamp colour,
// ≤ 10 px, and only while the lamp is lit. An unlit lamp has no glow at all.

/** The halo of a lit lamp: 8 px blur + 1 px spread (≤ 10 px). */
export function lampGlow(color: IecLampColor): string {
  return `0 0 8px 1px ${IEC_LAMP[color]}b3`;
}

/** A lens lit from inside: brightest in the middle, the device colour at the rim. */
export function litLens(color: IecLampColor, rim: string): string {
  return `radial-gradient(circle at 50% 45%, ${IEC_LAMP.white} 0%, ${IEC_LAMP[color]} 38%, ${rim} 100%)`;
}

/** 2 Hz: 250 ms lit (ring + halo), 250 ms dark. Colours come in as CSS variables. */
const FLASH_KEYFRAMES = 'rv-operator-lamp-flash';
const FLASH_STYLE_ID = 'rv-operator-lamp-flash-style';

/** Injects the flash keyframes once (inline styles cannot carry @keyframes). */
function ensureFlashKeyframes(): void {
  if (typeof document === 'undefined' || document.getElementById(FLASH_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = FLASH_STYLE_ID;
  s.textContent = `@keyframes ${FLASH_KEYFRAMES} {
    0%, 49.9% { border-color: var(--rv-lamp); box-shadow: var(--rv-lamp-glow); }
    50%, 100% { border-color: ${IEC_LAMP_OFF}; box-shadow: none; }
  }`;
  document.head.appendChild(s);
}

/** Ring style for `data-ring`: solid, dashed (flash under reduced motion), dotted (not driven). */
export type RingStroke = 'solid' | 'dashed' | 'dotted';

/**
 * The ring of a lamp for a lamp state: a flat stroke in the lamp colour plus,
 * while lit, its light (halo). Flashing modulates stroke and light together;
 * under reduced motion a flashing lamp is drawn steady, lit and dashed.
 */
export function lampRing(lamp: LampState, width: number, reducedMotion: boolean): {
  style: CSSProperties;
  stroke: RingStroke;
  look: LampLook;
  /** True while the lamp emits light (lit, or flashing). */
  glowing: boolean;
} {
  const look = lampLook(lamp);
  const lit = IEC_LAMP[lamp.color];
  const glow = lampGlow(lamp.color);
  if (look === 'flash') {
    if (reducedMotion) {
      return { look, glowing: true, stroke: 'dashed', style: { border: `${width}px dashed ${lit}`, boxShadow: glow } };
    }
    ensureFlashKeyframes();
    return {
      look,
      glowing: true,
      stroke: 'solid',
      style: {
        border: `${width}px solid ${lit}`,
        ['--rv-lamp' as string]: lit,
        ['--rv-lamp-glow' as string]: glow,
        animation: `${FLASH_KEYFRAMES} 0.5s steps(1, end) infinite`,
      } as CSSProperties,
    };
  }
  if (look === 'on') return { look, glowing: true, stroke: 'solid', style: { border: `${width}px solid ${lit}`, boxShadow: glow } };
  if (look === 'not-driven') return { look, glowing: false, stroke: 'dotted', style: { border: `${width}px dotted ${IEC_LAMP_OFF}` } };
  return { look, glowing: false, stroke: 'solid', style: { border: `${width}px solid ${IEC_LAMP_OFF}` } };
}

// ─── PilotLamp ──────────────────────────────────────────────────────────

export interface PilotLampProps extends LampState {
  /** What the lamp indicates, e.g. "Control on". */
  name: string;
  /** Diameter in px. Default 16. */
  size?: number;
}

/**
 * A round indicator lamp: a lens lit from inside with its light, or an unlit
 * lens with its ring. `role="img"`, named "<name> lamp, on/off" — the state is
 * in words.
 */
export function PilotLamp({ name, size = 16, ...lamp }: PilotLampProps) {
  const reduced = usePrefersReducedMotion();
  const ring = lampRing(lamp, 2, reduced);
  const look = ring.look;
  const state = look === 'on' ? 'on' : look === 'flash' ? 'flashing' : look === 'not-driven' ? NOT_DRIVEN_HINT : 'off';
  return (
    <span
      role="img"
      aria-label={`${name} lamp, ${state}`}
      title={`${name}: ${state}`}
      data-on={lamp.on ? 'true' : 'false'}
      data-lamp={look}
      data-ring={ring.stroke}
      data-glow={ring.glowing ? 'true' : 'false'}
      style={{
        display: 'inline-block',
        flex: '0 0 auto',
        width: size,
        height: size,
        boxSizing: 'border-box',
        borderRadius: '50%',
        background: ring.glowing ? litLens(lamp.color, IEC_LAMP[lamp.color]) : 'transparent',
        ...ring.style,
      }}
    />
  );
}
