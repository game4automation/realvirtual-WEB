// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-script-save-pipeline.ts — the WebComponent script save pipeline
 * (plan-210 phase 3, §4.3), factored as PURE functions so it is testable
 * without React and without Monaco:
 *
 * ```
 * transpile (Monaco TS worker, monaco-loader.ts)  →  JS
 *   → validateScriptForSave(js, meta)             (parse + DES lint + apiVersion)
 *   → ok:    applyScriptSave(...)                 (setCode op → hot-reload)
 *   → error: NOTHING is swapped — the old running code stays, the panel
 *            shows markers/toast, the editor stays dirty (§4.3).
 * ```
 *
 * Validation steps (§4.3):
 *  1. Parse check — `new Function(js)` by default (a syntax error there is
 *     definitely a syntax error in QuickJS; the module-free global-`setup`
 *     convention makes the function-body wrap conservative). An injectable
 *     `parseCheck` allows a QuickJS dry-run where a host is available.
 *  2. DES-safety lint (`rv-des-lint.ts`) — errors block; with
 *     `DesSafe: true` the warning rules escalate to errors (lint semantics).
 *  3. ApiVersion check — the component's declared `ApiVersion` must not
 *     exceed the SDK version of this build (v1: constant 1).
 */

import { lintDesSafety, type DesLintDiagnostic } from '../../sdk/rv-des-lint';
import { SDK_API_VERSION } from '../../sdk/rv-sdk-dts';
import {
  freshOpId, WEB_COMPONENT_CODE_FIELD, WEB_COMPONENT_TYPE, type PrimitiveEditOp,
} from '../scene/rv-scene-edits';

// ─── Validation ─────────────────────────────────────────────────────────────

/** One validation finding (superset of the DES-lint diagnostic shape). */
export interface ScriptSaveDiagnostic {
  /** 1-based line (0 = whole file / no position). */
  line: number;
  /** 1-based column (0 = whole file / no position). */
  col: number;
  message: string;
  severity: 'warning' | 'error';
  rule: 'parse' | 'module-syntax' | 'api-version' | 'missing-setup' | DesLintDiagnostic['rule'];
}

export interface ValidateScriptOptions {
  /** The component's `DesSafe` claim — escalates DES-lint warnings to errors. */
  desSafe?: boolean;
  /** The component's declared `ApiVersion` (default 1). */
  apiVersion?: number;
  /**
   * Parse-check override (e.g. a QuickJS compile dry-run). Must throw on a
   * syntax error. Default: `new Function(js)` — never EXECUTES the code.
   */
  parseCheck?: (js: string) => void;
}

export interface ScriptSaveValidation {
  /** True when no error-severity diagnostic exists — the swap may proceed. */
  ok: boolean;
  diagnostics: ScriptSaveDiagnostic[];
}

/** Extracts a 1-based line/col from a SyntaxError when the runtime offers one. */
function parseErrorPosition(err: unknown): { line: number; col: number } {
  const anyErr = err as { lineNumber?: number; columnNumber?: number };
  return {
    line: typeof anyErr?.lineNumber === 'number' ? anyErr.lineNumber : 0,
    col: typeof anyErr?.columnNumber === 'number' ? anyErr.columnNumber : 0,
  };
}

/**
 * Validates emitted JS BEFORE the hot-reload swap (§4.3). Never executes the
 * code. Returns every finding; `ok` is false as soon as one error exists.
 */
