// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-plc-automap — model PLC signals → S7 / PLCSIM Advanced interface signals (plan-545).
 *
 * Pure: no React, no DOM, no store. The ConnectPanel section and the MCP tool
 * `web_signal_automap` both feed the SAME {@link matchPlcSignals} report, so the
 * panel badge and the agent can never disagree about what is mapped.
 *
 * ## Where the address comes from
 *
 * A model signal carries its absolute PLC address as the PREFIX of its comment,
 * `"<address> · <text>"` (e.g. `"%I0.2 · Betriebsart: Automatik"`, written by
 * `build-plc-model.mjs`). The comment is read from the GLB's own rv_extras
 * (`rv_extras.<Type>.Comment`), never from the SignalStore meta: CONNECT metadata
 * overwrites that one with the interface comment (`connect-plugin.tsx`
 * `mirrorConnectSignalMeta`), which after an Apply no longer carries the address.
 *
 * ## Keys
 *
 * - **S7** binds by address, so the key is the model signal NAME (= the browser
 *   store key) and the comment address is what gets written.
 * - **PLCSIM Advanced** binds by tag name (ordinal, case-sensitive). The browse
 *   reports struct members quoted (`"FG01_P_Camera".bEnable`), the model writes
 *   them unquoted — both sides go through {@link normaliseTagName}, and Apply
 *   writes the PLC spelling as `protocolAddress`.
 *
 * Apply is merge-only: it never removes an interface signal and never touches
 * `allowWebToPlc`.
 */

import { parseAddress } from './s7-tag-table';
import type { ConnectInterfaceSignal } from '../hmi/connect-store';

// ── Types ──────────────────────────────────────────────────────────────

/** Protocols the auto-map understands (= CONNECT interface type strings). */
export type AutoMapProtocol = 'S7' | 'PlcSimAdvanced';

/** The six PLC signal component types (`SIGNAL_TYPES`). */
export const PLC_SIGNAL_KINDS = [
  'PLCOutputBool', 'PLCInputBool', 'PLCOutputFloat', 'PLCInputFloat', 'PLCOutputInt', 'PLCInputInt',
] as const;

/** One PLC signal of the loaded model. */
export interface ModelPlcSignal {
  /** RUNTIME signal name (= SignalStore key). */
  name: string;
  /**
   * The PERSISTED, asset-local symbol (`rv_extras.<Type>.Name`, plan-589).
   * Equal to {@link name} for an authored signal — those stay raw — and the
   * unscoped leaf name for a generated one (`Flow.Run` vs. `Conv.Flow.Run`).
   */
  localName: string;
  /** Component type, e.g. `PLCOutputBool`. */
  type: string;
  /** GLB comment (`rv_extras.<Type>.Comment`), may carry the `<address> · ` prefix. */
  comment?: string;
  /**
   * PLC data type as the source names it (`BOOL`, `DINT`, `REAL`), read from
   * `rv_extras.<Type>.OriginDataType` — NOT from `SignalMeta`, which CONNECT
   * overwrites (see the module header).
   */
  originDataType?: string;
  /**
   * Legacy address from the Unity-side `rv_extras.<Type>.Metadata` (plan-589 F9), already
   * extracted by {@link readMetadataAddress}. Read only by the "Adopt legacy addresses" action,
   * and only where it parses as an address of the target protocol.
   */
  metadataAddress?: string;
  /** Node path, for diagnostics. */
  path?: string;
}

/**
 * Unity `Metadata` keys that carry a communication address, in priority order.
 *
 * One list for every protocol realvirtual for Unity writes: an S7 `Address`, a PLCSIM/TIA
 * `TagName`, a Modbus register, a KEBA variable, a device address. They are READ here for all
 * protocols and ADOPTED only where the value parses for the interface at hand, so a Modbus
 * address in a GLB can never end up as an S7 address.
 */
export const LEGACY_METADATA_ADDRESS_KEYS: readonly string[] = [
  'Address', 'TagName', 'ModbusAddress', 'KebaVariable', 'DeviceAddress',
];

