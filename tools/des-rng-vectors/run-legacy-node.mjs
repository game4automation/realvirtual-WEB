// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// No-child-process fallback for the sandbox (Vite/esbuild spawn is denied).
import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '../realvirtual-WebViewer~/node_modules/typescript/lib/typescript.js';
const localRepo = new URL('../realvirtual-WebViewer~/', import.meta.url);
const repo = process.env.LEGACY_SOURCE_REPO
  ? pathToFileURL(process.env.LEGACY_SOURCE_REPO.replaceAll('\\', '/').replace(/\/$/, '') + '/')
  : localRepo;
globalThis.__RV_HAS_PRIVATE__ = true;
globalThis.__RV_EMBED__ = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@rv/')) specifier = new URL('src/' + specifier.slice(4), repo).href;
    if (specifier.startsWith('@rv-private/')) specifier = new URL('../realvirtual-WebViewer-Private~/src/' + specifier.slice(12), repo).href;
    if (specifier.startsWith('.') || specifier.startsWith('file:')) {
      let url = new URL(specifier, context.parentURL);
      if (url.href.startsWith(new URL('src/', localRepo).href)) {
        url = new URL(url.href.slice(localRepo.href.length), repo);
      }
      for (const suffix of ['', '.ts', '.tsx', '/index.ts']) {
        const candidate = new URL(url.href + suffix);
        if (/\.(ts|tsx)$/.test(candidate.pathname) && existsSync(candidate)) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.json')) return { format: 'module', source: 'export default ' + readFileSync(new URL(url), 'utf8'), shortCircuit: true };
    if (/\.(ts|tsx)$/.test(new URL(url).pathname)) {
      const source = ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
        fileName: fileURLToPath(url), compilerOptions: {
          target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX, experimentalDecorators: true,
        },
      }).outputText;
      // Synthetic scene explicitly registers Station/Downtime; no model plugins.
      return { format: 'module', source: 'import.meta.env = { DEV: true, MODE: "test" }; import.meta.glob = () => ({});\n' + source, shortCircuit: true };
    }
    return next(url, context);
  },
});
await import(process.argv[2] ? new URL(process.argv[2], import.meta.url).href : './legacy-sequences.ts');
