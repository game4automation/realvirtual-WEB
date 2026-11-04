// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Type declarations for gen-odt-split.mjs. */
export const SOURCE_FILE: string;
export const STRUCTURE_FILE: string;
export const DESCRIPTIONS_FILE: string;
export function splitOdt(doc: unknown): { structure: any; descriptions: Record<string, string> };
export function renderOdtSplit(sourceText?: string): { structure: string; descriptions: string };
