/**
 * The Telegram status widget's HTML (Bot API `sendWidget`). It only draws the
 * `chat_data` built by reachabilityWidget.ts; see the wire format there.
 *
 * Runs in Telegram's QuickJS sandbox: no network, generic fonts only, theme
 * colours from `--tg-theme-*`. Node names go in through `textContent`. Limits
 * (tested): 32768 bytes, and 4096 bytes after zlib level 9. Any edit here
 * changes the widget version, which sends a new message on the next refresh.
 */
/**
 * The "люди" cell: minutes since a person's last handshake on the node, as
 * [text, class]. Under an hour "<1ч", under a day whole hours ("5ч"), then
 * days with one decimal, rounded down ("1.1д"). Over 24 h yellow, over 48 h
 * red, "-" when no person has ever connected. Kept as source so the tests run
 * exactly what the widget runs.
 */
export const PEOPLE_CELL_JS =
  "function P(m){if(m==null)return['-','na'];if(m<60)return['<1\\u0447',''];" +
  "if(m<1440)return[Math.floor(m/60)+'\\u0447',''];" +
  "return[(Math.floor(m/144)/10).toFixed(1)+'\\u0434',m>2880?'no':m>1440?'wy':'']}";

export const REACHABILITY_WIDGET_HTML = `<style>
body{margin:0}
.w{padding:8px 12px;font:13px/1.3 system-ui,sans-serif;color:var(--tg-theme-text-color)}
h4{margin:0 0 6px;font-size:14px;font-weight:600}
table{border-collapse:collapse;width:100%;font-size:12px}
th{color:var(--tg-theme-hint-color);font-weight:500;padding:2px 4px;text-align:center}
td{text-align:center;padding:3px 4px;border-top:1px solid var(--tg-theme-section-separator-color);vertical-align:top}
th,td{width:1%;white-space:nowrap}
th:first-child,td:first-child{text-align:left;width:100%;max-width:0;padding-left:0}
.nm{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.d{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:var(--tg-theme-hint-color)}
.g{background:#2ea043}.r{background:#e5534b}
.ok{color:#2ea043}.no{color:#e5534b}.wy{color:#c69026}.na{color:var(--tg-theme-hint-color)}
.sn{display:block;color:#e5534b;font-size:10.5px;margin-left:12px}
.b{border-radius:8px;padding:5px 8px;margin-bottom:6px;font-size:12px}
.wa{background:rgba(227,179,65,.25)}
.st{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-hint-color)}
.dim{opacity:.45}
.f{color:var(--tg-theme-hint-color);font-size:11px;margin-top:6px}
</style>
<div class="w"><h4 id="h"></h4><div id="b"></div>
<table id="t">
<thead><tr><th>нода</th><th>ssh</th><th>vpn</th><th>инет</th><th>онл.</th><th>люди</th></tr></thead><tbody id="r"></tbody></table>
<div class="f" id="f"></div></div>
<script>
var W=window.TelegramWidget;
function $(i){return document.getElementById(i)}
function E(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function M(v,st){return E('td',st?'':v=='1'?'ok':v=='0'?'no':'na',v=='1'?'\\u2713':v=='0'?'\\u2715':'-')}
${PEOPLE_CELL_JS}
function R(){
var d=null;try{d=JSON.parse(W&&W.chatData)}catch(e){}
var h=$('h'),b=$('b'),r=$('r'),f=$('f'),t=$('t');
b.textContent='';r.textContent='';
if(!d||d.v!==4){h.textContent='Нет данных';t.style.display='none';f.textContent='';return}
t.style.display='';
var age=d.c?Math.floor(Date.now()/1e3)-d.c:0,st=d.s||!d.c||age>d.sl;
h.textContent='VPN из '+d.l+': '+(st?'нет данных':d.k+' из '+d.t);
if(st)b.appendChild(E('div','b st',d.c?'Последняя проверка '+d.ct+', '+Math.max(1,Math.floor(age/3600))+' ч назад. Данные ниже устарели':'Проверок ещё не было'));
else if(d.m)b.appendChild(E('div','b wa','Все ноды недоступны в одном прогоне - возможно, сломалась сама проверка'));
t.className=st?'dim':'';
d.n.forEach(function(n){
var l=n[1],hs=l[2],tr=E('tr'),c=E('td'),nm=E('span','nm');
nm.appendChild(E('span','d '+(st?'':hs=='1'?'g':hs=='0'?'r':'')));
nm.appendChild(document.createTextNode(n[0]));c.appendChild(nm);
if(n[4]&&!st)c.appendChild(E('span','sn','с '+n[4]));
tr.appendChild(c);
for(var i=1;i<4;i++)tr.appendChild(M(l[i],st));
tr.appendChild(E('td','',n[2]));
var q=P(n[3]===''?null:+n[3]+Math.floor(age/60));tr.appendChild(E('td',st?'':q[1],q[0]));
r.appendChild(tr)});
if(d.x){var x=E('tr'),c=E('td','na','\\u2026 ещё '+d.x);c.colSpan=6;x.appendChild(c);r.appendChild(x)}
f.textContent=st?'Ждём следующую проверку':'Проверка '+d.ct+(d.nt?' \\u00b7 следующая ~'+d.nt:'');
}
if(W)W.onEvent('chatDataChanged',R);
setInterval(R,60000);
R();
</script>`;
