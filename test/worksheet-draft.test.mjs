import test from 'node:test';
import assert from 'node:assert/strict';
import {serializeWorksheet,draftFromWorksheet,checkDraft,buildProposal} from '../src/creator.js';
import {verifyAuthoredProposal} from '../src/model.js';

const fixture=()=>({title:'',worlds:[{id:'Draft_A',label:'  ',order:'BA',rootOn:0,childOff:8,childOn:3},{id:'Draft-B',label:'灯 🪔',order:'AB',rootOn:8,childOff:1,childOn:0}],clamp:'B0'});
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
const raw=d=>JSON.stringify({schema:'equivia.worksheet.v1',...d});

test('Unfinished controls round trip exactly without scientific acceptance or input mutation',()=>{
 const draft=freeze(fixture());assert.equal(checkDraft(draft).accepted,false);
 const bytes=serializeWorksheet(draft);assert.equal(typeof bytes,'string');assert.ok(bytes.endsWith('\n'));assert.match(bytes,/\n\s+"/);
 const record=JSON.parse(bytes);assert.equal(record.schema,'equivia.worksheet.v1');assert.deepEqual(Object.keys(record).sort(),['clamp','schema','title','worlds']);
 const reopened=draftFromWorksheet(bytes);assert.deepEqual(reopened,draft);assert.notEqual(reopened,draft);assert.notEqual(reopened.worlds,draft.worlds);
 reopened.worlds[0].label='Changed independently';assert.equal(draft.worlds[0].label,'  ');
 assert.equal(verifyAuthoredProposal(record,{variableIds:['A','B']}).accepted,false);
});
test('Scientific failure is independent of worksheet structural validity',()=>{
 const unequal=fixture();unequal.title='Different observations';unequal.worlds.forEach((w,i)=>{w.label='World '+i;w.order='AB';w.rootOn=i?8:0;w.childOff=0;w.childOn=8;});
 const same=structuredClone(unequal);same.worlds[1]={...same.worlds[0],id:'Other',label:'Other'};
 for(const d of [unequal,same]){assert.equal(checkDraft(d).accepted,false);assert.deepEqual(draftFromWorksheet(serializeWorksheet(d)),d);}
});
test('Text and ID boundaries preserve accepted values exactly',()=>{
 for(const title of ['', ' \t ', 'é'.repeat(100), '🪔'.repeat(50)]){const d=fixture();d.title=title;d.worlds[0].id='A'+'0'.repeat(39);assert.deepEqual(draftFromWorksheet(serializeWorksheet(d)),d);}
 for(const title of ['x'.repeat(101),'🪔'.repeat(51),'line\nline','line\rline']){const d=fixture();d.title=title;assert.throws(()=>serializeWorksheet(d));assert.throws(()=>draftFromWorksheet(raw(d)));}
 for(const id of ['', '1startsWrong','A'+'a'.repeat(40),'bad id']){const d=fixture();d.worlds[0].id=id;assert.throws(()=>serializeWorksheet(d));}
 const duplicate=fixture();duplicate.worlds[1].id=duplicate.worlds[0].id;assert.throws(()=>draftFromWorksheet(raw(duplicate)));
});
test('Wrong structure and unsupported fields fail instead of being normalized or dropped',()=>{
 const mutations=[d=>d.worlds.pop(),d=>d.worlds.push({...d.worlds[0],id:'Third'}),d=>d.clamp='AB1',d=>d.worlds[0].order='AA',d=>d.worlds[0].rootOn='4',d=>d.worlds[0].childOff=-1,d=>d.worlds[0].childOn=9,d=>d.worlds[0].rootOn=0.5,d=>d.worlds[0].label=null,d=>d.checked=true,d=>d.worlds[0].accepted=true];
 for(const mutate of mutations){const d=fixture();mutate(d);assert.throws(()=>serializeWorksheet(d));assert.throws(()=>draftFromWorksheet(raw(d)));}
 for(const value of ['null','[]','{}','{"schema":"equivia.worksheet.v2"}','{broken',raw(fixture()).replace('"title":""','"title":"","__proto__":{}')])assert.throws(()=>draftFromWorksheet(value));
});
test('UTF8 input limit is enforced before parsing even when excess bytes are whitespace',()=>{
 const valid=raw(fixture());assert.ok(Buffer.byteLength(valid)<65536);
 const atLimit=valid+' '.repeat(65536-Buffer.byteLength(valid));assert.deepEqual(draftFromWorksheet(atLimit),fixture());
 assert.throws(()=>draftFromWorksheet(atLimit+' '));
 const oversized=raw({...fixture(),title:'é'.repeat(33000)});assert.ok(Buffer.byteLength(oversized)>65536);assert.throws(()=>draftFromWorksheet(oversized));
});
test('Accessors and unsupported own properties cannot execute or disappear through serialization',()=>{
 let calls=0;const d=fixture();Object.defineProperty(d,'title',{get(){calls++;return'Injected';},enumerable:true});assert.throws(()=>serializeWorksheet(d));assert.equal(calls,0);
 const symbol=fixture();symbol[Symbol('unsupported')]=true;assert.throws(()=>serializeWorksheet(symbol));
 const hidden=fixture();Object.defineProperty(hidden.worlds[0],'extra',{value:true});assert.throws(()=>serializeWorksheet(hidden));
});
test('Checked author-pair contract remains separate from editable worksheet data',()=>{
 const d={title:'Accepted pair',worlds:[{id:'Left',label:'Left',order:'AB',rootOn:4,childOff:0,childOn:8},{id:'Right',label:'Right',order:'BA',rootOn:4,childOff:0,childOn:8}],clamp:'A1'};
 assert.equal(checkDraft(d).accepted,true);const proposal=buildProposal(d);assert.equal(proposal.schema,'equivia.author.v1');
 assert.throws(()=>draftFromWorksheet(JSON.stringify(proposal)));assert.deepEqual(draftFromWorksheet(serializeWorksheet(d)),d);
});
