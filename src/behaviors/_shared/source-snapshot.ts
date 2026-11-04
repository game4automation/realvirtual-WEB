// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Adapter capture/restore owns generated and pending; no extra hook needed.
export const sourceRunState = ['generated', 'pending'] as const;
export const sourceServices = [] as const;
export const sourceDerived = [] as const;
// Synchronous emission guard and Problems display dedupe do not affect DES.
export const sourceScratch = ['emitting', 'poseFallbackReported'] as const;
