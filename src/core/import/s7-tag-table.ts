// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * s7-tag-table.ts — Browser-side import of Siemens TIA tag tables for the
 * realvirtual CONNECT MQTT ProcessImage interface.
 *
 * A tag table (xlsx or csv) lists named signals with their Siemens symbolic
 * address (e.g. `%I0.0`, `%IW13`, `%MD20`), data type and an optional comment.
 * This module parses such a table into a flat list of {@link S7Tag}, validates
 * each address against its data type, derives the rv wire type, and runs an
 * overlap check (range overlap, including cross-area) so the user is warned
 * about non-flat tables before pushing the configuration to CONNECT.
 *
 * xlsx parsing uses `read-excel-file` (lazy-loaded to keep the initial bundle
 * small and to avoid pulling a spreadsheet parser into the critical path).
 * csv parsing is delimiter-autodetecting (`,` / `;` / Tab — German TIA exports
 * frequently use `;`).
 *
 * The result mirrors the CONNECT-side decoder: parse/conflict errors are hard
 * (the offending tag is dropped into `warnings`), whereas range overlaps are
 * soft warnings (`overlaps`) that do NOT block the push.
 */

import { matchesAny } from '../glob-match';

// ── Public Types ───────────────────────────────────────────────────────────

export interface S7Tag {
  name: string;
  /** Siemens data type as written in the table: Bool/Byte/Word/Int/DWord/DInt/Real/LReal. */
  dataType: string;
  /** Original symbolic address, e.g. "%IW13" or a bare "96.0". */
  address: string;
  /** Memory area letter: I/Q/M/E/A, or empty for a bare process-image address (e.g. "96.0"). */
  area: string;
  comment?: string;
}

export interface ParsedTagTable {
  tags: S7Tag[];
  /** Hard problems (invalid address, data-type/size conflict). Offending tags are dropped. */
  warnings: string[];
  /** Soft range-overlap warnings — these do NOT block the push. */
  overlaps: string[];
}

// ── Multi-Tab (Excel → MQTT Topic) Types ─────────────────────────────────────

/** A single parsed signal with its derived rv wire type (Multi-Tab import). */
export interface ParsedTag extends S7Tag {
  /** Derived rv PLC wire type (direction + value kind), e.g. "PLCOutputBool". */
  wireType: string;
}

/** Options for the Multi-Tab Excel → MQTT Topic import (one tab = one topic). */
export interface MqttExcelImportOptions {
  /** Glob pattern matched against sheet/tab names, e.g. "Data_Q*". Empty = all tabs (F12). */
  sheetPattern: string;
  /** F6: force every signal (even %I inputs) to a PLCOutput wire type. */
  forceAllAsOutput: boolean;
  /** Optional prefix prepended to the topic name. Default "". */
  topicPrefix?: string;
}

/** One imported tab mapped to one MQTT topic. */
export interface ParsedTopic {
  /** Final MQTT topic name (sanitized, prefixed). */
  topic: string;
  /** Original sheet/tab name. */
  sheetName: string;
  /** Signals parsed from the tab, with derived wire types. */
  signals: ParsedTag[];
  /** Per-topic warnings (dropped addresses, overlaps, sanitizing). */
  warnings: string[];
}

/** Result of a Multi-Tab Excel import. */
export interface ParsedMultiTabTable {
  /** Only the tabs matching the pattern, one topic each. */
  topics: ParsedTopic[];
  /** Tab names filtered out by the pattern. */
  ignoredSheets: string[];
  /** Total signal count across all imported topics. */
  totalSignals: number;
  /** Cross-tab warnings (duplicate signal names, topic-name collisions). */
  warnings: string[];
}

// ── Address Parsing ─────────────────────────────────────────────────────────

/**
 * Siemens symbolic address: optional `%`, optional area letter, optional size letter,
 * byte offset, optional bit. The area letter is optional because the raw process image is
 * flat (offset = index, area ignored), so bare addresses such as `96.0` or `96` are valid.
 */
const ADDRESS_RE = /^%?([IQMEA]?)([BWDX]?)(\d+)(?:\.([0-7]))?$/;

/** Recognized Siemens data types and their byte length (Bool handled separately as 1 bit). */
const TYPE_SIZE: Record<string, number> = {
  bool: 0, // bit
  byte: 1,
  word: 2,
  int: 2,
  dword: 4,
  dint: 4,
  real: 4,
  lreal: 8,
};

