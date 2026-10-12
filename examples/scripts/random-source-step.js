// WebComponent Code on the same node as LogicStep_JavaScript.
// Change the full source path for your project. No Unity component is needed.
function setup(self) {
  const source = self.source('Festo/LogoSource');
  const step = self.logicStep(self.path);
  if (!source || !step) throw new Error('Source or JavaScript logic step missing');
  let run = -1;
  let remaining = 0;
  let delay = 0;
  return {
    continuous: {
      fixedUpdate(dt) {
        if (step.state !== 'Active') return;
        if (run !== step.runId) {
          run = step.runId;
          remaining = 1 + Math.floor(self.random() * 3);
          delay = 0;
        }
        delay -= dt;
        if (delay > 0) return;
        // A disabled/capped source returns null; retry without losing a part.
        if (source.spawn() === null) return;
        remaining--;
        delay = 0.3;
        if (remaining === 0) step.complete();
      },
    },
  };
}
