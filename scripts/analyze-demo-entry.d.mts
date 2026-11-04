// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for the helpers of analyze-demo-entry.mjs used by tests. */
export function attributeBytes(code: string, map: unknown, SourceMapConsumer: new (map: any) => { eachMapping(cb: (m: any) => void): void }): { total: number; bySource: Record<string, number> };
