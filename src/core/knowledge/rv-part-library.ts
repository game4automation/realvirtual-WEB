// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-part-library — curated part knowledge for AI modelling (plan-641 Phase 5).
 *
 * `public/knowledge/parts.json` holds GENERIC rules derived from public
 * manufacturer type codes: a regex over the part / node name, the size and the
 * stroke taken from the type number (`$1`, `$2` = capture groups), the motion
 * kind, name patterns of the moving and the fixed sub-parts (e.g. `(K)` /
 * `(Z)`) and a reference-point hint. `lookupPart(name)` answers which rules
 * match a name; the agent cites a hit in `_source` (`parts:DFM-12-50`) and
 * still verifies the geometry with `web_check_gap` / `web_check_contact`.
 *
 * Pure module: the library is passed in (tests) or fetched once from
 * `<BASE_URL>knowledge/parts.json` by {@link loadPartLibrary}. Not imported by
 * the entry bundle — only the `web_part_lookup` tool loads it.
 */

/** One rule of the library (the JSON row). */
export interface PartRule {
  family: string;
  vendor?: string;
  kind?: string;
  /** Regex source, matched case-insensitively anywhere in the name. */
  pattern: string;
  /** `$n` = capture group n, a number, or null. */
  size?: string | number | null;
  sizeMeaning?: string;
  stroke_mm?: string | number | null;
  strokeHint?: string;
  motion?: string;
  moving?: string[];
  fixed?: string[];
  referencePoint?: string;
  confidence?: 'observed' | 'inferred' | 'unverified';
}

export interface PartLibrary {
  $schema?: string;
  note?: string;
  parts: PartRule[];
}

/** One match of {@link lookupPart}. */
export interface PartMatch {
  family: string;
  vendor?: string;
  kind?: string;
  /** The part of the name the rule matched (the type code). */
  typeCode: string;
  size: number | null;
  sizeMeaning?: string;
  stroke_mm: number | null;
  strokeHint?: string;
  motion?: string;
  moving: string[];
  fixed: string[];
  referencePoint?: string;
  confidence: 'observed' | 'inferred' | 'unverified';
  /** What to put into `_source` when a model change relies on this hit. */
  source: string;
}

/** Resolve a `$n` template against the match groups; numbers pass through. */
function fieldValue(tpl: string | number | null | undefined, m: RegExpExecArray): number | null {
  if (tpl === null || tpl === undefined) return null;
  if (typeof tpl === 'number') return Number.isFinite(tpl) ? tpl : null;
  const g = /^\$(\d+)$/.exec(tpl.trim());
  const raw = g ? m[Number(g[1])] : tpl;
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) ? n : null;
}

/** Validate a parsed `parts.json`; rows without family or with a broken pattern are dropped. */
export function parsePartLibrary(raw: unknown): PartLibrary {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const rows = Array.isArray(obj['parts']) ? obj['parts'] as unknown[] : [];
  const parts: PartRule[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as PartRule;
    if (typeof row.family !== 'string' || typeof row.pattern !== 'string') continue;
    try { new RegExp(row.pattern, 'i'); } catch { continue; }
    parts.push(row);
  }
  return {
    ...(typeof obj['$schema'] === 'string' ? { $schema: obj['$schema'] as string } : {}),
    ...(typeof obj['note'] === 'string' ? { note: obj['note'] as string } : {}),
    parts,
  };
}

/**
 * Every rule of `library` whose pattern occurs in `name` (case-insensitive).
 * The type code must not be glued to a preceding letter or digit (`XDFM-6-5`
 * is no DFM). No match → empty list; nothing is guessed.
 */
export function lookupPart(name: string, library: PartLibrary): PartMatch[] {
  const text = String(name ?? '');
  const out: PartMatch[] = [];
  for (const rule of library.parts) {
    const re = new RegExp(`(?:^|[^A-Za-z0-9])(${rule.pattern})`, 'i');
    const hit = re.exec(text);
    if (!hit) continue;
    // Re-run the rule's own pattern on the matched text so `$n` counts its groups.
    const m = new RegExp(rule.pattern, 'i').exec(hit[1]);
    if (!m) continue;
    const typeCode = m[0].toUpperCase();
    out.push({
      family: rule.family,
      ...(rule.vendor ? { vendor: rule.vendor } : {}),
      ...(rule.kind ? { kind: rule.kind } : {}),
      typeCode,
      size: fieldValue(rule.size, m),
      ...(rule.sizeMeaning ? { sizeMeaning: rule.sizeMeaning } : {}),
      stroke_mm: fieldValue(rule.stroke_mm, m),
      ...(rule.strokeHint ? { strokeHint: rule.strokeHint } : {}),
      ...(rule.motion ? { motion: rule.motion } : {}),
      moving: [...(rule.moving ?? [])],
      fixed: [...(rule.fixed ?? [])],
      ...(rule.referencePoint ? { referencePoint: rule.referencePoint } : {}),
      confidence: rule.confidence ?? 'inferred',
      source: `parts:${typeCode}`,
    });
  }
  return out;
}

let cached: Promise<PartLibrary> | null = null;

/** The shipped library, fetched once from `<BASE_URL>knowledge/parts.json`. */
export function loadPartLibrary(fetchImpl: typeof fetch = fetch): Promise<PartLibrary> {
  if (!cached) {
    const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
    cached = fetchImpl(`${base}knowledge/parts.json`)
      .then((r) => {
        if (!r.ok) throw new Error(`knowledge/parts.json: HTTP ${r.status}`);
        return r.json();
      })
      .then(parsePartLibrary)
      .catch((e) => { cached = null; throw e; });
  }
  return cached;
}

/** Test hook. */
export function _resetPartLibraryForTest(): void {
  cached = null;
}
