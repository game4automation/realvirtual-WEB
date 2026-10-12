// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The ONE dotenv parser plus its per-caller merge policy
 * (`scripts/lib/rv-dotenv.mjs`, plan-587 F7).
 *
 * Two scripts parsed `.env` by hand and a comment DEMANDED that they stay
 * identical, with nothing checking it. The spike (plan-587 §4b M2) measured
 * what actually differed and it was not the pattern — the two regexes were
 * character for character the same. The divergence was in the MERGE, and these
 * tests nail BOTH halves down:
 *
 *  - `Test_ParseDotEnv_MatchesBunnyDeployBehaviour` — the parser behaves like
 *    the hand-written loop in `bunny-deploy.mjs` did, including the shape of
 *    its `process.env` guard.
 *  - `Test_MergeEnv_MeasuredDivergence_TwoPoliciesTwoResults` — the measured
 *    divergence itself: ONE input, two policies, two results (`"first"` vs
 *    `"third"`). If someone ever "unifies" the merge, this test is what says no.
 *
 * Pure string handling; no file system, no process, no network.
 */

import { describe, it, expect } from 'vitest';
// Typed through the sibling declaration file scripts/lib/rv-dotenv.d.mts.
import { parseDotEnvText, mergeEnv, loadDotEnvText } from '../scripts/lib/rv-dotenv.mjs';

//! The exact repro of plan-587 §4b M2.
const MEASURED_DIVERGENCE = 'K=first\nK=\nK=third\n';

//! The hand-written loop of `bunny-deploy.mjs:105` before plan-587, verbatim apart from the
//! target object. Kept here as the ORACLE: the shared parser is compared against it, so the
//! test states a behaviour and not just its own implementation.
function legacyBunnyLoadDotEnv(text: string, env: Record<string, string | undefined>) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1]!;
    const val = m[2]!.replace(/^["']|["']$/g, '');
    if (env[key] === undefined || env[key] === '') env[key] = val;
  }
  return env;
}

//! The hand-written `parseEnvText` of `dev-deploy-watch.mjs:341` before plan-587, verbatim.
function legacyWatcherParseEnvText(text: string) {
  const values: Record<string, string> = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^["']|["']$/g, '');
  }
  return values;
}

const SAMPLES = [
  '',
  'A=1\n',
  'A=1\r\nB=2\r\n',
  '# a comment\nA=1\n\nB = two \n',
  'A="quoted"\nB=\'single\'\nC="mismatched\'\n',
  'lowercase=skipped\nA-B=skipped\nA=kept\n',
  '  SPACED  =  value  \n',
  'EMPTY=\nEMPTY=later\n',
  'A=has=equals=inside\n',
  MEASURED_DIVERGENCE,
];

describe('rv-dotenv — the one parser (plan-587 F7)', () => {
  it('Test_ParseDotEnv_MatchesBunnyDeployBehaviour', () => {
    for (const sample of SAMPLES) {
      const legacy = legacyBunnyLoadDotEnv(sample, {});
      const shared = mergeEnv(parseDotEnvText(sample), 'firstNonEmpty', {});
      expect(shared, `sample ${JSON.stringify(sample)}`).toEqual(legacy);
    }
  });

  it('Test_ParseDotEnv_MatchesWatcherBehaviour', () => {
    for (const sample of SAMPLES) {
      const legacy = legacyWatcherParseEnvText(sample);
      const shared = mergeEnv(parseDotEnvText(sample), 'last', {});
      expect(shared, `sample ${JSON.stringify(sample)}`).toEqual(legacy);
    }
  });

  it('Test_ParseDotEnv_KeepsTheOrderItRead', () => {
    // The order is the payload: it is the only thing that lets `mergeEnv` tell the two
    // policies apart. An object-returning parser would have destroyed the distinction before
    // any caller could decide, which is why `parseDotEnvText` returns pairs.
    expect(parseDotEnvText(MEASURED_DIVERGENCE)).toEqual([['K', 'first'], ['K', ''], ['K', 'third']]);
  });

  it('Test_ParseDotEnv_SkipsNonAssignments', () => {
    expect(parseDotEnvText('# comment\n\n   \nnot an assignment\nlower=case\nOK=1')).toEqual([['OK', '1']]);
  });

  it('Test_ParseDotEnv_StripsOneLayerOfQuotes', () => {
    expect(Object.fromEntries(parseDotEnvText('A="x"\nB=\'y\'\nC="z\nD=w"'))).toEqual({
      A: 'x', B: 'y', C: 'z', D: 'w',
    });
  });

  it('Test_ParseDotEnv_NonString_DoesNotThrow', () => {
    expect(parseDotEnvText(undefined)).toEqual([]);
    expect(parseDotEnvText(null)).toEqual([]);
  });
});

