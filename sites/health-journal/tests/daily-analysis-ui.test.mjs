import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import worker from '../worker/index.js';
import { analyzeHealthDay } from '../worker/daily-analysis.js';

const html=await(await worker.fetch(new Request('https://journal.test/'),{})).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('daily analysis opens the latest saved report and date actions refresh only the analysis with stale responses ignored',async()=>{
 assert.ok(html.includes('data-view="analysis"'));
 const elements=new Map(),listeners=new Map(),calls=[],pending=[];
 let defer=false;
 const element=key=>{if(!elements.has(key))elements.set(key,{elements:{kind:{}}});return elements.get(key);};
 const contextFor=day=>({today:'2026-11-11',from:'2026-10-01',to:day,entries:[{id:'sleep',day,kind:'sleep',source:'device',label:'睡眠',minutes:420}],plan:[],goal:null,latestWeight:null});
 const reportFor=day=>{const data=contextFor(day);return{...data,analysis:analyzeHealthDay(data,{day}),analysisDays:['2026-10-31','2026-10-30']};};
 const ctx=vm.createContext({TextDecoder,TextEncoder,setTimeout,document:{querySelector:element,querySelectorAll:()=>[],addEventListener:(name,fn)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(fn);}},fetch:async(_url,options)=>{
  const q=JSON.parse(options.body);calls.push(q);
  if(q.name==='daily_analysis'&&defer)return new Promise(resolve=>pending.push({q,resolve}));
  return{ok:true,json:async()=>q.name==='daily_analysis'?reportFor(q.args.day??'2026-10-31'):contextFor('2026-11-11')};
 }});
 vm.runInContext(script,ctx);await vm.runInContext('refresh()',ctx);
 const click=async dataset=>{for(const fn of listeners.get('click')??[])await fn({target:{dataset}});};
 await click({view:'analysis'});
 assert.deepEqual(calls.at(-1),{name:'daily_analysis',args:{}});
 assert.match(element('#content').innerHTML,/2026-10-31 的记录解析/);
 assert.equal(element('#metrics').hidden,true);assert.equal(element('#hero-tip').hidden,true);
 await click({analysisOffset:'-1'});assert.deepEqual(calls.at(-1).args,{day:'2026-10-30'});
 await click({analysisToday:'true'});assert.deepEqual(calls.at(-1).args,{day:'2026-11-11'});
 await click({analysisLatest:'true'});assert.deepEqual(calls.at(-1).args,{});
 const count=calls.length;
 for(const fn of listeners.get('change')??[])await fn({target:{id:'analysis-date',value:'2099-01-01'}});
 assert.equal(calls.length,count);
 defer=true;
 const old=click({analysisDate:'2026-10-30'}),fresh=click({analysisDate:'2026-10-31'});
 pending[1].resolve({ok:true,json:async()=>reportFor('2026-10-31')});await fresh;
 pending[0].resolve({ok:true,json:async()=>reportFor('2026-10-30')});await old;
 assert.match(element('#content').innerHTML,/2026-10-31 的记录解析/);
 assert.equal(vm.runInContext('state.analysis.day',ctx),'2026-10-31');
});
