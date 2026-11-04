// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, describe, expect, it } from 'vitest';
import { lintDesSafety, loadDesAstCheck } from '../../src/core/sdk/rv-des-lint';
beforeAll(loadDesAstCheck);
const check = (code: string) => lintDesSafety(code, { desSafe: true, checkState: true })
  .filter(d => d.rule === 'des-script-undeclared-state');
const setup = (body: string) => `function setup(self) { ${body} }`;
describe('DES undeclared state AST gate', () => {
  it.each([
    ['let', 'let n = 0; return {des:{on(){ n++; }}};'],
    ['unmutated let', 'let n = 0; return {state(){return n;}};'],
    ['var', 'var n = 0; return {des:{on(){ n++; }}};'],
    ['object const', 'const n = {}; return {des:{on(){ n.x = 1; }}};'],
    ['array const', 'const n = []; return {des:{on(){ n.push(1); }}};'],
    ['frozen table', 'const n = Object.freeze({x:1}); return {state(){return n.x;}};'],
    ['destructured persist', 'const {n} = self.persist({n:0}); return {};'],
    ['review: constructor of a self-derived value hides an array', 'const a=self.vec3(0,0,0).constructor([]); return {des:{on(){a.push(1);}}};'],
    ['review: computed member on a self-derived value', 'const a=self["vec3"](0,0,0); return {des:{on(){}}};'],
    ['review: mutating method on an SDK handle result', 'const outs=self.outputs(); return {des:{on(){outs.push(1);}}};'],
    ['review: intrinsic replacement', 'const st=self.persist({}); return {des:{on(){Object.getOwnPropertyDescriptor=()=>({enumerable:true,value:0}); st.bad=()=>1;}}};'],
    ['review: builtin prototype write', 'return {des:{on(){Array.prototype.toJSON = () => 1;}}};'],
    ['globalThis write', 'return {des:{on(){globalThis.n = 1;}}};'],
    ['this write', 'return {des:{on(){this.n = 1;}}};'],
    ['nested global write', 'return {des:{on(){globalThis.x.n++;}}};'],
    ['this alias', 'return {des:{on(){const x=this; x.n=1;}}};'],
    ['global alias', 'return {des:{on(){const x=globalThis; x.n=1;}}};'],
    ['function property', 'function f() {} return {des:{on(){f.n = 1;}}};'],
    ['returned object', 'const h = {des:{on(){}}}; h.x = 1; return h;'],
    ['Object.assign', 'function f() {} return {des:{on(){Object.assign(f,{n:1});}}};'],
    ['defineProperty', 'function f() {} return {des:{on(){Object.defineProperty(f,"n",{value:1});}}};'],
    ['Reflect.set', 'function f() {} return {des:{on(){Reflect.set(f,"n",1);}}};'],
    ['function reassignment R7 n=3 vs n=1', 'function count(){return 1;} return {des:{on(){count = () => 3;}},state:count};'],
    ['destructuring assignment', 'const n = 1; return {des:{on(){({n} = {n:2});}}};'],
    ['array assignment', 'const n = 1; return {des:{on(){[n] = [2];}}};'],
    ['increment', 'const n = 1; return {des:{on(){n++;}}};'],
    ['decrement', 'const n = 1; return {des:{on(){--n;}}};'],
    ['compound', 'const n = 1; return {des:{on(){n += 2;}}};'],
    ['function expression reassignment', 'const count = () => 1; return {des:{on(){count = () => 3;}}};'],
    ['captured local increment', 'return {des:{on(){let n=0; self.sensor("S").on(() => ++n);}}};'],
    ['captured parameter compound', 'return {des:{on(n){self.sensor("S").on(() => {n += 1;});}}};'],
    ['factory parameter R8', 'function make(n=0){return () => ++n;} return {des:{on:make()}};'],
    ['factory object', 'function make(){let n=0;return {on(){n++;}};} return {des:make()};'],
    ['factory local', 'function make(){let n=0;return () => n += 1;} return {des:{on:make()}};'],
    ['captured local method', 'return {des:{on(){const a=[]; self.sensor("S").on(() => a.push(1));}}};'],
    ['captured parameter assignment', 'return {des:{on(n){ self.sensor("S").on(() => { n = 1; });}}};'],
    ['persist is no exemption', 'const st=self.persist({}); let n=0; return {des:{on(){n++;}}};'],
    ['legacy is no exemption', 'let n=0; return {onSnapshot(){return n;},onRestore(s){n=s;}};'],
  ])('refuses %s', (_label, body) => {
    const d = check(setup(body));
    expect(d.length).toBeGreaterThan(0);
    expect(d.every(x => x.severity === 'error' && x.message.includes('use self.persist(...)') && x.line > 0)).toBe(true);
  });
  it('refuses module state', () => expect(check('let n=0; function setup(self){return {des:{on(){n++;}}};}').length).toBeGreaterThan(0));
  it.each([
    'const st=self.persist({n:0,items:[]}); return {des:{on(){st.n++; st.items.push(st.n);}}};',
    'const n=3; return {des:{on(){self.log(n);}}};',
    'const n=3; return {des:{on(){self.log(n.toString());}}};',
    'return {des:{on(){let n=0; n++; const a=[]; a.push(n); self.log(a);}}};',
    'function on(){let n=0; n++; self.log(n);} return {des:{on}};',
    'const on=() => {let n=0; self.log(++n);}; return {des:{on}};',
    'return {des:{on(n){n++; self.log(n);}}};',
    'const st=self.persist({n:0}); return {des:{on(){Object.assign(st,{n:1});}}};',
  ])('allows literal handlers, persist and own locals: %s', body => expect(check(setup(body))).toEqual([]));
  it('reports original source line', () => expect(check('function setup(self) {\n  let n=0;\nreturn {}; }')[0].line).toBe(2));
});
