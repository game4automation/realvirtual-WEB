// plan-659 test 9.1 — RVMuJoCoWorld load / step / dispose.
//
// Beyond the plan's "steps without NaN": this file also pins the two rules the
// class exists for.
//
//  - Heap growth (risk 5.1 / finding M2): a SECOND model is loaded while the
//    first is live, which grows the WASM heap and detaches every TypedArray
//    view taken before. A cached view would read zeros here without raising;
//    `readQpos()` re-reads the property, so the values stay correct.
//  - Contact access (finding M7): Microduck's own code says "the WASM bindings
//    expose no contact array". In @mujoco/mujoco 3.11.0 they DO — `data.ncon`
//    and `data.contact` are both readable; the vector is a copy whose handles
//    this class deletes. Phase 4 can count contacts directly.
import { describe, expect, it } from 'vitest';
import { RVMuJoCoWorld } from '@rv-private/mujoco/rv-mujoco-world';
import { loadMicroduckWorld, loadReference } from './rv-microduck-runtime';

/** Smallest possible second model — one free-falling box, no assets. */
const BALLAST_XML = `<mujoco>
  <option timestep="0.005"/>
  <worldbody>
    <geom name="floor" type="plane" size="0 0 0.05" pos="0 0 0"/>
    <body name="box" pos="0 0 0.5"><freejoint/><geom type="box" size="0.05 0.05 0.05"/></body>
  </worldbody>
</mujoco>`;

describe('9.1 RVMuJoCoWorld load/step/dispose', () => {
  it('loads the Microduck scene with the compiled dimensions of Phase 0', async () => {
    const world = await loadMicroduckWorld();
    try {
      const dims = loadReference().meta.contract.model_dims;
      expect({ nq: world.nq, nv: world.nv, nu: world.nu }).toEqual(dims);
      expect(world.timestep).toBeCloseTo(0.005, 12);
    } finally {
      world.dispose();
    }
  });

  it('steps 1000 times without producing a non-finite state', async () => {
    const world = await loadMicroduckWorld();
    try {
      world.step(1000);
      expect(Array.from(world.readQpos()).every(Number.isFinite)).toBe(true);
      expect(Array.from(world.readQvel()).every(Number.isFinite)).toBe(true);
      expect(Array.from(world.readActuatorForce()).every(Number.isFinite)).toBe(true);
      expect(world.time).toBeCloseTo(5, 6);
    } finally {
      world.dispose();
    }
  });

  it('survives heap growth from a second model (no cached views)', async () => {
    const world = await loadMicroduckWorld();
    let ballast: RVMuJoCoWorld | null = null;
    try {
      world.step(50);
      const before = Array.from(world.readQpos());
      expect(before.some((v) => v !== 0)).toBe(true);

      // Growing the heap underneath the first world: a view captured before
      // this point would be detached and read as empty.
      ballast = await RVMuJoCoWorld.load(BALLAST_XML);
      ballast.step(200);

      const after = Array.from(world.readQpos());
      expect(after).toEqual(before);
      world.step(10);
      const stepped = Array.from(world.readQpos());
      expect(stepped.every(Number.isFinite)).toBe(true);
      expect(stepped).not.toEqual(before);
    } finally {
      ballast?.dispose();
      world.dispose();
    }
  });

  it('exposes ncon and the contact list (finding M7 resolved)', async () => {
    const world = await loadMicroduckWorld();
    try {
      // The duck starts above the floor; after settling its soles touch.
      world.step(400);
      const ncon = world.contactCount();
      const contacts = world.readContacts();
      expect(ncon).toBeGreaterThan(0);
      expect(contacts.length).toBe(ncon);
      for (const contact of contacts) {
        expect(Number.isFinite(contact.dist)).toBe(true);
        expect(contact.geom1).toBeGreaterThanOrEqual(0);
        expect(contact.geom2).toBeGreaterThanOrEqual(0);
        expect(contact.pos.every(Number.isFinite)).toBe(true);
      }
      // eslint-disable-next-line no-console
      console.log(`[9.1] ncon after settling = ${ncon}, first contact dist = ${contacts[0].dist}`);
    } finally {
      world.dispose();
    }
  });

  it('rejects a non-finite ctrl vector instead of writing it', async () => {
    const world = await loadMicroduckWorld();
    try {
      const good = new Float64Array(world.nu).fill(0.1);
      expect(world.setCtrl(good)).toBe(true);
      const bad = new Float64Array(world.nu).fill(0.1);
      bad[3] = Number.NaN;
      expect(world.setCtrl(bad)).toBe(false);
      expect(Array.from(world.readCtrl())).toEqual(Array.from(good));
    } finally {
      world.dispose();
    }
  });

  it('is disposable exactly once and dead afterwards', async () => {
    const world = await loadMicroduckWorld();
    world.step(1);
    world.dispose();
    // Idempotent: a second dispose must not reach Embind again (double delete).
    expect(() => world.dispose()).not.toThrow();
    expect(world.isDisposed).toBe(true);
    expect(() => world.step(1)).toThrow(/disposed/);
    expect(() => world.readQpos()).toThrow(/disposed/);
  });

  it('survives 20 load/step/dispose cycles', async () => {
    for (let i = 0; i < 20; i++) {
      const world = await loadMicroduckWorld();
      try {
        world.step(20);
        expect(Array.from(world.readQpos()).every(Number.isFinite)).toBe(true);
      } finally {
        world.dispose();
      }
    }
  });

  it('fails the load visibly for a broken MJCF and leaks nothing', async () => {
    await expect(RVMuJoCoWorld.load('<mujoco><worldbody><geom/></worldbody>')).rejects.toBeDefined();
    // The library is still usable afterwards.
    const world = await RVMuJoCoWorld.load(BALLAST_XML);
    try {
      world.step(10);
      expect(world.time).toBeCloseTo(0.05, 6);
    } finally {
      world.dispose();
    }
  });
});
