// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Ambient jest-dom style matchers (`toBeInTheDocument`, `toBeVisible`,
 * `toHaveTextContent`, …) that vitest's browser mode adds to `expect`.
 *
 * Without this file the matcher types were pulled in only by accident: they
 * arrived via `@vitest/browser/context` through whichever test file happened to
 * import it. The community type-check (base `tsconfig.json`, which excludes the
 * private-dependent tests — see scripts/gen-private-test-excludes.mjs) dropped
 * those importers and with them the augmentation, so ~65 assertions in files
 * that never changed suddenly failed to compile. Referencing the types here,
 * from a file that is always part of the `tests` include, makes the matchers
 * independent of which tests are in the current set.
 */

/// <reference types="@vitest/browser/matchers" />

export {};
