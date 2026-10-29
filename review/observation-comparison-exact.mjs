import assert from 'node:assert/strict';
import { compareObservation } from '../src/observation-comparison.js';
// Independent literal-fraction receiving: no product engine is used as an oracle.
const run=(worlds,{variable,state})=>worlds.map(w=>{
 const r=compareObservation(w,{[variable]:state});
 assert.equal(r.selectedVariable,variable); assert.equal(r.selectedValue,state);
 assert.equal(r.observedVariable,variable==='A'?'B':'A');
 return {worldId:r.worldId,seeing:r.watched,holding:r.held};
});
const V=(id,parents,noiseBits,table)=>({id,parents,noiseBits,table});
const W=(id,variables)=>({schema:'equivia.scm.v1',id,label:id,observed:['A','B'],variables});
const forward=W('forward',[V('A',[],1,[0,1]),V('B',['A'],0,[0,1])]);
const reverse=W('reverse',[V('B',[],1,[0,1]),V('A',['B'],0,[0,1])]);
const noisy=W('noisy',[V('A',[],2,[0,0,0,1]),V('B',['A'],1,[0,1,1,1])]);
const impossible=W('impossible',[V('A',[],2,[0,0,0,1]),V('B',[],0,[0])]);
const ratio=(f,n,d,msg)=>{assert.ok(BigInt(f.denominator)>0n);assert.equal(BigInt(f.numerator)*BigInt(d),BigInt(n)*BigInt(f.denominator),msg);};
function marginal(dist,id,state){
 assert.equal(dist.status,'ok'); assert.ok(dist.observed.includes(id));
 let n=0n,d=1n;
 for(const o of dist.outcomes){
  const value=Array.isArray(o.values)?o.values[dist.observed.indexOf(id)]:o.values[id];
  if(value!==state)continue;
  const a=BigInt(o.probability.numerator),b=BigInt(o.probability.denominator);
  assert.ok(b>0n);n=n*b+a*d;d*=b;
 }
 return {numerator:String(n),denominator:String(d)};
}
const check=(dist,id,state,n,d)=>ratio(marginal(dist,id,state),n,d,`${id}=${state}`);
const worlds=[forward,reverse,noisy,impossible];
const snapshot=JSON.stringify(worlds);
const pair=run([forward,reverse],{variable:'B',state:1});
assert.deepEqual(pair.map(x=>x.worldId),['forward','reverse']);
for(const row of pair){ratio(row.seeing.evidence,1,2);check(row.seeing,'A',1,1,1);}
check(pair[0].holding,'A',1,1,2);check(pair[1].holding,'A',1,1,1);
const [n1]=run([noisy],{variable:'B',state:1});
ratio(n1.seeing.evidence,5,8);check(n1.seeing,'A',1,2,5);check(n1.holding,'A',1,1,4);
const [n0]=run([noisy],{variable:'B',state:0});
ratio(n0.seeing.evidence,3,8);check(n0.seeing,'A',1,0,1);check(n0.seeing,'A',0,1,1);check(n0.holding,'A',1,1,4);
const mixed=run([noisy,impossible],{variable:'B',state:1});
assert.deepEqual(mixed.map(x=>x.worldId),['noisy','impossible']);
check(mixed[0].seeing,'A',1,2,5);
assert.equal(mixed[1].seeing.status,'zero_evidence');ratio(mixed[1].seeing.evidence,0,1);
check(mixed[1].holding,'A',1,1,4);
const switched=run([forward,reverse],{variable:'A',state:0});
for(const row of switched){ratio(row.seeing.evidence,1,2);check(row.seeing,'B',1,0,1);}
check(switched[0].holding,'B',1,0,1);check(switched[1].holding,'B',1,1,2);
assert.equal(JSON.stringify(worlds),snapshot,'helper mutated world inputs');
console.log('Independent literal-fraction oracles passed');
