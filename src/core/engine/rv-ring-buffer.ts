// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Fixed-size circular buffer.
 * Once full, the oldest entry is overwritten.
 */
export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private head = 0;
  private _count = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  /** Number of elements currently stored. */
  get count(): number {
    return this._count;
  }

  /** Alias for count — number of elements currently stored. */
  get length(): number {
    return this._count;
  }

  /** Return the most recently pushed value, or undefined if empty. */
  last(): T | undefined {
    if (this._count === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buffer[idx];
  }

  /** Push a new value into the ring buffer. */
  push(value: T): void {
    this.buffer[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this._count < this.capacity) this._count++;
  }

  /** Return all stored values in chronological order (oldest first). */
  toArray(): T[] {
    if (this._count < this.capacity) {
      return this.buffer.slice(0, this._count) as T[];
    }
    // Wrap around: head points to oldest entry
    const result: T[] = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      result[i] = this.buffer[(this.head + i) % this.capacity] as T;
    }
    return result;
  }

  /** Return the last `n` stored values in chronological order. */
  lastN(n: number): T[] {
    const take = Math.min(n, this._count);
    if (take === 0) return [];
    if (take === this._count) return this.toArray();
    // Start index: skip (_count - take) oldest entries
    const startIdx = (this.head - take + this.capacity) % this.capacity;
    const result: T[] = new Array(take);
    for (let i = 0; i < take; i++) {
      result[i] = this.buffer[(startIdx + i) % this.capacity] as T;
    }
    return result;
  }

  /** Clear all entries. */
  clear(): void {
    this.head = 0;
    this._count = 0;
  }
}
