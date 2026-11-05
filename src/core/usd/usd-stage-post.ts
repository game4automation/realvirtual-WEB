// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { PrimIdentity } from './usd-prim-identity';
import type { ReducedChannel } from './keyframe-reduce';

export type VisibilityToken = 'invisible' | 'inherited';
export interface PrimPostData {
  customData?: PrimIdentity;
  visibility?: VisibilityToken;
  visibilitySamples?: readonly (readonly [number, VisibilityToken])[];
  /** Original track values, never parsed back from rounded exporter text. */
  translate?: ReducedChannel;
  orient?: ReducedChannel;
  scale?: ReducedChannel;
  matrix?: ReducedChannel;
}
export interface StagePostOptions {
  finalNames: readonly string[];
  prims?: ReadonlyMap<number, PrimPostData>;
  writeAddresses?: boolean;
  time?: { endTimeCode: number; fps: number };
  blenderVisibilityCompat?: boolean;
  fixSubsetFamily?: boolean;
  /**
   * Split parts of oversized geometries (plan-2246): `_rvP<i>_<k>` -> final name.
   * Renamed only — no customData, no visibility, no transform edits.
   */
  partNames?: ReadonlyMap<string, string>;
}
interface Token { value: string; start: number; end: number }
type TextPart = string | Uint8Array;
interface Edit { start: number; end: number; text: string | readonly TextPart[] }

/** End of a quoted string, asset or path. Contents never become tokens. */
function quotedEnd(text: string, start: number): number {
  const end = text[start] === '<' ? '>' : text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === end) return i + 1;
  }
  throw new Error('Unclosed USDA string/path');
}

/** Scan opaque attribute payloads by index, retaining only delimiter depth. */
function blockEnd(text: string, start: number): number {
  const stack = [text[start] === '(' ? ')' : text[start] === '[' ? ']' : '}'];
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === '@' || c === '<') { i = quotedEnd(text, i) - 1; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c === '(' ? ')' : c === '[' ? ']' : '}');
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) throw new Error('Unbalanced USDA block');
      if (!stack.length) return i;
    }
  }
  throw new Error('Unclosed USDA block');
}

/**
 * Retain declaration/header tokens only. Time-sample dictionaries, arrays and
 * tuple-valued attributes are scanned as opaque ranges, so ten minutes of TRS
 * samples costs no per-frame/per-number token objects. Metadata dictionaries
 * remain structural because withIdentity merges their string fields.
 */
function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < text.length;) {
    const c = text[i];
    const code = text.charCodeAt(i);
    if (code <= 32 || (code > 127 && /\s/.test(c))) { i++; continue; }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    const previous = out[out.length - 1];
    const opaque = c === '[' || (previous?.value === '=' && (c === '('
      || (c === '{' && out[out.length - 2]?.value.endsWith('.timeSamples'))));
    if (opaque) {
      const end = blockEnd(text, i);
      out.push({ value: c, start: i, end: i + 1 }, { value: text[end], start: end, end: end + 1 });
      i = end + 1;
      continue;
    }
    const start = i++;
    if (c === '"' || c === '@' || c === '<') i = quotedEnd(text, start);
    else if (/[A-Za-z_]/.test(c)) {
      while (i < text.length && /[\w:.]/.test(text[i])) i++;
    } else if (/[0-9+.-]/.test(c)) {
      // Scalar numeric attributes need positions, never one object per digit.
      while (i < text.length && /[0-9eE+.-]/.test(text[i])) i++;
      out.push({ value: 'number', start, end: i });
      continue;
    }
    out.push({ value: text.slice(start, i), start, end: i });
  }
  return out;
}
function closing(ts: readonly Token[], index: number): number {
  const end = ts[index].value === '(' ? ')' : '}';
  const stack = [end];
  for (let i = index + 1; i < ts.length; i++) {
    const value = ts[i].value;
    if (value === '(' || value === '{') stack.push(value === '(' ? ')' : '}');
    else if (value === ')' || value === '}') {
      if (stack.pop() !== value) throw new Error('Unbalanced USDA block');
      if (!stack.length) return i;
    }
  }
  throw new Error('Unclosed USDA block');
}
function* editedParts(text: string, edits: Edit[]): Generator<TextPart | { start: number; end: number }> {
  edits.sort((a, b) => b.start - a.start);
  let before = 0;
  // Reverse the stable descending order, including same-position insertions,
  // to preserve the original string post-pass's exact output order.
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i];
    if (edit.start < before) throw new Error('Overlapping USDA edits');
    yield { start: before, end: edit.start };
    if (typeof edit.text === 'string') yield edit.text;
    else yield* edit.text;
    before = edit.end;
  }
  yield { start: before, end: text.length };
}

