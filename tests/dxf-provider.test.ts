// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-741 §9.5 — the DXF provider against the unified import facade contract
 * (plan-238), on the same terms as `fbx-provider.test.ts`.
 *
 * Beyond the contract itself, this pins the three failure modes a factory DXF
 * actually hits: a binary file saved by accident, a pre-2007 file in
 * windows-1252 whose layer names carry umlauts, and a cancel on a large import.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDxfImportProvider,
  decodeDxfBytes,
  dxfBaseName,
  isDxfImportEnabled,
  DXF_FLAG_KEY,
} from '@rv-private/plugins/import-providers/dxf-import-provider';
import {
  importProviderRegistry,
  resolveProviderSafe,
  type ImportProgress,
} from '../src/core/import/rv-import-provider';
import { BINARY_DXF_MAGIC } from '@rv-private/plugins/dxf-import/dxf-analyze';
import { DEFAULT_DXF_OPTIONS, type DxfImportOptions } from '@rv-private/plugins/dxf-import/dxf-import.types';

// ─── Fixtures ───────────────────────────────────────────────────────────

/** A minimal but complete hall plan: one layer, one wall, one closed room. */
function hallDxf(insUnits = 4, layerName = 'WALLS'): string {
  return [
    '0', 'SECTION', '2', 'HEADER',
    '9', '$ACADVER', '1', 'AC1032',
    '9', '$INSUNITS', '70', String(insUnits),
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER',
    '0', 'LAYER', '2', layerName, '70', '0', '62', '1',
    '0', 'ENDTAB', '0', 'ENDSEC',
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'LINE', '8', layerName, '10', '0', '20', '0', '11', '60000', '21', '0',
    '0', 'LWPOLYLINE', '8', layerName, '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '20000', '20', '0', '10', '20000', '20', '15000', '10', '0', '20', '15000',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
}

function dxfFile(text: string, name = 'hall.dxf'): File {
  return new File([text], name, { type: 'application/dxf' });
}

function customInput(files: File[], options: Partial<DxfImportOptions> = {}) {
  return { kind: 'custom' as const, data: { files, options: { ...DEFAULT_DXF_OPTIONS, ...options } } };
}

beforeEach(() => {
  localStorage.clear();
  importProviderRegistry.unregister('dxf');
});

// ─── Contract ───────────────────────────────────────────────────────────

describe('DxfImportProvider (CadImportProvider contract)', () => {
  it('is always ready — parsing is local, no gateway and no auth', () => {
    const p = createDxfImportProvider();
    expect(p.id).toBe('dxf');
    expect(p.label).toBe('DXF');
    expect(p.order).toBe(27);
    expect(p.availability()).toBe('ready');
  });

  it('onAvailabilityChange returns a working unsubscribe', () => {
    const off = createDxfImportProvider().onAvailabilityChange(() => undefined);
    expect(typeof off).toBe('function');
    off();
  });

  it('registers into and unregisters from the importProviderRegistry', () => {
    importProviderRegistry.register(createDxfImportProvider());
    expect(importProviderRegistry.get('dxf')).toBeDefined();
    expect(importProviderRegistry.list().some(p => p.id === 'dxf')).toBe(true);
    importProviderRegistry.unregister('dxf');
    expect(importProviderRegistry.get('dxf')).toBeUndefined();
  });
});

describe('kill-switch rv.import.dxf', () => {
  it('is ON by default', () => {
    expect(isDxfImportEnabled()).toBe(true);
  });

  it('is disabled by off/false/0 and by nothing else', () => {
    for (const v of ['off', 'false', '0']) {
      localStorage.setItem(DXF_FLAG_KEY, v);
      expect(isDxfImportEnabled()).toBe(false);
    }
    localStorage.setItem(DXF_FLAG_KEY, 'on');
    expect(isDxfImportEnabled()).toBe(true);
  });
});

// ─── Decoding ───────────────────────────────────────────────────────────

describe('decodeDxfBytes', () => {
  it('reads a windows-1252 file so umlauted layer names survive', () => {
    // Pre-2007 AutoCAD writes the ANSI code page. 0xE4 ("ä") is not valid UTF-8,
    // which is exactly what makes the fallback reliable.
    const bytes = new Uint8Array([0x57, 0xe4, 0x6e, 0x64, 0x65]); // "Wände" in CP1252
    expect(decodeDxfBytes(bytes.buffer as ArrayBuffer).text).toBe('Wände');
    expect(decodeDxfBytes(bytes.buffer as ArrayBuffer).encoding).toBe('windows-1252');
  });

  it('prefers UTF-8 when the bytes really are UTF-8', () => {
    const bytes = new TextEncoder().encode('Wände');
    expect(decodeDxfBytes(bytes.buffer as ArrayBuffer)).toEqual({ text: 'Wände', encoding: 'utf-8' });
  });

  it('derives a sensible asset name from the filename', () => {
    expect(dxfBaseName('C:\\plans\\hall-layout.DXF')).toBe('hall-layout');
    expect(dxfBaseName('.dxf')).toBe('drawing');
  });
});

// ─── resolve() ──────────────────────────────────────────────────────────

describe('resolve()', () => {
  it('produces GLB bytes with DXF CADLink metadata', async () => {
    const p = createDxfImportProvider();
    const res = await resolveProviderSafe(p, customInput([dxfFile(hallDxf())]));
    expect(res.failed).toEqual([]);
    expect(res.ok).toHaveLength(1);
    const item = res.ok[0];
    expect(item.kind).toBe('glb');
    if (item.kind !== 'glb') throw new Error('unreachable');
    expect(item.suggestedName).toBe('hall');
    expect(item.bytes.byteLength).toBeGreaterThan(0);
    expect(item.cadlink?.Quality).toBe('dxf');
    expect(item.cadlink?.File).toBe('hall.dxf');
    expect(item.cadlink?.Sha256).toMatch(/^[0-9a-f]{64}$/);
    // A drawing plane is the XY plane with Z up — always.
    expect(item.cadlink?.ZIsUpVector).toBe(true);
  });

  it.each([
    ['mm', 4, 0.001],
    ['cm', 5, 0.01],
    ['m', 6, 1],
    ['in', 1, 0.0254],
    ['ft', 2, 0.3048],
  ])('records the %s scale factor actually used', async (_unit, insUnits, factor) => {
    // An explicit override, so the plausibility heuristic cannot second-guess it.
    const p = createDxfImportProvider();
    const res = await resolveProviderSafe(
      p,
      customInput([dxfFile(hallDxf(insUnits as number))], { units: _unit as 'mm' }),
    );
    expect(res.ok).toHaveLength(1);
    const item = res.ok[0];
    if (item.kind !== 'glb') throw new Error('unreachable');
    expect(item.cadlink?.ImportScaleFactor).toBe(factor);
  });

  it('keeps a windows-1252 layer name intact end to end', async () => {
    const text = hallDxf(4, 'Wände');
    // Encode the fixture the way an old AutoCAD would have written it.
    const cp1252 = new Uint8Array([...text].map(c => c.charCodeAt(0) & 0xff));
    const file = new File([cp1252], 'wände.dxf');
    const res = await resolveProviderSafe(createDxfImportProvider(), customInput([file]));
    expect(res.failed).toEqual([]);
    expect(res.ok).toHaveLength(1);
    // The layer name reaches the GLB as a node name; the bytes carry it verbatim.
    if (res.ok[0].kind !== 'glb') throw new Error('unreachable');
    const asText = new TextDecoder('utf-8').decode(new Uint8Array(res.ok[0].bytes));
    expect(asText).toContain('Wände');
  });

  it('refuses a BINARY DXF with an actionable message', async () => {
    const magic = new TextEncoder().encode(`${BINARY_DXF_MAGIC}\r\n\x1a\0`);
    const file = new File([magic], 'hall.dxf');
    const res = await resolveProviderSafe(createDxfImportProvider(), customInput([file]));
    expect(res.ok).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toMatch(/binary DXF/i);
    expect(res.failed[0].error).toMatch(/ASCII/);
  });

  it('fails gracefully on rubbish input instead of throwing', async () => {
    const res = await resolveProviderSafe(
      createDxfImportProvider(),
      customInput([dxfFile('this is not a DXF at all', 'junk.dxf')]),
    );
    expect(res.ok).toEqual([]);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].id).toBe('junk.dxf');
  });

  it('names the mistake when non-DXF files were picked', async () => {
    const res = await resolveProviderSafe(
      createDxfImportProvider(),
      customInput([new File(['x'], 'plan.dwg')]),
    );
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].error).toMatch(/No \.dxf file/i);
  });

  it('isolates a bad file: the good ones still import', async () => {
    const res = await resolveProviderSafe(createDxfImportProvider(), customInput([
      dxfFile(hallDxf(), 'good.dxf'),
      dxfFile('garbage', 'bad.dxf'),
    ]));
    expect(res.ok).toHaveLength(1);
    expect(res.failed).toHaveLength(1);
  });

  it('reports monotone progress inside [0, 1]', async () => {
    const seen: ImportProgress[] = [];
    await resolveProviderSafe(
      createDxfImportProvider(),
      customInput([dxfFile(hallDxf(), 'a.dxf'), dxfFile(hallDxf(), 'b.dxf')]),
      (p) => seen.push(p),
    );
    expect(seen.length).toBeGreaterThan(2);
    let last = -1;
    for (const p of seen) {
      expect(p.percent).not.toBeNull();
      expect(p.percent!).toBeGreaterThanOrEqual(0);
      expect(p.percent!).toBeLessThanOrEqual(1);
      expect(p.percent!).toBeGreaterThanOrEqual(last);
      last = p.percent!;
    }
  });

  it('imports a drawing large enough to take the WORKER path', async () => {
    // Over DXF_WORKER_MIN_BYTES the pipeline moves off the main thread; below it
    // stays inline. Both must produce the same kind of result, and a worker that
    // cannot be created must fall back rather than fail the import — which is
    // exactly what this asserts, since either path satisfies it.
    const head = [
      '0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
    ];
    for (let i = 0; i < 30000; i++) {
      const x = (i * 37) % 90000;
      const y = (i * 91) % 50000;
      head.push('0', 'LINE', '8', 'WALLS', '10', String(x), '20', String(y), '11', String(x + 400), '21', String(y + 120));
    }
    head.push('0', 'ENDSEC', '0', 'EOF');
    const text = head.join('\r\n');
    expect(text.length).toBeGreaterThan(1024 * 1024);

    const res = await resolveProviderSafe(createDxfImportProvider(), customInput([dxfFile(text, 'big.dxf')]));
    expect(res.failed).toEqual([]);
    expect(res.ok).toHaveLength(1);
    const item = res.ok[0];
    if (item.kind !== 'glb') throw new Error('unreachable');
    expect(item.bytes.byteLength).toBeGreaterThan(1000);
    expect(item.cadlink?.Quality).toBe('dxf');
  }, 60_000);

  it('a cancel between files resolves to nothing at all (not to an error)', async () => {
    const controller = new AbortController();
    const res = await resolveProviderSafe(
      createDxfImportProvider(),
      customInput([dxfFile(hallDxf(), 'a.dxf'), dxfFile(hallDxf(), 'b.dxf')]),
      () => controller.abort(), // abort on the very first progress report
      controller.signal,
    );
    expect(res).toEqual({ ok: [], failed: [] });
  });
});
