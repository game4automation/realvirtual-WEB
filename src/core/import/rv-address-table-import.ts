// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-address-table-import — the address TABLE as an address source (plan-2025 F12).
 *
 * A CSV / TSV of `name;address[;dataType[;topic]]` for ANY interface type: the second way (next to
 * "Fill addresses from controller") to put protocol addresses into CONNECT without typing them one
 * by one. Pure: parsing, row checks and the batch are computed here; the store adds the gateway's
 * own per-row address check (`POST /signals/validate`) and sends the batch.
 *
 * Rules (plan-589, binding): the address goes into CONNECT (`ProtocolAddress`) and nowhere else —
 * never into the model, never into a comment; the row NAME is the signal name verbatim (no
 * normalisation, no guessing); every row is judged on its own and a rejected row says why. Only
 * accepted rows travel, as ONE atomic batch of `signal.upsert`.
 *
 * Containers: a row lands in the interface-level `signals` list or in one MQTT topic's list. The
 * container comes either from the row's `topic` column or from one choice for the whole import. A
 * topic the interface does not have, a name that lives in more than one container, or a name that
 * lives in a topic while the row names none is rejected — never guessed.
 */

import { addressRuleFor, isProcessImageAddress } from './rv-iface-signal-slots';
import { schemaDataType } from './rv-fill-addresses';
import type { ModelPlcSignal } from './rv-plc-automap';
import type {
  ConnectConfigOp,
  ConnectConfigPlanBase,
  ConnectInterface,
  ConnectMqttTopic,
  ConnectSignalSchema,
  SignalValidationResult,
} from '../hmi/connect-store';

// ── Parsing ────────────────────────────────────────────────────────────

/** Column separators the parser recognises. */
export type AddressTableDelimiter = ';' | ',' | '\t';

/** Which column carries which field (0-based); `null` = the table has no such column. */
export interface AddressTableColumns {
  name: number;
  address: number;
  dataType: number | null;
  topic: number | null;
}

export interface AddressTableRow {
  /** 1-based line in the source text (for messages). */
  line: number;
  cells: string[];
}

export interface ParsedAddressTable {
  delimiter: AddressTableDelimiter;
  /** The header row, when the first row is one. */
  header: string[] | null;
  rows: AddressTableRow[];
  /** Column mapping from the header, else the positional `name;address;dataType;topic`. */
  columns: AddressTableColumns;
  /** Widest row (header included). */
  columnCount: number;
}

const HEADER_NAMES: Record<keyof AddressTableColumns, RegExp> = {
  name: /^(name|signal|signal ?name|symbol|tag|tag ?name)$/i,
  address: /^(address|protocol ?address|adresse|node ?id|topic address)$/i,
  dataType: /^(data ?type|datatype|type)$/i,
  topic: /^(topic|container)$/i,
};

/** The separator choice of the import dialog: detected, or one the user names. */
export type AddressTableDelimiterChoice = 'auto' | AddressTableDelimiter;

/** Separators of one line that stand OUTSIDE quoted text (`"ns=2;s=Motor"` hides its `;`). */
function delimitersOutsideQuotes(line: string): { tab: number; semicolon: number; comma: number } {
  const out = { tab: 0, semicolon: 0, comma: 0 };
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { i++; continue; } // "" inside quotes = one quote
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (c === '\t') out.tab++;
    else if (c === ';') out.semicolon++;
    else if (c === ',') out.comma++;
  }
  return out;
}

/**
 * The separator of a table: a tab when the first data line has one, else `;` when present, else `,`
 * — counted only OUTSIDE quoted fields, so `Motor,"ns=2;s=Motor",Bool` is a comma table.
 */
export function detectDelimiter(text: string): AddressTableDelimiter {
  const first = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    .find(l => l.trim() !== '' && !l.trimStart().startsWith('#')) ?? '';
  const n = delimitersOutsideQuotes(first);
  if (n.tab > 0) return '\t';
  if (n.semicolon > 0) return ';';
  return ',';
}

