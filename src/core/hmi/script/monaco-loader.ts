// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * monaco-loader.ts — lazy Monaco loader for the WebComponent script editor
 * (plan-210 phase 3, §4.2).
 *
 * PUBLIC counterpart of the private PLC loader
 * (`…-Private~/src/plugins/plc/monaco-loader.ts`, plan-242) — same lazy
 * pattern, but the TypeScript language service instead of the ST Monarch
 * language. The private loader is NOT imported (public must never depend on
 * private); `monaco-editor` is already a public dependency.
 *
 * Monaco is imported EXCLUSIVELY via dynamic import on the first panel open —
 * it never enters the eager viewer bundle (guarded by
 * tests/plc-import-boundary.node.test.ts MONACO_ALLOWED + lazy assertion, and
 * visible in the production build as a separate chunk).
 *
 * Worker setup follows the official Vite ESM integration: the generic editor
 * worker plus the TypeScript language worker are bundled via `?worker`
 * imports — no vite.config change needed. `MonacoEnvironment.getWorker`
 * dispatches by label; a previously installed getWorker (e.g. the private ST
 * loader in internal builds) is preserved as fallback for foreign labels.
 *
 * TypeScript language mode (§4.2):
 *  - `rv-sdk.d.ts` (generated, §6 S5) + the minimal `noLib` ambient lib are
 *    injected as extraLibs — the author sees ONLY the SDK surface.
 *  - Compiler options are restrictive: `noLib: true`, no DOM, `module: None`
 *    (top-level import/export is an error — stored code is a plain script
 *    against the global `setup` convention).
 *  - Inline diagnostics come from the TS language service automatically;
 *    DES-lint markers are set by the panel (owner 'rv-des-lint').
 */

// Monaco 0.55: the TypeScript language service lives in the TOP-LEVEL
// `typescript` namespace of the package root (editor.main) — the old
// `languages.typescript` on editor.api is a deprecated stub. The root import
// is lazy (dynamic) anyway, so the extra language contributions it carries
// never touch the eager bundle.
import type * as MonacoApi from 'monaco-editor';
import { generateSdkDts, SDK_MINIMAL_LIB_DTS } from '../../sdk/rv-sdk-dts';

export type Monaco = typeof MonacoApi;

/** Language id the script editor models use. */
export const SCRIPT_LANGUAGE_ID = 'typescript';

let monacoPromise: Promise<Monaco> | null = null;

/**
 * Loads Monaco (editor core + generic worker + TypeScript worker) exactly
 * once, installs the SDK typings and restrictive compiler options, and
 * returns the API. Safe to call repeatedly (promise-cached).
 */
export function loadScriptEditorMonaco(): Promise<Monaco> {
  if (!monacoPromise) monacoPromise = doLoad();
  return monacoPromise;
}

async function doLoad(): Promise<Monaco> {
  const [monaco, { default: EditorWorker }, { default: TsWorker }] = await Promise.all([
    import('monaco-editor'),
    import('monaco-editor/esm/vs/editor/editor.worker?worker'),
    import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
  ]);

  // Compose with an already-installed environment (internal builds may have
  // loaded the private ST editor first): we own 'typescript'/'javascript',
  // everything else falls through to the previous getWorker (or the generic
  // editor worker).
  const g = self as unknown as {
    MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker };
  };
  const previousGetWorker = g.MonacoEnvironment?.getWorker;
  g.MonacoEnvironment = {
    getWorker: (workerId: string, label: string): Worker => {
      if (label === 'typescript' || label === 'javascript') return new TsWorker();
      if (previousGetWorker) return previousGetWorker(workerId, label);
      return new EditorWorker();
    },
  };

  configureTypescript(monaco);
  await warmUpTypescript(monaco);
  return monaco;
}

/**
 * Forces the TypeScript language mode to initialise before the loader
 * resolves: the contribution registers the worker lazily on the first
 * 'typescript' model, and `getTypeScriptWorker()` throws
 * "TypeScript not registered!" when called before that async registration
 * completed. A throwaway model + one awaited worker round-trip settles it.
 */
async function warmUpTypescript(monaco: Monaco): Promise<void> {
  const model = monaco.editor.createModel('', SCRIPT_LANGUAGE_ID,
    monaco.Uri.parse('file:///rv-script-warmup.ts'));
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        const getWorker = await monaco.typescript.getTypeScriptWorker();
        await getWorker(model.uri);
        return;
      } catch (err) {
        if (attempt >= 50) throw err;                    // ~5 s upper bound
        await new Promise((r) => setTimeout(r, 100));    // registration is async
      }
    }
  } finally {
    model.dispose();
  }
}

/** Restrictive TS setup: SDK-only surface, no DOM, no module system (§4.2). */
function configureTypescript(monaco: Monaco): void {
  const ts = monaco.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    // No module system: stored code is a plain script (global `setup`
    // convention, phase 0); a top-level `export` is a compile error here
    // exactly as it is a SyntaxError in the QuickJS `type:'global'` eval.
    module: ts.ModuleKind.None,
    noLib: true,                    // author sees ONLY the SDK, no window/fetch
    allowNonTsExtensions: true,
    allowJs: true,
    checkJs: false,
    strict: false,
    noEmitOnError: false,           // emit is gated by the save pipeline instead
  });
  ts.typescriptDefaults.setExtraLibs([
    { content: SDK_MINIMAL_LIB_DTS, filePath: 'file:///rv-sdk-lib.d.ts' },
    { content: generateSdkDts(), filePath: 'file:///rv-sdk.d.ts' },
  ]);
  ts.typescriptDefaults.setEagerModelSync(true);
}

// ─── TS → JS erasure via the Monaco TS worker (§4.3) ────────────────────────

export interface TranspileResult {
  /** Emitted conservative JS ('' when emit produced no output). */
  js: string;
  /** Syntax errors — these BLOCK the save (the emit is unreliable then). */
  syntaxErrors: string[];
  /** Type errors — advisory only (TS is optional authoring sugar). */
  semanticErrors: string[];
}

/**
 * Runs the Monaco-owned TypeScript worker over a model: collects syntactic +
 * semantic diagnostics and the emitted JS (`getEmitOutput` — type erasure,
 * no extra dependency). The result feeds `validateScriptForSave` before any
 * hot-reload swap.
 */
export async function transpileModel(
  monaco: Monaco,
  model: MonacoApi.editor.ITextModel,
): Promise<TranspileResult> {
  const getWorker = await monaco.typescript.getTypeScriptWorker();
  const worker = await getWorker(model.uri);
  const uri = model.uri.toString();
  const [syntactic, semantic, emit] = await Promise.all([
    worker.getSyntacticDiagnostics(uri),
    worker.getSemanticDiagnostics(uri),
    worker.getEmitOutput(uri),
  ]);
  const flat = (msg: string | { messageText: unknown } | unknown): string => {
    if (typeof msg === 'string') return msg;
    if (msg && typeof msg === 'object' && 'messageText' in msg) {
      return flat((msg as { messageText: unknown }).messageText);
    }
    return String(msg);
  };
  return {
    js: emit.outputFiles[0]?.text ?? '',
    syntaxErrors: syntactic.map((d) => flat(d.messageText)),
    semanticErrors: semantic.map((d) => flat(d.messageText)),
  };
}