function apply(text: string, edits: Edit[]): string {
  if (!edits.length) return text;
  const chunks: string[] = [];
  for (const part of editedParts(text, edits)) chunks.push(typeof part === 'string' ? part
    : part instanceof Uint8Array ? new TextDecoder().decode(part) : text.slice(part.start, part.end));
  return chunks.join('');
}

/** Encode bounded source ranges, never splitting a UTF-16 surrogate pair. */
function encodeRange(text: string, start: number, end: number, encoder: TextEncoder, chunks: Uint8Array[]): void {
  while (start < end) {
    let next = Math.min(start + 8192, end);
    const last = text.charCodeAt(next - 1);
    if (next < end && last >= 0xd800 && last <= 0xdbff
      && text.charCodeAt(next) >= 0xdc00 && text.charCodeAt(next) <= 0xdfff) next--;
    chunks.push(encoder.encode(text.slice(start, next)));
    start = next;
  }
}

/** Production path: bounded UTF-8 chunks, no stage-sized string or byte join. */
function applyByteChunks(text: string, edits: Edit[]): readonly Uint8Array[] {
  const encoder = new TextEncoder(), chunks: Uint8Array[] = [];
  for (const part of editedParts(text, edits)) {
    if (part instanceof Uint8Array) chunks.push(part);
    else if (typeof part === 'string') encodeRange(part, 0, part.length, encoder, chunks);
    else encodeRange(text, part.start, part.end, encoder, chunks);
  }
  return chunks;
}
function quote(value: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) throw new Error('Unsupported USDA string control character');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite USD value');
  return Object.is(value, -0) ? '0' : String(value);
}

/** Matrix4.elements are column-major; USD's row-vector convention uses those as rows. */
function tuple(values: ArrayLike<number>, offset: number, width: number): string {
  const parts: string[] = [];
  for (let j = 0; j < width; j++) parts.push(numberText(values[offset + j]));
  return `(${parts.join(', ')})`;
}
function matrixText(values: ArrayLike<number>, offset: number): string {
  return `(${[0, 4, 8, 12].map((j) => tuple(values, offset + j, 4)).join(', ')})`;
}

/** Bounded flat chunks; never retain a cons-string graph per sample. */
class TextChunks {
  private readonly chunks: TextPart[] = [];
  private bytes = new Uint8Array(16384);
  private readonly decoder = new TextDecoder();
  private used = 0;
  constructor(private readonly binary = false) {}
  emit(text: string): void {
    this.emitRange(text, 0, text.length);
  }
  emitRange(text: string, start: number, end: number): void {
    for (let j = start; j < end; j++) this.emitCode(text.charCodeAt(j));
  }
  emitFrame(frame: number): void {
    let divisor = 1;
    while (frame >= divisor * 10) divisor *= 10;
    do {
      this.emitCode(48 + Math.floor(frame / divisor));
      frame %= divisor; divisor /= 10;
    } while (divisor >= 1);
  }
  private emitCode(code: number): void {
    this.bytes[this.used++] = code;
    if (this.used === this.bytes.length) {
      this.chunks.push(this.binary ? this.bytes : this.decoder.decode(this.bytes));
      if (this.binary) this.bytes = new Uint8Array(16384);
      this.used = 0;
    }
  }
  finish(): readonly TextPart[] {
    if (this.used) this.chunks.push(this.binary ? this.bytes.subarray(0, this.used) : this.decoder.decode(this.bytes.subarray(0, this.used)));
    return this.chunks;
  }
}

