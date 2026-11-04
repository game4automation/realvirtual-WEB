// plan-659 diagnostic — how much of the push is VISIBLE on screen?
// The follow adds the base delta (all three axes) to camera AND orbit target
// every frame. Anything the base does is therefore cancelled 1:1 in screen
// space. This measures the projected (screen) displacement of the base over the
// push window, with the follow ON and with it OFF.
import { chromium } from 'playwright';

const URL = 'http://localhost:5659/?projectUrl=/spike-659-duck/&doc=doc_rv_walker_659';
const browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));
await page.addInitScript(() => { try { localStorage.setItem('rv-terms-accepted','1'); localStorage.setItem('rv-welcome-dismissed','1'); localStorage.setItem('rv-auto-quality-applied','1'); } catch {} });
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__rvViewer, { timeout: 120000 });
await page.waitForFunction(() => !!window.__rvMuJoCo && window.__rvMuJoCo.report().status === 'running', { timeout: 180000 });
try { await page.getByRole('button', { name: 'OK', exact: true }).click({ timeout: 4000 }); } catch {}

const out = await page.evaluate(async () => {
  const api = window.__rvMuJoCo; const v = window.__rvViewer;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const st = () => api.report().state;
  // Screen position of the trunk node, in pixels.
  const trunk = v.scene.getObjectByName('trunk_base') || (() => { let f = null; v.scene.traverse(n => { if (!f && n.userData?.rv_free_joint) f = n; }); return f; })();
  const THREE = v.THREE || null;
  const screenOf = () => {
    const p = trunk.getWorldPosition(new (trunk.position.constructor)());
    p.project(v.camera);
    return [ (p.x * 0.5 + 0.5) * 1600, (-p.y * 0.5 + 0.5) * 1000 ];
  };
  const run = async (label) => {
    api.reset(); await sleep(5000);
    const s0 = screenOf(); const w0 = st().base.slice();
    const camStart = v.camera.position.toArray();
    api.pushFall();
    const screen = []; const world = [];
    for (let i = 0; i < 40; i++) { await sleep(50); screen.push(screenOf()); world.push(st().base.slice()); }
    const camEnd = v.camera.position.toArray();
    const dScreen = Math.max(...screen.map(s => Math.hypot(s[0]-s0[0], s[1]-s0[1])));
    const dWorld  = Math.max(...world.map(w => Math.hypot(w[0]-w0[0], w[1]-w0[1], w[2]-w0[2])));
    const camMoved = Math.hypot(camEnd[0]-camStart[0], camEnd[1]-camStart[1], camEnd[2]-camStart[2]);
    return { label, maxScreenPx: Math.round(dScreen), maxWorldM: Number(dWorld.toFixed(3)), cameraMovedM: Number(camMoved.toFixed(3)) };
  };
  const withFollow = await run('follow ON (today)');
  // Freeze the follow by hand: the plugin's own flag is private, so the orbit
  // target and camera are simply left alone by stopping the plugin's follow via
  // its options is not reachable — instead measure how far the camera travels.
  return { withFollow, trunkName: trunk?.name };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
