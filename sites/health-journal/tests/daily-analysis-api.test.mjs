import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/index.js';

function storage(){
 const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE entries(owner TEXT,id TEXT,day TEXT,kind TEXT,data TEXT,PRIMARY KEY(owner,id));CREATE TABLE goals(owner TEXT PRIMARY KEY,weight REAL)');
 return{db,DB:{prepare:sql=>({bind:(...args)=>({all:async()=>({results:db.prepare(sql).all(...args)}),first:async()=>db.prepare(sql).get(...args)??null})})},seed(owner,entry){db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(owner,entry.id,entry.day,entry.kind,JSON.stringify(entry));}};
}
async function request(s,args={},owner='owner',mcp=false){
 const body=mcp?{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'daily_analysis',arguments:args}}:{name:'daily_analysis',args};
 return worker.fetch(new Request('https://journal.test/'+(mcp?'mcp':'api'),{method:'POST',headers:{'content-type':'application/json',origin:'https://journal.test',...(owner?{'oai-authenticated-user-id':owner}:{})},body:JSON.stringify(body)}),{DB:s.DB});
}

test('daily analysis defaults to the latest saved day, keeps owner context and is read-only',async()=>{
 const s=storage();try{
 s.seed('owner',{id:'older',day:'2025-01-01',kind:'meal',source:'manual',label:'早餐',kcal:400});
 s.seed('owner',{id:'last',day:'2025-01-02',kind:'activity',source:'device',label:'活动',steps:1234});
 s.seed('other',{id:'private-other',day:'2025-02-03',kind:'meal',source:'manual',label:'其他人的记录',kcal:900});
 const before=s.db.prepare('SELECT * FROM entries ORDER BY owner,id').all();
 const response=await request(s);assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.analysis.day,'2025-01-02');assert.equal(data.analysis.latestDataDay,'2025-01-02');
 assert.deepEqual(data.analysisDays,['2025-01-02','2025-01-01']);assert.equal(data.from,'2024-12-05');assert.equal(data.to,'2025-01-02');
 assert.equal(data.analysis.recordCount,1);assert.ok(data.entries.every(row=>row.id!=='private-other'));
 assert.deepEqual(s.db.prepare('SELECT * FROM entries ORDER BY owner,id').all(),before);
 const empty=await(await request(s,{},'empty-owner')).json();assert.equal(empty.analysis.recordCount,0);assert.deepEqual(empty.analysisDays,[]);
 }finally{s.db.close();}
});

test('an explicitly selected historical day loads only prior context and is exposed through the authenticated MCP tool',async()=>{
 const s=storage();try{
 s.seed('owner',{id:'old',day:'2025-01-01',kind:'sleep',source:'device',label:'睡眠',minutes:420});
 s.seed('owner',{id:'future-context',day:'2025-01-03',kind:'sleep',source:'device',label:'睡眠',minutes:600});
 const response=await request(s,{day:'2025-01-01'},'owner',true);assert.equal(response.status,200);
 const body=await response.json();assert.notEqual(body.result?.isError,true);
 const data=JSON.parse(body.result.content[0].text);assert.equal(data.analysis.day,'2025-01-01');assert.equal(data.analysis.latestDataDay,'2025-01-03');
 assert.ok(data.entries.every(row=>row.day<='2025-01-01'));assert.equal(data.analysis.recordCount,1);
 assert.equal((await request(s,{},null)).status,401);
 for(const day of ['2025-02-30','2099-01-01','bad'])assert.equal((await request(s,{day})).status,400);
 }finally{s.db.close();}
});
