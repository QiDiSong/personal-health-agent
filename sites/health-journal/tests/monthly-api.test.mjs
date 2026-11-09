import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

const schema='CREATE TABLE entries(owner TEXT,id TEXT,day TEXT,kind TEXT,data TEXT,PRIMARY KEY(owner,id));CREATE TABLE goals(owner TEXT PRIMARY KEY,weight REAL);';
function storage(){const db=new DatabaseSync(':memory:');db.exec(schema);return {db,DB:{prepare:sql=>({bind:(...args)=>({run:async()=>db.prepare(sql).run(...args),all:async()=>({results:db.prepare(sql).all(...args)}),first:async()=>db.prepare(sql).get(...args)??null})}),batch:async items=>{db.exec('BEGIN');try{const r=await Promise.all(items.map(s=>s.run()));db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};}
async function api(s,name,args={},owner='owner'){return worker.fetch(new Request('https://journal.test/api',{method:'POST',headers:{'content-type':'application/json',origin:'https://journal.test','oai-authenticated-user-id':owner},body:JSON.stringify({name,args})}),{DB:s.DB});}

test('monthly quantity records are device imports, bounded and idempotent with owner isolation',async()=>{
 const s=storage();try{
 const entries=[{id:'apple:activity:2025-10-01',day:'2025-10-01',kind:'activity',label:'Apple 健康活动',steps:1234,walking_distance_km:1.2},{id:'apple:nutrition:2025-10-01',day:'2025-10-01',kind:'nutrition',label:'Apple 健康营养',kcal:1800,protein:100,water_ml:2000},{id:'apple:vitals:2025-10-01',day:'2025-10-01',kind:'vitals',label:'Apple 健康体征',heart_rate_bpm:70,spo2_percent:98}];
 for(let i=0;i<2;i++){const r=await api(s,'import_health',{entries});assert.equal(r.status,200);}
 assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,3);
 const result=await(await api(s,'read_health',{from:'2025-10-01',to:'2025-10-31'})).json();
 assert.equal(result.from,'2025-10-01');assert.equal(result.to,'2025-10-31');assert.equal(result.entries.length,3);assert.ok(result.entries.every(e=>e.source==='device'));
 assert.deepEqual((await(await api(s,'read_health',{from:'2025-10-01',to:'2025-10-31'},'another')).json()).entries,[]);
 const manual=await api(s,'log_health',entries[0]);assert.equal(manual.status,400);
 }finally{s.db.close();}
});
test('invalid device quantity and invalid historical ranges cause no health writes',async()=>{
 const s=storage();try{
 const good={id:'apple:activity:2025-10-01',day:'2025-10-01',kind:'activity',label:'Apple 健康活动',steps:100};
 for(const bad of [{...good,steps:-1},{...good,steps:1e20},{...good,id:'wrong-day'},{id:'apple:vitals:2025-10-01',day:'2025-10-01',kind:'vitals',label:'体征',spo2_percent:200}]){assert.equal((await api(s,'import_health',{entries:[good,bad]})).status,400);}
 assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM entries').get().n,0);
 for(const args of [{from:'2025-10-31',to:'2025-10-01'},{from:'2025-02-30',to:'2025-03-01'},{from:'2020-01-01',to:'2025-01-01'},{from:'2025-01-01'}])assert.equal((await api(s,'read_health',args)).status,400);
 }finally{s.db.close();}
});
