// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * sew-symbol-table.ts — Browser-side import of a SEW MOVI-C symbol table for the
 * realvirtual CONNECT MQTT **Json** topic mode (plan-457).
 *
 * A SEW symbol table is a three-column list `Name;Typ;Richtung` — no address
 * column, because the JSON key IS the address. It is the exact table the Unity
 * class `SEWSimInterface.ImportSignalsFromCSV()` reads
 * (`Packages/io.realvirtual.professional/Runtime/Interfaces/SEWMQTT/SEWSimInterface.cs`
 * L152–214), and the mapping here is that method line for line:
 *
 *   - the first non-empty line is a header and is skipped,
 *   - `INT` / `REAL` / `BOOL` / `TEXT` map straight through, `STRING` and
 *     `WSTRING` both become `TEXT`,
 *   - `PLC_IN` / `PLC_OUT` are the only directions,
 *   - a row with fewer than three fields, an unknown type or an unknown
 *     direction is an error for THAT row — the import continues.
 *
 * The one deliberate widening over the C# original: types and directions are
 * matched case-insensitively (the C# `switch` is case-sensitive). A table
 * written `Int;plc_out` is unambiguous and refusing it would only produce
 * puzzling per-row errors in a browser import dialog.
 *
 * The result feeds {@link buildJsonTopicsFromRows}, which splits it into the two
 * CONNECT topics a SEW station needs: PLC_OUT signals on the RECEIVE topic (the
 * station publishes, the viewer reads) and PLC_IN signals on the PUBLISH topic
 * (the viewer writes, CONNECT publishes cyclically).
 */

import { detectDelimiter, splitCsvLine } from './s7-tag-table';

// ── Public Types ───────────────────────────────────────────────────────────

/** Value kind of a SEW symbol after `STRING`/`WSTRING` have collapsed into `TEXT`. */
export type SewSymbolType = 'INT' | 'REAL' | 'BOOL' | 'TEXT';

/** Signal direction as written in the symbol table (PLC point of view). */
export type SewDirection = 'PLC_IN' | 'PLC_OUT';

/** Payload encoding of a Json topic (mirrors CONNECT `MqttTopicConfig.Encoding`). */
export type SewEncoding = 'Utf8' | 'WString' | 'Auto';

/** One accepted row of the symbol table. `line` is 1-based for error display. */
export interface SewSymbolRow {
  name: string;
  type: SewSymbolType;
  direction: SewDirection;
  line: number;
}

/** One rejected row: the import never stops, it reports. */
export interface SewSymbolError {
  line: number;
  reason: string;
}

/** Result of {@link parseSewSymbolTable}: accepted rows plus per-row errors. */
export interface SewImportResult {
  rows: SewSymbolRow[];
  errors: SewSymbolError[];
  /** Empty names with a valid fixed-size type/direction; still reported in errors. */
  reservedRows: SewSymbolRow[];
}

/** A fixed-size CONNECT UDP signal, ready for an interface's signals array. */
export interface UdpImportSignal {
  protocolAddress: string;
  name: string;
  type: string;
  dataType: string;
  record: boolean;
}

/** A CONNECT signal entry as the Json topic mode expects it (no address). */
export interface SewJsonSignal {
  /** Always empty for Json signals — the JSON key is `name`. */
  protocolAddress: string;
  name: string;
  /** Explicit rv wire type, e.g. `PLCOutputInt` — never derived from an address. */
  type: string;
  /** Original SEW type, kept for display in the signal list. */
  dataType: string;
  record: boolean;
}

/** A CONNECT MQTT topic in Json mode, ready to be pushed as `MqttTopicConfig`. */
export interface SewJsonTopic {
  topic: string;
  mode: 'Json';
  qos: number;
  retained: boolean;
  encoding: SewEncoding;
  publishIntervalMs?: number;
  signals: SewJsonSignal[];
}

/** Options of {@link buildJsonTopicsFromRows}; every field has a SEW default. */
export interface SewJsonTopicOptions {
  /** Topic the SEW station publishes on (PLC_OUT signals). Default `SEW/SimOUT`. */
  receiveTopic?: string;
  /** Topic CONNECT publishes on (PLC_IN signals). Default `SEW/SimIN`. */
  publishTopic?: string;
  /** Inbound encoding. Default `Auto` (BOM, then null-byte heuristic). */
  receiveEncoding?: SewEncoding;
  /** Outbound encoding. Default `WString` — the Unity default is `UseWString = true`. */
  publishEncoding?: SewEncoding;
  /** Cyclic publish interval in milliseconds. Default 100. */
  publishIntervalMs?: number;
  /** MQTT QoS for both topics. Default 1. */
  qos?: number;
}

/** Default topic names / encodings, exported so the UI can prefill its fields. */
export const SEW_DEFAULT_RECEIVE_TOPIC = 'SEW/SimOUT';
export const SEW_DEFAULT_PUBLISH_TOPIC = 'SEW/SimIN';
export const SEW_DEFAULT_RECEIVE_ENCODING: SewEncoding = 'Auto';
export const SEW_DEFAULT_PUBLISH_ENCODING: SewEncoding = 'WString';
export const SEW_DEFAULT_PUBLISH_INTERVAL_MS = 100;

// ── Type / direction mapping ────────────────────────────────────────────────

const TYPE_MAP: Record<string, SewSymbolType> = {
  INT: 'INT',
  REAL: 'REAL',
  BOOL: 'BOOL',
  TEXT: 'TEXT',
  STRING: 'TEXT',
  WSTRING: 'TEXT',
};

/** Value half of the rv wire type for a SEW symbol type. */
const WIRE_KIND: Record<SewSymbolType, string> = {
  INT: 'Int',
  REAL: 'Float',
  BOOL: 'Bool',
  TEXT: 'Text',
};

/**
 * rv wire type for a symbol: direction from the table's `PLC_IN`/`PLC_OUT`
 * column, never from an address (Json signals have none).
 *
 * `PLC_OUT` = process output data of the PLC = a command the viewer READS →
 * `PLCOutput*`. `PLC_IN` = process input data = feedback the viewer WRITES →
 * `PLCInput*`. Same convention as Unity and as the S7 area mapping.
 */
export function sewWireType(type: SewSymbolType, direction: SewDirection): string {
  return `${direction === 'PLC_OUT' ? 'PLCOutput' : 'PLCInput'}${WIRE_KIND[type]}`;
}

// ── Format detection ────────────────────────────────────────────────────────

/** An explicit Siemens address (`%IW13`, `QD120`) — never present in a SEW table. */
const S7_ADDRESS_RE = /^(%[IQMEA]?[BWDX]?\d+(\.[0-7])?|[IQMEA][BWDX]?\d+(\.[0-7])?)$/i;
const DIRECTION_RE = /^PLC_(IN|OUT)$/i;

/**
 * Decide whether a csv text is a SEW symbol table or a Siemens tag table.
 *
 * SEW is recognized by the pair of properties that only it has: a column whose
 * values are `PLC_IN`/`PLC_OUT`, and NO column carrying a Siemens address. A
 * table with both is a tag table that happens to name a column that way, and
 * takes the existing S7 path.
 */
export function detectFormat(text: string): 'sew' | 's7' {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  let hasDirection = false;
  let hasAddress = false;
  // Skip the header line; a header cell may legitimately read "Direction".
  for (let i = 1; i < lines.length; i++) {
    for (const field of splitCsvLine(lines[i], delimiter)) {
      const f = field.trim();
      if (f.length === 0) continue;
      if (DIRECTION_RE.test(f)) hasDirection = true;
      else if (S7_ADDRESS_RE.test(f)) hasAddress = true;
    }
  }
  return hasDirection && !hasAddress ? 'sew' : 's7';
}

// ── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse a SEW symbol table (`Name;Typ;Richtung`) into rows plus per-row errors.
 *
 * The delimiter (`;` / `,` / Tab) is autodetected on the first line, quoted
 * fields are honored — both shared with the Siemens importer. The first
 * non-empty line is always treated as a header and skipped, exactly like the
 * Unity original (which calls `ReadLine()` once before its loop).
 */
export function parseSewSymbolTable(text: string): SewImportResult {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/);
  const rows: SewSymbolRow[] = [];
  const errors: SewSymbolError[] = [];
  const reservedRows: SewSymbolRow[] = [];

  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim().length === 0) continue;
    if (!headerSeen) { headerSeen = true; continue; }

    const line = i + 1;
    const fields = splitCsvLine(raw, delimiter).map(f => f.trim());
    if (fields.length < 3) {
      errors.push({ line, reason: `Row has ${fields.length} column(s), expected at least 3 (Name;Type;Direction)` });
      continue;
    }

    const name = fields[0];
    const type = TYPE_MAP[fields[1].toUpperCase()];
    const dirRaw = fields[2].toUpperCase();
    if (name.length === 0) {
      // UdpSymbolTable.cs counts bytes only after validating type and direction.
      // Keep the existing MQTT error and rows unchanged, including for TEXT.
      if (type && type !== 'TEXT' && (dirRaw === 'PLC_IN' || dirRaw === 'PLC_OUT')) {
        reservedRows.push({ name, type, direction: dirRaw, line });
      }
      errors.push({ line, reason: 'Missing signal name' });
      continue;
    }

    if (!type) {
      errors.push({ line, reason: `Unknown data type "${fields[1]}"` });
      continue;
    }

    if (dirRaw !== 'PLC_IN' && dirRaw !== 'PLC_OUT') {
      errors.push({ line, reason: `Unknown direction "${fields[2]}" (expected PLC_IN or PLC_OUT)` });
      continue;
    }

    rows.push({ name, type, direction: dirRaw, line });
  }

  return { rows, errors, reservedRows };
}

