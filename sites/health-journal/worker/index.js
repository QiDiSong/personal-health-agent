import { archiveBrowserJS } from './archive-browser.js';
import { quantityRows } from './health-quantities.js';
import { renderMonthDashboard } from './monthly-dashboard.js';
import { appleSleepSource, appleSleepRows, appleSleepDayRows, appleLegacySleepRows } from './apple-sleep.js';
import { handlePhoneSync, downloadPhoneConfig, phoneSyncAction } from './native-sync.js';
import { phonePanel, phoneClient, guidePage } from './native-ui.js';
import { nativeGuide } from './native-guide.js';
const kinds = {meal:'饮食', workout:'运动', sleep:'睡眠', weight:'体重'};
const iso = date => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const dayOK = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
const num = (v,min,max) => typeof v==='number' && Number.isFinite(v) && v>=min && v<=max;
const privateProfile = env => {
 const baseline=Number(env.PROFILE_BASELINE_KG),height=Number(env.PROFILE_HEIGHT_CM);
 return {baselineKg:num(baseline,20,500)?baseline:null,heightCm:num(height,50,250)?height:null};
};
const entrySchema = {type:'object',required:['kind','day','label'],properties:{
kind:{enum:Object.keys(kinds)},day:{type:'string',description:'YYYY-MM-DD，按北京时间。睡眠按起床日。'},label:{type:'string'},id:{type:'string',description:'修改时传原记录 ID'},source:{enum:['manual','estimate'],description:'任何估算值都标为 estimate'},kcal:{type:'number'},protein:{type:'number'},fat:{type:'number'},carbs:{type:'number'},minutes:{type:'number'},kg:{type:'number'},bed:{type:'string'},wake:{type:'string'}}};
const toolList=[
{name:'read_health',description:'读取饮食营养、睡眠、训练、活动、体重及身体指标。默认最近30天；from/to 可读取指定历史月份。Apple 圆环分钟不作为训练时长。',inputSchema:{type:'object',properties:{days:{type:'integer',minimum:1,maximum:90},from:{type:'string',description:'可选起始日 YYYY-MM-DD，须与 to 同传'},to:{type:'string',description:'可选结束日 YYYY-MM-DD；单次最多366天'}}}},
{name:'log_health',description:'新增或修改饮食、运动、睡眠或体重。根据食物和份量估算热量及三大营养素，估算须标记 estimate；未知字段留空。',inputSchema:entrySchema},
{name:'delete_health_entry',description:'按记录 ID 删除一条记录',inputSchema:{type:'object',required:['id'],properties:{id:{type:'string'}}}},
{name:'set_weight_goal',description:'保存用户明确提供的目标体重（kg）',inputSchema:{type:'object',required:['kg'],properties:{kg:{type:'number'}}}},
{name:'today_plan',description:'获取今天的记录和下一步行动建议。',inputSchema:{type:'object',properties:{}}}
];
function clean(a, device=false){
 if((!Object.hasOwn(kinds,a.kind)&&!(device&&['activity','nutrition','vitals'].includes(a.kind)))||!dayOK(a.day)||a.day>iso(new Date())||typeof a.label!=='string'||!a.label.trim()||a.label.length>150)throw Error('请检查日期、类型与名称。');
 const r={id:a.id||crypto.randomUUID(),day:a.day,kind:a.kind,label:a.label.trim(),source:device?'device':a.source==='estimate'?'estimate':'manual'};
 if(typeof r.id!=='string'||!/^[-a-zA-Z0-9_:]{1,160}$/.test(r.id))throw Error('无效记录 ID');
 if(['activity','nutrition','vitals'].includes(r.kind)&&r.id!=='apple:'+r.kind+':'+r.day)throw Error('无效的每日健康记录标识');
 const fields={activity:{steps:[0,1e6],active_energy_kcal:[0,1e5],apple_exercise_minutes:[0,1440],walking_distance_km:[0,1000],resting_energy_kcal:[0,1e5]},nutrition:{kcal:[0,20000],protein:[0,2000],fat:[0,2000],carbs:[0,2000],fiber:[0,500],sugar:[0,2000],sodium_mg:[0,50000],water_ml:[0,20000]},vitals:{heart_rate_bpm:[20,300],resting_heart_rate_bpm:[20,300],hrv_ms:[0,1000],spo2_percent:[0,100],respiratory_rate:[1,100],body_fat_percent:[0,100],bmi:[1,150]},meal:{kcal:[0,20000],protein:[0,2000],fat:[0,2000],carbs:[0,2000]},workout:{minutes:[1,1440],kcal:[0,10000],distance_km:[0,1000]},sleep:{minutes:[1,1440]},weight:{kg:[20,500]}}[r.kind];
 for(const [k,[lo,hi]] of Object.entries(fields)){if(a[k]==null)continue;if(!num(a[k],lo,hi))throw Error('数值超出范围 '+k);r[k]=a[k];}
 if(['activity','nutrition','vitals'].includes(r.kind)&&!Object.keys(fields).some(k=>r[k]!=null))throw Error('每日汇总至少需要一个已知数值');
 const required={workout:'minutes',sleep:'minutes',weight:'kg'}[r.kind];if(required&&r[required]==null)throw Error('请填写 '+required);
 if(r.kind==='sleep')for(const k of ['bed','wake'])if(a[k]){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(a[k]))throw Error('时间格式为 HH:MM');r[k]=a[k];}
 return r;
}
const upsert=(db,owner,r)=>db.prepare('INSERT INTO entries(owner,id,day,kind,data) VALUES(?,?,?,?,?) ON CONFLICT(owner,id) DO UPDATE SET day=excluded.day,kind=excluded.kind,data=excluded.data').bind(owner,r.id,r.day,r.kind,JSON.stringify(r));
async function action(db,owner,name,a,profile={}){
 if(!owner)throw Error('请先登录站点。');
 if(['phone_sync_list','phone_sync_revoke'].includes(name))return phoneSyncAction(db,owner,name,a);
 if(name==='log_health'){const r=clean(a);await upsert(db,owner,r).run();return r;}
 if(name==='import_health'){if(!Array.isArray(a.entries)||!a.entries.length||a.entries.length>5000)throw Error('请选择包含 1–5000 条记录的文件');const rows=a.entries.map(r=>clean(r,true));for(let i=0;i<rows.length;i+=75)await db.batch(rows.slice(i,i+75).map(r=>upsert(db,owner,r)));return {count:rows.length};}
 if(name==='reconcile_apple_sleep'){
  if(!Array.isArray(a.entries)||!a.entries.length||a.entries.length>5000)throw Error('睡眠核对记录应为 1–5000 条');
  const ids=new Set(),rows=a.entries.map(a=>{
   const r=clean(a,true);
   if(r.kind!=='sleep'||r.id!=='apple:sleep:'+r.day||r.label!=='Apple 健康睡眠'||!r.bed||!r.wake||(a.source!=null&&a.source!=='device')||ids.has(r.id))throw Error('无效的旧版 Apple 睡眠核对记录');
   ids.add(r.id);return r;
  });
  // Only an exact legacy result for this owner may be removed after reimport.
  for(let i=0;i<rows.length;i+=75)await db.batch(rows.slice(i,i+75).map(r=>db.prepare("DELETE FROM entries WHERE owner=? AND id=? AND day=? AND kind='sleep' AND json_extract(data,'$.id')=? AND json_extract(data,'$.day')=? AND json_extract(data,'$.kind')='sleep' AND json_extract(data,'$.source')='device' AND json_extract(data,'$.label')=? AND json_extract(data,'$.minutes')=? AND json_extract(data,'$.bed')=? AND json_extract(data,'$.wake')=?").bind(owner,r.id,r.day,r.id,r.day,r.label,r.minutes,r.bed,r.wake)));
  return {checked:rows.length};
 }
 if(name==='delete_health_entry'){await db.prepare('DELETE FROM entries WHERE owner=? AND id=?').bind(owner,a.id).run();return {deleted:true};}
 if(name==='set_weight_goal'){if(!num(a.kg,20,500))throw Error('请输入 20–500 kg 范围内的目标');await db.prepare('INSERT INTO goals VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET weight=excluded.weight').bind(owner,a.kg).run();return {goal:a.kg};}
 if(!['today_plan','read_health'].includes(name))throw Error('未知操作');
 const today=iso(new Date()),days=Number.isInteger(a.days)?Math.min(90,Math.max(1,a.days)):30;
 let from=iso(new Date(Date.now()-(days-1)*864e5)),to=today;
 if(a.from!=null||a.to!=null){if(!dayOK(a.from)||!dayOK(a.to)||a.from>a.to||a.to>today||(Date.parse(a.to)-Date.parse(a.from))/864e5>365)throw Error('请选择有效的日期范围（最多366天，不晚于今天）');from=a.from;to=a.to;}
 const [rows,g,w]=await Promise.all([db.prepare('SELECT data FROM entries WHERE owner=? AND day BETWEEN ? AND ? ORDER BY day DESC,rowid DESC').bind(owner,from,to).all(),db.prepare('SELECT weight FROM goals WHERE owner=?').bind(owner).first(),db.prepare("SELECT data FROM entries WHERE owner=? AND kind='weight' ORDER BY day DESC,rowid DESC LIMIT 1").bind(owner).first()]);
 const entries=rows.results.map(x=>JSON.parse(x.data)), current=entries.filter(x=>x.day===today);
 const plan=[current.some(x=>x.kind==='meal')?'下一餐可先安排一份蛋白质食物、一份蔬菜和适量主食。':'先记录今天的一餐，补上食物和大致份量。',current.some(x=>x.kind==='workout')?'记录训练后的感受和恢复情况。':'有球局就记下项目和时长，休息日可按自己的安排活动。',current.some(x=>x.kind==='sleep')?'今晚选一个可执行的结束工作或放下手机的时间。':'补记昨晚的入睡、起床时间或实际睡眠时长。'];
 return {today,from,to,entries:name==='today_plan'?current:entries,goal:g?.weight??null,latestWeight:w?JSON.parse(w.data):null,baselineKg:profile.baselineKg??null,baselineSource:profile.baselineKg!=null?'自述约值':null,heightCm:profile.heightCm??null,plan};
}
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export default {async fetch(req,env){
 const path=new URL(req.url).pathname,owner=req.headers.get('oai-authenticated-user-id');
 if(req.method==='POST'&&path==='/api/phone-sync')return handlePhoneSync(req,env);
 if(req.method==='POST'&&path==='/phone-sync/config')return downloadPhoneConfig(req,env,owner);
 if(req.method==='GET'&&path==='/phone-sync/help')return new Response(guidePage(nativeGuide),{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(req.method==='GET'&&path==='/')return new Response(page,{headers:{'content-type':'text/html;charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});
 if(req.method!=='POST'||!['/api','/mcp'].includes(path))return json({error:'未找到'},404);
 try{
 const data=await req.json();
 if(path==='/mcp'){
  const reply=result=>json({jsonrpc:'2.0',id:data.id,result});
  if(data.method==='server/discover')return reply({supportedVersions:['2026-07-28'],capabilities:{tools:{}}});
  if(data.method==='initialize')return reply({protocolVersion:data.params?.protocolVersion??'2026-07-28',capabilities:{tools:{}},serverInfo:{name:'adi-health',version:'1.2.0'}});
  if(data.method==='notifications/initialized')return new Response(null,{status:202});
  if(data.method==='tools/list')return reply({tools:toolList});
  if(data.method==='tools/call'){try{const name=data.params?.name;if(!toolList.some(t=>t.name===name))throw Error('未知工具');return reply({content:[{type:'text',text:JSON.stringify(await action(env.DB,owner,name,data.params.arguments??{},privateProfile(env)))}]});}catch(e){return reply({isError:true,content:[{type:'text',text:e.message}]});}}
  return json({jsonrpc:'2.0',id:data.id,error:{code:-32601,message:'Method not found'}});
 }
 if(!owner)return json({error:'请通过 ChatGPT 登录站点。'},401);
 if(req.headers.get('origin')!==new URL(req.url).origin && req.headers.get('sec-fetch-site')!=='same-origin')return json({error:'请从站点发起操作。'},403);
 return json(await action(env.DB,owner,data.name,data.args??{},privateProfile(env)));
 }catch(e){return json({error:e.message},400);}
}};
const page=String.raw`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>阿迪的健康日志</title>
<style>
[hidden]{display:none!important}
:root{font:15px system-ui,sans-serif;color:#172e29;background:#f2f5ef;--ink:#173f35;--muted:#50645b;--line:#dce5dc}*{box-sizing:border-box}body{margin:0}header{background:#133d32;color:white}header>div,main{max-width:1130px;margin:auto;padding:20px 26px}header>div,nav,.row,.section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}.brand{font-size:20px;font-weight:750}.mark{color:#bcf178;margin-right:9px}.private{font-size:13px;color:#deebd9}main{padding-top:26px;padding-bottom:60px}.hero{background:#19493d;color:#fff;border-radius:24px;padding:30px;display:grid;grid-template-columns:1.5fr 1fr;gap:22px}.hero p{color:#e0ede5;margin-bottom:0}.tag{font-size:12px;letter-spacing:.08em;color:#c6ef9b;font-weight:700}h1{font-size:clamp(28px,5vw,43px);margin:9px 0}h2{margin:0;font-size:20px}h3{margin:0 0 12px}.tip{background:#24584a;border-radius:16px;padding:18px}.tip p{margin:8px 0}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.card,article{background:white;border:1px solid var(--line);border-radius:16px;padding:17px}.metric strong{display:block;font-size:26px;color:var(--ink);margin:6px 0}.muted,small{color:var(--muted)}nav{justify-content:flex-start;margin:21px 0}button,input,select{font:inherit}button{border:1px solid var(--line);background:#fff;border-radius:9px;color:var(--ink);padding:8px 13px;cursor:pointer}button[aria-pressed=true],.primary{background:#1c5947;color:white;border-color:#1c5947}button:hover{filter:brightness(.94)}section{margin:16px 0}.grid{display:grid;grid-template-columns:1.4fr 1fr;gap:14px}.section-title{margin-bottom:13px}.empty{padding:20px;background:#f5f8f2;color:var(--muted);border-radius:10px}.entry{padding:11px 0;border-bottom:1px solid var(--line)}.entry:last-child{border:0}.pill{background:#e7f0df;border-radius:30px;padding:3px 8px;font-size:12px}.estimate{background:#fff1d4}.chart{display:block;width:100%;height:145px;background:#f6f9f3;border-radius:10px}.entry small{display:block;margin-top:5px}label{display:grid;gap:5px;font-size:14px}input,select{border:1px solid #bdcdc0;border-radius:8px;padding:8px;width:100%;background:white;color:#162c25}.fields{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}dialog{width:min(520px,94vw);border:1px solid var(--line);border-radius:18px;padding:20px;color:inherit}dialog::backdrop{background:#0b2722aa}progress{width:100%;accent-color:#258464}#status{min-height:1.2em;color:#395e4d}.alert{padding:9px 12px;background:#fff5e1;border-radius:10px;margin:8px 0}@media(max-width:650px){header>div,main{padding-left:14px;padding-right:14px}.hero,.grid{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}.hero{padding:20px}}
</style><header><div><div class="brand"><span class="mark">◈</span>健康日志</div><span class="private">私人空间 · 北京时间</span></div></header>
<main><div class="hero"><div><div class="tag" id="date">个人健康工作台</div><h1>阿迪的月度健康记录</h1><p id="profile">饮食、运动、睡眠与体重，保存为自己的长期记录。</p></div><div class="tip"><div class="tag">TODAY PLAN</div><h3>今天怎么安排</h3><div id="plan">正在读取今日记录…</div></div></div>
<div id="metrics" class="metrics"></div><nav aria-label="视图"><button data-view="today">今日总览</button><button data-view="week">周报 · 7天</button><button data-view="month" aria-pressed="true">月度健康</button><button data-view="connect">聊天与数据</button><button class="primary" id="add">＋ 补充记录</button></nav>
<section id="month-controls" class="card"><div class="row"><label>查看范围<select id="month-mode"><option value="recent">最近 30 天</option><option value="calendar">选择月份</option></select></label><label>月份<input id="month-picker" type="month"></label><button data-view="connect" class="primary">导入每月健康文件</button></div><p class="muted">每月从 iPhone 导出一次，在这里导入 ZIP 或 XML。历史月份会持续保留；饮食可从健康记录导入，也可通过网页或 ChatGPT 补充。</p></section><div id="status" role="status"></div><div id="content"></div></main>
<dialog id="editor"><form id="form"><div class="section-title"><h2>健康记录</h2><button type="button" id="close">关闭</button></div><div class="fields"><label>类型<select name="kind"><option value="meal">饮食</option><option value="workout">运动</option><option value="sleep">睡眠</option><option value="weight">体重</option></select></label><label>日期<input name="day" type="date" required></label><label>名称或份量<input name="label" required maxlength="150" placeholder="如 午餐：米饭 150 g"></label><label>数值来源<select name="source"><option value="estimate">估算</option><option value="manual">手动记录</option></select></label></div><div class="fields" id="extra"></div><div class="row"><small>估算请注明，未知项可留空。</small><button class="primary">保存</button></div><p id="error" role="alert"></p></form></dialog>
<script>
${archiveBrowserJS}
${quantityRows.toString()}
${renderMonthDashboard.toString()}
const $=s=>document.querySelector(s), esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const phonePanel=${JSON.stringify(phonePanel)};
const labels={meal:'饮食',workout:'运动',sleep:'睡眠',weight:'体重',activity:'每日活动',nutrition:'健康营养汇总',vitals:'身体指标'}, src={estimate:'估算',manual:'手动',device:'Apple 健康导入'};
const keys={meal:{kcal:'热量 kcal',protein:'蛋白质 g',fat:'脂肪 g',carbs:'碳水 g'},workout:{minutes:'时长 min',kcal:'消耗 kcal',distance_km:'距离 km'},sleep:{minutes:'睡眠 min',bed:'入睡时间',wake:'起床时间'},weight:{kg:'体重 kg'},activity:{steps:'步数',active_energy_kcal:'活动能量 kcal',apple_exercise_minutes:'Apple 锻炼时间 min',walking_distance_km:'步行跑步距离 km',resting_energy_kcal:'静息能量 kcal'},nutrition:{kcal:'摄入 kcal',protein:'蛋白质 g',fat:'脂肪 g',carbs:'碳水 g',fiber:'膳食纤维 g',sugar:'糖 g',sodium_mg:'钠 mg',water_ml:'饮水 mL'},vitals:{heart_rate_bpm:'平均心率 bpm',resting_heart_rate_bpm:'静息心率 bpm',hrv_ms:'心率变异性 ms',spo2_percent:'血氧 %',respiratory_rate:'呼吸 次/分',body_fat_percent:'体脂 %',bmi:'BMI'}};
let state,view='month',editing,selectedMonth='',readRevision=0;
async function api(name,args={}){const r=await fetch('/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,args})});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
const message=x=>$('#status').textContent=x;
const round=x=>Math.round(x*10)/10;
const sum=(rows,k)=>rows.some(r=>r[k]!=null)?round(rows.reduce((s,r)=>s+(r[k]??0),0)):null;
const display=(x,unit='')=>x==null?'—':x+' '+unit;
const empty=text=>'<p class="empty">'+text+'</p>';
const fmt=(r,k)=>esc(keys[r.kind][k])+' '+esc(r[k]);
function entry(r){return '<div class="entry row"><div><b>'+esc(r.label)+'</b> <span class="pill '+(r.source==='estimate'?'estimate':'')+'">'+src[r.source]+'</span><small>'+r.day+' · '+Object.keys(keys[r.kind]).filter(k=>r[k]!=null).map(k=>fmt(r,k)).join(' · ')+'</small></div><div>'+(r.source==='device'?'':'<button data-edit="'+r.id+'">编辑</button> ')+'<button data-del="'+r.id+'">删除</button></div></div>';}
function grouped(rows){return Object.keys(labels).map(k=>'<article><h3>'+labels[k]+'</h3>'+(rows.filter(r=>r.kind===k).map(entry).join('')||empty('暂无记录'))+'</article>').join('');}
function graph(rows,key,days){if(!rows.length)return empty('记录后显示趋势');const vals=rows.map(r=>r[key]);const lo=Math.min(...vals),hi=Math.max(...vals);const points=rows.map(r=>[305-(Date.parse(state.today)-Date.parse(r.day))/864e5*290/(days-1),115-(r[key]-lo)/(hi-lo||1)*90]);
return '<svg class="chart" viewBox="0 0 320 140" role="img" aria-label="按日期绘制趋势"><path d="M15 115H305 M15 70H305 M15 25H305" stroke="#dbe7db"/><polyline points="'+points.map(p=>p.join(',')).join(' ')+'" fill="none" stroke="#237b62" stroke-width="2"/>'+points.map((p,i)=>'<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="#237b62"><title>'+rows[i].day+' '+rows[i][key]+'</title></circle>').join('')+'</svg><div class="row"><small>最近 '+days+' 天</small><small>范围 '+round(lo)+'–'+round(hi)+(key==='kg'?' kg':' 分钟')+'</small></div>';}
function render(){
 const today=state.entries.filter(r=>r.day===state.today),meals=today.filter(r=>r.kind==='meal'),sleep=today.filter(r=>r.kind==='sleep'),work=today.filter(r=>r.kind==='workout'),w=state.latestWeight;
 $('#date').textContent=state.today+' · 私人健康日志';$('#month-controls').hidden=view!=='month';$('#metrics').hidden=view==='month';$('#month-picker').max=state.today.slice(0,7);$('#month-picker').value=selectedMonth||state.today.slice(0,7);$('#month-picker').disabled=!selectedMonth;$('#month-mode').value=selectedMonth?'calendar':'recent';$('#plan').innerHTML=state.plan.map(x=>'<p>'+esc(x)+'</p>').join('');
 $('#profile').textContent=['减脂目标',...(state.heightCm!=null?['身高 '+state.heightCm+' cm']:[]),...(state.baselineKg!=null?['起点约 '+state.baselineKg+' kg（自述）']:[])].join(' · ');
 const approx=meals.some(r=>r.source==='estimate')?'约 ':'';
 $('#metrics').innerHTML=[['饮食摄入',(sum(meals,'kcal')==null?'':approx)+display(sum(meals,'kcal'),'kcal'),meals.length+' 条饮食记录'],['运动时长',display(sum(work,'minutes'),'min'),work.some(r=>r.source==='estimate')?'含估算':'当日已记录'],['睡眠',display(sleep.length?sleep[0].minutes:null,'min'),sleep[0]?.source==='estimate'?'估算':'按起床日'],['最新体重',display(w?.kg,'kg'),w?(w.day+' · '+src[w.source]):'等待首次记录']].map(x=>'<div class="card metric"><span class="muted">'+x[0]+'</span><strong>'+x[1]+'</strong><small>'+x[2]+'</small></div>').join('');
 const goal=state.goal,baseline=state.baselineKg,pct=goal&&baseline!=null&&goal<baseline&&w?Math.max(0,Math.min(100,(baseline-w.kg)/(baseline-goal)*100)):null;
 const goalBox='<article><h3>目标进度</h3><p class="muted">'+(goal?'目标 '+goal+' kg':'目标体重待设置')+'</p>'+(pct!=null?'<progress max="100" value="'+pct+'"></progress><p>约 '+round(pct)+'% · 以 '+esc(baseline)+' kg 自述约值为起点</p>':'')+'<form id="goal" class="row"><label>目标体重（kg）<input type="number" min="20" max="500" step="0.1" required value="'+(goal??'')+'"></label><button>保存目标</button></form></article>';
 if(view==='month'){$('#content').innerHTML=renderMonthDashboard(state,{from:state.from||new Date(Date.parse(state.today)-29*864e5).toISOString().slice(0,10),to:state.to||state.today,title:selectedMonth?selectedMonth+' 月度健康':'最近 30 天健康记录'});return;}
 if(view==='connect'){$('#content').innerHTML='<div class="grid"><article><h3>Apple 健康</h3><p class="pill">每月一次 · 导入健康数据</p><p>不想搭快捷指令，每月导入一次 Apple 健康的 ZIP 或 export.xml，补齐运动、睡眠、体重、步数和可用的营养、身体指标。苹果导出包含全部历史，月报显示最近 30 天。重复导入会更新对应记录，并仅清理与本文件旧版结果完全匹配的过期睡眠日记录。</p><p>健康 App → 头像 → 导出所有健康数据 → 保存到「文件」；在这里直接选择导出的 ZIP，无需解压。也支持解压后的 export.xml。</p><label>选择每月导出的 ZIP 或 XML 并导入<input type="file" id="xml" accept=".zip,.xml,application/zip,text/xml,application/xml"></label><p><small>这是手动导入；新增数据需再次导出导入。ZIP/XML 在浏览器解析，仅上传结构化记录。支持常见健康指标；没有记录在健康中的饮食需另行补记。步数、能量、营养按单一来源汇总，避免手机与手表重复相加，可能与健康 App 的来源优先级统计不同。文件最多 200 MiB，解压 XML 最多 150 MiB。</small></p></article><article><h3>用 ChatGPT 记录</h3><p>连接本站的私有插件后，可在聊天里写入和查询同一份日志。</p><ul><li>记录今天午餐，米饭约 150 克和一份番茄炒蛋，估算营养。</li><li>记录今天打羽毛球 90 分钟。</li><li>看看今天的计划和本周体重趋势。</li></ul></article></div><details class="card"><summary>可选：快捷指令上传（需首次搭建）</summary>'+phonePanel+'</details>';loadPhoneDevices();return;}
 if(view==='today'){
 const macros=[['蛋白质','protein'],['脂肪','fat'],['碳水','carbs']].map(([l,k])=>l+' '+(sum(meals,k)==null?'':approx)+display(sum(meals,k),'g')).join('　');
 const hints=[...(!sleep.length?['今天还没有睡眠记录。']:[]),...(meals.some(r=>r.kcal==null)?['部分饮食记录缺少热量，汇总可能偏低。']:[]),...(!w?['还没有实际体重记录，暂时无法计算目标进度。']:[])];
 $('#content').innerHTML='<div class="grid"><article><h3>今日营养</h3><p>'+macros+'</p><small>汇总仅纳入已填写数值。含估算时显示「约」。</small></article>'+goalBox+'</div><section><article><h3>记录提醒</h3>'+(hints.length?hints.map(x=>'<div class="alert">'+x+'</div>').join(''):'<p>当前记录完整度无提示。</p>')+'</article></section><section class="grid">'+grouped(today)+'</section>';return;}
 const days=view==='week'?7:30,rows=state.entries.filter(r=>Date.parse(state.today)-Date.parse(r.day)<days*864e5),weights=rows.filter(r=>r.kind==='weight').reverse(),sleeps=[...new Map(rows.filter(r=>r.kind==='sleep').reverse().map(r=>[r.day,r])).values()],nutrition=rows.filter(r=>r.kind==='meal'),minutes=sum(rows.filter(r=>r.kind==='workout'),'minutes');
 $('#content').innerHTML='<div class="section-title"><h2>'+ (days===7?'周报':'月报') +'</h2><small>过去 '+days+' 天 · 含今天</small></div><div class="grid"><article><h3>体重趋势</h3>'+graph(weights,'kg',days)+'</article><article><h3>睡眠趋势</h3>'+graph(sleeps,'minutes',days)+'<p>有记录日平均 '+display(sleeps.length?round(sum(sleeps,'minutes')/sleeps.length):null,'min')+'</p><small>'+sleeps.map(r=>r.day.slice(5)+' '+(r.bed||'—')+' → '+(r.wake||'—')).join('　')+'</small></article><article><h3>每日活动</h3><p>已上传步数 '+display(sum(rows.filter(r=>r.kind==='activity'),'steps'))+' · 活动能量 '+display(sum(rows.filter(r=>r.kind==='activity'),'active_energy_kcal'),'kcal')+'</p><p>Apple 锻炼时间 '+display(sum(rows.filter(r=>r.kind==='activity'),'apple_exercise_minutes'),'min')+'</p><small>仅汇总已上传数据；圆环时间单独展示。</small></article><article><h3>饮食与运动</h3><p>已记录摄入 '+(nutrition.some(r=>r.source==='estimate')?'约 ':'')+display(sum(nutrition,'kcal'),'kcal')+' · 运动 '+display(minutes,'min')+'</p><small>覆盖 '+new Set(rows.map(r=>r.day)).size+' / '+days+' 天，缺失日未计为 0。</small></article>'+goalBox+'</div><section class="grid">'+grouped(rows)+'</section>';
}
async function refresh(){const revision=++readRevision;try{let args={};if(view==='month'&&selectedMonth){const y=Number(selectedMonth.slice(0,4)),m=Number(selectedMonth.slice(5));const last=new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);args={from:selectedMonth+'-01',to:last<state.today?last:state.today};}const next=await api('read_health',args);if(revision!==readRevision)return;state=next;render();}catch(e){if(revision!==readRevision)return;message(e.message);$('#plan').textContent='暂时无法读取记录。';}}
const form=$('#form'),fields=form.elements,dlg=$('#editor');
function inputs(r={}){$('#extra').innerHTML=Object.entries(keys[fields.kind.value]).map(([k,l])=>'<label>'+l+'<input name="'+k+'" type="'+(['bed','wake'].includes(k)?'time':'number" min="0" step="0.1')+'" value="'+esc(r[k])+'" '+(['minutes','kg'].includes(k)?'required':'')+'></label>').join('');}
function edit(r){if(!state)return;editing=r?.id??crypto.randomUUID();form.reset();fields.kind.value=r?.kind??'meal';fields.day.value=r?.day??state.today;fields.day.max=state.today;fields.label.value=r?.label??'';fields.source.value=r?.source??'estimate';inputs(r);$('#error').textContent='';dlg.showModal();}
$('#add').onclick=()=>edit();$('#close').onclick=()=>dlg.close();fields.kind.onchange=()=>inputs();
form.onsubmit=async e=>{e.preventDefault();const submit=form.querySelector('button.primary');submit.disabled=true;try{const r={id:editing,...Object.fromEntries(new FormData(form))};for(const k of Object.keys(keys[r.kind])){if(r[k]==='')delete r[k];else if(!['bed','wake'].includes(k))r[k]=Number(r[k]);}await api('log_health',r);dlg.close();await refresh();message('已保存记录');}catch(e){$('#error').textContent=e.message;}finally{submit.disabled=false;}};
document.addEventListener('click',async e=>{const d=e.target.dataset;if(d.view&&state){view=d.view;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b===e.target)));message('');await refresh();}if(d.edit)edit(state.entries.find(r=>r.id===d.edit));if(d.del&&confirm('删除这条记录？'))try{await api('delete_health_entry',{id:d.del});await refresh();message('已删除');}catch(e){message(e.message);}});
document.addEventListener('submit',async e=>{if(e.target.id!=='goal')return;e.preventDefault();try{await api('set_weight_goal',{kg:Number(e.target.querySelector('input').value)});await refresh();message('已更新目标');}catch(e){message(e.message);}});
const bjDate=t=>new Date(t+8*3600000).toISOString(), parse=t=>Date.parse(t.replace(' ','T').replace(/ ([+-]\d\d)(\d\d)$/,'$1:$2'));
${[appleSleepSource,appleSleepRows,appleSleepDayRows,appleLegacySleepRows].map(fn=>fn.toString()).join('\n')}
document.addEventListener('change',async e=>{
 if(e.target.id==='month-mode'){selectedMonth=e.target.value==='calendar'?state.today.slice(0,7):'';await refresh();return;}
 if(e.target.id==='month-picker'){if(/^\d{4}-\d{2}$/.test(e.target.value)&&e.target.value<=state.today.slice(0,7)){selectedMonth=e.target.value;await refresh();}return;}
 if(e.target.id!=='xml'||!e.target.files.length)return;
 e.target.disabled=true;message('正在解析 Apple 健康导出…');
 try{
 const xml=new DOMParser().parseFromString(await HealthArchive.readHealthFile(e.target.files[0]),'application/xml');if(xml.querySelector('parsererror')||xml.documentElement.nodeName!=='HealthData')throw Error('请选择 Apple 健康导出的 ZIP 或 export.xml。');
 const rows=[],sleepRecords=[],quantityRecords=[];
 for(const n of xml.querySelectorAll('Record, Workout')){
  const attr=k=>n.getAttribute(k)||'',type=attr('type'),kind=n.nodeName==='Workout'?'workout':type==='HKQuantityTypeIdentifierBodyMass'?'weight':type==='HKCategoryTypeIdentifierSleepAnalysis'?'sleep':'';
  if(!kind){if(/^HKQuantityTypeIdentifier(?:StepCount|ActiveEnergyBurned|BasalEnergyBurned|AppleExerciseTime|DistanceWalkingRunning|Dietary(?:EnergyConsumed|Protein|FatTotal|Carbohydrates|Fiber|Sugar|Sodium|Water)|HeartRate|RestingHeartRate|HeartRateVariabilitySDNN|OxygenSaturation|RespiratoryRate|BodyFatPercentage|BodyMassIndex)$/.test(type))quantityRecords.push(Object.fromEntries(['type','value','unit','startDate','endDate','sourceName','device'].map(k=>[k,attr(k)])));continue;}
  const start=parse(attr('startDate')),end=parse(attr('endDate'));if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)continue;
  if(kind==='sleep'){sleepRecords.push({start,end,value:attr('value'),source:appleSleepSource(attr('sourceName'),attr('device'))});continue;}
  const day=bjDate(start).slice(0,10);if(day>state.today)continue;
  const id='apple:'+kind+':'+start+':'+end;
  if(kind==='weight'){const unit=attr('unit'),kg=Number(attr('value'))*({kg:1,lb:.45359237,g:.001}[unit]??NaN);if(kg>=20&&kg<=500)rows.push({id,kind,day,kg:round(kg),label:'Apple 健康体重'});}
  if(kind==='workout'){const duration=Number(attr('duration')),factor={min:1,s:1/60,hr:60,h:60}[attr('durationUnit')];const minutes=round(attr('duration')&&Number.isFinite(duration)&&duration>0&&factor?duration*factor:(end-start)/60000);if(minutes>=1&&minutes<=1440){const raw=attr('workoutActivityType').replace('HKWorkoutActivityType','');rows.push({id,kind,day,minutes,label:({Badminton:'羽毛球',Basketball:'篮球',Cycling:'骑行',Running:'跑步',Walking:'步行'})[raw]||raw||'Apple 健康运动'});}}
 }
 for(const r of quantityRows(quantityRecords,{today:state.today}))rows.push(r);
 const sleeps=appleSleepRows(sleepRecords,state.today),sleepIDs=new Set(sleeps.map(r=>r.id));
 for(const r of sleeps)rows.push(r);
 const obsolete=appleLegacySleepRows(sleepRecords,state.today).filter(r=>!sleepIDs.has(r.id));
 if(!rows.length)throw Error('文件中没有可导入的已支持健康指标。');
 for(let i=0;i<rows.length;i+=500){message('正在保存 '+Math.min(i+500,rows.length)+' / '+rows.length+' 条结构化记录…');await api('import_health',{entries:rows.slice(i,i+500)});}
 for(let i=0;i<obsolete.length;i+=500)await api('reconcile_apple_sleep',{entries:obsolete.slice(i,i+500)});
 await refresh();message('已处理 '+rows.length+' 条 Apple 健康记录，重复项按标识更新'+(obsolete.length?'，并已核对旧版睡眠拆分记录':'')+'。');
 }catch(err){message(err.message);}finally{e.target.disabled=false;}
});
${phoneClient}
refresh();
</script></html>`;
