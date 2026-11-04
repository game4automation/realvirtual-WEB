// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// SinkSelf uses Record<string, never>; there is no local state factory.
// Consumption counters and MU lifecycle belong to the adapter.
export const sinkRunState = [] as const;
export const sinkServices = [] as const;
export const sinkDerived = [] as const;
export const sinkScratch = [] as const;
