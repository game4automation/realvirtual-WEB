// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.2 — browser-side `modelDescription.xml` reader.
 *
 * Fixture: `tests/fixtures/Feedthrough.fmu` — Reference-FMUs v0.0.40
 * (BSD-2-Clause, https://github.com/modelica/Reference-FMUs), copied from
 * `Packages/io.realvirtual.professional/Tests/FeatureTests/Fmi/TestData~/`.
 */

import { describe, it, expect } from 'vitest';
import { unzipSync, zipSync, strToU8, type UnzipOptions } from 'fflate';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import {
  readModelDescription,
  sha256OfPackage,
  FmuParseError,
  MAX_MODEL_DESCRIPTION_BYTES,
} from '../src/core/engine/rv-fmu-model-description';
import { validateFmuExtras } from '../src/core/engine/rv-extras-validator';
import { buildFmuExtras } from '../src/core/ops/rv-fmu-ops';

async function feedthrough(): Promise<Uint8Array> {
  const res = await fetch(feedthroughUrl);
  expect(res.ok).toBe(true);
  return new Uint8Array(await res.arrayBuffer());
}

function descriptionXml(fmiVersion: string, withCoSim = true): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<fmiModelDescription fmiVersion="${fmiVersion}" modelName="M" guid="{1}">
  ${withCoSim ? '<CoSimulation modelIdentifier="M"/>' : '<ModelExchange modelIdentifier="M"/>'}
  <ModelVariables>
    <ScalarVariable name="x" valueReference="1" causality="output"><Real/></ScalarVariable>
  </ModelVariables>
</fmiModelDescription>`;
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(FmuParseError);
  expect((err as FmuParseError).code).toBe(code);
}

describe('readModelDescription — Feedthrough.fmu', () => {
  it('reads modelName, guid, version, tool and the win64 binary', async () => {
    const md = await readModelDescription(await feedthrough());
    expect(md.modelName).toBe('Feedthrough');
    expect(md.guid).toBe('{37B954F1-CC86-4D8F-B97F-C7C36F6670D2}');
    expect(md.fmiVersion).toBe('2.0');
    expect(md.generationTool).toBe('Reference FMUs (v0.0.40)');
    expect(md.coSimulation).toBe(true);
    expect(md.modelIdentifier).toBe('Feedthrough');
    expect(md.hasWin64Binary).toBe(true);
  });

  it('keeps input/output/parameter variables with causality, type, start — drops independent', async () => {
    const md = await readModelDescription(await feedthrough());
    const byName = new Map(md.variables.map((v) => [v.name, v]));
    expect(byName.has('time')).toBe(false); // causality="independent"
    expect(byName.get('Float64_continuous_input')).toMatchObject({
      valueReference: 7, causality: 'input', variability: 'continuous', type: 'Real', start: '0',
    });
    expect(byName.get('Float64_tunable_parameter')).toMatchObject({ causality: 'parameter', variability: 'tunable' });
    expect(byName.get('Float64_fixed_parameter')).toMatchObject({ causality: 'parameter', variability: 'fixed' });
    expect(byName.get('Int32_output')).toMatchObject({ type: 'Integer', causality: 'output' });
    expect(byName.get('Boolean_input')).toMatchObject({ type: 'Boolean', start: 'false' });
    expect(byName.get('String_input')).toMatchObject({ type: 'String', start: 'Set me!' });
    expect(byName.get('Enumeration_input')).toMatchObject({ type: 'Enumeration', start: '1' });
    expect(md.variables).toHaveLength(14); // 15 scalars − `time`
  });

  it('inflates only modelDescription.xml (every other entry is only listed)', async () => {
    const inflated: string[] = [];
    const listed: string[] = [];
    await readModelDescription(await feedthrough(), {
      unzip: (data: Uint8Array, opts: UnzipOptions) => unzipSync(data, {
        filter: (info) => {
          listed.push(info.name);
          const keep = opts.filter!(info);
          if (keep) inflated.push(info.name);
          return keep;
        },
      }),
    });
    expect(inflated).toEqual(['modelDescription.xml']);
    expect(listed.length).toBeGreaterThan(10);
  });

  it('computes a stable sha256', async () => {
    const bytes = await feedthrough();
    const a = await sha256OfPackage(bytes);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await sha256OfPackage(bytes.slice())).toBe(a);
  });
});

async function bouncingBall(): Promise<Uint8Array> {
  const res = await fetch(bouncingBallUrl);
  expect(res.ok).toBe(true);
  return new Uint8Array(await res.arrayBuffer());
}

describe('readModelDescription — ranges, initial, declaredType, enum items (plan-502 §9.3)', () => {
  it('BouncingBall: e has 0.5–1, g is fixed/exact with the SimpleType unit, v_min (constant, no causality) is dropped', async () => {
    const md = await readModelDescription(await bouncingBall());
    const byName = new Map(md.variables.map((v) => [v.name, v]));
    expect(byName.get('e')).toMatchObject({
      causality: 'parameter', variability: 'tunable', initial: 'exact', start: '0.7', min: 0.5, max: 1,
    });
    expect(byName.get('e')!.declaredType).toBeUndefined();
    expect(byName.get('g')).toMatchObject({
      causality: 'parameter', variability: 'fixed', initial: 'exact', start: '-9.81',
      declaredType: 'Acceleration', unit: 'm/s2',
    });
    expect(byName.get('g')!.min).toBeUndefined();
    expect(byName.get('h')).toMatchObject({ causality: 'output', declaredType: 'Position', unit: 'm' });
    // `v_min` is variability="constant" without a causality (FMI default `local`) → not kept.
    expect(byName.has('v_min')).toBe(false);
  });

  it('Feedthrough: Enumeration_input has declaredType Option with two items', async () => {
    const md = await readModelDescription(await feedthrough());
    const en = md.variables.find((v) => v.name === 'Enumeration_input')!;
    expect(en.declaredType).toBe('Option');
    expect(en.enumItems).toEqual([
      { name: 'Option 1', value: 1, description: 'First option' },
      { name: 'Option 2', value: 2, description: 'Second option' },
    ]);
    expect(md.variables.find((v) => v.name === 'Float64_continuous_output')!.initial).toBe('calculated');
    expect(md.variables.find((v) => v.name === 'Int32_input')!.enumItems).toBeUndefined();
  });

  it('buildFmuExtras writes the new fields and validateFmuExtras keeps them', async () => {
    const bytes = await bouncingBall();
    const description = await readModelDescription(bytes);
    const extras = buildFmuExtras({ fileName: 'BouncingBall.fmu', sha256: 'a'.repeat(64), bytes, description });
    const check = validateFmuExtras(extras);
    expect(check.issues).toEqual([]);
    expect(check.variables.find((v) => v.name === 'e')).toMatchObject({ min: 0.5, max: 1, initial: 'exact' });
    expect(check.variables.find((v) => v.name === 'g')).toMatchObject({ declaredType: 'Acceleration' });
  });

  it('old extras without the new fields still validate unchanged; malformed new fields are dropped', () => {
    const check = validateFmuExtras({
      FmuVariables: [
        { name: 'e', valueReference: 6, causality: 'parameter', variability: 'tunable', type: 'Real', start: '0.7' },
        { name: 'x', valueReference: 7, causality: 'input', variability: 'discrete', type: 'Enumeration',
          min: 'no', max: Number.NaN, initial: 'sometimes', enumItems: [{ name: 'A', value: 1.5 }, 'junk'] },
      ],
    });
    expect(check.issues).toEqual([]);
    expect(check.variables[0]).toEqual({ name: 'e', valueReference: 6, causality: 'parameter', variability: 'tunable', type: 'Real', start: '0.7' });
    expect(check.variables[1].min).toBeUndefined();
    expect(check.variables[1].max).toBeUndefined();
    expect(check.variables[1].initial).toBeUndefined();
    expect(check.variables[1].enumItems).toBeUndefined();
  });
});

describe('readModelDescription — refusals', () => {
  it('FMI 1.0 and 3.0 → fmi-version', async () => {
    await expectCode(readModelDescription(zipSync({ 'modelDescription.xml': strToU8(descriptionXml('1.0')) })), 'fmi-version');
    await expectCode(readModelDescription(zipSync({ 'modelDescription.xml': strToU8(descriptionXml('3.0')) })), 'fmi-version');
  });

  it('Model Exchange only → no-cosimulation', async () => {
    await expectCode(readModelDescription(zipSync({ 'modelDescription.xml': strToU8(descriptionXml('2.0', false)) })), 'no-cosimulation');
  });

  it('a zip without modelDescription.xml → no-model-description; garbage → not-a-zip', async () => {
    await expectCode(readModelDescription(zipSync({ 'readme.txt': strToU8('hi') })), 'no-model-description');
    await expectCode(readModelDescription(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), 'not-a-zip');
  });

  it('the size limit refuses an oversized modelDescription.xml without inflating it', async () => {
    let inflatedCalls = 0;
    await expectCode(readModelDescription(new Uint8Array(4), {
      unzip: (_data, opts) => {
        const keep = opts.filter!({ name: 'modelDescription.xml', size: 10, originalSize: MAX_MODEL_DESCRIPTION_BYTES + 1, compression: 8 });
        if (keep) inflatedCalls++;
        return {};
      },
    }), 'model-description-too-large');
    expect(inflatedCalls).toBe(0);
  });

  it('a minimal valid FMU without win64 binary parses and reports hasWin64Binary=false', async () => {
    const md = await readModelDescription(zipSync({ 'modelDescription.xml': strToU8(descriptionXml('2.0')) }));
    expect(md.hasWin64Binary).toBe(false);
    expect(md.variables.map((v) => v.name)).toEqual(['x']);
  });
});