export function validateScriptForSave(
  js: string,
  opts: ValidateScriptOptions = {},
): ScriptSaveValidation {
  const diagnostics: ScriptSaveDiagnostic[] = [];

  // 1. Parse check.
  const parseCheck = opts.parseCheck ?? ((code: string) => {
    // eslint-disable-next-line no-new-func
    new Function(code);
  });
  try {
    parseCheck(js);
  } catch (err) {
    const { line, col } = parseErrorPosition(err);
    diagnostics.push({
      line, col, severity: 'error', rule: 'parse',
      message: `Syntax error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // 1b. Module-syntax check: the stored contract is a PLAIN SCRIPT (global
  // `setup`, phase-0 convention). A `new Function` parse does not catch a
  // CommonJS emit (`exports.setup = …` parses fine and only explodes at
  // runtime inside QuickJS), so leftover module plumbing is rejected
  // explicitly — the TS compiler options avoid it (module: None), this is
  // the belt-and-braces gate.
  const moduleSyntax = /^\s*(?:export|import)\b|\bObject\.defineProperty\s*\(\s*exports\b|\bmodule\.exports\b|^\s*exports\.[A-Za-z_$]/m;
  const moduleMatch = moduleSyntax.exec(js);
  if (moduleMatch) {
    const upto = js.slice(0, moduleMatch.index);
    diagnostics.push({
      line: upto.split('\n').length,
      col: moduleMatch.index - (upto.lastIndexOf('\n') + 1) + 1,
      severity: 'error', rule: 'module-syntax',
      message: 'Module syntax (import/export/exports) is not allowed — component scripts are plain scripts with a global setup(self) function.',
    });
  }

  // 2. DES-safety lint (structured diagnostics; DesSafe escalates).
  for (const d of lintDesSafety(js, { desSafe: opts.desSafe === true })) {
    diagnostics.push({ ...d });
  }

  // 3. ApiVersion check (v1: constant SDK_API_VERSION = 1).
  const apiVersion = opts.apiVersion ?? 1;
  if (!Number.isFinite(apiVersion) || apiVersion > SDK_API_VERSION) {
    diagnostics.push({
      line: 0, col: 0, severity: 'error', rule: 'api-version',
      message: `Component declares ApiVersion ${apiVersion}, but this build supports up to ${SDK_API_VERSION}.`,
    });
  }

  // Advisory: the runtime contract needs a global `setup` function.
  if (js.trim().length > 0 && !/\bfunction\s+setup\s*\(/.test(js) && !/\bsetup\s*=/.test(js)) {
    diagnostics.push({
      line: 0, col: 0, severity: 'warning', rule: 'missing-setup',
      message: "No global 'setup' function found — the component will not start (expected: function setup(self) { … }).",
    });
  }

  return { ok: diagnostics.every((d) => d.severity !== 'error'), diagnostics };
}

// ─── Apply (setCode op → hot-reload) ────────────────────────────────────────

/** Structural SceneStore slice (injectable for tests — PLC persist pattern). */
export interface ScriptSceneStoreLike {
  applyOp(op: PrimitiveEditOp): Promise<void>;
}

export interface ApplyScriptSaveArgs {
  nodePath: string;
  /** Validated conservative JS (the transpiled emit — NOT the TS buffer). */
  code: string;
  /** Previous `WebComponent.Code` (undefined when the node had none yet). */
  prev: string | undefined;
  /** SceneStore (or a test double). Null ⇒ nothing persists (reported). */
  store: ScriptSceneStoreLike | null;
  /**
   * Hot-reload sink (WebComponentPlugin.reloadOrCreate / registry.reload).
   * Null ⇒ persist-only (trust gate closed — no VM runs).
   */
  reload: ((nodePath: string, code: string) => void) | null;
}

export interface ApplyScriptSaveResult {
  /** True when the setCode op was written to the store. */
  persisted: boolean;
  /** True when the hot-reload sink was invoked. */
  reloaded: boolean;
  /** Resolves when the (async) op application finished — await before
   *  re-reading the materialised userData. */
  done: Promise<void>;
}

/**
 * Applies a VALIDATED save: one `setCode` op into the scene op log (undoable;
 * the store coalesces rapid saves in its generic window) followed by the
 * hot-reload (§4.1 steps 6–7). Call ONLY after `validateScriptForSave`
 * returned `ok` — this function performs no validation of its own.
 */
export function applyScriptSave(args: ApplyScriptSaveArgs): ApplyScriptSaveResult {
  const result: ApplyScriptSaveResult = { persisted: false, reloaded: false, done: Promise.resolve() };
  if (args.store && args.prev !== args.code) {
    result.done = args.store.applyOp({
      id: freshOpId(), ts: Date.now(), schemaV: 1,
      kind: 'setCode', nodePath: args.nodePath, code: args.code, prev: args.prev,
    }).catch((err) => {
      console.warn('[script-editor] setCode op failed:', err);
    });
    result.persisted = true;
  } else if (args.store) {
    result.persisted = true;      // unchanged — the stored state already matches
  }
  if (args.reload) {
    args.reload(args.nodePath, args.code);
    result.reloaded = true;
  }
  return result;
}

// ─── Node helpers (shared by panel + tests) ─────────────────────────────────

/** Reads the raw `WebComponent` entry off a node's materialised userData. */
export function readWebComponentRaw(
  node: { userData?: Record<string, unknown> } | null | undefined,
): Record<string, unknown> | null {
  const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
  const raw = rv?.[WEB_COMPONENT_TYPE];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

/** Current stored code of a node (undefined when no `WebComponent.Code` exists). */
export function readWebComponentCode(
  node: { userData?: Record<string, unknown> } | null | undefined,
): string | undefined {
  const raw = readWebComponentRaw(node);
  const code = raw?.[WEB_COMPONENT_CODE_FIELD];
  return typeof code === 'string' ? code : undefined;
}

/** Starter template written when a script is added to a node (editor entry). */
export const SCRIPT_TEMPLATE = `// realvirtual WEB component script (apiVersion ${SDK_API_VERSION})
// Contract: one global setup(self) returning lifecycle handlers.

function setup(self) {
  return {
    continuous: {
      fixedUpdate(dt) {
        // your logic here — e.g. self.drive('Path/To/Drive')?.moveTo(100);
      },
    },
  };
}
`;
