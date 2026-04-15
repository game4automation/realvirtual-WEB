// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { RVDrive } from './rv-drive';
import type { NodeRegistry } from './rv-node-registry';
import type { ActiveOnly } from './rv-active-only';
import { debug, debugWarn } from './rv-debug';

/**
 * Compact recording format matching the GLB export.
 * positions is a flat Float array: positions[frame * driveCount + driveIndex]
 */
export interface CompactRecording {
  fixedDeltaTime: number;
  numberFrames: number;
  driveCount: number;
  drives: { id: number; path: string }[];
  sequences?: { name: string; startFrame: number; endFrame: number }[];
  positions: number[];
}

/**
 * Parse DrivesRecording_compact from GLB extras.
 * Supports both compact format (flat array) and ScriptableObject inline format.
 */
export function parseCompactRecording(data: Record<string, unknown>): CompactRecording | null {
  // Compact format: flat positions array
  if (data['positions'] && data['drives'] && data['numberFrames']) {
    return {
      fixedDeltaTime: (data['fixedDeltaTime'] as number) ?? 0.02,
      numberFrames: (data['numberFrames'] as number) ?? 0,
      driveCount: (data['driveCount'] as number) ?? 0,
      drives: (data['drives'] as { id: number; path: string }[]) ?? [],
      sequences: data['sequences'] as { name: string; startFrame: number; endFrame: number }[] | undefined,
      positions: (data['positions'] as number[]) ?? [],
    };
  }
  return null;
}

/**
 * Parse DrivesRecording from ScriptableObject inline data.
 * Converts verbose Snapshot[] format to compact flat array.
 */
export function parseScriptableObjectRecording(data: Record<string, unknown>): CompactRecording | null {
  const soData = data['data'] as Record<string, unknown> | undefined;
  if (!soData) return null;

  const recordedDrives = soData['RecordedDrives'] as { Id: number; Path: string }[] | undefined;
  const snapshots = soData['Snapshots'] as { Frame: number; DriveID: number; Position: number }[] | undefined;
  const numberFrames = (soData['NumberFrames'] as number) ?? 0;
  const sequences = soData['Sequences'] as { Name: string; StartFrame: number; EndFrame: number }[] | undefined;

  if (!recordedDrives || !snapshots || numberFrames <= 0) return null;

  const driveCount = recordedDrives.length;
  const positions = new Array<number>(numberFrames * driveCount).fill(0);

  // Build id→index map
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < recordedDrives.length; i++) {
    idToIndex.set(recordedDrives[i].Id, i);
  }

  // Fill positions from snapshots
  for (const snap of snapshots) {
    const idx = idToIndex.get(snap.DriveID);
    if (idx !== undefined && snap.Frame < numberFrames) {
      positions[snap.Frame * driveCount + idx] = snap.Position;
    }
  }

  return {
    fixedDeltaTime: 0.02, // Default, not stored in ScriptableObject
    numberFrames,
    driveCount,
    drives: recordedDrives.map((rd, i) => ({
      id: i,
      path: rd.Path.replace(/^\//, ''), // Normalize path
    })),
    sequences: sequences?.map((s) => ({
      name: s.Name,
      startFrame: s.StartFrame,
      endFrame: s.EndFrame,
    })),
    positions,
  };
}

/**
 * RVDrivesPlayback - Frame-based drive recording playback.
 *
 * Reads a compact recording (flat float array of drive positions per frame)
 * and applies positions to RVDrive instances via positionOverwrite mode.
 *
 * Synchronizes with the simulation loop's fixedDeltaTime accumulator.
 * Supports looping and seeking.
 */
export class RVDrivesPlayback {
  private recording: CompactRecording;
  private driveBindings: (RVDrive | null)[];
  private currentFrame = 0;
  private accumulator = 0;
  private _isPlaying = false;
  private _loop = true;
  private _startFrame = 0;
  private _endFrame = 0;
  private _pendingRelease = false;

  /** ActiveOnly mode parsed from DrivesRecorder GLB extras. */
  activeOnly: ActiveOnly = 'Always';