/**
 * Split one line. A field that starts with `"` and whose closing quote is followed by the separator
 * (or the line end) is a quoted CSV field (`""` = one quote). Anything else is literal — so a TIA
 * symbol like `"DB1".Start` stays exactly as written instead of losing its quotes.
 */
export function splitLine(line: string, delimiter: AddressTableDelimiter): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < line.length) {
        if (line[j] === '"') {
          if (line[j + 1] === '"') { value += '"'; j += 2; continue; }
          closed = true;
          break;
        }
        value += line[j++];
      }
      if (closed && (j + 1 === line.length || line[j + 1] === delimiter)) {
        out.push(value.trim());
        i = j + 2;
        if (j + 1 === line.length) break;
        continue;
      }
    }
    const end = line.indexOf(delimiter, i);
    if (end < 0) { out.push(line.slice(i).trim()); break; }
    out.push(line.slice(i, end).trim());
    i = end + 1;
  }
  return out;
}

function isHeader(cells: readonly string[]): boolean {
  // A header names at least the two mandatory columns, in any order.
  return cells.some(c => HEADER_NAMES.name.test(c)) && cells.some(c => HEADER_NAMES.address.test(c));
}

function columnsFromHeader(header: readonly string[]): AddressTableColumns {
  const find = (re: RegExp, taken: Set<number>): number | null => {
    const i = header.findIndex((h, idx) => !taken.has(idx) && re.test(h.trim()));
    if (i >= 0) taken.add(i);
    return i >= 0 ? i : null;
  };
  const taken = new Set<number>();
  const name = find(HEADER_NAMES.name, taken) ?? 0;
  taken.add(name);
  const address = find(HEADER_NAMES.address, taken) ?? 1;
  taken.add(address);
  return { name, address, dataType: find(HEADER_NAMES.dataType, taken), topic: find(HEADER_NAMES.topic, taken) };
}

/** Positional mapping `name;address[;dataType[;topic]]` for a table of `width` columns. */
export function positionalColumns(width: number): AddressTableColumns {
  return { name: 0, address: 1, dataType: width > 2 ? 2 : null, topic: width > 3 ? 3 : null };
}

/** Parse a CSV / TSV address table. Empty lines and `#` comment lines are skipped. */
export function parseAddressTable(text: string, choice: AddressTableDelimiterChoice = 'auto'): ParsedAddressTable {
  const delimiter: AddressTableDelimiter = choice === 'auto' ? detectDelimiter(text) : choice;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows: AddressTableRow[] = [];
  let header: string[] | null = null;
  let columnCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const cells = splitLine(raw, delimiter);
    columnCount = Math.max(columnCount, cells.length);
    if (header === null && rows.length === 0 && isHeader(cells)) { header = cells; continue; }
    rows.push({ line: i + 1, cells });
  }
  const columns = header ? columnsFromHeader(header) : positionalColumns(columnCount);
  return { delimiter, header, rows, columns, columnCount };
}

// ── Planning ───────────────────────────────────────────────────────────

/** Where the rows go: the topic column per row, the flat list, or one topic for all. */
export type AddressImportContainer =
  | { kind: 'per-row' }
  | { kind: 'flat' }
  | { kind: 'topic'; topic: string };

/** What happens to an address the signal already has: kept (fill only empty ones) or replaced. */
export type AddressImportExisting = 'fillEmpty' | 'overwrite';

export interface AddressImportOptions {
  container: AddressImportContainer;
  existing: AddressImportExisting;
  /**
   * Direction for a NEW signal the model does not know and whose address does not imply one. null =
   * such rows are rejected ("direction unknown").
   */
  defaultDirection: 'input' | 'output' | null;
  /** Override of the column mapping (the dialog's column selects). */
  columns?: AddressTableColumns;
}

