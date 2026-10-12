// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-dotenv.mjs — the ONE dotenv parser of the Node tooling, plus an EXPLICIT
 * merge policy per caller (plan-587 F7, after the measurement in §4b M2).
 *
 * Two scripts parsed `.env` by hand, and a comment in one of them demanded that
 * the two stay identical without anything checking it. The spike measured what
 * actually differed, and it was not the regex — the two patterns are character
 * for character the same. **The divergence is in the MERGE:**
 *
 *   `bunny-deploy.mjs` writes into `process.env` behind the guard
 *   `if (process.env[key] === undefined || process.env[key] === '')`, so the
 *   FIRST non-empty value wins and a value already in the real shell
 *   environment outranks the file. That is its documented contract ("CI / real
 *   shell env wins").
 *
 *   `dev-deploy-watch.mjs`'s `parseEnvText` writes unconditionally into a plain
 *   object, so the LAST assignment in the text wins.
 *
 * Repro from the spike, input `K=first` / `K=` / `K=third`: bunny yields
 * `"first"`, the watcher `"third"`. An earlier draft of this plan wanted "last
 * wins for everyone"; that was WITHDRAWN, because it would have quietly
 * inverted bunny-deploy's env precedence — the thing its guard exists for.
 *
 * Hence the split: ONE `parseDotEnvText` that keeps the order it read, and
 * `mergeEnv(entries, policy)` where each caller names the policy it needs. The
 * policy is a parameter, not a default, so nobody inherits the other one's
 * behaviour by accident.
 *
 * Zero dependencies: pure string handling, no `node:` import at all.
 */

//! The one line pattern. `KEY=value`, upper-case/digits/underscore keys,
//! surrounding whitespace ignored, ONE layer of matching-or-not quotes stripped
//! from the ends. Kept character-identical to the two hand-written copies it
//! replaces (measured, plan-587 §4b M2) — a line that does not match is simply
//! not an assignment and is skipped, which is how comments and blanks fall out.
const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/;

//! Parses dotenv text into `[key, value]` pairs **in the order they appear**.
//!
//! The order is the payload: it is the only thing `mergeEnv` needs to tell the
//! two policies apart, and an object would have thrown it away (and with it the
//! `last`/`firstNonEmpty` distinction) before any caller could decide.
//!
//! Handles `\n` and `\r\n`. Never throws; a non-string is coerced.
export function parseDotEnvText(text) {
  const entries = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(LINE);
    if (!match) continue;
    entries.push([match[1], match[2].replace(/^["']|["']$/g, '')]);
  }
  return entries;
}

//! Folds `[key, value]` pairs into an object under an EXPLICIT policy.
//!
//! - `'firstNonEmpty'` — the first value that is neither absent nor `''` wins;
//!   later assignments to a key that already has a non-empty value are ignored.
//!   This is `bunny-deploy.mjs`'s `process.env` behaviour, lifted out of the
//!   guard it used to live in.
//! - `'last'` — plain assignment, the last one wins. This is
//!   `dev-deploy-watch.mjs`'s `parseEnvText`.
//!
//! `into` lets a caller fold several files (or a pre-seeded object) into one
//! result; with `'firstNonEmpty'` the already-present values therefore win,
//! which is exactly how `process.env` is meant to outrank the file.
//!
//! An unknown policy throws — there is no sensible default, and silently
//! picking one is the mistake this function exists to prevent.
export function mergeEnv(entries, policy, into = {}) {
  if (policy !== 'firstNonEmpty' && policy !== 'last') {
    throw new Error(`mergeEnv: unknown policy ${JSON.stringify(policy)} (expected 'firstNonEmpty' or 'last')`);
  }
  for (const [key, value] of entries ?? []) {
    if (policy === 'last') { into[key] = value; continue; }
    if (into[key] === undefined || into[key] === '') into[key] = value;
  }
  return into;
}

//! `parseDotEnvText` + `mergeEnv` in one call, for the common case.
export function loadDotEnvText(text, policy, into = {}) {
  return mergeEnv(parseDotEnvText(text), policy, into);
}