/** Native JSON number formatting has exactly Number.toString's finite-number
 * spelling (including -0 -> 0), but formats a packed batch without allocating
 * one JS string for every component of every frame. */
class NumberTextBatch {
  private readonly values: number[] = new Array<number>(512).fill(0.1);
  private text = '';
  private cursor = 1;
  private next = 0;
  constructor(private readonly source: ArrayLike<number>) {}
  emitNext(writer: TextChunks): void {
    if (this.cursor >= this.text.length - 1) {
      const count = Math.min(512, this.source.length - this.next);
      this.values.length = count;
      for (let i = 0; i < count; i++) {
        const value = this.source[this.next++];
        if (!Number.isFinite(value)) throw new Error('Non-finite USD value');
        this.values[i] = value;
      }
      this.text = JSON.stringify(this.values); this.cursor = 1;
    }
    const comma = this.text.indexOf(',', this.cursor);
    const end = comma < 0 ? this.text.length - 1 : comma;
    writer.emitRange(this.text, this.cursor, end);
    this.cursor = end + 1;
  }
}

function channelText(channel: ReducedChannel, kind: 'matrix' | 'translate' | 'orient' | 'scale', pad: string, binary: boolean): string | readonly TextPart[] {
  const matrix = kind === 'matrix', quaternion = kind === 'orient';
  const width = matrix ? 16 : quaternion ? 4 : 3;
  if (channel.values.length !== channel.frames.length * width || channel.defaultValue.length !== width) throw new Error('Invalid post-pass channel');
  const declaration = matrix ? 'matrix4d xformOp:transform' : `${quaternion ? 'quatf' : kind === 'translate' ? 'double3' : 'float3'} xformOp:${kind}`;
  const format = matrix ? matrixText : (v: ArrayLike<number>, at: number) => quaternion
    ? `(${numberText(v[at + 3])}, ${numberText(v[at])}, ${numberText(v[at + 1])}, ${numberText(v[at + 2])})` : tuple(v, at, 3);
  if (!channel.frames.length) return `${declaration} = ${format(channel.defaultValue, 0)}`;
  // Write numbers into bounded flat ASCII chunks. String concatenation here
  // retains a cons-string graph per sample until the final join (P2 memory gate).
  const writer = new TextChunks(binary), emit = (text: string): void => writer.emit(text);
  const numbers = matrix || kind === 'translate' ? new NumberTextBatch(channel.values) : null;
  let last = -1;
  emit(`${declaration}.timeSamples = {\n`);
  for (let i = 0; i < channel.frames.length; i++) {
    const frame = channel.frames[i];
    if (!Number.isInteger(frame) || frame <= last) throw new Error('Invalid post-pass frame');
    last = frame;
    emit(pad); emit('\t'); writer.emitFrame(frame); emit(': (');
    for (let j = 0; j < width; j++) {
      if (matrix && j % 4 === 0) emit('(');
      const value = channel.values[i * width + (quaternion ? (j + 3) % 4 : j)];
      // Translation/matrix numbers round-trip doubles exactly. Nine digits
      // round-trip the float32 orient/scale values read by USD exactly too.
      if (numbers) numbers.emitNext(writer);
      else {
        if (!Number.isFinite(value)) throw new Error('Non-finite USD value');
        emit(value.toPrecision(9));
      }
      if (matrix && j % 4 === 3) emit(')');
      if (j < width - 1) emit(', ');
    }
    emit('),\n');
  }
  emit(`${pad}}`);
  return writer.finish();
}

interface Property { name: string; start: number; end: number; valueStart: number; valueEnd: number }

/** Rewrite float-second-derived keys from original frames, preserving the
 * exporter's quaternion/scale values and tuple ordering byte-for-byte. */
