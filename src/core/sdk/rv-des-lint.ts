// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-lint.ts — DES-safety lint v1 (plan-210 §6b specification).
 *
 * Pure text analysis (no parser dependency): comments and string literals are
 * blanked offset-preserving, then three rules run over the remaining code:
 *
 *  (a) `continuous.fixedUpdate` handler present → the component is
 *      continuous-only ("not DES-safe"). Warning; ERROR when the component is
 *      declared `DesSafe: true`.
 *  (b) dt-accumulation heuristic (`x -= dt` / `x += dt`) — tick-polled timers
 *      that silently misbehave in the event kernel. Use `self.in()` instead.
 *      Warning; ERROR when `DesSafe: true`.
 *  (c) blocked globals (`Date`, `setTimeout`, `setInterval`, `Math.random`) —
 *      these are not exposed in the sandbox at all; the lint explains WHY
 *      (determinism) instead of leaving a bare ReferenceError. Always ERROR.
 *
 * Returns structured diagnostics (1-based line/col) — the Monaco markers land
 * in phase 3.
 */

export interface DesLintDiagnostic {
  /** 1-based line of the finding. */
  line: number;
  /** 1-based column of the finding. */
  col: number;
  message: string;
  severity: 'warning' | 'error';
  /** Stable rule id: 'fixed-update' | 'dt-accumulation' | 'blocked-global' | 'closure-state' | 'geometry-sampling'. */
  rule: 'fixed-update' | 'dt-accumulation' | 'blocked-global' | 'closure-state' | 'geometry-sampling';
}

export interface DesLintOptions {
  /** The component's `WebComponent.DesSafe` flag — escalates (a)+(b) to errors. */
  desSafe?: boolean;
}

/**
 * Blank comments and string/template literals with spaces (offset-preserving)
 * so the rules never fire inside them. Lightweight scanner — no AST.
 */
function blankNonCode(code: string): string {
  const out = code.split('');
  let i = 0;
  const n = code.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && code[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && next === '*') {
      let j = code.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === quote) { j++; break; }
        j++;
      }
      // Keep the delimiters, blank the content (offsets stay stable either way).
      blank(i + 1, Math.min(j - 1, n));
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

function positionOf(code: string, index: number): { line: number; col: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (code[i] === '\n') {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, col: index - lineStart + 1 };
}

const DOC_HINT = 'see doc-webviewer scripting: DES-safe components use event hooks (self.in/at, sensor.on, signal.on)';

/**
 * Run the DES-safety lint over a component source. `opts.desSafe` mirrors the
 * `WebComponent.DesSafe` flag: rules (a)+(b) escalate from warning to error.
 */
