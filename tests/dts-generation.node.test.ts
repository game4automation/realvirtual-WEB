// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * dts-generation.node.test.ts — plan-210 §6 S5.
 *
 * The generated `rv-sdk.d.ts` must compile standalone under the restrictive
 * editor setup (`noLib` + strict — no DOM, no ES lib; only the SDK surface
 * plus the minimal ambient lib). The §6-appendix turntable example serves as
 * the EXPRESSIVENESS compile test against the generated declarations (per
 * plan: a compile check, NOT a runtime migration).
 *
 * Node test (vitest.node.config.ts) — the TypeScript compiler API is a
 * Node-only dependency.
 */

import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import { generateSdkDts, SDK_MINIMAL_LIB_DTS } from '../src/core/sdk/rv-sdk-dts';

function compile(sources: Record<string, string>): string[] {
  const options: ts.CompilerOptions = {
    noLib: true,
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2020,
    types: [],
  };
  const files = new Map(Object.entries(sources));
  const host: ts.CompilerHost = {
    getSourceFile: (name, langVersion) => {
      const text = files.get(name);
      return text !== undefined ? ts.createSourceFile(name, text, langVersion, true) : undefined;
    },
    getDefaultLibFileName: () => 'lib.none.d.ts', // noLib — never resolved
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
    useCaseSensitiveFileNames: () => true,
    fileExists: (name) => files.has(name),
    readFile: (name) => files.get(name),
  };
  const program = ts.createProgram([...files.keys()], options, host);
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
  return diagnostics.map((d) =>
    `${d.file?.fileName ?? '?'}:${d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 : '?'} ` +
    ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

/**
 * The §6-appendix turntable example, transcribed as typed TS against the
 * generated SDK surface. Minimal type-safety adaptations vs. the plan's JS
 * (marked): `Number(...)` around the PropValue arithmetic, MU null-guard in
 * `des.on`, explicit `Handlers` return after `disable`.
 */
const TURNTABLE_EXAMPLE = `
function setup(self: Self): Handlers {
  const V = self.vec3;
  const drive = self.drive('Drive-Rot-Y');
  const sensor = self.sensor('Sensor');
  const belt = self.belt('Transport');
  if (!drive) { self.disable('no rotary drive'); return {}; }

  // Rotation axis + deterministic (u,v) basis perpendicular to it — once.
  const axis = V.normalize(drive.node.worldDirection(V(0, 1, 0)));
  const ref = Math.abs(axis.x) > 0.9 ? V(0, 0, 1) : V(1, 0, 0);
  const u = V.normalize(V.cross(axis, ref));
  const vAx = V.cross(axis, u);

  // OPEN angle math: project center→port direction onto the (u,v) plane.
  const angleToPort = (port: Port): number => {
    const dir = V.normalize(V.sub(port.node.worldPosition(), self.self.worldPosition()));
    return Math.atan2(V.dot(dir, vAx), V.dot(dir, u)) * self.RAD2DEG;
  };

  let clearTimer = 0;
  let selectedOut: string | null = null;   // ONE state, both runners
  self.signal('Flow.Run').set(true);
  self.setState('idle');

  sensor?.on((occ) => {
    if (occ && self.state === 'receiving') {
      const out = self.freeOutputs()[0];
      if (!out) return self.setState('holding');
      selectedOut = out.id; drive.moveTo(angleToPort(out)); self.setState('rotating_out');
    } else if (!occ && self.state === 'discharging') {
      clearTimer = 0.5; self.setState('discharge_clearing');
    }
  });

  return {
    continuous: {
      fixedUpdate(dt) {
        switch (self.state) {
          case 'idle':
            belt?.run(false);
            if (self.signal('Flow.Run').bool) {
              const p = self.inputs().find((x) => x.upstreamWaiting());
              if (p) { drive.moveTo(angleToPort(p)); self.setState('aligning_in'); }
            }
            break;
          case 'aligning_in':  if (drive.isAtTarget) { self.setState('receiving');  belt?.run(true); } break;
          case 'rotating_out': if (drive.isAtTarget) { self.setState('discharging'); belt?.run(true); } break;
          case 'discharge_clearing':
            clearTimer -= dt; if (clearTimer <= 0) { belt?.run(false); self.setState('idle'); }
            break;
        }
      },
    },
    des: {
      canAccept: (mu, port) => self.currentLoad < 1 && self.state === 'idle',
      onAccept(mu, port) {
        const out = self.freeOutputs()[0];
        if (!out) { self.setState('holding'); return true; }
        selectedOut = out.id;
        self.in(Math.abs(angleToPort(out)) / Number(self.prop.RotationSpeed ?? 45), 'rotated', mu);
        self.setState('rotating_out'); return true;
      },
      on(hook, mu) {
        if (hook === 'rotated' && mu) {
          self.transfer(mu, self.outputs().find((p) => p.id === selectedOut));
          self.setState('idle');
        }
      },
    },
  };
}
`;

describe('rv-sdk.d.ts generation', () => {
  it('the generated declarations compile standalone with noLib + strict', () => {
    const errors = compile({
      'lib.min.d.ts': SDK_MINIMAL_LIB_DTS,
      'rv-sdk.d.ts': generateSdkDts(),
    });
    expect(errors).toEqual([]);
  });

  it('the §6 turntable example compiles against the generated surface (expressiveness test)', () => {
    const errors = compile({
      'lib.min.d.ts': SDK_MINIMAL_LIB_DTS,
      'rv-sdk.d.ts': generateSdkDts(),
      'turntable.ts': TURNTABLE_EXAMPLE,
    });
    expect(errors).toEqual([]);
  });

  it('the restrictive lib really hides the browser surface (window/fetch are errors)', () => {
    const errors = compile({
      'lib.min.d.ts': SDK_MINIMAL_LIB_DTS,
      'rv-sdk.d.ts': generateSdkDts(),
      'evil.ts': `function setup(self: Self): Handlers { window.alert('x'); fetch('/'); return {}; }`,
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join('\n')).toMatch(/window/);
    expect(errors.join('\n')).toMatch(/fetch/);
  });

  it('a wrong handler shape is a type error (contract enforcement)', () => {
    const errors = compile({
      'lib.min.d.ts': SDK_MINIMAL_LIB_DTS,
      'rv-sdk.d.ts': generateSdkDts(),
      'bad.ts': `function setup(self: Self): Handlers { return { continuous: { fixedUpdate: 'nope' } }; }`,
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('declares the apiVersion marker', () => {
    expect(generateSdkDts()).toMatch(/apiVersion 1/);
  });
});
