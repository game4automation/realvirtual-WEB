// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Compute a simple moving average with the given window size. */
export function movingAverage(data: number[], window: number): number[] {
  if (data.length === 0) return [];
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - window + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) sum += data[j];
    result.push(sum / (i - start + 1));
  }
  return result;
}
