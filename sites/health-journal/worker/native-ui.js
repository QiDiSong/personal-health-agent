export const phonePanel = `<section class="grid"><article><h3>快捷指令 · 最近 30 天</h3><p>首次在 iPhone 配置一次，以后点一下快捷指令，即可补同步最近 30 天的睡眠。步数可按说明另行加入；无需每天手动导出。</p><p>先在手机 Safari 登录本站，下载私人连接文件，再按说明搭建快捷指令。完成首次上传后，Windows 和 ChatGPT 可读取已保存的数据。</p><p><a href="/phone-sync/help" target="_blank" rel="noopener">查看一步一步的设置说明</a></p><form action="/phone-sync/config" method="post"><label>设备名称<input name="name" value="我的 iPhone" required maxlength="60"></label><p><button class="primary">下载私人连接文件</button></p></form><small>连接文件只保存到自己的「文件」，请勿分享。每下载一次会创建一条连接，最多 5 条；已有连接可撤销。快捷指令不能读取的体能训练记录，仍可通过 XML 导入。为防止漏读样本，补同步不会缩短已有睡眠；需要调短时，请先删除对应日期的睡眠记录再同步，或重新导入完整 XML。</small></article><article><h3>手机上传状态</h3><p><button type="button" id="phone-refresh">刷新上传状态</button></p><div id="phone-devices" aria-live="polite">正在读取连接状态…</div><small>刷新只读取云端已保存的数据。上传前请解锁手机、联网，并等手表数据同步到「健康」。收件时间不代表刚刚重新读取了手机。</small></article></section>`;

export const phoneClient = String.raw`
async function loadPhoneDevices(){
 try{
  const data=await api('phone_sync_list');if(view!=='connect')return;
  $('#phone-devices').innerHTML=data.devices.length?data.devices.map(d=>'<div class="entry"><b>'+esc(d.name)+'</b><p>'+ (d.revokedAt?'已撤销':d.lastReceivedAt?'已收到上传':'等待首次上传')+'</p>'+(d.lastReceivedAt?'<small>服务器收件：'+esc(d.lastReceivedAt)+'<br>手机采集：'+esc(d.lastCollectedAt)+'<br>本次有效记录：'+esc(d.lastCount??0)+' 条 · 最新数据日期：'+esc(d.latestDataDay??'无有效记录')+'</small>':'')+(!d.revokedAt?'<p><button data-phone-revoke="'+esc(d.id)+'">撤销连接</button></p>':'')+'</div>').join(''):empty('还没有手机连接。首次下载连接文件后，按说明配置快捷指令。');
 }catch(e){if(view==='connect')$('#phone-devices').textContent=e.message;}
}
document.addEventListener('click',async e=>{
 if(e.target.id==='phone-refresh')await loadPhoneDevices();
 const id=e.target.dataset?.phoneRevoke;if(!id||!confirm('撤销后，这台手机需要重新配置连接文件。继续撤销？'))return;
 e.target.disabled=true;try{await api('phone_sync_revoke',{id});await loadPhoneDevices();message('已撤销手机连接');}catch(err){message(err.message);}finally{e.target.disabled=false;}
});
`;

// The guide is repository-owned static text; escape it before adding formatting.
export function guidePage(text) {
 const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const inline=value=>escape(value).replace(/`([^`]+)`/g,'<code>$1</code>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
 const lines=String(text).split('\n'),output=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];
  if(!line.trim())continue;
  if(line.startsWith('```')){const block=[];while(++i<lines.length&&!lines[i].startsWith('```'))block.push(lines[i]);output.push('<pre>'+escape(block.join('\n'))+'</pre>');continue;}
  const heading=/^(#{1,3}) (.+)$/.exec(line);
  if(heading){const level=heading[1].length;output.push('<h'+level+'>'+inline(heading[2])+'</h'+level+'>');continue;}
  if(line.startsWith('|')){const rows=[];for(;i<lines.length&&lines[i].startsWith('|');i++){const cells=lines[i].split('|').slice(1,-1).map(x=>x.trim());if(cells.every(c=>/^:?-+:?$/.test(c)))continue;const tag=rows.length?'td':'th';rows.push('<tr>'+cells.map(c=>'<'+tag+'>'+inline(c)+'</'+tag+'>').join('')+'</tr>');}i--;output.push('<div class="table"><table>'+rows.join('')+'</table></div>');continue;}
  if(/^\d+\. /.test(line)){const items=[];for(;i<lines.length&&/^\d+\. /.test(lines[i]);i++)items.push('<li>'+inline(lines[i].replace(/^\d+\. /,''))+'</li>');i--;output.push('<ol>'+items.join('')+'</ol>');continue;}
  output.push('<p>'+inline(line)+'</p>');
 }
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配置最近 30 天健康同步</title><style>body{max-width:860px;margin:28px auto;padding:0 16px 50px;font:16px/1.75 system-ui;color:#173f35;background:#f2f5ef}main{background:white;padding:24px;border-radius:18px}h1{font-size:26px;line-height:1.4}h2{margin-top:36px;font-size:21px}li{margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f5ef;padding:15px}code{background:#edf2eb;border-radius:4px;padding:1px 3px}a{color:#135f49}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #dce5dc;text-align:left;padding:9px;min-width:115px}</style><p><a href="/">← 返回健康日志</a></p><main>'+output.join('\n')+'</main></html>';
}