export type AddressImportStatus = 'create' | 'update' | 'unchanged' | 'kept' | 'rejected';

export interface AddressImportRow {
  line: number;
  name: string;
  address: string;
  dataType?: string;
  /** Resolved container; absent = the interface-level list. */
  topic?: string;
  status: AddressImportStatus;
  /** Wire type of a created signal. */
  type?: string;
  /** Existing address (update / kept). */
  existingAddress?: string;
  reason?: string;
}

export interface AddressImportPlan {
  interfaceId: string;
  existing: AddressImportExisting;
  rows: AddressImportRow[];
  counts: Record<AddressImportStatus, number>;
  /** Revision / instance / gateway the plan was computed on (set by the store; Apply sends exactly this). */
  base?: ConnectConfigPlanBase;
  /** The CONNECT size limit the batch breaks (set by the store), null/absent = within the limits. */
  limitError?: string | null;
}

export interface AddressImportInput {
  table: ParsedAddressTable;
  iface: ConnectInterface;
  schema: ConnectSignalSchema | null;
  options: AddressImportOptions;
  /** Model PLC signals: the wire type of a new signal comes from the model signal of the same name. */
  model?: readonly ModelPlcSignal[];
  /** Every OTHER interface — a new name already configured there would collide. */
  otherInterfaces?: readonly ConnectInterface[];
  /** The gateway's per-row address check, by line; absent = not checked (older gateway, not validatable). */
  validation?: ReadonlyMap<number, SignalValidationResult | null>;
}

const STATUSES: readonly AddressImportStatus[] = ['create', 'update', 'unchanged', 'kept', 'rejected'];

/** Statuses the batch writes. */
export const ADDRESS_IMPORT_WRITE_STATUSES: ReadonlySet<AddressImportStatus> = new Set<AddressImportStatus>(['create', 'update']);

function cell(row: AddressTableRow, index: number | null): string {
  return index === null ? '' : (row.cells[index] ?? '').trim();
}

function kindOfDataType(dataType: string | undefined): 'Bool' | 'Int' | 'Float' | 'Text' {
  const d = (dataType ?? '').trim().toUpperCase();
  if (d === 'BOOL' || d === 'BIT' || d === 'BOOLEAN') return 'Bool';
  if (d === 'REAL' || d === 'LREAL' || d === 'FLOAT' || d === 'DOUBLE') return 'Float';
  if (/^(TEXT|STRING|W?STRING(\s*[[(]\s*\d+\s*[\])])?)$/.test(d)) return 'Text';
  if (d === '') return 'Float';
  return 'Int';
}

/** The container a row goes to, or the reason it cannot be decided. */
function resolveContainer(
  iface: ConnectInterface,
  name: string,
  rowTopic: string,
  choice: AddressImportContainer,
): { topic?: ConnectMqttTopic; error?: string } {
  const topics = iface.topics ?? [];
  const wanted = choice.kind === 'topic' ? choice.topic : choice.kind === 'per-row' ? rowTopic : '';
  if (wanted) {
    const topic = topics.find(t => t.topic === wanted);
    if (!topic) return { error: `Unknown container: interface '${iface.id}' has no topic '${wanted}'` };
    return { topic };
  }
  // Flat list chosen (or no topic in the row): a name that already lives in a topic is ambiguous.
  const holders = topics.filter(t => (t.signals ?? []).some(s => s.name === name));
  if (holders.length > 0) {
    return {
      error: holders.length > 1
        ? `Ambiguous container: '${name}' lives in the topics ${holders.map(t => `'${t.topic}'`).join(', ')} — name the topic`
        : `Missing container: '${name}' lives in topic '${holders[0].topic}' — name the topic in the row or choose it for the import`,
    };
  }
  return {};
}

/**
 * Judge every row (plan-2025 F12). Rejected rows carry the reason; the rest say what the batch will
 * do. Duplicate rows for the same place: the first wins, later ones are rejected.
 */