function integerSampleKeys(usda: string, property: Property, frames: Uint32Array, binary: boolean): readonly TextPart[] {
  if (!property.name.endsWith('.timeSamples')) throw new Error('Exporter omitted animated channel');
  const writer = new TextChunks(binary);
  let cursor = property.start, search = property.valueStart + 1, last = -1;
  for (const frame of frames) {
    if (frame <= last) throw new Error('Invalid post-pass frame');
    last = frame;
    const colon = usda.indexOf(':', search);
    if (colon < 0 || colon >= property.valueEnd) throw new Error('Exporter sample count mismatch');
    let end = colon;
    while (end > search && usda.charCodeAt(end - 1) <= 32) end--;
    let start = end;
    while (start > search) {
      const code = usda.charCodeAt(start - 1);
      if (!(code >= 48 && code <= 57) && code !== 101 && code !== 69 && code !== 43 && code !== 45 && code !== 46) break;
      start--;
    }
    if (start === end) throw new Error('Invalid exporter frame');
    writer.emitRange(usda, cursor, start); writer.emitFrame(frame);
    cursor = end; search = colon + 1;
  }
  const extra = usda.indexOf(':', search);
  if (extra >= 0 && extra < property.valueEnd) throw new Error('Exporter sample count mismatch');
  writer.emitRange(usda, cursor, property.end);
  return writer.finish();
}
/** Only direct attributes: nested prims and opaque arrays/dictionaries are skipped. */
function properties(ts: readonly Token[], body: number, end: number): Property[] {
  const out: Property[] = [];
  for (let j = body + 1; j < end; j++) {
    if (ts[j].value === 'def' || ts[j].value === 'over') {
      let name = j + 1;
      if (!ts[name]?.value.startsWith('"')) name++;
      let nested = name + 1;
      if (ts[nested]?.value === '(') nested = closing(ts, nested) + 1;
      if (ts[nested]?.value !== '{') throw new Error('No nested prim body');
      j = closing(ts, nested);
    } else if (ts[j + 1]?.value === '=') {
      const value = j + 2;
      let valueEnd = value;
      if (ts[value]?.value === '[') valueEnd++;
      else if (['{', '('].includes(ts[value]?.value)) valueEnd = closing(ts, value);
      let start = j - 1;
      if (ts[start]?.value === ']') start -= 2; // token[]
      if (ts[start - 1]?.value === 'uniform') start--;
      out.push({ name: ts[j].value, start: ts[start].start, end: ts[valueEnd].end,
        valueStart: ts[value].start, valueEnd: ts[valueEnd].end });
      j = valueEnd;
    }
  }
  return out;
}

function subsetEdits(usda: string, ts: readonly Token[]): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].value !== 'def' || ts[i + 1]?.value !== 'Mesh') continue;
    let body = i + 3;
    if (ts[body]?.value === '(') body = closing(ts, body) + 1;
    if (ts[body]?.value !== '{') throw new Error('No Mesh body');
    const end = closing(ts, body);
    const props = properties(ts, body, end);
    if (props.some((p) => p.name === 'subsetFamily:materialBind:familyType')) continue;
    let subset = false;
    for (let j = body + 1; j < end; j++) {
      if (ts[j].value === 'def' && ts[j + 1]?.value === 'GeomSubset') {
        let sub = j + 3;
        if (ts[sub]?.value === '(') sub = closing(ts, sub) + 1;
        const family = properties(ts, sub, closing(ts, sub)).find((p) => p.name === 'familyName');
        if (family && usda.slice(family.valueStart, family.valueEnd) === '"materialBind"') subset = true;
      }
    }
    if (subset) {
      const lineStart = usda.lastIndexOf('\n', ts[i].start) + 1;
      const pad = /^[\t ]*/.exec(usda.slice(lineStart, ts[i].start))![0];
      edits.push({ start: ts[body].end, end: ts[body].end,
        text: `\n${pad}\tuniform token subsetFamily:materialBind:familyType = "nonOverlapping"` });
    }
  }
  return edits;
}

/** Shared with future static export / Live-Link fixes (plan-2242); opt-in only. */
export function addSubsetFamilyType(usda: string): string {
  return apply(usda, subsetEdits(usda, tokens(usda)));
}

