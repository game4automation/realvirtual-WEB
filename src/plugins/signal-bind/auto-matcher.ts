// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * auto-matcher.ts — suggests CONNECT signals for a component's bindable slots.
 *
 * Three escalating stages, SUGGESTIONS ONLY (never a silent auto-bind):
 *   1. Exact      — normalised slot name === normalised signal name.
 *   2. Token/synonym — token-subset overlap after CamelCase / `._-` splitting,
 *                      expanded through an industry synonym map.
 *   3. Fuzzy      — fuse.js fuzzy match over the remaining candidates.
 *
 * Each suggestion carries a `confidence` (0..1) and the `stage` it came from.
 * The picker shows these as highlights; the user confirms before any bind.
 *
 * Inputs are kept primitive (slot name + aliases, signal names) so the matcher
 * is trivially unit-testable without a SignalStore / DiscoveredSignal shape.
 */

import Fuse from 'fuse.js';
import type { SignalSlotDescriptor } from './slot-descriptors';

/** Minimum fuzzy confidence for a stage-3 suggestion (plan §3.3: score > 0.75). */
export const FUZZY_CONFIDENCE_THRESHOLD = 0.75;
/** Minimum token/synonym confidence to surface a stage-2 suggestion. */
export const TOKEN_CONFIDENCE_THRESHOLD = 0.5;

export type MatchStage = 'exact' | 'token' | 'fuzzy';

export interface MatchSuggestion {
  /** Candidate CONNECT signal name (as passed in — no normalisation applied). */
  signal: string;
  /** 0..1 — higher is a stronger match. Exact = 1. */
  confidence: number;
  stage: MatchStage;
}

/**
 * Industry synonym groups. Any token in a group matches any other token in the
 * same group during stage 2. Keep tokens lowercase and separator-free.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ['occupied', 'isoccupied', 'sensoroccupied', 'presence', 'present', 'detected', 'partpresent'],
  ['run', 'running', 'start', 'enable', 'enabled', 'on', 'motorrun', 'active'],
  ['speed', 'targetspeed', 'velocity'],
  ['forward', 'fwd', 'jogforward'],
  ['backward', 'bwd', 'jogbackward', 'reverse'],
  ['out', 'extend', 'advance', 'extended'],
  ['in', 'retract', 'home', 'retracted'],
  ['count', 'partcount'],
  ['stop', 'halt', 'off'],
  ['flow', 'conveyor', 'belt', 'transport'],
];

/** synonym token → canonical group id (index into SYNONYM_GROUPS). */
const SYNONYM_INDEX = new Map<string, number>();
SYNONYM_GROUPS.forEach((group, i) => {
  for (const tok of group) SYNONYM_INDEX.set(tok, i);
});

/** Lowercase, strip separators to a single comparable string. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[._\-\s]+/g, '');
}

/**
 * Split a name into lowercase tokens on CamelCase boundaries and `._- ` separators.
 * `"Conveyor1.SensorOccupied"` → `['conveyor1', 'sensor', 'occupied']`.
 */
export function tokenize(name: string): string[] {
  return name
    // insert a boundary between a lower/digit and an upper-case letter
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // and between an acronym run and a following word ("HTTPServer" → "HTTP Server")
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
}

/** Expand a token to the set of equivalent tokens via the synonym map. */
function expandToken(tok: string): Set<string> {
  const set = new Set<string>([tok]);
  const gi = SYNONYM_INDEX.get(tok);
  if (gi !== undefined) for (const s of SYNONYM_GROUPS[gi]) set.add(s);
  return set;
}

/** All comparable tokens for a slot: its own tokens + its declared aliases. */
function slotTokens(slot: SignalSlotDescriptor): Set<string> {
  const out = new Set<string>();
  for (const t of tokenize(slot.slot)) out.add(t);
  for (const a of slot.aliases ?? []) for (const t of tokenize(a)) out.add(t);
  return out;
}

/**
 * Token/synonym overlap score in [0..1]: fraction of the slot's meaningful
 * tokens that the signal covers (directly or via a synonym). Uses the slot as
 * the denominator so a long device-prefixed signal still scores high when it
 * carries the slot's key token (e.g. `Conveyor1.SensorOccupied` ↔ `IsOccupied`).
 */
