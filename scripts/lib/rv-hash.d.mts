// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

//! Types for scripts/lib/rv-hash.mjs. Sibling declaration file, the
//! established answer in this repo for a .mjs imported from a .ts test —
//! added with plan-587 F6, when `rv-project-json.mjs` made `sha256File` part
//! of a typed API surface.

export declare function sha256Buffer(bytes: ArrayBuffer | Uint8Array): string;

export declare function sha256File(path: string): { sha256: string; sizeBytes: number };
