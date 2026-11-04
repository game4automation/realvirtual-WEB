// Independent cross-check: bryc's current sfc32 (verbatim from simblob 2022-05, shown output-identical to
// compiled PractRand for seed(12345)), seeded like PractRand seed(Uint64): (a=0, b=lo32, c=hi32, d=counter=1), 12 discards.
import fs from 'node:fs';
function sfc32(a, b, c, d) {
  return function () {
    a |= 0; b |= 0; c |= 0; d |= 0;
    let t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = c << 21 | c >>> 11;
    c = c + t | 0;
    return (t >>> 0);
  };
}
const fx = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const entries = fx.vectors ?? fx.seeds ?? fx.cases ?? fx;
let n = 0, bad = 0;
for (const e of (Array.isArray(entries) ? entries : Object.values(entries))) {
  const s = BigInt(e.seed ?? e.seed64 ?? e.seedDecimal);
  const R = sfc32(0, Number(s & 0xffffffffn), Number((s >> 32n) & 0xffffffffn), 1);
  for (let i = 0; i < 12; i++) R();
  const out = (e.outputs ?? e.values).map(Number);
  for (let i = 0; i < out.length; i++) { n++; if (R() !== out[i]) { bad++; if (bad < 5) console.log('MISMATCH seed', s.toString(), 'i', i); } }
}
console.log(`bryc cross-check: ${n} outputs compared, ${bad} mismatches`);
process.exit(bad ? 1 : 0);
