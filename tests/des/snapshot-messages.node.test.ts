// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { DESRunner } from '../../src/plugins/des/des-runner';
import { clearProblem, getProblems } from '../../src/core/hmi/problems-store';
import { expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_MESSAGES, SNAPSHOT_PROBLEM_CODES, snapshotUserMessage, snapshotRefusalText } from '../../src/core/sdk/rv-des-snapshot-messages';

it('provides actionable messages and covers emitted codes', () => {
  for (const code of SNAPSHOT_PROBLEM_CODES) {
    expect(snapshotUserMessage(code).title.length).toBeGreaterThan(0);
    expect(snapshotUserMessage(code).text.length).toBeGreaterThan(30);
  }
  function scan(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.tsx?$/.test(path)) {
        const source = readFileSync(path, 'utf8');
        for (const match of source.matchAll(/['"`](des-snapshot-[a-z-]+|des-restore-[a-z-]+|rng-version-[a-z-]+|des-state-not-declared|des-script-undeclared-state)['"`]/g)) {
          // The message card's UI identifier is not a problem code.
          if (match[1] === 'des-snapshot-feedback') continue;
          // The matrix statistics' delta-unavailable reason (plan-2013 V1-C) is a UI reason, not a snapshot problem code; the KPI rows (V1-F2) render it.
          if (match[1] === 'rng-version-differs' && (path.endsWith('des-matrix-stats.ts') || path.endsWith('DesMatrixKpiSection.tsx'))) continue;
          expect(SNAPSHOT_MESSAGES, path + ': ' + match[1]).toHaveProperty(match[1]);
        }
      }
    }
  }
  scan('src');
  expect(snapshotRefusalText({ code: 'des-snapshot-fingerprint' })).toContain(snapshotUserMessage('des-snapshot-fingerprint').text);
  expect(snapshotUserMessage('unknown').text).toBe('The snapshot could not be saved or loaded. See the Problems panel.');
});

it('reports a fingerprint refusal with its user title and technical code', () => {
  const runner = new DESRunner();
  const code = 'des-snapshot-fingerprint';
  try {
    expect(() => (runner as any)._snapshotFailure(code, 'hash mismatch')).toThrow(code);
    const problem = getProblems().find(p => p.code === code)!;
    expect(problem.title).toBe(snapshotUserMessage(code).title);
    expect(problem.detail).toBe(`${snapshotUserMessage(code).text} [${code}] hash mismatch`);
  } finally { clearProblem(code); }
});