  constructor(recording: CompactRecording, registry: NodeRegistry, options?: { startFrame?: number; endFrame?: number; loop?: boolean }) {
    this.validateRecording(recording);
    this.recording = recording;
    this._startFrame = options?.startFrame ?? 0;
    this._endFrame = (options?.endFrame && options.endFrame > 0) ? Math.min(options.endFrame, recording.numberFrames - 1) : recording.numberFrames - 1;
    this._loop = options?.loop ?? true;

    // Bind recording drive IDs to actual RVDrive instances via NodeRegistry
    this.driveBindings = recording.drives.map((rd) => {
      const drive = registry.getByPath<RVDrive>('Drive', rd.path);
      if (!drive) {
        debugWarn('playback', `Drive not found for path: "${rd.path}"`);
      }
      return drive;
    });

    const bound = this.driveBindings.filter(Boolean).length;
    debug('playback', `Created: ${recording.numberFrames}f, ${bound}/${recording.driveCount} drives bound, ` +
      `dt=${recording.fixedDeltaTime}s, loop=${this._loop}, range=[${this._startFrame}..${this._endFrame}]` +
      (recording.sequences?.length ? `, sequences=[${recording.sequences.map(s => s.name).join(',')}]` : ''));
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(v: boolean) {
    this._loop = v;
  }

  get frame(): number {
    return this.currentFrame;
  }

  get totalFrames(): number {
    return this.recording.numberFrames;
  }

  get progress(): number {
    return this.recording.numberFrames > 0
      ? this.currentFrame / this.recording.numberFrames
      : 0;
  }

  get sequences() {
    return this.recording.sequences ?? [];
  }

  /** Start playback — enables positionOverwrite on all bound drives.
   *  Skips drives with isOwner=false (multiuser: server has authority). */
  play(): void {
    if (this.recording.numberFrames <= 0) return;
    // Don't start if drives are not owned (multiuser client mode)
    if (this.driveBindings.some(d => d && !d.isOwner)) {
      debug('playback', 'play() skipped — drives are not owned (multiuser client mode)');
      return;
    }
    this._isPlaying = true;
    this._pendingRelease = false;
    this.currentFrame = this._startFrame;
    for (const drive of this.driveBindings) {
      if (drive) drive.positionOverwrite = true;
    }
    this.applyFrame(this.currentFrame);
    debug('playback', `play() from frame ${this._startFrame}, loop=${this._loop}`);
  }

  /** Stop playback — disables positionOverwrite */
  pause(): void {
    this._isPlaying = false;
  }

  /** Stop and reset to frame 0 */
  stop(): void {
    this._isPlaying = false;
    this._pendingRelease = false;
    this.currentFrame = 0;
    this.accumulator = 0;
    for (const drive of this.driveBindings) {
      if (drive) drive.positionOverwrite = false;
    }
  }

  /** Play a named sequence (non-looping). Used by RVReplayRecording. */
  playSequence(name: string): boolean {
    const seq = this.recording.sequences?.find((s) => s.name === name);
    if (!seq) {
      debugWarn('playback', `Sequence "${name}" not found`);
      return false;
    }
    // Don't start if drives are not owned (multiuser client mode)
    if (this.driveBindings.some(d => d && !d.isOwner)) {
      debug('playback', `playSequence("${name}") skipped — drives not owned (multiuser client)`);
      return false;
    }
    debug('playback', `playSequence("${name}") frames [${seq.startFrame}..${seq.endFrame}] (${seq.endFrame - seq.startFrame} frames, ${((seq.endFrame - seq.startFrame) * this.recording.fixedDeltaTime).toFixed(1)}s)`);
    // Log first frame positions for debugging
    const firstOffset = seq.startFrame * this.recording.driveCount;
    const posInfo = this.recording.drives.map((rd, i) =>
      `${rd.path.split('/').pop()}=${this.recording.positions[firstOffset + i]?.toFixed(1)}`
    ).join(', ');
    debug('playback', `  Start positions: ${posInfo}`);
    this._startFrame = seq.startFrame;
    this._endFrame = Math.min(seq.endFrame, this.recording.numberFrames - 1);
    this._loop = false;
    this._isPlaying = true;
    this._pendingRelease = false;
    this.currentFrame = this._startFrame;
    this.accumulator = 0;
    for (const drive of this.driveBindings) {
      if (drive) drive.positionOverwrite = true;
    }
    this.applyFrame(this.currentFrame);
    return true;
  }

  /** Seek to a specific percentage (0..1) */
  seekToPercent(pct: number): void {
    if (this.recording.numberFrames <= 0) return;
    const frame = Math.floor(Math.max(0, Math.min(1, pct)) * (this.recording.numberFrames - 1));
    this.currentFrame = frame;
    this.accumulator = 0;
    this.applyFrame(frame);
  }

  /**
   * Update — called every simulation fixed timestep.
   * Uses its own accumulator based on the recording's fixedDeltaTime
   * to advance frames at the correct rate.
   */
  update(dt: number): void {
    // Deferred release: positionOverwrite was kept alive for one extra tick so that
    // drive.update() → onAfterUpdate could evaluate the final frame (e.g. Drive_Cylinder
    // sets IsOut/IsIn feedback signals). Now release it.
    if (this._pendingRelease) {
      this._pendingRelease = false;
      for (const drive of this.driveBindings) {
        if (drive) drive.positionOverwrite = false;
      }
      return;
    }

    if (!this._isPlaying || this.recording.numberFrames <= 0) return;

    this.accumulator += dt;

    while (this.accumulator >= this.recording.fixedDeltaTime) {
      this.accumulator -= this.recording.fixedDeltaTime;
      this.currentFrame++;

      if (this.currentFrame > this._endFrame) {
        if (this._loop) {
          this.currentFrame = this._startFrame;
        } else {
          this.currentFrame = this._endFrame;
          this._isPlaying = false;
          debug('playback', `Reached end frame ${this._endFrame}, stopping (non-loop). Deferring positionOverwrite release.`);
          break;
        }
      }
    }

    this.applyFrame(this.currentFrame);

    // Don't release positionOverwrite immediately — defer by one tick so drive.update()
    // can still evaluate the final frame's position via onAfterUpdate this tick.
    if (!this._isPlaying && !this._loop) {
      this._pendingRelease = true;
    }
  }

  /** Apply a specific frame's positions to all bound drives */
  private applyFrame(frame: number): void {
    const { driveCount, positions } = this.recording;
    const offset = frame * driveCount;

    for (let i = 0; i < driveCount; i++) {
      const drive = this.driveBindings[i];
      if (drive) {
        drive.currentPosition = positions[offset + i];
      }
    }
  }

  /** Validate recording data integrity */
  private validateRecording(rec: CompactRecording): void {
    if (!rec.positions || !rec.drives) {
      throw new Error('[DrivesPlayback] Recording missing positions or drives');
    }
    if (rec.fixedDeltaTime <= 0) {
      throw new Error(`[DrivesPlayback] Invalid fixedDeltaTime: ${rec.fixedDeltaTime}`);
    }
    if (rec.numberFrames < 0) {
      throw new Error(`[DrivesPlayback] Invalid numberFrames: ${rec.numberFrames}`);
    }
    const expected = rec.numberFrames * rec.driveCount;
    if (rec.positions.length !== expected) {
      throw new Error(
        `[DrivesPlayback] positions.length ${rec.positions.length} !== frames*drives ${expected}`
      );
    }
  }
}
