// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Installs the recorder's two on-page instruments.
 *
 * This function is serialised into the page, so it deliberately has no module-scope references.
 * The stamp is above the marker in every frame. The measured spike placed the marker above it and
 * hid six stamps per marker, defeating the strict whole-run Gate A sequence.
 *
 * WHAT protects the stamp is the stacking of the overlay ROOT against the stamp — both are
 * children of `document.body`, while the marker is a CHILD of the root and can never leave the
 * root's stacking context (measured 2026-10-27: raising the MARKER's z-index changed nothing).
 * `config.stacking` exists for exactly one caller, the marker-over-stamp counter-case of the viewer
 * suite (Defekt D), which reaches it through the `overlayStacking` test seam of `runTutorial`;
 * `main()` never passes it. Production stacking: root 2147483002 below stamp 2147483647.
 *
 * `config.stampMode` (plan-2043): `'inline'` shows the stamp in every grab (the behaviour above).
 * `'proof'` keeps it hidden; the runner shows it with `__tutorialOverlay.stamp(true)` only for the
 * per-frame proof grab of its 320x20 region, AFTER the app grab(s) of the same virtual frame, and
 * hides it again before the next app grab — so `recording.mp4` never contains a stamp pixel.
 */
export function installTutorialOverlay(config) {
  const stampConfig = config.stamp;
  const markerRgb = config.markerRgb;
  const rootZIndex = config.stacking?.rootZIndex ?? 2147483002;
  const stampZIndex = config.stacking?.stampZIndex ?? 2147483647;

  document.getElementById('rv-tutorial-overlay-root')?.remove();
  document.getElementById('rv-tutorial-frame-stamp')?.remove();

  const root = document.createElement('div');
  root.id = 'rv-tutorial-overlay-root';
  root.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${rootZIndex}`;

  const marker = document.createElement('div');
  marker.id = 'rv-tutorial-marker';
  marker.style.cssText = `position:fixed;inset:0;display:none;pointer-events:none;background:rgb(${markerRgb.r},${markerRgb.g},${markerRgb.b});z-index:2147483002`;
  root.appendChild(marker);
  document.body.appendChild(root);

  const stamp = document.createElement('div');
  stamp.id = 'rv-tutorial-frame-stamp';
  const stampDisplay = config.stampMode === 'proof' ? 'none' : 'flex';
  stamp.style.cssText = `position:fixed;left:${stampConfig.x}px;top:${stampConfig.y}px;width:${stampConfig.w}px;height:${stampConfig.h}px;display:${stampDisplay};pointer-events:none;z-index:${stampZIndex}`;
  const cells = [];
  const blockWidth = stampConfig.w / stampConfig.bits;
  for (let bit = 0; bit < stampConfig.bits; bit++) {
    const cell = document.createElement('div');
    cell.style.cssText = `width:${blockWidth}px;height:${stampConfig.h}px;background:#000`;
    stamp.appendChild(cell);
    cells.push(cell);
  }
  document.body.appendChild(stamp);

  function paint(value) {
    // LSB first, white = 1. `readStamps` uses the identical bit order modulo 2^16.
    for (let bit = 0; bit < stampConfig.bits; bit++) {
      cells[bit].style.background = ((value >> bit) & 1) === 1 ? '#fff' : '#000';
    }
  }

  const tick = () => {
    const frame = window.__vt?.frame;
    if (Number.isInteger(frame) && frame >= 0) paint(frame & 0xffff);
    window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);

  // --burn-cursor (plan-2031 P3): a DOM cursor, hidden by default. It sits BELOW the overlay root
  // (and so below marker and stamp, which keeps both gates decodable) and is driven per frame by
  // the runner from the pointer trace — no CSS animation, the click ring is a pure function of
  // `ringAgeSec`, so the virtual clock cannot change it.
  const CURSOR_Z = Math.min(rootZIndex, stampZIndex) - 1;
  const RING_SEC = 0.6;
  const cursor = document.createElement('div');
  cursor.id = 'rv-tutorial-cursor';
  cursor.style.cssText = `position:fixed;left:0;top:0;width:0;height:0;display:none;pointer-events:none;z-index:${CURSOR_Z}`;
  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;left:-24px;top:-24px;width:48px;height:48px;box-sizing:border-box;border-radius:50%;border:3px solid #FF538D;opacity:0;pointer-events:none';
  const arrow = document.createElement('div');
  arrow.style.cssText = 'position:absolute;left:0;top:0;width:24px;height:24px;transform-origin:0 0;pointer-events:none';
  arrow.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path d="M1.5 1.5 L1.5 18.5 L6 14.5 L9.2 21.8 L12.4 20.4 L9.3 13.3 L15.2 13.3 Z" fill="#101625" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  cursor.appendChild(ring);
  cursor.appendChild(arrow);
  document.body.appendChild(cursor);

  window.__tutorialOverlay = {
    marker(on) { marker.style.display = on ? 'block' : 'none'; },
    // Returns the scroll offset: the proof grab's clip is in document coordinates.
    stamp(on) { stamp.style.display = on ? 'flex' : 'none'; return { x: window.scrollX, y: window.scrollY }; },
    cursor(state) {
      if (!state) { cursor.style.display = 'none'; return; }
      cursor.style.transform = `translate(${state.x}px,${state.y}px)`;
      arrow.style.transform = `scale(${state.pressed ? 0.85 : 1})`;
      const age = state.ringAgeSec;
      if (typeof age === 'number' && age >= 0 && age < RING_SEC) {
        const k = age / RING_SEC;
        ring.style.opacity = String(1 - k);
        ring.style.transform = `scale(${0.3 + 0.7 * k})`;
      } else {
        ring.style.opacity = '0';
      }
      cursor.style.display = 'block';
    },
  };
  return true;
}