/** Merge existing customData metadata rather than authoring a duplicate dictionary. */
function withIdentity(metadata: string, identity: PrimIdentity, pad: string): string {
  const entries = Object.entries(identity).filter((entry): entry is [string, string] => entry[1] !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [key] of entries) if (!/^[A-Za-z_]\w*$/.test(key)) throw new Error('Invalid customData key');
  if (!entries.length) return metadata;
  const fields = entries.map(([key, value]) => `${pad}\t\t\tstring ${key} = ${quote(value)}`).join('\n');
  const ts = tokens(metadata);
  const custom = ts.findIndex((t) => t.value === 'customData');
  if (custom < 0) return metadata + `\n${pad}\tcustomData = {\n${pad}\t\tdictionary realvirtual = {\n${fields}\n${pad}\t\t}\n${pad}\t}\n${pad}`;
  if (ts[custom + 1]?.value !== '=' || ts[custom + 2]?.value !== '{') throw new Error('Unsupported customData metadata');
  const open = custom + 2, end = closing(ts, open);
  for (let i = open + 1; i < end; i++) {
    if (ts[i].value === 'dictionary' && ts[i + 1]?.value === 'realvirtual' && ts[i + 2]?.value === '=' && ts[i + 3]?.value === '{') {
      const dictEnd = closing(ts, i + 3), edits: Edit[] = [];
      const remaining = new Map(entries);
      for (let j = i + 4; j < dictEnd; j++) {
        if (ts[j].value === 'string' && remaining.has(ts[j + 1]?.value) && ts[j + 2]?.value === '=') {
          const key = ts[j + 1].value;
          edits.push({ start: ts[j + 3].start, end: ts[j + 3].end, text: quote(remaining.get(key)!) });
          remaining.delete(key);
        }
      }
      if (remaining.size) edits.push({ start: ts[dictEnd].start, end: ts[dictEnd].start,
        text: [...remaining].map(([key, value]) => `\n${pad}\t\t\tstring ${key} = ${quote(value)}`).join('') + `\n${pad}\t\t` });
      return apply(metadata, edits);
    }
    if (ts[i].value === '{' || ts[i].value === '(') i = closing(ts, i);
  }
  return apply(metadata, [{ start: ts[end].start, end: ts[end].start,
    text: `\n${pad}\t\tdictionary realvirtual = {\n${fields}\n${pad}\t\t}\n${pad}\t` }]);
}

/**
 * ID1/ID3 post-pass on three's model.usda. Rename ONLY def declarations.
 * Bindings, geometry references and existing TRS animation stay byte-identical.
 * The real prim block receives visibility; metadata receives customData.
 * Run after exporter-id normalization and before packaging (plan-2229 §2.9.13).
 */