export interface ParsedAddress {
  area: string;
  byteOffset: number;
  /** Bit index 0–7, or undefined for byte-aligned access. */
  bit?: number;
  /** Length in bytes the data type occupies (Bool = 1 byte range for overlap purposes). */
  byteLength: number;
}

/**
 * Parse a Siemens symbolic address against a data type.
 * Returns the parsed address, or sets `error` (and returns null) when the
 * address is invalid or its size letter conflicts with the data type.
 */
export function parseAddress(
  address: string,
  dataType: string,
): { parsed: ParsedAddress | null; error: string | null } {
  const raw = address.trim();
  const m = ADDRESS_RE.exec(raw);
  if (!m) {
    return { parsed: null, error: `Invalid address "${address}"` };
  }

  const area = m[1].toUpperCase();
  const sizeLetter = m[2].toUpperCase(); // '' | 'B' | 'W' | 'D' | 'X'
  const byteOffset = parseInt(m[3], 10);
  const bit = m[4] !== undefined ? parseInt(m[4], 10) : undefined;

  const dt = dataType.trim().toLowerCase();
  const typeBytes = TYPE_SIZE[dt];
  if (typeBytes === undefined) {
    return { parsed: null, error: `Unknown data type "${dataType}" for ${address}` };
  }

  const isBool = dt === 'bool';

  // Bit access (`X` or `.n`) is only valid for Bool, and Bool requires bit access.
  const hasBit = sizeLetter === 'X' || bit !== undefined;
  if (isBool && !hasBit) {
    return { parsed: null, error: `Bool tag "${address}" requires a bit address (e.g. %I0.0)` };
  }
  if (!isBool && hasBit) {
    return { parsed: null, error: `Non-bool type "${dataType}" cannot use a bit address (${address})` };
  }

  // Size letter must match the data type's byte width.
  if (!isBool && sizeLetter !== '') {
    const letterBytes = sizeLetter === 'B' ? 1 : sizeLetter === 'W' ? 2 : sizeLetter === 'D' ? 4 : -1;
    if (letterBytes !== typeBytes) {
      return {
        parsed: null,
        error: `Address size "${sizeLetter}" conflicts with data type "${dataType}" (${address})`,
      };
    }
  }

  return {
    parsed: {
      area,
      byteOffset,
      bit,
      byteLength: isBool ? 1 : typeBytes,
    },
    error: null,
  };
}

// ── Wire-type derivation ────────────────────────────────────────────────────

/**
 * Derive the rv PLC wire type (direction + value kind) from a Siemens data type
 * and memory area, matching the Unity nomenclature and the Siemens address
 * convention:
 *
 *   Direction (from area):
 *     I / E (PLC input)  → PLCInput*   — written by the viewer/operator
 *     Q / A (PLC output) → PLCOutput*  — read by the viewer
 *     M / '' / anything  → PLCOutput*  — DEFAULT when the area is unknown
 *
 *   Value kind (from data type):
 *     Bool                       → ...Bool
 *     Real / LReal               → ...Float
 *     Byte/Word/Int/DWord/DInt   → ...Int
 *
 * The derived direction is only a DEFAULT — it can be overridden per signal
 * downstream (see {@link S7Tag} → CONNECT `SignalConfig.Type`), because CONNECT
 * accepts an explicit `Type` via `PUT /config/interfaces/{id}` and never writes
 * back to the PLC regardless of direction.
 *
 * When `opts.forceOutput` is set, the direction is forced to `PLCOutput`
 * regardless of the area letter (F6: "Treat all signals as PLC Output"). The
 * value kind (Bool/Int/Float) is always derived from the data type.
 *
 * @param dataType Siemens data type (Bool/Byte/Word/Int/DWord/DInt/Real/LReal).
 * @param area     Memory area letter (I/E/Q/A/M) or '' for a bare process-image address.
 * @param opts     Optional flags; `forceOutput` pins the direction to PLCOutput.
 */
export function deriveWireType(dataType: string, area = '', opts?: { forceOutput?: boolean }): string {
  const dt = dataType.trim().toLowerCase();
  const kind = dt === 'bool' ? 'Bool' : dt === 'real' || dt === 'lreal' ? 'Float' : 'Int';
  // I/E = PLC input (viewer writes); everything else (Q/A/M/unknown) defaults to PLC output.
  const a = area.trim().toUpperCase();
  const direction = opts?.forceOutput || a === 'Q' || a === 'A' || a === 'M'
    ? 'PLCOutput'
    : a === 'I' || a === 'E'
      ? 'PLCInput'
      : 'PLCOutput';
  return `${direction}${kind}`;
}