/**
 * The legacy address inside a Unity `Metadata` field, in BOTH shapes it occurs in.
 *
 * Unity serialises its metadata either as a LIST of `{Key, Value}` pairs or as a plain object
 * `{Key: Value}`, depending on the exporter version — and a reader that knows only one of the two
 * silently finds nothing in half the files. Keys are matched case-insensitively; the first key of
 * {@link LEGACY_METADATA_ADDRESS_KEYS} that carries a non-empty string wins.
 */
export function readMetadataAddress(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const found = new Map<string, string>();
  const put = (key: unknown, value: unknown): void => {
    if (typeof key !== 'string') return;
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
    if (!text) return;
    const lower = key.trim().toLowerCase();
    if (!found.has(lower)) found.set(lower, text);
  };
  if (Array.isArray(metadata)) {
    for (const row of metadata) {
      if (row === null || typeof row !== 'object') continue;
      const entry = row as Record<string, unknown>;
      // `{Key, Value}` as Unity writes it; `{key, value}` after a camelCasing serialiser.
      put(entry['Key'] ?? entry['key'], entry['Value'] ?? entry['value']);
    }
  } else {
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) put(key, value);
  }
  for (const key of LEGACY_METADATA_ADDRESS_KEYS) {
    const hit = found.get(key.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** One tag the PLC reported in a discovery (PLCSIM browse). */
export interface DiscoveredPlcTag {
  /** Full tag name exactly as the PLC spells it (`"DB".Member`). */
  tag: string;
  direction?: 'input' | 'output' | 'unknown';
  dataType?: string;
}

/** The PLC side of a match. */
export interface PlcSide {
  /** Signals already configured on the interface. */
  signals: readonly ConnectInterfaceSignal[];
  /** PLCSIM only: tags from the browse. `undefined` = no discovery ran. */
  discovered?: readonly DiscoveredPlcTag[];
  /** Interface `allowWebToPlc` switch. */
  allowWebToPlc?: boolean;
  /** PLCSIM only: configured `plcSimAdvanced.dataBlockFilter` (comma separated). */
  dataBlockFilter?: string;
}

export const AUTOMAP_CATEGORIES = [
  'mapped',
  'mappable',
  'address-mismatch',
  'missing-in-plc',
  'no-address',
  'direction-conflict',
  'address-duplicate',
  'ambiguous',
  'plc-only',
] as const;

export type AutoMapCategory = typeof AUTOMAP_CATEGORIES[number];

/** One row of the report. */
export interface AutoMapEntry {
  /** Model signal name; for `plc-only` the interface signal name or PLC tag. */
  name: string;
  /** Model signal type (absent for `plc-only`). */
  type?: string;
  /** Address / tag that Apply writes as `protocolAddress` (mapped, mappable, address-mismatch). */
  protocolAddress?: string;
  /** Data type Apply writes. */
  dataType?: string;
  /** Comment text without the address prefix. */
  text?: string;
  /** Address currently on the interface (address-mismatch). */
  existingAddress?: string;
  /** Human-readable reason (conflicts, ambiguity). */
  reason?: string;
}

/**
 * Categories Apply writes.
 *
 * `address-mismatch` is in the list so an entry still reaches
 * {@link buildInterfaceSignals} — which then declines it, because since plan-589 the legacy seed
 * ("Adopt legacy addresses") is MERGE-ONLY: an address a CONNECT interface already carries is the
 * commissioned truth and is never overwritten by a GLB comment. The mismatch stays visible as a
 * report row; resolving it is a human decision.
 */
export const APPLY_CATEGORIES: readonly AutoMapCategory[] = ['mappable', 'address-mismatch', 'mapped'];

export interface AutoMapReport {
  protocol: AutoMapProtocol;
  /** Interface id the report was made for (set by the caller). */
  interfaceId?: string;
  counts: Record<AutoMapCategory, number> & {
    /** Number of PLC signals in the model. */
    total: number;
    /** Entries Apply would add or update (mappable + address-mismatch). */
    toApply: number;
  };
  categories: Record<AutoMapCategory, AutoMapEntry[]>;
  hints: string[];
  /** PLCSIM: data block names Apply adds to `plcSimAdvanced.dataBlockFilter`. */
  dataBlockFilter: string[];
}

// ── Comment address ────────────────────────────────────────────────────

/** `DBn.DBX/DBB/DBW/DBD<offset>[.<bit>]`, optional leading `%`. */
const DB_ADDRESS_RE = /^%?DB(\d+)\.DB([XBWD])(\d+)(?:\.([0-7]))?$/i;
/** Process image / flag area with a MANDATORY area letter (a bare `96.0` is not a comment address). */
const AREA_ADDRESS_RE = /^%?([IQMEA])([BWDX]?)(\d+)(?:\.([0-7]))?$/i;

/** Separators accepted between address and text — `·` always, `|` and `-` only before a valid address. */
const SEPARATORS = [' · ', '·', ' | ', ' - '];

/** Siemens data type implied by an address' size letter (for `parseAddress` validation). */
function impliedDataType(sizeLetter: string, hasBit: boolean): string {
  if (hasBit || sizeLetter === 'X') return 'Bool';
  if (sizeLetter === 'W') return 'Word';
  if (sizeLetter === 'D') return 'DWord';
  return 'Byte';
}

/** True when `raw` is a valid absolute S7 address (`%I0.2`, `%QW8`, `DB1.DBX0.0`, …). */
export function isValidPlcAddress(raw: string): boolean {
  const s = raw.trim();
  const db = DB_ADDRESS_RE.exec(s);
  if (db) {
    const size = db[2].toUpperCase();
    const hasBit = db[4] !== undefined;
    return size === 'X' ? hasBit : !hasBit;
  }
  const m = AREA_ADDRESS_RE.exec(s);
  if (!m) return false;
  const size = m[2].toUpperCase();
  const hasBit = m[4] !== undefined;
  if (size === 'X' && !hasBit) return false;
  // TIA syntax: a bare `%I0` is neither a bit (`%I0.0`) nor a byte (`%IB0`).
  if (size === '' && !hasBit) return false;
  return parseAddress(s, impliedDataType(size, hasBit)).parsed !== null;
}

/**
 * Split a model signal comment `"<address> · <text>"` into its parts.
 *
 * Splits at the first ` · ` (U+00B7); ` | ` and ` - ` are accepted only when the
 * left side is a valid address. A comment that is only an address (`"%Q108.0"`,
 * written for a tag without comment text) yields that address with empty text.
 * Returns null when no separator splits off a valid absolute S7 address and the
 * whole comment is not one either.
 */
export function parseCommentAddress(comment: string | undefined | null): { address: string; text: string } | null {
  if (typeof comment !== 'string') return null;
  for (const sep of SEPARATORS) {
    const i = comment.indexOf(sep);
    if (i <= 0) continue;
    const address = comment.slice(0, i).trim();
    if (!isValidPlcAddress(address)) continue;
    return { address, text: comment.slice(i + sep.length).trim() };
  }
  const trimmed = comment.trim();
  if (trimmed && isValidPlcAddress(trimmed)) return { address: trimmed, text: '' };
  return null;
}

/** Address area as direction: `I` → input, `Q` → output, `M`/DB → either. */
function addressDirection(address: string): 'input' | 'output' | 'any' {
  const m = AREA_ADDRESS_RE.exec(address.trim());
  if (!m) return 'any';
  const area = m[1].toUpperCase();
  if (area === 'I' || area === 'E') return 'input';
  if (area === 'Q' || area === 'A') return 'output';
  return 'any';
}

/** Canonical address for equality: upper case, no `%`, German E/A → I/Q, `X` dropped for bit access. */
export function canonicalAddress(address: string): string {
  const s = address.trim().toUpperCase().replace(/^%/, '');
  const m = AREA_ADDRESS_RE.exec(s);
  if (!m) return s;
  let area = m[1];
  if (area === 'E') area = 'I';
  if (area === 'A') area = 'Q';
  const size = m[2] === 'X' ? '' : m[2];
  return `${area}${size}${m[3]}${m[4] !== undefined ? `.${m[4]}` : ''}`;
}

// ── Names ──────────────────────────────────────────────────────────────

/**
 * Strip the double quotes around every dotted segment (`"FG01_P_Camera".bEnable`
 * → `FG01_P_Camera.bEnable`, `"DB"."M"` → `DB.M`) and trim. Case is preserved:
 * TIA names are case-sensitive and PLCSIM matches ordinally.
 */
export function normaliseTagName(name: string): string {
  return name.trim().replace(/"/g, '').trim();
}

/** `PLCInputBool` → `input`, `PLCOutput…` → `output`. */
function kindDirection(type: string): 'input' | 'output' {
  return type.startsWith('PLCInput') ? 'input' : 'output';
}

/** Value kind of a signal type: Bool / Int / Float. */
function valueKind(type: string): 'Bool' | 'Int' | 'Float' {
  if (type.endsWith('Bool')) return 'Bool';
  if (type.endsWith('Float')) return 'Float';
  return 'Int';
}

/**
 * Siemens data type written for a model signal: Bool → `Bool`, Float → `Real`,
 * Int → `Int` — widened to `DInt` / narrowed to `Byte` when the S7 address size
 * letter says so (a `%QD` Int is four bytes; `Int` would be rejected by the worker).
 */
export function dataTypeForKind(type: string, address?: string): string {
  const kind = valueKind(type);
  if (kind === 'Bool') return 'Bool';
  if (kind === 'Float') return 'Real';
  if (address) {
    const s = address.trim();
    const db = DB_ADDRESS_RE.exec(s);
    const size = (db ? db[2] : AREA_ADDRESS_RE.exec(s)?.[2] ?? '').toUpperCase();
    if (size === 'D') return 'DInt';
    if (size === 'B') return 'Byte';
  }
  return 'Int';
}

// ── Data block filter (PLCSIM) ─────────────────────────────────────────

/** Bare data block names of a configured `dataBlockFilter` string. */
export function parseDataBlockFilter(filter: string | undefined | null): string[] {
  if (!filter) return [];
  return filter.split(',').map((n) => n.trim().replace(/"/g, '').trim()).filter((n) => n.length > 0);
}

/** Merge new data block names into a configured filter — never removes an entry. */
export function mergeDataBlockFilter(existing: string | undefined | null, add: readonly string[]): string {
  const names = parseDataBlockFilter(existing);
  const seen = new Set(names);
  for (const n of add) {
    const bare = n.replace(/"/g, '').trim();
    if (bare && !seen.has(bare)) { seen.add(bare); names.push(bare); }
  }
  return names.join(',');
}

// ── Matching ───────────────────────────────────────────────────────────

/**
 * The legacy address of a model signal: the comment prefix first, the Unity `Metadata` second.
 *
 * The comment wins because it is what the WEB-side model generator writes (`build-plc-model.mjs`)
 * and therefore the fresher statement; `Metadata` is the Unity import's own record and is used
 * wherever the comment carries none. Only a valid absolute S7 address is accepted from metadata —
 * the same gate the comment passes — so a Modbus register or a KEBA variable in the same field is
 * read and then ignored for an S7 interface.
 */
function legacyAddressOf(s: ModelPlcSignal): { address: string; text: string } | null {
  const fromComment = parseCommentAddress(s.comment);
  if (fromComment) return fromComment;
  const meta = s.metadataAddress?.trim();
  if (meta && isValidPlcAddress(meta)) return { address: meta, text: s.comment?.trim() ?? '' };
  return null;
}

function emptyCategories(): Record<AutoMapCategory, AutoMapEntry[]> {
  const out = {} as Record<AutoMapCategory, AutoMapEntry[]>;
  for (const c of AUTOMAP_CATEGORIES) out[c] = [];
  return out;
}

/**
 * Match the model's PLC signals against one interface.
 *
 * Every model signal lands in exactly one model-side category; `plc-only` lists
 * the PLC side (interface signals for S7, browsed tags for PLCSIM) that no model
 * signal claims. Conflicts are reported, never guessed.
 */
export function matchPlcSignals(
  model: readonly ModelPlcSignal[],
  plc: PlcSide,
  protocol: AutoMapProtocol,
): AutoMapReport {
  const cat = emptyCategories();
  const hints: string[] = [];
  const dataBlockFilter: string[] = [];

  // De-duplicate model signals by name (the store key) — first wins.
  const seenNames = new Set<string>();
  const signals: ModelPlcSignal[] = [];
  for (const s of model) {
    if (!s.name || seenNames.has(s.name)) continue;
    seenNames.add(s.name);
    signals.push(s);
  }

  const existingByName = new Map<string, ConnectInterfaceSignal>();
  for (const s of plc.signals) if (!existingByName.has(s.name)) existingByName.set(s.name, s);

  if (protocol === 'S7') {
    // Address duplicates among the model signals that carry an address.
    const byAddress = new Map<string, string[]>();
    for (const s of signals) {
      const p = legacyAddressOf(s);
      if (!p) continue;
      const key = canonicalAddress(p.address);
      const list = byAddress.get(key) ?? [];
      list.push(s.name);
      byAddress.set(key, list);
    }

    for (const s of signals) {
      const p = legacyAddressOf(s);
      if (!p) {
        cat['no-address'].push({ name: s.name, type: s.type, text: s.comment });
        continue;
      }
      const dir = addressDirection(p.address);
      if (dir !== 'any' && dir !== kindDirection(s.type)) {
        cat['direction-conflict'].push({
          name: s.name, type: s.type, protocolAddress: p.address, text: p.text,
          reason: `${p.address} is a PLC ${dir} but the model signal is ${s.type}`,
        });
        continue;
      }
      const dupes = byAddress.get(canonicalAddress(p.address)) ?? [];
      if (dupes.length > 1) {
        cat['address-duplicate'].push({
          name: s.name, type: s.type, protocolAddress: p.address, text: p.text,
          reason: `${p.address} is also used by ${dupes.filter((n) => n !== s.name).join(', ')}`,
        });
        continue;
      }
      const entry: AutoMapEntry = {
        name: s.name, type: s.type, protocolAddress: p.address,
        dataType: dataTypeForKind(s.type, p.address), text: p.text,
      };
      const existing = existingByName.get(s.name);
      if (!existing) cat.mappable.push(entry);
      else if (canonicalAddress(existing.protocolAddress ?? '') === canonicalAddress(p.address)) cat.mapped.push(entry);
      else cat['address-mismatch'].push({ ...entry, existingAddress: existing.protocolAddress });
    }

    for (const s of plc.signals) {
      if (!seenNames.has(s.name)) cat['plc-only'].push({ name: s.name, protocolAddress: s.protocolAddress, type: s.type });
    }
  } else {
    // PLCSIM Advanced — key = normalised tag name.
    const discovered = plc.discovered ?? [];
    const tagsByKey = new Map<string, DiscoveredPlcTag[]>();
    for (const t of discovered) {
      const key = normaliseTagName(t.tag);
      const list = tagsByKey.get(key) ?? [];
      list.push(t);
      tagsByKey.set(key, list);
    }
    const ioPrefixes = new Set<string>();
    for (const key of tagsByKey.keys()) ioPrefixes.add(key.split('.')[0]);
    const configuredDbs = new Set(parseDataBlockFilter(plc.dataBlockFilter));
    const claimedKeys = new Set<string>();

    if (plc.discovered === undefined || discovered.length === 0) {
      hints.push('The PLCSIM browse returned no tags — is the PLCSIM Advanced instance running and the interface enabled?');
    }

    for (const s of signals) {
      const key = normaliseTagName(s.name);
      const p = parseCommentAddress(s.comment);
      const text = p ? p.text : s.comment;
      const modelDir = kindDirection(s.type);
      const commentDir = p ? addressDirection(p.address) : 'any';
      if (commentDir !== 'any' && commentDir !== modelDir) {
        cat['direction-conflict'].push({
          name: s.name, type: s.type, protocolAddress: p?.address, text,
          reason: `${p!.address} is a PLC ${commentDir} but the model signal is ${s.type}`,
        });
        claimedKeys.add(key);
        continue;
      }
      const tags = tagsByKey.get(key) ?? [];
      if (tags.length > 1) {
        cat.ambiguous.push({
          name: s.name, type: s.type, text,
          reason: `PLC tags ${tags.map((t) => t.tag).join(', ')} all normalise to ${key}`,
        });
        claimedKeys.add(key);
        continue;
      }
      if (tags.length === 0) {
        cat['missing-in-plc'].push({ name: s.name, type: s.type, text });
        const dot = key.indexOf('.');
        if (dot > 0 && discovered.length > 0) {
          const db = key.slice(0, dot);
          if (!ioPrefixes.has(db) && !configuredDbs.has(db) && !dataBlockFilter.includes(db)) dataBlockFilter.push(db);
        }
        continue;
      }
      const tag = tags[0];
      claimedKeys.add(key);
      if (tag.direction && tag.direction !== 'unknown' && tag.direction !== modelDir) {
        cat['direction-conflict'].push({
          name: s.name, type: s.type, protocolAddress: tag.tag, text,
          reason: `PLC tag ${tag.tag} is a PLC ${tag.direction} but the model signal is ${s.type}`,
        });
        continue;
      }
      const entry: AutoMapEntry = {
        name: s.name, type: s.type, protocolAddress: tag.tag,
        dataType: tag.dataType || dataTypeForKind(s.type), text,
      };
      const existing = existingByName.get(s.name);
      if (!existing) cat.mappable.push(entry);
      else if (existing.protocolAddress === tag.tag) cat.mapped.push(entry);
      else cat['address-mismatch'].push({ ...entry, existingAddress: existing.protocolAddress });
    }

    for (const [key, tags] of tagsByKey) {
      if (claimedKeys.has(key)) continue;
      for (const t of tags) cat['plc-only'].push({ name: t.tag, protocolAddress: t.tag });
    }

    if (dataBlockFilter.length > 0) {
      hints.push(`dataBlockFilter: [${dataBlockFilter.map((d) => `"${d}"`).join(', ')}] — these data blocks are not in the process-image browse; Apply adds them to the PLCSIM data block filter and browses again.`);
    }
  }

  if (signals.some((s) => kindDirection(s.type) === 'input') && plc.allowWebToPlc !== true) {
    hints.push('The model has PLCInput signals but "Allow web to PLC" is off on this interface — values the viewer writes will not reach the PLC. Auto-map never changes that switch.');
  }

  const counts = { total: signals.length, toApply: 0 } as AutoMapReport['counts'];
  for (const c of AUTOMAP_CATEGORIES) counts[c] = cat[c].length;
  // Only NEW entries are written — see APPLY_CATEGORIES: a mismatch is reported, never applied.
  counts.toApply = counts.mappable;

  return { protocol, counts, categories: cat, hints, dataBlockFilter };
}

// ── Builder ────────────────────────────────────────────────────────────

/**
 * Merge the report's mapped / mappable / address-mismatch entries into the
 * interface signals. Existing signals keep their position (same name → updated
 * in place), new ones are appended in model order, nothing is removed.
 * Idempotent: building twice from a re-check yields the same array.
 */
export function buildInterfaceSignals(
  report: AutoMapReport,
  existing: readonly ConnectInterfaceSignal[],
): ConnectInterfaceSignal[] {
  const out = existing.map((s) => ({ ...s }));
  const index = new Map<string, number>();
  out.forEach((s, i) => { if (!index.has(s.name)) index.set(s.name, i); });

  for (const c of APPLY_CATEGORIES) {
    for (const e of report.categories[c]) {
      if (!e.type || !e.protocolAddress) continue;
      const prev = index.has(e.name) ? out[index.get(e.name)!] : undefined;
      // Merge-only (plan-589 F9): a configured address wins over anything the model suggests.
      if (prev && (prev.protocolAddress ?? '').trim() !== '') continue;
      const sig: ConnectInterfaceSignal = {
        protocolAddress: e.protocolAddress,
        name: e.name,
        type: e.type,
        ...(e.dataType ? { dataType: e.dataType } : {}),
        ...(e.text ? { comment: e.text } : {}),
        record: prev?.record ?? false,
      };
      if (prev) out[index.get(e.name)!] = sig;
      else { index.set(e.name, out.length); out.push(sig); }
    }
  }
  return out;
}

/** True when two signal arrays carry the same content (order-sensitive). */
export function sameSignals(a: readonly ConnectInterfaceSignal[], b: readonly ConnectInterfaceSignal[]): boolean {
  if (a.length !== b.length) return false;
  const norm = (s: ConnectInterfaceSignal) => JSON.stringify([
    s.name, s.protocolAddress, s.type, s.dataType ?? '', s.comment ?? '', !!s.record,
  ]);
  for (let i = 0; i < a.length; i++) if (norm(a[i]) !== norm(b[i])) return false;
  return true;
}

// ── Model access ───────────────────────────────────────────────────────

/** The two viewer members {@link collectModelPlcSignals} reads (structural, no viewer import). */
export interface AutoMapViewerLike {
  registry: {
    getAll<T = unknown>(type: string): { path: string; instance: T }[];
    getNode(path: string): { name: string; userData: Record<string, unknown> } | null;
  } | null;
}

/**
 * Collect every PLC signal of the loaded model with its GLB comment.
 *
 * Reads `NodeRegistry` entries written by `registerSignal()` and the comment
 * from the node's own `userData.realvirtual.<Type>.Comment` (see the module
 * header for why not the SignalStore meta).
 */
export function collectModelPlcSignals(viewer: AutoMapViewerLike | null | undefined): ModelPlcSignal[] {
  const registry = viewer?.registry;
  if (!registry) return [];
  const out: ModelPlcSignal[] = [];
  for (const type of PLC_SIGNAL_KINDS) {
    for (const { path, instance } of registry.getAll<{ signalName?: string }>(type)) {
      const node = registry.getNode(path);
      const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown> | undefined> | undefined;
      const extras = rv?.[type];
      const local = (extras?.['Name'] as string | undefined) || node?.name;
      // The registry entry carries the RUNTIME name `registerSignal` resolved
      // (scoped for a generated signal); the extras carry the asset-local one.
      const name = instance?.signalName || local;
      if (!name) continue;
      const comment = extras?.['Comment'];
      const originDataType = extras?.['OriginDataType'];
      // plan-589 F9: the Unity import's own address record, read for the legacy seed only.
      const metadataAddress = readMetadataAddress(extras?.['Metadata']);
      out.push({
        name, localName: local ?? name, type, path,
        ...(typeof comment === 'string' && comment ? { comment } : {}),
        ...(typeof originDataType === 'string' && originDataType ? { originDataType } : {}),
        ...(metadataAddress ? { metadataAddress } : {}),
      });
    }
  }
  return out;
}

/** Compact report for MCP: names only, capped per category. */
export function summariseReport(report: AutoMapReport, cap = 100): {
  protocol: AutoMapProtocol;
  interfaceId?: string;
  counts: AutoMapReport['counts'];
  categories: Partial<Record<AutoMapCategory, { names: string[]; more: number; details?: AutoMapEntry[] }>>;
  hints: string[];
  dataBlockFilter: string[];
} {
  const categories: Partial<Record<AutoMapCategory, { names: string[]; more: number; details?: AutoMapEntry[] }>> = {};
  for (const c of AUTOMAP_CATEGORIES) {
    const list = report.categories[c];
    if (list.length === 0) continue;
    const withReason = c === 'direction-conflict' || c === 'address-duplicate' || c === 'ambiguous' || c === 'address-mismatch';
    categories[c] = {
      names: list.slice(0, cap).map((e) => e.name),
      more: Math.max(0, list.length - cap),
      ...(withReason ? { details: list.slice(0, Math.min(cap, 20)) } : {}),
    };
  }
  return {
    protocol: report.protocol,
    ...(report.interfaceId ? { interfaceId: report.interfaceId } : {}),
    counts: report.counts,
    categories,
    hints: report.hints,
    dataBlockFilter: report.dataBlockFilter,
  };
}
