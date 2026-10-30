import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceReport, renderEvidenceReport } from '../src/evidence-report.js';

const worlds = () => [
  {schema:'equivia.scm.v1', id:'cause-a', label:'A drives B', observed:['A','B'], variables:[
    {id:'A',parents:[],noiseBits:1,table:[0,1]},
    {id:'B',parents:['A'],noiseBits:0,table:[0,1]}]},
  {schema:'equivia.scm.v1', id:'cause-b', label:'B drives A', observed:['A','B'], variables:[
    {id:'B',parents:[],noiseBits:1,table:[0,1]},
    {id:'A',parents:['B'],noiseBits:0,table:[0,1]}]},
];
const trial = (id, a, b, prediction=0, intervention={A:1}) =>
  ({id,kind:'intervene',intervention,outcome:{A:a,B:b},prediction});
const input = () => ({title:'Peer investigation', explanation:'Current explanation', budget:6, worlds:worlds(), history:[]});
const fractions = r => Object.fromEntries(r.weights.map(w=>[w.worldId,w.probability]));
const frac = (n,d) => ({numerator:String(n),denominator:String(d)});
function freezeDeep(o){ if(o && typeof o==='object'){ Object.values(o).forEach(freezeDeep); Object.freeze(o); } return o; }
function forbidden(o, keys){ for(const key of keys) Object.defineProperty(o,key,{enumerable:true,get(){throw Error('read forbidden '+key);}}); return o; }