// ── Overlap check ───────────────────────────────────────────────────────────

/**
 * Detect byte-range overlaps between tags. The table is expected to be flat
 * (Area ignored, offset = index), so any overlapping byte range — including
 * cross-area (`%I3.x` vs `%M3.x`) — is reported as a non-blocking warning.
 */
function findOverlaps(tags: S7Tag[]): string[] {
  const overlaps: string[] = [];
  interface Range { tag: S7Tag; start: number; end: number; isBit: boolean; bit: number; }
  const ranges: Range[] = [];

  for (const tag of tags) {
    const { parsed } = parseAddress(tag.address, tag.dataType);
    if (!parsed) continue; // already reported as a hard warning
    ranges.push({
      tag,
      start: parsed.byteOffset,
      end: parsed.byteOffset + parsed.byteLength - 1,
      isBit: parsed.bit !== undefined,
      bit: parsed.bit ?? -1,
    });
  }

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i];
      const b = ranges[j];
      // Byte ranges must intersect to possibly overlap.
      if (a.start > b.end || b.start > a.end) continue;
      // Two distinct bits in the same single byte do NOT overlap.
      if (a.isBit && b.isBit && a.start === b.start && a.end === b.end && a.bit !== b.bit) continue;
      overlaps.push(
        `Overlap: "${a.tag.name}" (${a.tag.address}) overlaps "${b.tag.name}" (${b.tag.address})`,
      );
    }
  }
  return overlaps;
}

// ── Row → tags ──────────────────────────────────────────────────────────────

type Cell = string | number | boolean | Date | null | undefined;

function cellToString(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  return String(cell).trim();
}

/** A cell looks like a Siemens address — or a bare "96.0" — (used for header auto-detect). */
const ADDRESS_LIKE_RE = /^%?[IQMEA]?[BWDX]?\d+(\.[0-7])?$/;

/**
 * Zero-based column indices for a tag-table layout. Different Siemens exports use
 * different column orders — a plain xlsx/csv tag table is Name/Type/Address/Comment,
 * whereas a TIA `.sdf` symbol-table export is Name/Address/Type/…/Comment(6).
 */
export interface TagColumnMap {
  name: number;
  dataType: number;
  address: number;
  comment: number;
}

/** Column layout of a plain xlsx/csv tag table: Name, Type, Address, Comment. */
export const CSV_COLUMNS: TagColumnMap = { name: 0, dataType: 1, address: 2, comment: 3 };

/**
 * Column layout of a TIA Portal `.sdf` symbol-table export (quoted, comma-separated,
 * no header): `"Name","Address","DataType",<HMI flags 3..5>,"Comment"(6),…`. Mirrors the
 * Unity `S7Interface.ReadSignalFile()` column mapping (0=symbol, 1=address, 2=type, 6=comment).
 */
export const SDF_COLUMNS: TagColumnMap = { name: 0, address: 1, dataType: 2, comment: 6 };

/**
 * Build tags from a matrix of rows (header auto-detected). Column order is taken
 * from {@link TagColumnMap}, defaulting to the Name/Type/Address/Comment layout.
 */
function rowsToTable(rows: Cell[][], columns: TagColumnMap = CSV_COLUMNS): ParsedTagTable {
  const tags: S7Tag[] = [];
  const warnings: string[] = [];

  // Header auto-detect (F7): skip the first row when its address column is NOT a
  // Siemens address; otherwise the first row is already data (a `.sdf` has no header).
  let startRow = 0;
  if (rows.length > 0) {
    const firstAddr = cellToString(rows[0][columns.address]);
    if (!ADDRESS_LIKE_RE.test(firstAddr)) {
      startRow = 1;
    }
  }

  for (let r = startRow; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0) continue;

    const name = cellToString(row[columns.name]);
    const dataType = cellToString(row[columns.dataType]);
    const address = cellToString(row[columns.address]);
    const comment = cellToString(row[columns.comment]);

    // Skip fully empty rows.
    if (!name && !dataType && !address) continue;

    if (!name || !address) {
      warnings.push(`Row ${r + 1}: missing name or address — skipped`);
      continue;
    }

    const { parsed, error } = parseAddress(address, dataType);
    if (!parsed) {
      warnings.push(`Row ${r + 1} "${name}": ${error}`);
      continue;
    }

    tags.push({
      name,
      dataType: dataType,
      address,
      area: parsed.area,
      comment: comment || undefined,
    });
  }

  const overlaps = findOverlaps(tags);
  return { tags, warnings, overlaps };
}