describe('rv-dotenv — the MEASURED merge divergence (plan-587 §4b M2)', () => {
  it('Test_MergeEnv_MeasuredDivergence_TwoPoliciesTwoResults', () => {
    // THE measurement of the spike, nailed down: the very same input, the two policies the two
    // callers need, and two DIFFERENT answers. An earlier draft of plan-587 wanted "last wins
    // for everyone"; that would have made these two values equal and silently inverted
    // bunny-deploy's env precedence. If this assertion ever has to be relaxed, the precedence
    // of the real shell environment over `.env` is what is being given up.
    const entries = parseDotEnvText(MEASURED_DIVERGENCE);
    expect(mergeEnv(entries, 'firstNonEmpty', {}).K).toBe('first');
    expect(mergeEnv(entries, 'last', {}).K).toBe('third');
  });

  it('Test_MergeEnv_FirstNonEmpty_PreExistingValueWins', () => {
    // This is the whole reason bunny-deploy folds into `process.env` with this policy: a value
    // already in the real shell environment (or in CI) must outrank the file.
    const env: Record<string, string | undefined> = { K: 'from-the-shell' };
    mergeEnv(parseDotEnvText('K=from-the-file\n'), 'firstNonEmpty', env);
    expect(env.K).toBe('from-the-shell');
  });

  it('Test_MergeEnv_FirstNonEmpty_EmptyPreExistingValueIsFilled', () => {
    // `''` counts as absent — the guard in the original was `undefined || ''`, not just
    // `undefined`, and an exported-but-empty variable must not shadow the file.
    const env: Record<string, string | undefined> = { K: '' };
    mergeEnv(parseDotEnvText('K=from-the-file\n'), 'firstNonEmpty', env);
    expect(env.K).toBe('from-the-file');
  });

  it('Test_MergeEnv_FirstNonEmpty_AcrossFiles_FirstFileWins', () => {
    // bunny-deploy reads `.env.production` then `.env`, folding into the same object: the
    // earlier FILE wins, which falls out of the same policy without extra bookkeeping.
    const env: Record<string, string | undefined> = {};
    mergeEnv(parseDotEnvText('K=production\n'), 'firstNonEmpty', env);
    mergeEnv(parseDotEnvText('K=plain\n'), 'firstNonEmpty', env);
    expect(env.K).toBe('production');
  });

  it('Test_MergeEnv_Last_OverwritesUnconditionally', () => {
    const env: Record<string, string | undefined> = { K: 'before' };
    mergeEnv(parseDotEnvText('K=after\n'), 'last', env);
    expect(env.K).toBe('after');
  });

  it('Test_MergeEnv_UnknownPolicy_Throws', () => {
    // There is deliberately NO default policy: picking one silently is exactly the mistake
    // this function exists to prevent.
    expect(() => mergeEnv([['K', 'v']], 'whatever' as never)).toThrow(/unknown policy/i);
    expect(() => mergeEnv([['K', 'v']], undefined as never)).toThrow(/unknown policy/i);
  });

  it('Test_MergeEnv_NoEntries_ReturnsTheTarget', () => {
    const env = { KEEP: '1' };
    expect(mergeEnv(null, 'last', env)).toBe(env);
    expect(env).toEqual({ KEEP: '1' });
  });

  it('Test_LoadDotEnvText_IsParsePlusMerge', () => {
    expect(loadDotEnvText(MEASURED_DIVERGENCE, 'firstNonEmpty')).toEqual({ K: 'first' });
    expect(loadDotEnvText(MEASURED_DIVERGENCE, 'last')).toEqual({ K: 'third' });
  });
});

describe('rv-dotenv — the two callers still behave as measured', () => {
  it('Test_Callers_UseTheirOwnPolicy', async () => {
    // The watcher's exported `parseEnvText` is the `last` policy; nothing else in the repo may
    // quietly become `firstNonEmpty` (or the other way round) without this failing.
    // @ts-expect-error — plain JS Node module, no type declarations by design (plan-488).
    const { parseEnvText } = await import('../scripts/dev-deploy-watch.mjs') as { parseEnvText: (text: string) => Record<string, string> };
    expect(parseEnvText(MEASURED_DIVERGENCE)).toEqual({ K: 'third' });
    expect(parseEnvText(MEASURED_DIVERGENCE)).toEqual(legacyWatcherParseEnvText(MEASURED_DIVERGENCE));
  });
});
