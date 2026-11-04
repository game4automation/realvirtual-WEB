// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-dev-golden.mjs (plan-615 F4): imported by
//! vite.config.ts and tests/dev-snapshot-endpoint.node.test.ts.

export declare const GOLDEN_DIR_REL: string;
export declare const DEV_GOLDEN_ROUTE: string;
export declare const DEV_GOLDEN_MAX_BODY: number;

export declare function serializeGolden(value: unknown): string;

export type GoldenTarget =
  | { ok: true; file: string; rel: string }
  | { ok: false; error: string };

export declare function resolveGoldenTarget(root: string, name: unknown): GoldenTarget;

export type GoldenWriteResult =
  | { ok: true; status: 200; path: string }
  | { ok: false; status: number; error: string; path?: string };

export declare function writeGolden(
  root: string,
  name: unknown,
  value: unknown,
  options?: { overwrite?: boolean },
): GoldenWriteResult;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export declare function devGoldenMiddleware(root: string): (req: any, res: any, next: () => void) => void;

export declare function goldenRootOf(root: string): string;