// ── CSV parsing ─────────────────────────────────────────────────────────────

/** Autodetect the CSV delimiter by counting `,`, `;` and Tab on the first line. */
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = {
    ';': (firstLine.match(/;/g) ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
    ',': (firstLine.match(/,/g) ?? []).length,
  };
  let best = ',';
  let bestCount = -1;
  for (const d of [';', '\t', ',']) {
    if (counts[d] > bestCount) {
      best = d;
      bestCount = counts[d];
    }
  }
  return best;
}

/** Split a single CSV line on a delimiter, honoring double-quoted fields. */
function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsv(text: string): ParsedTagTable {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows: Cell[][] = lines.map(l => splitCsvLine(l, delimiter));
  return rowsToTable(rows);
}

// ── SDF parsing (TIA symbol-table export) ────────────────────────────────────

/**
 * Parse a TIA Portal `.sdf` symbol-table export. The format is a header-less,
 * fully double-quoted, comma-separated table whose columns are
 * `Name, Address, DataType, <HMI flags>, Comment(6), …` (see {@link SDF_COLUMNS}).
 * The address keeps its `%` and area letter (e.g. `%QD120`, `%M10000.0`), which the
 * shared {@link parseAddress}/{@link deriveWireType} handle unchanged.
 *
 * Example line: `"MC01_1","%QD120","DWord","True","True","False","","","True"`.
 */
export function parseSdf(text: string): ParsedTagTable {
  const delimiter = detectDelimiter(text);
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  const rows: Cell[][] = lines.map(l => splitCsvLine(l, delimiter));
  return rowsToTable(rows, SDF_COLUMNS);
}

// ── Public entry point ──────────────────────────────────────────────────────

/**
 * Parse a Siemens tag table file (xlsx or csv) into a flat list of tags with
 * validation and overlap warnings.
 */
export async function parseTagTable(file: File): Promise<ParsedTagTable> {
  const name = (file.name ?? '').toLowerCase();
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls');
  const isSdf = name.endsWith('.sdf');

  if (isXlsx) {
    // Lazy-load the spreadsheet parser only when an xlsx is actually imported.
    const mod = await import('read-excel-file');
    const readXlsxFile = (mod.default ?? mod) as (input: File | Blob | ArrayBuffer) => Promise<Cell[][]>;
    const rows = await readXlsxFile(file);
    return rowsToTable(rows);
  }

  const text = await file.text();
  return isSdf ? parseSdf(text) : parseCsv(text);
}

// ── Multi-Tab (Excel → MQTT Topic) Mapping ───────────────────────────────────

/**
 * Sanitize a tab name into a valid MQTT topic level: the MQTT wildcard
 * characters (`#`, `+`), the level separator `/` and whitespace are not allowed
 * inside a topic segment derived from a single tab, so they are replaced with
 * `_`. Leading/trailing `_` are trimmed; a fully-empty result falls back to
 * `topic`.
 */