export function planAddressTableImport(input: AddressImportInput): AddressImportPlan {
  const { table, iface, schema, options } = input;
  const columns = options.columns ?? table.columns;
  const counts = {} as Record<AddressImportStatus, number>;
  for (const s of STATUSES) counts[s] = 0;
  const rows: AddressImportRow[] = [];
  const modelByName = new Map<string, ModelPlcSignal>();
  for (const m of input.model ?? []) if (m.name && !modelByName.has(m.name)) modelByName.set(m.name, m);
  const elsewhere = new Set<string>();
  for (const other of input.otherInterfaces ?? []) {
    if (other.id === iface.id) continue;
    for (const s of other.signals ?? []) elsewhere.add(s.name);
    for (const t of other.topics ?? []) for (const s of t.signals ?? []) elsewhere.add(s.name);
  }
  const seen = new Set<string>();

  for (const row of table.rows) {
    const name = cell(row, columns.name);
    const address = cell(row, columns.address);
    const rawDataType = cell(row, columns.dataType);
    const rowTopic = cell(row, columns.topic);
    const base = { line: row.line, name, address, ...(rawDataType ? { dataType: rawDataType } : {}) };
    const reject = (reason: string, topic?: string): void => {
      rows.push({ ...base, ...(topic !== undefined ? { topic } : {}), status: 'rejected', reason });
      counts.rejected++;
    };

    if (!name) { reject('Name missing'); continue; }
    const container = resolveContainer(iface, name, rowTopic, options.container);
    if (container.error) { reject(container.error); continue; }
    const topicName = container.topic?.topic;
    const placeKey = `${topicName ?? ''}\u0000${name}`;
    if (seen.has(placeKey)) { reject('Duplicate row for this signal — the first row wins', topicName); continue; }
    seen.add(placeKey);

    // Address rule of the place (plan-589): what the gateway's worker does with an (empty) address.
    const rule = addressRuleFor({ topic: topicName, mode: container.topic?.mode }, schema);
    if (rule === 'required' && !address) { reject(`Address missing — this place needs a ${schema?.addressLabel ?? 'address'}`, topicName); continue; }
    if (rule === 'container-topic' && address) {
      reject(`No address allowed here — the topic '${topicName}' is the address`, topicName); continue;
    }
    if (rule === 'none' && address) {
      reject(`No address allowed here — topic '${topicName}' keys its JSON object by the signal name`, topicName); continue;
    }
    // Protocol syntax: a ProcessImage byte offset locally, everything else by the gateway's parser.
    const processImage = container.topic?.mode === 'ProcessImage';
    if (address && processImage && !isProcessImageAddress(address)) {
      reject(`Invalid process-image address '${address}' — expected e.g. %IW13, %I3.1 or 96.0`, topicName); continue;
    }
    const check = !processImage ? input.validation?.get(row.line) ?? null : null;
    if (address && check && check.checked && !check.valid) {
      reject(check.error ? `Invalid address: ${check.error}` : `Invalid address '${address}'`, topicName); continue;
    }

    let dataType: string | undefined;
    if (rawDataType) {
      dataType = schemaDataType(rawDataType, schema);
      if (!dataType) {
        reject(`Data type '${rawDataType}' is not allowed for ${iface.type} (allowed: ${(schema?.dataTypes ?? []).join(', ')})`, topicName);
        continue;
      }
    }
    const finalAddress = (check?.valid && check.normalizedAddress) || address;

    const list = container.topic ? container.topic.signals ?? [] : iface.signals ?? [];
    const existing = list.find(s => s.name === name);
    const topic = topicName !== undefined ? { topic: topicName } : {};
    if (existing) {
      const current = existing.protocolAddress ?? '';
      const sameData = dataType === undefined || dataType === (existing.dataType ?? '');
      if (current === finalAddress && sameData) {
        rows.push({ ...base, address: finalAddress, ...topic, status: 'unchanged', existingAddress: current }); counts.unchanged++;
      } else if (current.trim() !== '' && current !== finalAddress && options.existing === 'fillEmpty') {
        rows.push({
          ...base, address: finalAddress, ...topic, status: 'kept', existingAddress: current,
          reason: 'The signal already has a different address — kept (choose "Overwrite" to replace it)',
        });
        counts.kept++;
      } else {
        rows.push({ ...base, address: finalAddress, ...(dataType ? { dataType } : {}), ...topic, status: 'update', existingAddress: current });
        counts.update++;
      }
      continue;
    }

    if (elsewhere.has(name)) { reject(`'${name}' is already configured on another interface`, topicName); continue; }
    const modelType = modelByName.get(name)?.type;
    const effective = check?.valid ? check.effectiveType ?? null : null;
    const direction = modelType
      ? (modelType.startsWith('PLCInput') ? 'input' : 'output')
      : effective
        ? (effective.includes('PLCInput') ? 'input' : 'output')
        : options.defaultDirection;
    if (!direction) {
      reject('Direction unknown — no model signal of this name and the address implies none; choose a default direction', topicName);
      continue;
    }
    const kindFromEffective = effective?.match(/(Bool|Int|Float|Text)$/)?.[1];
    const type = modelType ?? `PLC${direction === 'input' ? 'Input' : 'Output'}${kindFromEffective ?? kindOfDataType(dataType)}`;
    rows.push({ ...base, address: finalAddress, ...(dataType ? { dataType } : {}), ...topic, status: 'create', type });
    counts.create++;
  }
  return { interfaceId: iface.id, existing: options.existing, rows, counts };
}

