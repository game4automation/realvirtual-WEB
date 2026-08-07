// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Truncates text in the middle so identity-bearing suffixes stay visible.
 *
 * The returned string never exceeds `maxLength` UTF-16 code units. Values that
 * already fit are returned unchanged.
 */
export function middleTruncate(value: string, maxLength: number): string {
  const limit = Math.max(0, Math.floor(maxLength));
  if (value.length <= limit) return value;
  if (limit === 0) return '';
  if (limit === 1) return '…';

  const visibleCharacters = limit - 1;
  const prefixLength = Math.ceil(visibleCharacters / 2);
  const suffixLength = Math.floor(visibleCharacters / 2);
  return `${value.slice(0, prefixLength)}…${value.slice(value.length - suffixLength)}`;
}
