// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004) — the virtual clock inside the page (Weg C, rank 0).
 *
 * The runner drives the page frame by frame: one `__vt.step(1000/fps)` and one
 * `Page.captureScreenshot` per output frame. Everything the page uses to measure time is replaced,
 * so a frame of video is exactly `1/fps` of page time and the frame number IS the video time.
 * Measured: 2700/2700 frames, container duration exactly 90.000 s, `viewer.simTime` per frame
 * min = max = 0.03333 s, gap 0 ms, drift 0 frames, 24/24 clicks at offset exactly 0.
 *
 * THE MOST DANGEROUS TRAP IN THIS PLAN — the clock must not start at 0 (spike finding 3).
 * With epoch 0 `performance.now()` jumps BACKWARDS relative to what the page has already seen;
 * every `dt = now - last` turns permanently negative and the SIMULATION STANDS STILL while
 * `isSimulationPaused` still reports `false`. Measured: `simTime` and `fixedStepCount` unchanged
 * for 40 steps. That run looks perfect — 24/24 clicks at offset 0 — and is empty. Hence
 * `__vt.enable()` seeds the epoch from the real `performance.now()`, and the numeric Null-epoch
 * preflight (§ 2.4 step 3a) checks it before a single frame is recorded.
 */

/**
 * The init script, injected as `context.addInitScript(virtualClockInitScript, { forceEpochZero })`.
 *
 * It must be a single function with NO references to anything outside itself, because Playwright
 * serialises it and evaluates it in the page. It installs `window.__vt` with the `frame` getter
 * plus `enable()`, `beginCapture()`, `step(ms)`, `now()` and `stats()`.
 *
 * `options.forceEpochZero` exists ONLY for `Test_Viewer_VirtualClockEpochZero_PreflightFailsExit1`
 * and `--epoch-zero-diagnosis`; it reproduces the measured failure case on purpose.
 */