/** Rows whose address the gateway should check (`POST /signals/validate`) before planning. */
export function rowsToValidate(
  table: ParsedAddressTable,
  iface: ConnectInterface,
  schema: ConnectSignalSchema | null,
  options: AddressImportOptions,
): Array<{ line: number; address: string; dataType?: string }> {
  if (!schema?.addressValidatable) return [];
  const columns = options.columns ?? table.columns;
  const out: Array<{ line: number; address: string; dataType?: string }> = [];
  for (const row of table.rows) {
    const address = cell(row, columns.address);
    if (!address) continue;
    const name = cell(row, columns.name);
    const container = resolveContainer(iface, name, cell(row, columns.topic), options.container);
    if (container.error || container.topic) continue; // topic places: container-topic / none / ProcessImage (local)
    const dataType = cell(row, columns.dataType);
    // A row that cannot write is not worth a gateway round trip: the signal already has exactly this
    // address (unchanged), or has another one and "fill empty" keeps it (kept). A data type in the row
    // could still make an update, so such rows are validated.
    const existing = name && !dataType ? (iface.signals ?? []).find(s => s.name === name) : undefined;
    if (existing) {
      const current = existing.protocolAddress ?? '';
      if (current === address) continue;
      if (current.trim() !== '' && options.existing === 'fillEmpty') continue;
    }
    out.push({ line: row.line, address, ...(dataType ? { dataType } : {}) });
  }
  return out;
}

/** The ONE batch of an import: a `signal.upsert` per create / update row. */
export function addressImportOps(plan: AddressImportPlan): ConnectConfigOp[] {
  const ops: ConnectConfigOp[] = [];
  for (const row of plan.rows) {
    if (!ADDRESS_IMPORT_WRITE_STATUSES.has(row.status)) continue;
    ops.push({
      op: 'signal.upsert',
      interfaceId: plan.interfaceId,
      ...(row.topic !== undefined ? { topic: row.topic } : {}),
      name: row.name,
      protocolAddress: row.address,
      addressMode: plan.existing,
      ...(row.dataType ? { dataType: row.dataType } : {}),
      ...(row.status === 'create' ? { type: row.type, record: false } : {}),
    });
  }
  return ops;
}