export function lintDesSafety(code: string, opts: DesLintOptions = {}): DesLintDiagnostic[] {
  const desSafe = opts.desSafe === true;
  const scan = blankNonCode(code);
  const diagnostics: DesLintDiagnostic[] = [];
  const gateSeverity: 'warning' | 'error' = desSafe ? 'error' : 'warning';

  // (a) continuous.fixedUpdate handler — property key `fixedUpdate` used as a
  // method/function-valued property (`fixedUpdate(dt) {`, `fixedUpdate: (dt) =>`,
  // `fixedUpdate: function`).
  const fixedUpdateRe = /\bfixedUpdate\s*(?:\(|:\s*(?:function\b|\(|async\b))/g;
  for (const m of matches(fixedUpdateRe, scan)) {
    const { line, col } = positionOf(code, m.index);
    diagnostics.push({
      line, col,
      severity: gateSeverity,
      rule: 'fixed-update',
      message: desSafe
        ? `'continuous.fixedUpdate' declared but the component is marked DesSafe — tick polling does not run in the event kernel. ${DOC_HINT}.`
        : `'continuous.fixedUpdate' makes this component continuous-only (not DES-safe). ${DOC_HINT}.`,
    });
  }

  // (b) dt accumulation: `x -= dt` / `x += dt` (also `x = x - dt`).
  const dtAccumRe = /\b[\w.$]+\s*(?:[-+]=\s*dt\b|=\s*[\w.$]+\s*[-+]\s*dt\b)/g;
  for (const m of matches(dtAccumRe, scan)) {
    const { line, col } = positionOf(code, m.index);
    diagnostics.push({
      line, col,
      severity: gateSeverity,
      rule: 'dt-accumulation',
      message: `dt accumulation ('${m.match.trim()}') is a tick-polled timer — it never fires in the event kernel. Schedule with self.in(delaySec, hook) instead. ${DOC_HINT}.`,
    });
  }

  // (c) blocked globals — not exposed in the sandbox; explain why.
  const globalRules: Array<{ re: RegExp; what: string; why: string }> = [
    { re: /\bMath\.random\s*\(/g, what: 'Math.random()', why: 'non-deterministic — use the seeded self.random()' },
    { re: /\bDate\b/g, what: 'Date', why: 'wall-clock time breaks determinism — use self.now (virtual sim time)' },
    { re: /\bsetTimeout\s*\(/g, what: 'setTimeout()', why: 'wall-clock timers do not exist in the sandbox — use self.in(delaySec, hook)' },
    { re: /\bsetInterval\s*\(/g, what: 'setInterval()', why: 'wall-clock timers do not exist in the sandbox — use self.in(delaySec, hook)' },
  ];
  for (const rule of globalRules) {
    for (const m of matches(rule.re, scan)) {
      const { line, col } = positionOf(code, m.index);
      diagnostics.push({
        line, col,
        severity: 'error',
        rule: 'blocked-global',
        message: `'${rule.what}' is not available in script components: ${rule.why}.`,
      });
    }
  }

  // (d) free persistent closure variables (plan-261): a mutable `let`/`var`
  // declared in the setup closure that is reassigned later holds state that
  // does NOT survive a DES snapshot/restore unless the script persists it via
  // the onSnapshot()/onRestore() hooks (the only supported channel — `self.prop`
  // is read-only configuration in the sandbox). ALWAYS a warning (never error):
  // legitimate transient locals would otherwise break the lint gate.
  if (!/\bonSnapshot\s*[(:]/.test(scan)) {
    const declRe = /\b(?:let|var)\s+([A-Za-z_$][\w$]*)/g;
    const seen = new Set<string>();
    for (const m of matches(declRe, scan)) {
      const name = /\b(?:let|var)\s+([A-Za-z_$][\w$]*)/.exec(m.match)?.[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // Loop counters (`for (let i = …`) are transient, not closure state.
      if (/for\s*\(\s*$/.test(scan.slice(Math.max(0, m.index - 12), m.index))) continue;
      // Mutated AFTER the declaration statement? (`x = …` not `x ==`, `x +=`, `x++`, …)
      const rest = scan.slice(m.index + m.match.length);
      const mutRe = new RegExp(
        String.raw`(?<![\w$.])${name.replace(/\$/g, '\\$')}\s*(?:=(?!=)|[-+*/]=|\+\+|--)`,
      );
      if (!mutRe.test(rest)) continue;
      const { line, col } = positionOf(code, m.index);
      diagnostics.push({
        line, col,
        severity: 'warning',
        rule: 'closure-state',
        message: `'${name}' is persistent closure state — it is LOST on DES snapshot/restore. Persist it via onSnapshot() { return {…} } / onRestore(state), the only supported channel (self.prop is read-only configuration). ${DOC_HINT}.`,
      });
    }
  }

  // (e) live geometry sampling in a DES-hook component (plan-262): a script
  // that declares DES hooks (`des: { … }`) AND reads live world transforms
  // (`worldPosition()` / `worldQuaternion()` / `worldDirection()`) depends on
  // the runner's per-event-time tween settle to see exact positions. That is
  // handled — the settle stays active while such a component exists — but it
  // keeps the FastForward settle fast path off for the whole model. ALWAYS a
  // hint-level warning (never an error, never escalated by DesSafe).
  if (/\bdes\s*:/.test(scan)) {
    const geoRe = /\bworld(?:Position|Quaternion|Direction)\s*\(/g;
    for (const m of matches(geoRe, scan)) {
      const { line, col } = positionOf(code, m.index);
      diagnostics.push({
        line, col,
        severity: 'warning',
        rule: 'geometry-sampling',
        message: `'${m.match.replace(/\s*\($/, '')}()' samples live geometry in a component with DES hooks — `
          + `the event-time tween settle stays active for the whole model in FastForward (slower FF). `
          + `Prefer positions carried in event data when possible. ${DOC_HINT}.`,
      });
    }
  }

  diagnostics.sort((a, b) => a.line - b.line || a.col - b.col);
  return diagnostics;
}

function matches(re: RegExp, text: string): Array<{ index: number; match: string }> {
  const out: Array<{ index: number; match: string }> = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    out.push({ index: m.index, match: m[0] });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}
