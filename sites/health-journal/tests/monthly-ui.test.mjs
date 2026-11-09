import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import worker from '../worker/index.js';
const page=await(await worker.fetch(new Request('https://journal.test/'),{})).text();
const script=page.match(/<script>([\s\S]*?)<\/script>/)[1];
test('switching months keeps the newest requested data and ignores stale request errors',async()=>{
 const requests=[],elements=new Map();
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{elements:{kind:{}}});return elements.get(selector);};
 const result=(from='2026-10-12',to='2026-11-10')=>({today:'2026-11-10',from,to,entries:[],plan:[],goal:null,latestWeight:null});
 const ctx=vm.createContext({TextDecoder,TextEncoder,document:{querySelector:element,querySelectorAll:()=>[],addEventListener:()=>{}},fetch:async(_url,options)=>{
  const {args}=JSON.parse(options.body);if(!args.from)return{ok:true,json:async()=>result()};
  return new Promise(resolve=>requests.push({args,resolve}));
 }});
 vm.runInContext(script,ctx);await vm.runInContext('refresh()',ctx);
 const old=vm.runInContext("selectedMonth='2025-09';refresh()",ctx);
 const fresh=vm.runInContext("selectedMonth='2025-10';refresh()",ctx);
 requests[1].resolve({ok:true,json:async()=>result('2025-10-01','2025-10-31')});await fresh;
 requests[0].resolve({ok:true,json:async()=>result('2025-09-01','2025-09-30')});await old;
 assert.equal(vm.runInContext('state.from',ctx),'2025-10-01');
 assert.match(element('#content').innerHTML,/2025-10-01 至 2025-10-31/);
 const failed=vm.runInContext("selectedMonth='2025-09';refresh()",ctx);
 const next=vm.runInContext("selectedMonth='2025-10';refresh()",ctx);
 requests[3].resolve({ok:true,json:async()=>result('2025-10-01','2025-10-31')});await next;
 requests[2].resolve({ok:false,json:async()=>({error:'old error'})});await failed;
 assert.notEqual(element('#status').textContent,'old error');
});