function processModelUsda(usda: string, options: StagePostOptions, binary: boolean): { output: string | readonly Uint8Array[]; renamed: number; unmatched: number[] } {
  for (const name of options.finalNames) if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Invalid final prim name: ${name}`);
  const ts = tokens(usda), edits: Edit[] = [], seen = new Set<number>();
  if (options.fixSubsetFamily) edits.push(...subsetEdits(usda, ts));
  if (options.time) {
    const { endTimeCode, fps } = options.time;
    if (!Number.isInteger(endTimeCode) || endTimeCode < 0 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid stage time');
    const header = ts.findIndex((t) => t.value === '(');
    if (header < 0 || ts.slice(0, header).some((t) => t.value === 'def')) throw new Error('Missing stage metadata');
    const end = closing(ts, header);
    const values: Record<string, number> = { startTimeCode: 0, endTimeCode, timeCodesPerSecond: fps, framesPerSecond: fps };
    for (let j = header + 1; j < end; j++) {
      if (ts[j].value in values && ts[j + 1]?.value === '=') {
        edits.push({ start: ts[j + 2].start, end: ts[j + 2].end, text: numberText(values[ts[j].value]) });
        delete values[ts[j].value];
      }
      if (ts[j].value === '{') j = closing(ts, j);
    }
    if (Object.keys(values).length) edits.push({ start: ts[end].start, end: ts[end].start,
      text: Object.entries(values).map(([key, value]) => `\t${key} = ${numberText(value)}\n`).join('') });
  }
  const partNames = options.partNames, partsSeen = new Set<string>();
  if (partNames) for (const name of partNames.values()) if (!/^[A-Za-z_]\w*$/.test(name)) throw new Error(`Invalid part prim name: ${name}`);
  for (let i = 0; i < ts.length; i++) {
    if (ts[i].value !== 'def') continue;
    let name = i + 1;
    if (!ts[name]?.value.startsWith('"')) name++;
    if (partNames?.size) {
      const part = /^"(_rvP\d+_\d+)"$/.exec(ts[name]?.value ?? '');
      if (part) {
        const final = partNames.get(part[1]);
        if (final === undefined || partsSeen.has(part[1])) throw new Error(`Unknown or repeated part placeholder ${part[1]}`);
        partsSeen.add(part[1]);
        edits.push({ start: ts[name].start, end: ts[name].end, text: quote(final) });
        continue;
      }
    }
    const match = /^"_rvN(\d+)"$/.exec(ts[name]?.value ?? '');
    if (!match) continue;
    const k = Number(match[1]);
    if (k >= options.finalNames.length || seen.has(k)) throw new Error(`Unknown or repeated placeholder _rvN${k}`);
    seen.add(k);
    edits.push({ start: ts[name].start, end: ts[name].end, text: quote(options.finalNames[k]) });
    let body = name + 1;
    const metaOpen = ts[body]?.value === '(' ? body : -1;
    const metaEnd = metaOpen >= 0 ? closing(ts, metaOpen) : -1;
    if (metaEnd >= 0) body = metaEnd + 1;
    if (ts[body]?.value !== '{') throw new Error(`No body for _rvN${k}`);
    const bodyEnd = closing(ts, body);
    const data = options.prims?.get(k);
    if (!data) continue;
    const lineStart = usda.lastIndexOf('\n', ts[i].start) + 1;
    const pad = /^[\t ]*/.exec(usda.slice(lineStart, ts[i].start))![0];
    const props = properties(ts, body, bodyEnd);
    const additions: string[] = [];
    const replaceProperty = (property: string, text: string | readonly TextPart[]): void => {
      const found = props.filter((p) => p.name === property || p.name === property + '.timeSamples');
      if (found.length > 1) throw new Error(`Duplicate ${property}`);
      if (found.length) edits.push({ start: found[0].start, end: found[0].end, text });
      else edits.push({ start: ts[body].end, end: ts[body].end, text: ['\n' + pad + '\t', ...(typeof text === 'string' ? [text] : text)] });
    };
    if (data.matrix) {
      if (data.translate || data.orient || data.scale) throw new Error('Matrix prim cannot have TRS channels');
      for (const p of props) if (p.name.startsWith('xformOp:') && !p.name.startsWith('xformOp:transform')) throw new Error('Matrix prim has TRS ops');
      replaceProperty('xformOp:transform', channelText(data.matrix, 'matrix', pad + '\t', binary));
    } else for (const kind of ['translate', 'orient', 'scale'] as const) {
      const channel = data[kind];
      if (channel) {
        if (kind !== 'translate' && channel.frames.length) {
          const property = props.find((p) => p.name === `xformOp:${kind}.timeSamples`);
          if (!property) throw new Error(`Exporter omitted animated ${kind}`);
          replaceProperty('xformOp:' + kind, integerSampleKeys(usda, property, channel.frames, binary));
        } else replaceProperty('xformOp:' + kind, channelText(channel, kind, pad + '\t', binary));
      }
    }
    if (options.writeAddresses !== false && data.customData && Object.keys(data.customData).length) {
      const metadata = metaOpen >= 0 ? usda.slice(ts[metaOpen].end, ts[metaEnd].start) : '';
      const updated = withIdentity(metadata, data.customData, pad);
      edits.push(metaOpen >= 0
        ? { start: ts[metaOpen].end, end: ts[metaEnd].start, text: updated }
        : { start: ts[name].end, end: ts[name].end, text: ` (${updated})` });
    }
    if (data.visibility !== undefined || data.visibilitySamples !== undefined) {
      if (data.visibility !== undefined && !['invisible', 'inherited'].includes(data.visibility)) throw new Error('Invalid visibility');
      if (data.visibility !== undefined && data.visibilitySamples !== undefined) throw new Error('Choose static or animated visibility');
      // Never silently duplicate an existing direct visibility property.
      for (let j = body + 1; j < bodyEnd; j++) {
        if (ts[j].value === 'visibility' || ts[j].value === 'visibility.timeSamples') throw new Error(`Visibility already authored for _rvN${k}`);
        if (ts[j].value === '{' || ts[j].value === '(') j = closing(ts, j);
      }
      let value = `\n${pad}\ttoken visibility = ${quote(data.visibility ?? 'inherited')}`;
      if (data.visibilitySamples !== undefined) {
        let last = -1;
        const lines: string[] = [];
        for (const [frame, token] of data.visibilitySamples) {
          if (!Number.isInteger(frame) || frame < 0 || frame <= last || !['invisible', 'inherited'].includes(token)) throw new Error('Invalid visibility samples');
          last = frame;
          lines.push(`${pad}\t\t${frame}: ${quote(token)},`);
        }
        value = `\n${pad}\ttoken visibility.timeSamples = {\n${lines.join('\n')}\n${pad}\t}`;
      }
      edits.push({ start: ts[body].end, end: ts[body].end, text: value });
      const samples = data.visibilitySamples;
      if (options.blenderVisibilityCompat && samples?.some(([, token]) => token !== samples[0][1])) {
        const steps = new Map<number, number>();
        let previous = samples[0][1] === 'invisible' ? 0 : 1;
        steps.set(samples[0][0], previous);
        for (let j = 1; j < samples.length; j++) {
          const [frame, token] = samples[j], next = token === 'invisible' ? 0 : 1;
          if (next === previous) continue;
          steps.set(frame - 1, previous); steps.set(frame, next); previous = next;
        }
        if (props.some((p) => p.name.startsWith('xformOp:scale:rvVisibility'))) throw new Error('Visibility op already authored');
        additions.push(`float3 xformOp:scale:rvVisibility.timeSamples = {\n`
          + [...steps].sort(([a], [b]) => a - b).map(([f, v]) => `${pad}\t\t${f}: (${v}, ${v}, ${v}),`).join('\n') + `\n${pad}\t}`);
        const order = props.find((p) => p.name === 'xformOpOrder');
        if (!order) throw new Error('Visibility prim has no xformOpOrder');
        const old = data.matrix ? '["xformOp:transform"]' : usda.slice(order.valueStart, order.valueEnd);
        edits.push({ start: order.valueStart, end: order.valueEnd,
          text: old.slice(0, -1).replace(/\s+$/, '') + ', "xformOp:scale:rvVisibility"]' });
      }
    }
    if (additions.length) edits.push({ start: ts[body].end, end: ts[body].end,
      text: '\n' + additions.map((s) => pad + '\t' + s).join('\n') });
  }
  const unmatched = options.finalNames.flatMap((_, k) => seen.has(k) ? [] : [k]);
  if (unmatched.length) throw new Error(`Exporter omitted placeholders: ${unmatched.join(', ')}`);
  if (partNames && partsSeen.size !== partNames.size) throw new Error('Exporter omitted split part placeholders');
  return { output: binary ? applyByteChunks(usda, edits) : apply(usda, edits), renamed: seen.size, unmatched };
}

/** Convenience string API; large stages should use the bounded UTF-8 byte API. */
export function postProcessModelUsda(usda: string, options: StagePostOptions): { text: string; renamed: number; unmatched: number[] } {
  const { output, renamed, unmatched } = processModelUsda(usda, options, false);
  return { text: output as string, renamed, unmatched };
}

/** Same model.usda bytes as the string API, with bounded formatting/encoding buffers. */
export function postProcessModelUsdaChunks(usda: string, options: StagePostOptions): { chunks: readonly Uint8Array[]; renamed: number; unmatched: number[] } {
  const { output, renamed, unmatched } = processModelUsda(usda, options, true);
  return { chunks: output as readonly Uint8Array[], renamed, unmatched };
}
