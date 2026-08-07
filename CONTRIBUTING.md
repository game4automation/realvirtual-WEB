# Contributing to realvirtual WEB

Thank you for your interest in contributing to realvirtual WEB.

realvirtual WEB is dual-licensed: it is available under the AGPL-3.0-only license
and under a commercial license offered by realvirtual GmbH. To keep this
dual-licensing model legally possible, every contribution requires the grant of
rights described below.

## Development & Required Checks

```bash
npm install
npm run dev          # Vite dev server with HMR
```

Before opening a pull request, all of the following must be green:

```bash
npx tsc --noEmit     # Type check — the community view (see below)
npm run lint         # ESLint (flat config, boundaries rule)
npm test             # Browser tests (headless Chromium via Playwright)
npm run test:node    # Node tests (fs, glob, ESLint instance)
```

Use plain `npx tsc --noEmit`. It type-checks against the base `tsconfig.json`, which is the
**community view**: it excludes the generated list of tests that depend on modules only
maintainers have. `npm run typecheck` is the maintainer full check — it needs the private
sibling repository `../realvirtual-WebViewer-Private~`, which is not part of this
repository, and without it fails with unresolvable `@rv-private/*` errors.

### Private-dependent tests must stay registered

Some tests import `@rv-private/*` / `@rv-projects/*`, or reach into a private sibling
repository by path. Those imports can never resolve in a clone of this repository, so such
tests are listed in the generated `tests/private-dependent-tests.json` (and in the matching
`exclude` block of `tsconfig.json`) and are skipped here.

If you add, remove, or change such an import in a test file, regenerate the list:

```bash
node scripts/gen-private-test-excludes.mjs
```

Never edit the list or the `tsconfig.json` exclude block by hand. The guard test
`tests/private-test-excludes.node.test.ts` recomputes the scan and fails whenever the
generated list has drifted.

### What is not in this repository

Some subsystems of realvirtual WEB are commercial and are not part of this repository — most
notably the CAD import providers (STEP, JT, USD, Onshape) and the PLC runtime. In this
repository, GLB/glTF is the import format, and the stubs in `src/private-stubs/` stand in for
the commercial modules so the community edition builds and runs on its own.

## Grant of Rights (Contribution License)

By submitting a contribution to this repository — for example a pull request,
patch, code, documentation, translation, or other material (a "Contribution") —
you accept and agree to the following terms for your present and future
Contributions:

1. **Grant of rights.** You grant realvirtual GmbH the perpetual, worldwide,
   irrevocable, transferable, sublicensable, royalty-free and **exclusive**
   right to use your Contribution without restriction — including the right to
   reproduce, modify, adapt, distribute, publicly display, publicly perform,
   and make available the Contribution (in whole or in part, in original or
   modified form) as part of realvirtual WEB or any other product, and the
   right to license and relicense the Contribution under license terms of
   realvirtual GmbH's choosing, including the AGPL-3.0-only license, commercial
   licenses, and other open-source or proprietary licenses. To the extent that
   an exclusive grant of rights is not permitted under applicable law, you
   grant these rights on a non-exclusive basis to the maximum extent permitted.

2. **Your continued use.** You retain the right to use, modify, and distribute
   your own Contribution for any purpose, including in other projects.

3. **Authorship and authority.** You represent that you are the author of the
   Contribution, that you have the legal right to grant the rights above, and
   that the Contribution — to the best of your knowledge — does not infringe
   any third-party rights. If your employer has rights to intellectual property
   you create, you represent that your employer has authorized the Contribution
   under these terms or has waived such rights.

4. **Third-party material.** If your Contribution includes material that you
   did not author, you must clearly identify it, including its source and
   license, when submitting the Contribution.

5. **Outbound license.** Your Contribution will be published as part of this
   repository under the AGPL-3.0-only license (see [LICENSE](LICENSE)) — in
   addition to the commercial licensing by realvirtual GmbH described above.

6. **No obligation.** You are not required to provide support for your
   Contribution. realvirtual GmbH is not obligated to accept, use, or retain
   any Contribution. Except for the representations made above, the
   Contribution is provided "as is", without warranties of any kind.

If you cannot or do not want to agree to these terms, please do not submit
Contributions to this repository.

Questions? Contact us via [realvirtual.io](https://realvirtual.io).
