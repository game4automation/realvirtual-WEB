// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVDrivesPlayback } from './rv-drives-playback';
import type { SignalStore } from './rv-signal-store';
import type { ActiveOnly } from './rv-active-only';

/**
 * RVReplayRecording - Port of ReplayRecording.cs
 *
 * Watches a StartOnSignal for a positive flank (false→true),
 * then triggers a named sequence on the DrivesPlayback.
 * Reports playback status via IsReplayingSignal.
 */
export class RVReplayRecording {
  readonly sequenceName: string;
  readonly startOnSignalAddr: string | null;
  readonly isReplayingSignalAddr: string | null;

  /** ActiveOnly mode parsed from ReplayRecording GLB extras. */
  activeOnly: ActiveOnly = 'Always';

  private playback: RVDrivesPlayback;
  private signalStore: SignalStore;
  private isReplaying = false;
  private oldStartOnSignal = false;

  constructor(
    sequenceName: string,
    startOnSignalAddr: string | null,
    isReplayingSignalAddr: string | null,
    playback: RVDrivesPlayback,
    signalStore: SignalStore,
  ) {
    this.sequenceName = sequenceName;
    this.startOnSignalAddr = startOnSignalAddr;
    this.isReplayingSignalAddr = isReplayingSignalAddr;
    this.playback = playback;
    this.signalStore = signalStore;
  }

  fixedUpdate(_dt: number): void {
    // Positive flank detection on StartOnSignal
    if (!this.isReplaying && this.startOnSignalAddr) {
      const currentVal = this.signalStore.getBoolByPath(this.startOnSignalAddr);
      if (currentVal && !this.oldStartOnSignal) {
        this.playback.playSequence(this.sequenceName);
        this.isReplaying = true;
      }
    }

    // Track playback completion
    if (this.isReplaying && !this.playback.isPlaying) {
      this.isReplaying = false;
    }

    // Write status to IsReplayingSignal
    if (this.isReplayingSignalAddr) {
      this.signalStore.setByPath(this.isReplayingSignalAddr, this.isReplaying);
    }

    // Store for next frame flank detection
    if (this.startOnSignalAddr) {
      this.oldStartOnSignal = this.signalStore.getBoolByPath(this.startOnSignalAddr);
    }
  }
}