test('empty imported evidence reports equal priors and no fabricated observations',()=>{
  const r=createEvidenceReport(input());
  assert.equal(r.schema,'equivia.evidence-report.v1');
  assert.equal(r.status,'ok'); assert.equal(r.interventions,0);
  assert.deepEqual(r.history,[]);
  assert.deepEqual(fractions(r),{'cause-a':frac(1,2),'cause-b':frac(1,2)});
  assert.match(renderEvidenceReport(input()),/No trials have been recorded/);
});
test('one intervention has independently calculated exact posterior',()=>{
  const x=input(); x.history=[trial(1,1,1,0)];
  const r=createEvidenceReport(freezeDeep(x));
  assert.deepEqual(fractions(r),{'cause-a':frac(2,3),'cause-b':frac(1,3)});
  assert.equal(r.interventions,1); assert.equal(r.history[0].prediction,0);
  assert.deepEqual(r.history[0].intervention,{A:1});
});
test('discriminating evidence assigns zero and one without rounding away certainty',()=>{
  const x=input(); x.history=[trial(1,1,0,1)];
  assert.deepEqual(fractions(createEvidenceReport(x)),{'cause-a':frac(0,1),'cause-b':frac(1,1)});
});
test('trial order, observations and tiny recorded predictions survive individually',()=>{
  const x=input(); x.history=[
    {id:1,kind:'observe',intervention:{},outcome:{A:0,B:0},prediction:null},
    trial(2,1,1,0), trial(3,1,1,1), trial(4,1,1,1e-12,{B:1})
  ];
  const r=createEvidenceReport(x), html=renderEvidenceReport(x);
  assert.deepEqual(r.history.map(e=>e.id),[1,2,3,4]);
  assert.deepEqual(r.history.map(e=>e.prediction),[null,0,1,1e-12]);
  assert.equal(r.interventions,3); assert.equal(r.history.length,4);
  assert.deepEqual(r.history[3].intervention,{B:1});
  assert.match(html,/0% chance that the other lamp, B/);
  assert.match(html,/100% chance that the other lamp, B/);
  assert.match(html,/1e-10% chance that the other lamp, A/);
});
test('an interior forecast is never formatted as a certain one',()=>{
  const x=input(); x.history=[trial(1,1,1,0.9999999999999999)];
  assert.doesNotMatch(renderEvidenceReport(x),/100% chance that the other lamp/);
});
test('current explanation and changed controls do not rewrite trial evidence',()=>{
  const x=input(); x.history=[trial(1,1,1,0.25)];
  const before=createEvidenceReport(x);
  x.explanation='Revised after the trial'; x.currentPrediction=0.9; x.currentAction={B:0};
  const after=createEvidenceReport(x);
  assert.equal(after.explanation,'Revised after the trial');
  assert.deepEqual(after.history,before.history); assert.deepEqual(after.weights,before.weights);
});
test('hidden replay fields and arbitrary extras are never read or serialized',()=>{
  const x=input(); x.history=[trial(1,1,1,0.25)];
  forbidden(x,['activeWorldId','initialSeed','seed','revealed','privateCanary']);
  forbidden(x.history[0],['beforeSeed','afterSeed','privateEventCanary']);
  forbidden(x.worlds[0],['privateWorldCanary']);
  forbidden(x.worlds[0].variables[0],['privateVariableCanary']);
  const r=createEvidenceReport(x), html=renderEvidenceReport(x), serialized=JSON.stringify(r);
  for(const key of ['activeWorldId','initialSeed','beforeSeed','afterSeed','privateCanary','privateEventCanary','privateWorldCanary','privateVariableCanary']){
    assert.ok(!serialized.includes(key),key); assert.ok(!html.includes(key),key);
  }
  assert.deepEqual(r.history[0],{id:1,kind:'intervene',intervention:{A:1},outcome:{A:1,B:1},prediction:0.25});
});
test('HTML treats learner content as text and is standalone',()=>{
  const x=input(); x.title='Équivia <img src=x onerror=alert(1)> & review';
  x.explanation='東京 <script>alert("oops")</script>';
  x.worlds[0].label='Candidate <iframe src="https://invalid.example">';
  const html=renderEvidenceReport(x);
  assert.match(html,/Équivia/); assert.match(html,/東京/);
  assert.match(html,/&lt;img/); assert.match(html,/&lt;script/); assert.match(html,/&lt;iframe/);
  assert.doesNotMatch(html,/<(?:script|iframe|img|link)\b/i);
  assert.match(html,/<meta\s+[^>]*charset\s*=\s*["']?utf-8/i); assert.match(html,/@media\s+print/);
});
test('impossible evidence has undefined weights, never a uniform fallback',()=>{
  const x=input(); x.history=[{id:1,kind:'observe',intervention:{},outcome:{A:0,B:1},prediction:null}];
  const r=createEvidenceReport(x);
  assert.equal(r.status,'zero_evidence'); assert.deepEqual(r.weights,[]);
  assert.match(renderEvidenceReport(x),/None of these candidate models can explain/);
  assert.match(renderEvidenceReport(x),/Posterior weights are undefined/);
});
for(const [name, change] of [
  ['sparse history',x=>{x.history=new Array(1);}],
  ['out-of-order ID',x=>{x.history=[trial(2,1,1)];}],
  ['missing outcome lamp',x=>{x.history=[trial(1,1,1)];delete x.history[0].outcome.B;}],
  ['unknown outcome lamp',x=>{x.history=[trial(1,1,1)];x.history[0].outcome.C=1;}],
  ['two clamped lamps',x=>{x.history=[trial(1,1,1,0,{A:1,B:1})];}],
  ['missing trial prediction',x=>{x.history=[trial(1,1,1)];delete x.history[0].prediction;}],
  ['nonfinite prediction',x=>{x.history=[trial(1,1,1,NaN)];}],
  ['observe with prediction',x=>{x.history=[{id:1,kind:'observe',intervention:{},outcome:{A:0,B:0},prediction:0}];}],
  ['unsupported budget',x=>{x.budget=0;}],
  ['budget overrun',x=>{x.history=Array.from({length:7},(_,i)=>trial(i+1,1,1));}],
  ['duplicate candidates',x=>{x.worlds[1].id=x.worlds[0].id;}],
  ['wrong candidate count',x=>{x.worlds.pop();}],
  ['empty title',x=>{x.title=' ';}],
  ['overlong explanation',x=>{x.explanation='x'.repeat(1601);}],
]) test('rejects '+name+' through both public APIs',()=>{
  const x=input();change(x);assert.throws(()=>createEvidenceReport(x));assert.throws(()=>renderEvidenceReport(x));
});

test('notebook-valid non-text labels use the public ID without serializing extras',()=>{
  const x=input();x.worlds[0].label={private:'SECRET_LABEL_CANARY'};
  const r=createEvidenceReport(x),html=renderEvidenceReport(x);
  assert.equal(r.worlds[0].label,'cause-a');
  assert.ok(!html.includes('SECRET_LABEL_CANARY'));assert.ok(!JSON.stringify(r).includes('SECRET_LABEL_CANARY'));
});
test('source bounds are rejected before inspecting records',()=>{
  for (const field of ['worlds','history']) {
    const x=input(), arr=new Array(field==='worlds'?3:65);
    Object.defineProperty(arr,0,{enumerable:true,get(){throw new Error('UNEXPECTED_ENTRY_READ');}});
    x[field]=arr;
    assert.throws(()=>createEvidenceReport(x),error=>!error.message.includes('UNEXPECTED_ENTRY_READ'));
  }
});
test('maximum complete notebook chronology retains all64records and6interventions',()=>{
  const x=input();
  x.history=Array.from({length:58},(_,i)=>({id:i+1,kind:'observe',intervention:{},outcome:{A:0,B:0},prediction:null}));
  x.history.push(...Array.from({length:6},(_,i)=>trial(i+59,1,1,0.5)));
  const r=createEvidenceReport(x),html=renderEvidenceReport(x);
  assert.equal(r.history.length,64);assert.equal(r.interventions,6);
  assert.equal((html.match(/data-trial-id=/g)||[]).length,64);
  assert.deepEqual(fractions(r),{'cause-a':frac(64,65),'cause-b':frac(1,65)});
});
