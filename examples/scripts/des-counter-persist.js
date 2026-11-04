// SPDX-License-Identifier: AGPL-3.0-only
// Snapshot contract: keep all runtime state in one JSON-only self.persist object.
// No module-scope let/var. The SDK restores the timer and RNG; do not re-arm
// timers in onRestore (that would duplicate the pending tick).
function setup(self) {
  const st = self.persist({ counter: 0, history: [], timerId: 0 });
  st.timerId = self.every(1, 'beat');
  return {
    des: { on(hook) {
      if (hook !== 'beat') return;
      st.counter++;
      st.history.push([self.now, Math.round(self.random() * 1000000)]);
      if (st.history.length > 4) st.history.shift();
    } },
    state() { return st; },
  };
}
