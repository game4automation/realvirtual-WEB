// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * write-queue — one write at a time, per backend instance (plan-709 §2.2.1-3).
 *
 * ## Why the compare-and-swap is not enough on its own
 *
 * The revision precondition added in plan-709 phase 1 answers "did somebody
 * else replace these bytes since I read them". It does **not** make the
 * primitives underneath atomic, and both writable backends have a real
 * interleaving hazard that no precondition can see:
 *
 *  - the **browser** backend keeps its path→digest map in ONE localStorage
 *    value and updates it read-modify-write. Two `writeBlob` calls to two
 *    *different* paths therefore race on the index itself: whichever one reads
 *    first can write an index that has forgotten the other's entry. The bytes
 *    survive in OPFS; the path that addressed them does not.
 *  - the **folder** backend checks its precondition by reading the file and
 *    hashing it, which is a TOCTOU window by construction.
 *
 * Serialising every write of one backend closes the first hazard completely
 * and narrows the second to the multi-tab case, which is the one this process
 * genuinely cannot see. That residual is documented, not claimed as fixed.
 *
 * ## The queue lives on the INSTANCE, deliberately
 *
 * A module-level queue would serialise across projects and outlive the project
 * switch. `ProjectStore._adoptProject` replaces the backend object; with the
 * queue on the instance the outgoing backend's pending writes drain in order
 * against the store they were addressed to, and the incoming one starts empty.
 * A cross-project queue would make a slow write in the project the user just
 * left delay — or worse, order itself against — writes in the one they opened.
 *
 * ## No timeout, on purpose
 *
 * A hanging write blocks only its own backend's queue and is visible through
 * the document busy flag. A timeout would release the queue while the previous
 * write may still land, i.e. it would trade a visible stall for an invisible
 * interleaving — the exact failure the queue exists to prevent.
 */

/** A serialising promise chain. One per backend instance. */
export class WriteQueue {
  private _tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `work` after everything queued before it, and before everything
   * queued after it.
   *
   * A rejection is delivered to ITS caller only: the tail continues with a
   * settled promise, so one failed write never wedges the queue for the rest
   * of the session.
   */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this._tail.then(work, work);
    this._tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Resolve once everything queued so far has settled. */
  async drain(): Promise<void> {
    await this._tail;
  }
}