export function virtualClockInitScript(options) {
  {
    const realNow = performance.now.bind(performance);
    const realSetTimeout = globalThis.setTimeout.bind(globalThis);
    const realClearTimeout = globalThis.clearTimeout.bind(globalThis);

    const state = {
      enabled: false,
      // Epoch, NEVER 0 unless the failure case is forced on purpose.
      epoch: 0,
      vt: 0,
      // `performance.now()` must creep forward per call even between steps, or a page that
      // measures two timestamps inside one frame divides by zero (vorbefund: 0.5 us).
      creepUs: 0.5,
      creep: 0,
      steps: 0,
      timers: new Map(),
      // Virtual ids live far above the browser's native timer ids, so a `clearTimeout` with a
      // native id can never cancel a virtual timer that happens to share the number.
      nextTimerId: 1e9,
      rafs: new Map(),
      nextRafId: 1e9,
      // Native timeouts and rAF stand-ins started BEFORE `enable()` and not fired yet. `enable()`
      // moves them onto the virtual scheduler (remaining delay), so nothing scheduled during
      // load/setup fires on wall time in the middle of the take (Codex review 2026-10-27).
      preTimers: new Map(),
      preRafs: new Map(),
      // plan-2237 Phase 2 — wall mode (time-lapse): page time follows the REAL clock from
      // `wallBegin` on, a real `setTimeout` pump fires virtual timers and rAF, `markFrame` counts
      // output frames. `vt` only ever moves forward, so the return to stepping is monotone.
      wall: false,
      wallHeld: false,
      wallVtBase: 0,
      wallRealBase: 0,
      wallPump: null,
      wallPumps: 0,
    };

    /** Wall mode: pull `vt` up to the real instant (never down). */
    function syncWall() {
      const v = state.wallVtBase + (realNow() - state.wallRealBase);
      if (v > state.vt) state.vt = v;
    }

    function virtualNow() {
      if (!state.enabled) return realNow();
      if (state.wall) syncWall();
      state.creep += state.creepUs / 1000;
      return state.epoch + state.vt + state.creep;
    }

    performance.now = virtualNow;

    // `Event.prototype.timeStamp` must follow the same clock, otherwise input events carry wall
    // clock stamps and any page-side `dt` mixes two time bases.
    try {
      const descriptor = Object.getOwnPropertyDescriptor(Event.prototype, 'timeStamp');
      if (descriptor && descriptor.configurable) {
        Object.defineProperty(Event.prototype, 'timeStamp', {
          configurable: true,
          get() { return virtualNow(); },
        });
      }
    } catch { /* locked down: the page keeps the native stamp */ }

    globalThis.requestAnimationFrame = (callback) => {
      if (!state.enabled) {
        const nativeId = realSetTimeout(() => { state.preRafs.delete(nativeId); callback(virtualNow()); }, 16);
        state.preRafs.set(nativeId, callback);
        return nativeId;
      }
      const id = state.nextRafId++;
      state.rafs.set(id, callback);
      return id;
    };
    globalThis.cancelAnimationFrame = (id) => {
      if (state.preRafs.has(id)) { state.preRafs.delete(id); realClearTimeout(id); }
      else state.rafs.delete(id);
    };

    globalThis.setTimeout = (callback, delay = 0, ...args) => {
      if (!state.enabled) {
        // A string callback cannot be re-scheduled faithfully; it stays native (never seen in the viewer).
        if (typeof callback !== 'function') return realSetTimeout(callback, delay, ...args);
        const wait = Math.max(0, Number(delay) || 0);
        const nativeId = realSetTimeout((...callArgs) => { state.preTimers.delete(nativeId); callback(...callArgs); }, wait, ...args);
        state.preTimers.set(nativeId, { dueReal: realNow() + wait, callback, args });
        return nativeId;
      }
      const id = state.nextTimerId++;
      state.timers.set(id, { due: state.vt + Math.max(0, Number(delay) || 0), callback, args, interval: null });
      return id;
    };
    globalThis.clearTimeout = (id) => {
      if (state.timers.has(id)) state.timers.delete(id);
      else if (state.preTimers.has(id)) { state.preTimers.delete(id); realClearTimeout(id); }
      else realClearTimeout(id);
    };
    globalThis.setInterval = (callback, delay = 0, ...args) => {
      const id = state.nextTimerId++;
      const every = Math.max(1, Number(delay) || 1);
      state.timers.set(id, { due: state.vt + every, callback, args, interval: every });
      return id;
    };
    globalThis.clearInterval = (id) => { state.timers.delete(id); };

    function fireDue() {
      // Timers first, then rAF — the browser order. A timer that re-arms inside this pass runs in
      // the NEXT frame, never in this one, or a `setTimeout(f, 0)` loop would never end.
      const due = [...state.timers.entries()].filter(([, timer]) => timer.due <= state.vt);
      due.sort((a, b) => a[1].due - b[1].due);
      for (const [id, timer] of due) {
        if (timer.interval === null) state.timers.delete(id);
        else timer.due = state.vt + timer.interval;
        try { timer.callback(...timer.args); } catch (error) { console.error('[rv-tutorial] timer threw', error); }
      }
      const rafs = [...state.rafs.entries()];
      state.rafs.clear();
      for (const [, callback] of rafs) {
        try { callback(virtualNow()); } catch (error) { console.error('[rv-tutorial] rAF threw', error); }
      }
    }

    window.__vt = {
      /** Output frame being produced. `step()` increments first, so capture k sees k. */
      get frame() { return state.steps - 1; },
      /** Switches the clock on. Epoch = the REAL `performance.now()` — never 0. */
      enable() {
        if (state.enabled) return { epoch: state.epoch, already: true };
        const realAtEnable = realNow();
        const epoch = options && options.forceEpochZero ? 0 : realAtEnable;
        state.epoch = epoch;
        state.vt = 0;
        state.creep = 0;
        state.enabled = true;
        // Migrate what is still pending on the wall clock: same id (a later clear must still
        // work), remaining delay on the virtual clock; pending rAF stand-ins fire with the next step.
        let migratedTimers = 0;
        for (const [nativeId, timer] of state.preTimers) {
          realClearTimeout(nativeId);
          state.timers.set(nativeId, { due: Math.max(0, timer.dueReal - realAtEnable), callback: timer.callback, args: timer.args, interval: null });
          migratedTimers++;
        }
        state.preTimers.clear();
        let migratedRafs = 0;
        for (const [nativeId, callback] of state.preRafs) {
          realClearTimeout(nativeId);
          state.rafs.set(nativeId, callback);
          migratedRafs++;
        }
        state.preRafs.clear();
        return { epoch, forced: Boolean(options && options.forceEpochZero), migratedTimers, migratedRafs };
      },
      /** Starts output-frame numbering after non-recorded preflight steps. Page time is untouched. */
      beginCapture() {
        if (!state.enabled) throw new Error('__vt.beginCapture before __vt.enable');
        state.steps = 0;
        return { frame: -1 };
      },
      /** Advances page time by `ms` and runs everything that falls due. One call = one video frame. */
      step(ms) {
        if (!state.enabled) throw new Error('__vt.step before __vt.enable');
        if (state.wall) throw new Error('__vt.step during wall mode (call __vt.wallEnd first)');
        state.vt += Number(ms);
        // plan-2237 F1 — creep CARRY: the per-call creep of `performance.now()` is absorbed by the
        // frame's own dt, so page time no longer runs ahead of `vt` (measured: one extra fixed step
        // per 175..265 frames, the old ~16 s limit). Never a reset: after a long fast-forward the
        // creep exceeds one frame, and a reset would move `performance.now()` BACKWARDS.
        state.creep = Math.max(0, state.creep - Number(ms));
        state.steps++;
        fireDue();
        return { frame: state.steps - 1 };
      },
      now() { return virtualNow(); },
      stats() {
        return { enabled: state.enabled, epoch: state.epoch, vt: state.vt, steps: state.steps, timers: state.timers.size,
          rafs: state.rafs.size, creep: state.creep, wall: state.wall, wallPumps: state.wallPumps };
      },
      /**
       * plan-2237 Phase 2: leave deterministic stepping. Page time follows the wall clock from here
       * on; a real timer pump (`pumpMs`) fires virtual timers and rAF unless `wallHold(true)`.
       */
      wallBegin({ pumpMs = 16 } = {}) {
        if (!state.enabled) throw new Error('__vt.wallBegin before __vt.enable');
        if (state.wall) throw new Error('__vt.wallBegin: already in wall mode');
        state.wall = true;
        state.wallHeld = false;
        state.wallVtBase = state.vt;
        state.wallRealBase = realNow();
        state.wallPumps = 0;
        const every = Math.max(1, Number(pumpMs) || 16);
        const pump = () => {
          if (!state.wall) return;
          if (!state.wallHeld) {
            syncWall();
            state.wallPumps++;
            fireDue();
          }
          state.wallPump = realSetTimeout(pump, every);
        };
        state.wallPump = realSetTimeout(pump, 0);
        return { vt: state.vt, frame: state.steps - 1 };
      },
      /** Wall mode only: holds the pump (no timer, no rAF fires) while a grab sequence runs. */
      wallHold(on) {
        if (!state.wall) throw new Error('__vt.wallHold outside wall mode');
        state.wallHeld = Boolean(on);
        return { held: state.wallHeld };
      },
      /**
       * Wall mode only: counts ONE output frame without stepping. `flush` (default) first brings page
       * time to the wall instant and runs what is due — the stamp is painted in rAF, so a grab
       * without the flush shows the previous frame's stamp (spike: 33/33 wrong).
       */
      markFrame(flush = true) {
        if (!state.wall) throw new Error('__vt.markFrame outside wall mode');
        state.steps++;
        if (flush) {
          syncWall();
          fireDue();
        }
        return { frame: state.steps - 1, vt: state.vt };
      },
      /** Return to deterministic stepping; `vt` keeps the wall-advanced value (monotone). Idempotent. */
      wallEnd() {
        if (!state.wall) return { already: true, vt: state.vt, frame: state.steps - 1 };
        syncWall();
        // The creep piled up in wall mode (no `step` absorbs it there; a batch polling
        // `performance.now()` adds ~100 ms in seconds) is folded into `vt`: page time stays where it
        // is (monotone), and the stepped frames after wallEnd advance by their full dt again. As a
        // carry it ate whole frame dts — page time stood still and the viewer ran no fixed step for
        // several frames (acceptance probe 2026-11-05: frames 845..848, I1 "0 fixed steps").
        state.vt += state.creep;
        state.creep = 0;
        state.wall = false;
        state.wallHeld = false;
        if (state.wallPump !== null) realClearTimeout(state.wallPump);
        state.wallPump = null;
        return { vt: state.vt, wallMs: state.vt - state.wallVtBase, pumps: state.wallPumps, frame: state.steps - 1 };
      },
    };
  }
}
