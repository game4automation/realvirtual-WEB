// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * video-capture-fixture — the small scene the plan-537 video-capture tests
 * record: a floor, a static post and a red block on a jogging linear Drive
 * (LinearX, 500 mm/s), loaded through the real `viewer.loadModel` from a GLB
 * built with GLTFExporter — the same extras a Unity export writes.
 * Plus an MP4 demux / decode helper on mediabunny's Input.
 */

import {
  BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene,
} from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { RVViewer } from '../../src/core/rv-viewer';

/** Path of the moving drive node inside the fixture. */
export const SLIDE_PATH = 'Cell/Slide';

function box(name: string, size: [number, number, number], color: number, pos: [number, number, number]): Mesh {
  const m = new Mesh(new BoxGeometry(...size), new MeshStandardMaterial({ color, roughness: 0.6 }));
  m.name = name;
  m.position.set(...pos);
  return m;
}

/** GLB bytes of the fixture scene. */
export async function videoFixtureGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  const cell = new Object3D();
  cell.name = 'Cell';
  scene.add(cell);
  cell.add(box('Floor', [4, 0.1, 4], 0x808890, [0, -0.05, 0]));
  cell.add(box('Post', [0.2, 1.2, 0.2], 0x3060c0, [1.2, 0.6, -1.2]));
  const slide = new Object3D();
  slide.name = 'Slide';
  slide.position.set(-1.2, 0.25, 0);
  slide.userData.realvirtual = { Drive: { Direction: 'LinearX', TargetSpeed: 500, JogForward: true } };
  slide.add(box('Block', [0.5, 0.5, 0.5], 0xd02020, [0, 0, 0]));
  cell.add(slide);
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}

/** Load the fixture into a real viewer (replacing whatever is loaded). */
export async function loadVideoFixture(viewer: RVViewer): Promise<void> {
  await viewer.loadModel('video-fixture.glb', { data: await videoFixtureGlb() });
}

export interface DemuxedVideo {
  samples: number;
  /** Presentation timestamps in seconds, ascending. */
  timestamps: number[];
  duration: number;
  width: number;
  height: number;
  codec: string | null;
}

/** Demux an MP4 with mediabunny: sample count, timestamps, duration, size. */
export async function demuxMp4(bytes: Uint8Array): Promise<DemuxedVideo> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const sink = new mb.EncodedPacketSink(track);
  const timestamps: number[] = [];
  for (let p = await sink.getFirstPacket(); p; p = await sink.getNextPacket(p)) timestamps.push(p.timestamp);
  timestamps.sort((a, b) => a - b);
  return {
    samples: timestamps.length,
    timestamps,
    duration: await input.computeDuration(),
    width: track.displayWidth,
    height: track.displayHeight,
    codec: await track.getCodecParameterString(),
  };
}

/** Decode the frame at `t` seconds into RGBA pixels. */
export async function decodeFrame(bytes: Uint8Array, t: number): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const mb = await import('mediabunny');
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BufferSource(bytes) });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('no video track');
  const sink = new mb.CanvasSink(track, { poolSize: 0 });
  const wrapped = await sink.getCanvas(t);
  if (!wrapped) throw new Error(`no frame at ${t}`);
  const c = wrapped.canvas as HTMLCanvasElement | OffscreenCanvas;
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const img = ctx.getImageData(0, 0, c.width, c.height);
  return { data: img.data, width: c.width, height: c.height };
}

/** Mean luminance (0..255) of an RGBA buffer. */
export function meanLuma(data: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < data.length; i += 4) s += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  return s / (data.length / 4);
}

/** Mean absolute per-channel difference of two equally sized RGBA buffers. */
export function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) s += Math.abs(a[i] - b[i]);
  return s / ((a.length / 4) * 3);
}

/** Standard deviation of the luminance — a uniform (blank / white) frame is ~0. */
export function lumaStdDev(data: Uint8ClampedArray): number {
  const mean = meanLuma(data);
  let s = 0;
  for (let i = 0; i < data.length; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    s += (l - mean) * (l - mean);
  }
  return Math.sqrt(s / (data.length / 4));
}