function tokenScore(slot: SignalSlotDescriptor, signalTokens: Set<string>): number {
  // Expand the signal tokens once through synonyms.
  const sigExpanded = new Set<string>();
  for (const st of signalTokens) for (const e of expandToken(st)) sigExpanded.add(e);

  const slotToks = slotTokens(slot);
  if (slotToks.size === 0) return 0;

  let covered = 0;
  for (const st of slotToks) {
    const expanded = expandToken(st);
    let hit = false;
    for (const e of expanded) {
      if (sigExpanded.has(e)) { hit = true; break; }
    }
    if (hit) covered++;
  }
  return covered / slotToks.size;
}

/**
 * Suggest the best CONNECT signal(s) for ONE slot, ranked by confidence.
 * Returns at most `limit` suggestions above the relevant stage threshold.
 * Never returns a suggestion below threshold (so the caller never silent-binds).
 */
export function suggestForSlot(
  slot: SignalSlotDescriptor,
  signals: readonly string[],
  limit = 3,
): MatchSuggestion[] {
  if (signals.length === 0) return [];
  const slotNorm = normalizeName(slot.slot);
  const aliasNorms = (slot.aliases ?? []).map(normalizeName);

  const out: MatchSuggestion[] = [];
  const used = new Set<string>();

  // ── Stage 1: exact (normalised) name or alias match ──
  for (const sig of signals) {
    const n = normalizeName(sig);
    if (n === slotNorm || aliasNorms.includes(n)) {
      out.push({ signal: sig, confidence: 1, stage: 'exact' });
      used.add(sig);
    }
  }

  // ── Stage 2: token / synonym overlap ──
  const tokenScored: MatchSuggestion[] = [];
  for (const sig of signals) {
    if (used.has(sig)) continue;
    const score = tokenScore(slot, new Set(tokenize(sig)));
    if (score >= TOKEN_CONFIDENCE_THRESHOLD) {
      tokenScored.push({ signal: sig, confidence: score, stage: 'token' });
    }
  }
  tokenScored.sort((a, b) => b.confidence - a.confidence);
  for (const s of tokenScored) { out.push(s); used.add(s.signal); }

  // ── Stage 3: fuzzy (fuse.js) over what's left ──
  const remaining = signals.filter((s) => !used.has(s));
  if (remaining.length > 0 && out.length < limit) {
    const fuse = new Fuse(remaining, {
      includeScore: true,
      ignoreFieldNorm: true,
      threshold: 0.4,
    });
    // Query with the slot name and its aliases; take the best score per signal.
    const queries = [slot.slot, ...(slot.aliases ?? [])];
    const best = new Map<string, number>();
    for (const q of queries) {
      for (const r of fuse.search(q)) {
        // fuse score: 0 = perfect, 1 = no match → confidence = 1 - score.
        const conf = 1 - (r.score ?? 1);
        const prev = best.get(r.item) ?? 0;
        if (conf > prev) best.set(r.item, conf);
      }
    }
    const fuzzy: MatchSuggestion[] = [];
    for (const [sig, conf] of best) {
      if (conf >= FUZZY_CONFIDENCE_THRESHOLD) fuzzy.push({ signal: sig, confidence: conf, stage: 'fuzzy' });
    }
    fuzzy.sort((a, b) => b.confidence - a.confidence);
    for (const s of fuzzy) out.push(s);
  }

  return out.slice(0, limit);
}

/** One slot's single best suggestion (or null), used by the picker's auto-assign. */
export interface SlotSuggestion {
  slot: string;
  suggestion: MatchSuggestion | null;
}

/**
 * Suggest one signal per slot for a whole element. Greedy: a signal already
 * chosen (as a high-confidence suggestion) for an earlier slot is not offered
 * again, so "Auto-assign" doesn't map the same signal to two slots.
 */
export function suggestForElement(
  slots: readonly SignalSlotDescriptor[],
  signals: readonly string[],
): SlotSuggestion[] {
  const taken = new Set<string>();
  const result: SlotSuggestion[] = [];
  // Process slots in declared order; exact matches naturally win their signal first.
  for (const slot of slots) {
    const candidates = suggestForSlot(slot, signals.filter((s) => !taken.has(s)), 1);
    const top = candidates[0] ?? null;
    if (top) taken.add(top.signal);
    result.push({ slot: slot.slot, suggestion: top });
  }
  return result;
}
