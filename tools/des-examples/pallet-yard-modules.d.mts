// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

export declare function buildYardModuleBytes(): Promise<Map<string, Uint8Array>>;
export declare function writeYardModules(opts?: { libDir?: string }): Promise<Array<{
  file: string; sha256: string; sizeBytes: number; written: boolean;
}>>;
