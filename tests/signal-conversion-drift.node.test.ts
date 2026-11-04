// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-conversion-drift — plan-2227 R7. The SignalConnector conversion lives in three runtimes:
 * this repo (`rv-signal-conversion.ts`), Unity (`SignalConversion.cs` in the starter package) and
 * CONNECT (a VERBATIM copy of the Unity file, plan-2227 Phase 5). One canonical vector table
 * (`tests/fixtures/signal-conversion-vectors.json`) keeps them honest, and each runtime's tests read
 * their own copy of it. This test fails when a copy drifts:
 *
 * - the Unity vector copy must have the same CONTENT as the canonical table,
 * - the CONNECT vector copy (once it exists) the same content,
 * - the CONNECT kernel (once it exists) must be byte-identical to the Unity kernel (line endings
 *   normalised: git autocrlf in CONNECT and Plastic in Unity may check the same content out differently).
 *
 * A sibling checkout that is not there (a bare web clone, a worktree session, CONNECT before
 * Phase 5) is skipped WITH the reason, never failed and never silently passed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain JS Node module, no type declarations by design.
import { workspaceRoot } from '../scripts/lib/rv-machine-paths.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = join(repoRoot, 'tests/fixtures/signal-conversion-vectors.json');

const UNITY_VECTORS = 'Packages/io.realvirtual.starter/Tests/Data/signal-conversion-vectors.json';
const UNITY_KERNEL = 'Packages/io.realvirtual.starter/Runtime/Interfaces/SignalConversion.cs';
const CONNECT_KERNEL = 'Assets/realvirtual-Connect~/src/Connect/Core/SignalConversion.cs';
const CONNECT_VECTORS = 'Assets/realvirtual-Connect~/tests/Connect.Tests/signal-conversion-vectors.json';

const STARTER_MARKER = 'Packages/io.realvirtual.starter/package.json';

/**
 * The Unity project that holds the starter package, found by the package's own marker (NOT by the
 * kernel this test guards, so a deleted kernel fails instead of skipping). An explicit
 * `RV_UNITY_PROJECT` is used as given, never replaced by another candidate.
 */
function unityProjectRoot(): string | null {
  const explicit = process.env.RV_UNITY_PROJECT;
  if (explicit) return resolve(explicit);
  const candidates = [
    resolve(repoRoot, '../..'), // <project>/Assets/realvirtual-WebViewer~
    join(workspaceRoot() as string, 'game4automation/realvirtual'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, STARTER_MARKER))) return resolve(c);
  }
  return null;
}

/**
 * C# source without comments, string and char literals, in ONE left-to-right pass (so a `/*` inside
 * a string is a string, and a `"` inside a comment is a comment). Verbatim (`@"…"`, `""` escapes)
 * and regular strings (`\` escapes) are both handled; `$` prefixes stay as harmless code.
 */
function stripCSharpNoise(src: string): string {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
    } else if (c === '@' && next === '"') {
      i += 2;
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') i += 2;
        else if (src[i] === '"') { i++; break; }
        else i++;
      }
      out += '""';
    } else if (c === '"' || c === '\'') {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      out += c + c;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The namespace or type each using directive imports, in any form: plain, static, global, alias, `global::`. */
function usingTargets(code: string): string[] {
  return [...code.matchAll(/\busing\s+(?:static\s+)?(?:\w+\s*=\s*)?(?:global::)?([\w.]+)\s*;/g)].map((m) => m[1]);
}

/** Line endings are a checkout artefact (git autocrlf vs Plastic); the content must be identical. */
function normalizedBytes(path: string): Buffer {
  return Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const unity = unityProjectRoot();
const NO_UNITY = 'no Unity project with the starter package next to this checkout (set RV_UNITY_PROJECT to check it)';

describe('signal conversion copies (plan-2227 R7)', () => {
  it('the canonical vector table is present and readable', () => {
    expect(existsSync(CANONICAL)).toBe(true);
    const v = json(CANONICAL) as { convert: unknown[]; word: unknown[]; connectSignal: unknown[] };
    expect(v.convert.length).toBeGreaterThan(0);
    expect(v.word.length).toBeGreaterThan(0);
    expect(v.connectSignal.length).toBeGreaterThan(0);
  });

  it('the C# dependency scan sees every using form and ignores comments and strings', () => {
    const probe = [
      'using System; using Other.Dep;',
      'using Alias = global::Another.Type;',
      'using static Third.Helpers;',
      '// using Commented.Out; UnityEngine.Vector3',
      '/* using Block.Comment; */',
      'class X { string s = "/* not a comment */ using InString;"; string v = @"say ""using Verbatim;"""; char q = \'"\'; }',
    ].join('\n');
    const code = stripCSharpNoise(probe);
    expect(usingTargets(code)).toEqual(['System', 'Other.Dep', 'Another.Type', 'Third.Helpers']);
    expect(code).not.toMatch(/\bUnityEngine\b/);
    expect(code).toContain('class X');
  });

  it('the Unity vector copy has the content of the canonical table', (ctx) => {
    if (!unity) return ctx.skip(NO_UNITY);
    const copy = join(unity, UNITY_VECTORS);
    expect(existsSync(copy), `missing Unity vector copy: ${copy}`).toBe(true);
    expect(json(copy), `${UNITY_VECTORS} drifted from tests/fixtures/signal-conversion-vectors.json — copy the canonical file`)
      .toEqual(json(CANONICAL));
  });

  it('the Unity kernel exists and stays self-contained (System only, no UnityEngine)', (ctx) => {
    if (!unity) return ctx.skip(NO_UNITY);
    const kernel = join(unity, UNITY_KERNEL);
    expect(existsSync(kernel), `missing Unity kernel: ${kernel}`).toBe(true);
    const code = stripCSharpNoise(readFileSync(kernel, 'utf8'));
    // Every using directive, in any form (plain, alias, static, global), must name System itself.
    const usings = usingTargets(code);
    expect(usings,'SignalConversion.cs is copied verbatim into CONNECT: only `using System;`').toEqual(['System']);
    expect(code, 'no UnityEngine reference in code').not.toMatch(/\bUnityEngine\b/);
  });

  it('the CONNECT kernel is a byte-identical copy of the Unity kernel', (ctx) => {
    if (!unity) return ctx.skip(NO_UNITY);
    const connect = join(unity, CONNECT_KERNEL);
    if (!existsSync(connect)) return ctx.skip(`CONNECT kernel not there yet (${CONNECT_KERNEL}, plan-2227 Phase 5)`);
    expect(normalizedBytes(connect).equals(normalizedBytes(join(unity, UNITY_KERNEL))),
      `${CONNECT_KERNEL} drifted from ${UNITY_KERNEL} — copy the Unity file, never edit the CONNECT copy`).toBe(true);
  });

  it('the CONNECT vector copy has the content of the canonical table', (ctx) => {
    if (!unity) return ctx.skip(NO_UNITY);
    const copy = join(unity, CONNECT_VECTORS);
    if (!existsSync(copy)) return ctx.skip(`CONNECT vector copy not there yet (${CONNECT_VECTORS}, plan-2227 Phase 5)`);
    expect(json(copy)).toEqual(json(CANONICAL));
  });
});
