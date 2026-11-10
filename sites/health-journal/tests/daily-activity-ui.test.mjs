import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import worker from '../worker/index.js';

const html=await(await worker.fetch(new Request('https://journal.test/'),{})).text();
const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];

test('daily activity has its own navigation and requests recent 7/30/90-day records independently of the selected month',async()=>{
 assert.ok(html.includes('data-view="activity"'),'每日活动入口应可见');
 const elements=new Map(),listeners=new Map(),calls=[];
 const navigation=['month','activity','connect'].map(view=>({dataset:{view},setAttribute(name,value){this[name]=value;}}));
 const element=selector=>{if(!elements.has(selector))elements.set(selector,{elements:{kind:{}}});return elements.get(selector);};
 const ctx=vm.createContext({TextDecoder,TextEncoder,setTimeout,document:{querySelector:element,querySelectorAll:()=>navigation,addEventListener:(name,handler)=>{if(!listeners.has(name))listeners.set(name,[]);listeners.get(name).push(handler);}},fetch:async(_url,options)=>{
  const call=JSON.parse(options.body);calls.push(call);
  return{ok:true,json:async()=>({today:'2026-11-10',from:call.args.days===90?'2026-08-13':call.args.days===7?'2026-11-04':'2026-10-12',to:'2026-11-10',entries:[{id:'apple:activity:2026-11-09',day:'2026-11-09',kind:'activity',steps:1234,source:'device'},{id:'meal-id',day:'2026-11-09',kind:'meal',label:'不应出现在活动列表的餐食',kcal:500,source:'manual'}],plan:[],goal:null,latestWeight:null})};
 }});
 vm.runInContext(script,ctx);await vm.runInContext('refresh()',ctx);
 vm.runInContext("selectedMonth='2025-01'",ctx);
 const click=async dataset=>{for(const handler of listeners.get('click')??[])await handler({target:{dataset}});};
 await click({view:'activity'});
 assert.equal(navigation.find(item=>item.dataset.view==='activity')['aria-pressed'],'true');
 assert.deepEqual(calls.at(-1).args,{days:30});
 assert.match(element('#content').innerHTML,/每日活动/);
 assert.match(element('#content').innerHTML,/1,234|1234/);
 assert.doesNotMatch(element('#content').innerHTML,/不应出现在活动列表的餐食/);
 assert.equal(element('#metrics').hidden,true);
 assert.equal(element('#month-controls').hidden,true);
 await click({activityDays:'90'});assert.deepEqual(calls.at(-1).args,{days:90});
 await click({activityDays:'7'});assert.deepEqual(calls.at(-1).args,{days:7});
 const before=calls.length;await click({activityDays:'9999'});assert.equal(calls.length,before);
});
