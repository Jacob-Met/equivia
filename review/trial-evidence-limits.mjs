// Run with node review/trial-evidence-limits.mjs [output-notebook.json].
// Timings are observations, not a latency acceptance threshold.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createSession, observe, experiment, serializeSession, receiveSession } from '../src/session.js';
import { explainTrial } from '../src/trial-evidence.js';
const constant = Array(16).fill(0);
const root = [...Array(8).fill(0), ...Array(8).fill(1)];
const copy = [...Array(16).fill(0), ...Array(16).fill(1)];
const make = (id, cause, effect) => ({ schema:'equivia.scm.v1', id, observed:['A','B'], variables:[
  {id:'U',parents:[],noiseBits:4,table:constant.slice()},
  {id:cause,parents:[],noiseBits:4,table:root.slice()},
  {id:effect,parents:[cause],noiseBits:4,table:copy.slice()},
] });
const worlds = [make('forward','A','B'), make('reverse','B','A')];
let session = createSession({ worlds, seed:123, activeWorldId:'forward', title:'Maximum noise and notebook evidence receiver' });
for (const count of [12,12,12,10]) session = observe(session,count);
for (let i=0;i<6;i++) session = experiment(session,{intervention:{A:1},prediction:0.5});
assert.equal(session.history.length,64);
assert.equal(session.history.filter(x=>x.kind==='observe').length,58);
const serialized = serializeSession(session);
assert.deepEqual(receiveSession(serialized),session);
const history = session.history.map(({intervention,outcome})=>({intervention,outcome}));
const fraction = (numerator,denominator=1)=>({numerator:String(numerator),denominator:String(denominator)});
const start = performance.now();
for(let i=0;i<6;i++) {
  const result = explainTrial(worlds,history,58+i);
  assert.equal(result.status,'ok');
  const n=2**i;
  assert.deepEqual(result.hypotheses.map(x=>[x.likelihood,x.beforeWeight,x.afterWeight]),[
    [fraction(1),fraction(n,n+1),fraction(2*n,2*n+1)],
    [fraction(1,2),fraction(1,n+1),fraction(1,2*n+1)],
  ]);
}
const elapsedMs = performance.now()-start;
const output = process.argv[2] || 'trial-evidence-limit-notebook.json';
writeFileSync(output,serialized);
console.log(JSON.stringify({output,bytes:Buffer.byteLength(serialized),events:64,passive:58,interventions:6,noiseBitsPerWorld:12,selectedCalls:6,elapsedMs,firstAfter:['2/3','1/3'],lastAfter:['64/65','1/65'],checks:'exact expected weights and replay asserted; no latency threshold'},null,2));