// ── Row → UDP signals ───────────────────────────────────────────────────────

/**
 * Mirror CONNECT Protocols/Udp/UdpSymbolTable.cs: no alignment, separate send
 * and receive offsets, and case-sensitive names shared across both directions.
 * Parser errors remain in result.errors; skipped reports builder rejections.
 * Unlike C# Browse, filter oversized addresses here rather than at validation.
 */
export function buildUdpSignalsFromSewRows(result: SewImportResult): {
  signals: UdpImportSignal[];
  skipped: { line: number; name: string; reason: string }[];
} {
  const signals: UdpImportSignal[] = [];
  const skipped: { line: number; name: string; reason: string }[] = [];
  const names = new Set<string>();
  let sendOffset = 0;
  let receiveOffset = 0;

  for (const row of [...result.rows, ...result.reservedRows].sort((a, b) => a.line - b.line)) {
    const skip = (reason: string) => skipped.push({ line: row.line, name: row.name, reason });
    if (row.type === 'TEXT') {
      skip('no fixed size in a UDP telegram');
      continue;
    }

    const size = row.type === 'BOOL' ? 1 : 4;
    const offset = row.direction === 'PLC_IN' ? sendOffset : receiveOffset;
    const end = offset + size;
    if (row.direction === 'PLC_IN') sendOffset = end;
    else receiveOffset = end;

    if (row.name.length === 0) {
      skip('missing name — bytes reserved');
      continue;
    }
    if (names.has(row.name)) {
      skip('duplicate name — bytes reserved');
      continue;
    }
    // C# registers the name before address validation, including oversized fields.
    names.add(row.name);
    if (end > 65507) {
      skip('beyond the largest UDP datagram (65507 bytes)');
      continue;
    }

    signals.push({
      protocolAddress: `${offset}:${row.type}`,
      name: row.name,
      type: sewWireType(row.type, row.direction),
      dataType: row.type,
      record: false,
    });
  }
  return { signals, skipped };
}

