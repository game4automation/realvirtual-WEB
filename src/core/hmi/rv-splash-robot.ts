// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Splash robot controller — syncs the loading-screen robot cell (pure SVG/CSS
 * in index.html, running before any script) with the real model load.
 *
 * One load step = one robot turn = one box on the outfeed conveyor. Nothing
 * pops in: every box on the belt is one the robot actually delivered.
 * - Step 1 is the virtual start-up step: the inline boot script in index.html
 *   delivers it while the app code is still loading.
 * - Steps 2 … SLOTS come from main.ts (reading the model, then the scene
 *   loader's phase marks); finish() earns the last step, which the robot puts
 *   down on the place point of the full belt.
 * - Behind the earned steps the cell runs faster (up to MAX_RATE). Ahead of
 *   the load it still never swings empty: it keeps carrying boxes at
 *   AHEAD_RATE: the unearned box joins the tail while the queue moves on one
 *   pitch and its lead box rides off the belt end, so the number of boxes on
 *   the belt stays the number of earned steps.
 * - The load is never delayed: the overlay fades on schedule, the robot just
 *   races through whatever is left during the fade.
 * - fault() stops the cell where it is (E-stop) until the next load.
 * While a load runs, the detail line rotates machine quips.
 */

/** Distance in px (SVG user units) from the place point to the empty-belt tail. */
const TAIL_EMPTY = 156;
/** Queue pitch; must match the slot positions and the boot script in index.html. */
const SLOT_PITCH = 30;
/** Slat pitch of the belt: its travel is rounded to it so the reset is seamless. */
const SLAT_PITCH = 12;
/** Playback rate of the cell when several steps are waiting to be delivered. */
const MAX_RATE = 5;
/** Extra travel of the lead box beyond the queue shift, enough to leave the belt. */
const LEAD_EXIT = 50;
/** Playback rate while the cell is ahead of the load (the lead box rides out). */
const AHEAD_RATE = 0.8;
const QUIP_INTERVAL_MS = 1800;
const QUIP_FADE_MS = 250;

const QUIPS = [
  'Homing axes…',
  'Calibrating TCP…',
  'Checking the safety door…',
  'Asking the PLC nicely…',
  'Greasing virtual bearings…',
  'Counting conveyor rollers…',
  'Converting millimetres to metres…',
  'Aligning coordinate systems…',
  'Tightening virtual bolts…',
  'Waiting for the forklift…',
  'Teaching the robot new tricks…',
  'Torquing to spec…',
  'Packing the things…',
  'Taping boxes shut…',
  'Labelling parcels…',
  'Stacking pallets…',
  'Wrapping it in bubble foil…',
  'Counting boxes twice…',
  'Finding the box for the box…',
];

export interface SplashRobot {
  /** A new load starts at step 1 (the start-up step); quips on. */
  reset(): void;
  /** The load reached step `n` (2 … steps-1); monotonic per load. */
  setStep(n: number): void;
  /** Load done: the last step is earned, the robot races to deliver it; quips off. */
  finish(): void;
  /** Load failed (true) or retried (false). */
  fault(on: boolean): void;
  /** Number of steps of a load: one per queue slot plus the final put-down. */
  readonly steps: number;
}

const NOOP: SplashRobot = { reset() {}, setStep() {}, finish() {}, fault() {}, steps: 0 };

/** Binds the controller to the splash in `overlay`; a no-op when the cell is absent. */
export function createSplashRobot(overlay: HTMLElement, detail: HTMLElement | null): SplashRobot {
  const cell = overlay.querySelector<SVGSVGElement>('.rv-cell');
  if (!cell) return NOOP;
  const slots = Array.from(overlay.querySelectorAll('.rv-cell .slot'));
  const steps = slots.length + 1;
  // From here on the controller owns the cell; the boot script stops.
  overlay.dataset.rvLoad = '1';
  let bootDelivered = overlay.querySelectorAll('.rv-cell .slot.on').length;

  let delivered = 0;
  let earned = 0;
  let rate = Number.NaN;
  /** Whether the running cycle's box is earned (adds to the queue) or pushes the lead box off. */
  let carrying = false;
  let quipTimer = 0;
  let quipIndex = 0;

  /** Ride target of the running cycle's box; an unearned one lands on the last
   *  queue position while the queue moves on one pitch. */
  const setTail = () => {
    const queued = Math.min(delivered, slots.length);
    const to = !carrying ? TAIL_EMPTY - SLOT_PITCH * (queued - 1)
      : queued >= slots.length ? 0 : TAIL_EMPTY - SLOT_PITCH * queued;
    cell.style.setProperty('--rv-q-shift', carrying ? '0px' : `${SLOT_PITCH}px`);
    cell.style.setProperty('--rv-q-exit', carrying ? '0px' : `${LEAD_EXIT}px`);
    cell.style.setProperty('--rv-out-to', `${to}px`);
    cell.style.setProperty('--rv-belt-to', `${Math.round(to / SLAT_PITCH) * SLAT_PITCH}px`);
  };
  const setRate = (next: number) => {
    if (next === rate) return;
    rate = next;
    for (const a of cell.getAnimations({ subtree: true })) a.updatePlaybackRate(next);
  };
  /** Speed for the current backlog. */
  const applyRate = () => {
    const backlog = earned - delivered;
    setRate(backlog > 0 ? Math.min(MAX_RATE, 1 + 1.5 * (backlog - 1)) : AHEAD_RATE);
  };
  /** Decides at a cycle start whether its box is earned or pushes the lead box off.
   *  With an empty belt there is nothing to push, so that box always counts. */
  const startCycle = () => {
    carrying = earned > delivered || delivered >= steps || delivered === 0;
    setTail();
    applyRate();
  };

  // A cycle ended. If its box was earned, it is now delivered: it stays at the
  // tail as a queue box (or, on a full belt, on the place point).
  cell.querySelector('.out-box')?.addEventListener('animationiteration', () => {
    if (overlay.classList.contains('rv-fault')) return;
    if (carrying && delivered < earned) {
      if (delivered < slots.length) slots[delivered].classList.add('on');
      delivered++;
    }
    startCycle();
  });

  const setQuip = (text: string) => {
    if (!detail) return;
    detail.classList.add('out');
    window.setTimeout(() => {
      detail.textContent = text;
      detail.classList.remove('out');
    }, QUIP_FADE_MS);
  };
  const startQuips = () => {
    if (!detail || quipTimer) return;
    setQuip(QUIPS[quipIndex++ % QUIPS.length]);
    quipTimer = window.setInterval(() => setQuip(QUIPS[quipIndex++ % QUIPS.length]), QUIP_INTERVAL_MS);
  };
  const stopQuips = (text = '') => {
    window.clearInterval(quipTimer);
    quipTimer = 0;
    if (detail) { detail.classList.remove('out'); detail.textContent = text; }
  };

  return {
    steps,
    reset() {
      // The first load keeps what the boot phase delivered; later loads start empty.
      delivered = bootDelivered;
      bootDelivered = 0;
      earned = Math.max(1, delivered);
      slots.forEach((s, i) => s.classList.toggle('on', i < delivered));
      startCycle();
      this.fault(false);
      startQuips();
    },
    setStep(n) {
      const next = Math.min(n, steps - 1);
      if (next <= earned) return;
      earned = next;
      applyRate();
    },
    finish() {
      earned = steps;
      applyRate();
      stopQuips();
    },
    fault(on) {
      overlay.classList.toggle('rv-fault', on);
      if (on) stopQuips('E-LOAD · robot stopped');
      else startQuips();
    },
  };
}
