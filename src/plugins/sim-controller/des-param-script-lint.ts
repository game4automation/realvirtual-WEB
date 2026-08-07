// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-param-script-lint.ts — the setter-only linter for DES experiment
 * parametrisation scripts (plan-265 F4).
 *
 * A `paramScript` is CONFIGURATION run once before a replication starts — it may
 * only SET model fields (`self.setField(...)`). It is NOT runtime control logic:
 * scheduling primitives (`self.in(...)`, `self.at(...)`, `self.cancel(...)`) and
 * time reads (`self.now`) belong to the GLB-first-JS behaviour surface (plan-210),
 * NOT to a pre-start config script. This linter flags those so a mis-authored
 * script is rejected before it runs (the existing continuous/event lint does not
 * check this — §2.4 / test 9.7).
 *
 * Pure text analysis — no dependency on the (plan-210) script host, so it lints a
 * script string offline in the Monaco cell (Phase 4) and in unit tests alike.
 */

/** One lint diagnostic. */
export interface ParamScriptLintError {
  /** 1-based line number in the script source. */
  line: number;
  /** The offending token (e.g. `self.in`). */
  token: string;
  /** Human-readable message. */
  message: string;
}

/** Forbidden `self.<member>` accesses in a setter-only config script. */
const FORBIDDEN_MEMBERS: ReadonlyArray<{ member: string; call: boolean }> = [
  { member: 'in', call: true },
  { member: 'at', call: true },
  { member: 'cancel', call: true },
  { member: 'spawn', call: true },
  { member: 'transfer', call: true },
  { member: 'setState', call: true },
  { member: 'now', call: false },
];

/**
 * Strip line/block comments and string/template literals from a source line so a
 * forbidden token inside a comment or string is not falsely flagged. Replaces
 * stripped spans with spaces to keep column positions stable (line-local only).
 */
function stripNonCode(line: string): string {
  let out = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    const c2 = line[i + 1];
    // Line comment — rest of the line is non-code.
    if (c === '/' && c2 === '/') break;
    // Block comment start — skip to end on the same line (naive: single-line only).
    if (c === '/' && c2 === '*') {
      const end = line.indexOf('*/', i + 2);
      if (end === -1) { out += ' '.repeat(n - i); break; }
      out += ' '.repeat(end + 2 - i);
      i = end + 2;
      continue;
    }
    // String / template literal — skip to the matching quote (respect escapes).
    if (c === '"' || c === "'" || c === '`') {
      out += ' ';
      i++;
      while (i < n) {
        if (line[i] === '\\') { out += '  '; i += 2; continue; }
        if (line[i] === c) { out += ' '; i++; break; }
        out += ' ';
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Lint a DES parametrisation script. Returns an array of diagnostics — empty when
 * the script only uses setters (`self.setField(...)`) and other allowed code.
 *
 * `self` is optional in the source (an author may destructure), but the common
 * and documented surface is `self.setField(...)`; the linter targets the
 * `self.<member>` form for the forbidden runtime primitives.
 */
export function lintParamScript(source: string): ParamScriptLintError[] {
  const errors: ParamScriptLintError[] = [];
  const lines = source.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const code = stripNonCode(lines[li]);
    for (const { member, call } of FORBIDDEN_MEMBERS) {
      // Match `self.<member>` where <member> is a whole word, optionally followed
      // by `(` for the call-form primitives (so `self.info` never trips `in`).
      const suffix = call ? '\\s*\\(' : '(?![A-Za-z0-9_$])';
      const re = new RegExp(`\\bself\\s*\\.\\s*${member}${suffix}`, 'g');
      if (re.test(code)) {
        const token = `self.${member}`;
        errors.push({
          line: li + 1,
          token,
          message: call
            ? `'${token}(...)' is a runtime scheduling/transfer primitive and is not allowed in a ` +
              `parametrisation script — a param script may only SET fields via self.setField(...).`
            : `'${token}' reads simulation time and is not allowed in a parametrisation script — ` +
              `param scripts run once before start and may only SET fields via self.setField(...).`,
        });
      }
    }
  }
  return errors;
}

/** Convenience: true when the script passes the setter-only rule. */
export function isValidParamScript(source: string): boolean {
  return lintParamScript(source).length === 0;
}