function sanitizeTopicName(raw: string): string {
  const cleaned = raw.replace(/[#+/\s]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'topic';
}

/**
 * Build one topic per sheet from already-read row matrices — the pure mapping
 * core of the Multi-Tab import (no xlsx IO), so it is unit-testable inline.
 *
 * `sheets` maps a tab name to its raw `Cell[][]` (first row = header
 * Name|Type|Address|Comment, auto-detected). Sheets whose name does not match
 * `options.sheetPattern` go to `ignoredSheets`. Each accepted sheet becomes a
 * {@link ParsedTopic} whose `topic` is the (prefixed, sanitized) tab name.
 *
 * Implements: F12 (empty pattern = all tabs), F13 (topic sanitizing + collision
 * check), F14 (cross-tab duplicate signal-name warnings), F15 (unparsable
 * addresses surfaced as per-topic drop warnings, never silently lost).
 */
export function buildTopicsFromRows(
  sheets: Record<string, Cell[][]>,
  options: MqttExcelImportOptions,
): ParsedMultiTabTable {
  const prefix = options.topicPrefix ?? '';
  const pattern = options.sheetPattern ?? '';
  const matchAll = pattern.trim().length === 0; // F12: empty pattern = ALL tabs.

  const topics: ParsedTopic[] = [];
  const ignoredSheets: string[] = [];
  const warnings: string[] = [];
  let totalSignals = 0;

  // F14: track signal names across all imported tabs.
  const nameToSheets = new Map<string, string[]>();
  // F13: track sanitized topic → originating sheet to detect collisions.
  const topicToSheet = new Map<string, string>();

  for (const sheetName of Object.keys(sheets)) {
    // F3 / F12: pattern filter (case-sensitive, no /i flag).
    if (!matchAll && !matchesAny([pattern], sheetName)) {
      ignoredSheets.push(sheetName);
      continue;
    }

    const table = rowsToTable(sheets[sheetName]);
    const topicWarnings: string[] = [];

    // F15: report dropped (unparsable) rows per topic — never silent loss.
    if (table.warnings.length > 0) {
      topicWarnings.push(
        `${table.warnings.length} row(s) dropped (unparsable address/type): ${table.warnings.join('; ')}`,
      );
    }
    // Carry over soft overlap warnings (F11).
    for (const o of table.overlaps) topicWarnings.push(o);

    const signals: ParsedTag[] = table.tags.map(t => ({
      ...t,
      wireType: deriveWireType(t.dataType, t.area, { forceOutput: options.forceAllAsOutput }),
    }));

    // F13: sanitize the topic name and apply the optional prefix.
    const sanitized = sanitizeTopicName(sheetName);
    const topic = `${prefix}${sanitized}`;
    const prevSheet = topicToSheet.get(topic);
    if (prevSheet !== undefined) {
      warnings.push(`Topic collision: "${sheetName}" and "${prevSheet}" both map to topic "${topic}"`);
    } else {
      topicToSheet.set(topic, sheetName);
    }

    // F14: record signal names for the cross-tab duplicate check.
    for (const s of signals) {
      const arr = nameToSheets.get(s.name) ?? [];
      arr.push(sheetName);
      nameToSheets.set(s.name, arr);
    }

    totalSignals += signals.length;
    topics.push({ topic, sheetName, signals, warnings: topicWarnings });
  }

  // F14: emit one warning per signal name seen in more than one tab.
  for (const [name, sheetList] of nameToSheets) {
    if (sheetList.length > 1) {
      warnings.push(`Duplicate signal name "${name}" in tabs: ${[...new Set(sheetList)].join(', ')}`);
    }
  }

  return { topics, ignoredSheets, totalSignals, warnings };
}

/**
 * Parse a multi-tab Excel workbook (xlsx) into one MQTT topic per matching tab.
 *
 * Reads the sheet names lazily via `read-excel-file`'s `readSheetNames`, reads
 * each matching sheet's rows via `readXlsxFile(file, { sheet })`, then delegates
 * all mapping to the pure {@link buildTopicsFromRows}. Keeping the xlsx IO out
 * of the mapping core lets the latter be unit-tested without a fixture file.
 */
export async function parseMqttExcelMultiTab(
  file: File,
  options: MqttExcelImportOptions,
): Promise<ParsedMultiTabTable> {
  return buildTopicsFromRows(await readWorkbookSheets(file), options);
}

/**
 * Read every sheet of an xlsx workbook into a `tab name → Cell[][]` map, once.
 *
 * The per-sheet reads are independent, so they run in parallel. Exposed separately
 * from {@link parseMqttExcelMultiTab} so a UI can read the workbook a single time and
 * then re-run the pure {@link buildTopicsFromRows} on every filter/prefix change,
 * instead of re-reading the file on each keystroke.
 */
export async function readWorkbookSheets(file: File): Promise<Record<string, Cell[][]>> {
  const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
  const sheetNames = await readSheetNames(file);
  const rowsPerSheet = await Promise.all(
    sheetNames.map(name => readXlsxFile(file, { sheet: name }) as Promise<Cell[][]>),
  );
  const sheets: Record<string, Cell[][]> = {};
  sheetNames.forEach((name, i) => { sheets[name] = rowsPerSheet[i]; });
  return sheets;
}
