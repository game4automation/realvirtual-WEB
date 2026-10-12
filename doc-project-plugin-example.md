# A Community project plugin from start to finish

> **Applies to:** standalone Community checkout; no private repository or Unity is required.
> **Reference baseline:** 6.3.43, reviewed 2026-09-16.

The [sample](examples/community-first-project/) creates a small GLB triangle and
binds a native TypeScript plugin through `documents[].scriptRef`. The plugin adds
a button showing a live counter signal. It demonstrates loading, subscriptions,
named signal writers and cleanup without React or external package imports.

## Prepare and compile

After installing the repository dependencies, run from the repository root:

```bash
node examples/community-first-project/prepare.mjs
npm run build:project-scripts -- examples/community-first-project
npm run build:project-scripts -- examples/community-first-project --check
npm run dev
```

The preparation script creates `triangle.glb` only if absent. It does not change
an existing project manifest or model. Compilation emits
`plugins/counter.js` beside `plugins/counter.ts`. `--check` reports missing/stale
compiled files; it does not build them. Recompile after editing TypeScript.

```text
community-first-project/
  project.json                 # document identity, path and scriptRef
  triangle.glb                 # generated public sample geometry
  plugins/
    counter.ts                 # source
    counter.js                 # compiled self-contained ES module
```

The two type-only imports in the sample resolve against this checkout during
development and are erased by compilation. The delivered `.js` has no imports of
the viewer source tree. For a separate repository, adjust type-only import paths
to your development checkout. Never bundle a second copy of the viewer engine.

## Open and verify

1. In Chrome/Edge on localhost, open the dashboard projects list, choose **Add**,
   and select `examples/community-first-project`.
2. Open **Community triangle**. Allow native project code when prompted, after
   reviewing `counter.ts`. This consent is separate from sandboxed GLB scripting.
3. A triangle and **Community counter: 0** button should appear. Click the button:
   the `Community.Clicks` signal and displayed count increase together.
4. Open another document or close the project. The button and its subscription
   disappear. Reopen the sample: only one button appears.
5. Save/reopen the document to check the project workflow. The counter is runtime
   state, so its value is not a promise of persisted authored model data.

The PLUGIN slot should show `plugins/counter.ts`. The manifest already binds it;
for your own document, drag a file under `plugins/` onto that slot or use
**Bind plugin…**. `registerModelPlugins` registers the plugin and
`unregisterModelPlugins` removes it. The class handles model clear, user disable,
user enable and final disposal independently.

## Troubleshooting and distribution

If there is no button, check the PLUGIN binding state and console: a missing `.js`
sibling, denied consent, import failure or missing registration exports prevents
loading. Keep the manifest, GLB, `.ts` source and compiled `.js` together when
copying the project. A private `deliver:customer` command is not needed.

For full APIs see [Scripting](doc-scripting.md),
[Extending WEB](doc-extending-webviewer.md) and [Events](doc-events-and-hooks.md).
