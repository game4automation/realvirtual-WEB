// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-sound-variation.ts — a small, FIXED spread per Sound instance, so identical axes
 * do not sound identical. Deterministic: derived from a seed string (the node id) once,
 * never random per frame, and the same on every reload and for every viewer.
 */

/** Pitch spread: the frequencies of one source are scaled by 1 ± this. */
export const PITCH_SPREAD = 0.07;
/** Level spread: the voice and one-shot level of one source is scaled by 1 ± this. */
export const LEVEL_SPREAD = 0.10;

/** Pitch and level factors of one source. */
export interface SoundVariation {
  /** Frequency factor, 1 - PITCH_SPREAD .. 1 + PITCH_SPREAD. */
  pitch: number;
  /** Level factor, 1 - LEVEL_SPREAD .. 1 + LEVEL_SPREAD. */
  level: number;
}

/** FNV-1a 32 bit hash of a string. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Finalizer (murmur3 fmix32) so the two factors are independent of each other. */
function mix32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The variation of one seed. Pure and allocation-free except for the result object. */
export function soundVariation(seed: string, out: SoundVariation = { pitch: 1, level: 1 }): SoundVariation {
  const h = hashSeed(seed);
  const u1 = mix32(h ^ 0x9e3779b9) / 4294967295;
  const u2 = mix32(h ^ 0x7f4a7c15) / 4294967295;
  out.pitch = 1 + (u1 * 2 - 1) * PITCH_SPREAD;
  out.level = 1 + (u2 * 2 - 1) * LEVEL_SPREAD;
  return out;
}