// ── Row → Json topics ───────────────────────────────────────────────────────

function toSignal(row: SewSymbolRow): SewJsonSignal {
  return {
    protocolAddress: '',
    name: row.name,
    type: sewWireType(row.type, row.direction),
    dataType: row.type,
    record: false,
  };
}

/**
 * Split parsed symbol rows into the two CONNECT Json topics of a SEW station.
 *
 * PLC_OUT rows form the RECEIVE topic (inbound only — CONNECT subscribes and
 * decodes), PLC_IN rows the PUBLISH topic (outbound only — CONNECT publishes
 * the full object every `publishIntervalMs`). A side with no rows produces no
 * topic, so a receive-only table never creates an idle publish loop.
 *
 * `retained` is false for both: a retained process image is stale data on the
 * next connect, which is exactly what a cyclic full-image publish must not do.
 */
export function buildJsonTopicsFromRows(
  rows: SewSymbolRow[],
  options: SewJsonTopicOptions = {},
): SewJsonTopic[] {
  const qos = options.qos ?? 1;
  const receiveSignals = rows.filter(r => r.direction === 'PLC_OUT').map(toSignal);
  const publishSignals = rows.filter(r => r.direction === 'PLC_IN').map(toSignal);

  const topics: SewJsonTopic[] = [];
  if (receiveSignals.length > 0) {
    topics.push({
      topic: options.receiveTopic ?? SEW_DEFAULT_RECEIVE_TOPIC,
      mode: 'Json',
      qos,
      retained: false,
      encoding: options.receiveEncoding ?? SEW_DEFAULT_RECEIVE_ENCODING,
      signals: receiveSignals,
    });
  }
  if (publishSignals.length > 0) {
    topics.push({
      topic: options.publishTopic ?? SEW_DEFAULT_PUBLISH_TOPIC,
      mode: 'Json',
      qos,
      retained: false,
      encoding: options.publishEncoding ?? SEW_DEFAULT_PUBLISH_ENCODING,
      publishIntervalMs: options.publishIntervalMs ?? SEW_DEFAULT_PUBLISH_INTERVAL_MS,
      signals: publishSignals,
    });
  }
  return topics;
}

/**
 * Parse a SEW symbol-table file and return both the raw result and the derived
 * Json topics — the single entry point the import dialog uses.
 */
export async function parseSewSymbolTableFile(file: File): Promise<SewImportResult> {
  return parseSewSymbolTable(await file.text());
}
