let ALL = [], INSTR = [], STRATS = [];

const QUALS = ['Good Win','Bad Win','Good Loss','Bad Loss'];
const EXITS = ['Target hit','Ran past target','Trailed stop hit','Stopped out','Manual close'];
let MYRISK = 1;                                     // planned risk per trade, % of equity
const specOf = name => INSTR.find(i => i.trader===ME && i.name===name) || null;
const hasSpec = sp => !!(sp && sp.pipSize>0 && sp.valuePerPip>0);
// Must stay in step with riskOfPosition()/lotsForRisk() in lib/util.ts.
function riskOfPosition(entry, sl, lots, sp){
  if(!hasSpec(sp) || !(lots>0)) return null;
  const pips = Math.abs(entry-sl)/sp.pipSize;
  if(!isFinite(pips) || pips<=0) return null;
  return Math.round(pips*sp.valuePerPip*lots*100)/100;
}
function lotsForRisk(entry, sl, riskMoney, sp){
  if(!hasSpec(sp) || !(riskMoney>0)) return null;
  const step = sp.lotStep>0 ? sp.lotStep : 0.01;
  const pips = Math.abs(entry-sl)/sp.pipSize;
  if(!isFinite(pips) || pips<=0) return null;
  // Settle the division before flooring: see lotsForRisk() in lib/util.ts.
  const lots = Math.floor(+((riskMoney/(pips*sp.valuePerPip))/step).toFixed(9))*step;
  const dp = Math.max(0, Math.ceil(-Math.log10(step)));
  return lots>0 ? +lots.toFixed(dp) : 0;
}
/** Equity in one currency, from the same figures the dashboard shows. */
function equityIn(ccy){
  const row = equityInfo().find(o => o.c === ccy);
  return row ? row.bal : 0;
}
const EXIT_TOL_R = 0.05;
// Must stay in step with detectExitReason() in lib/util.ts.
function detectExit(o){
  const risk = o.entry - o.sl;
  if(!risk || isNaN(risk)) return 'Manual close';
  const r = v => (v - o.entry) / risk, rExit = r(o.exit);
  if(o.tp!=null && o.tp!=='' && isFinite(o.tp)){
    const rTp = r(+o.tp);
    if(rExit >= rTp - EXIT_TOL_R) return rExit > rTp + EXIT_TOL_R ? 'Ran past target' : 'Target hit';
  }
  if(+o.finalSl !== +o.sl && Math.abs(rExit - r(+o.finalSl)) <= EXIT_TOL_R) return 'Trailed stop hit';
  if(Math.abs(rExit + 1) <= EXIT_TOL_R) return 'Stopped out';
  return 'Manual close';
}
/** Stored reason, or one derived on the fly for trades logged before this existed. */
function exitOf(t){
  if(t.exitReason) return t.exitReason;
  const e=+t.entry, sl=+t.sl, x=+t.exit;
  if([e,sl,x].some(v=>isNaN(v))) return 'Manual close';
  return detectExit({entry:e, sl:sl, finalSl:t.finalSl===''?sl:+t.finalSl, tp:t.tp===''?null:+t.tp, exit:x});
}
const $ = id => document.getElementById(id);
const fmt = (n, d=2) => (n===null||n===undefined||n===''||isNaN(n)) ? '–' : Number(n).toFixed(d);
const cls = n => n>0?'pos':(n<0?'neg':'');
const esc = s => String(s??'').replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const key = s => String(s||'').replace(/\s/g,'');

let ME = '', MEMBERS = [], SCOPE_TOUCHED = false;   // scope defaults to "Me" (once you have trades) until you pick a view yourself
/* ---------------------------------------------------------------- transport
   One JSON endpoint, called by function name - the same shape the Apps Script
   version had, so the rest of this file is unchanged. */
// Vendored so sign-in does not depend on a third-party CDN being reachable.
// Regenerate with `npm run vendor` after bumping @supabase/supabase-js.
const SB_LIB = '/assets/vendor/supabase.js';
let SB = null, SB_READY = null, ROLE = 'user', BOOTED = false;

async function rpc(fn, args = [], token = ''){
  const headers = {'Content-Type':'application/json'};
  if(token) headers.Authorization = 'Bearer ' + token;
  let r;
  try{ r = await fetch('/api/rpc', {method:'POST', headers, body:JSON.stringify({fn, args})}); }
  catch(e){ throw new Error('No connection. Check your network and try again.'); }
  let j = {};
  try{ j = await r.json(); }catch(e){ /* non-JSON error page */ }
  if(!r.ok || j.error) throw new Error(j.error || ('Request failed (' + r.status + ')'));
  return j.result;
}

/** Lazily builds the Supabase browser client from server-provided config. */
function supa(){
  if(!SB_READY){
    SB_READY = (async () => {
      const cfg = await rpc('config');
      const { createClient } = await import(SB_LIB);
      SB = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true, flowType:'pkce' }
      });
      SB.auth.onAuthStateChange((event, session) => {
        // Supabase holds an internal lock while this callback runs, so anything
        // that calls back into auth (getSession, refresh) has to wait a tick or
        // it deadlocks.
        setTimeout(() => {
          if(event === 'PASSWORD_RECOVERY') return changePassword();
          if(event === 'SIGNED_OUT') return lock();
          if(session && (event === 'SIGNED_IN' || event === 'INITIAL_SESSION')) enter();
        }, 0);
      });
      return SB;
    })().catch(e => { SB_READY = null; throw e; });
  }
  return SB_READY;
}

async function accessToken(){
  const sb = await supa();
  const { data } = await sb.auth.getSession();
  return (data && data.session && data.session.access_token) || '';
}

/** Authenticated call. Mirrors the old api(fn, ...args). */
async function api(fn, ...a){
  const t = await accessToken();
  if(!t) throw new Error('AUTH: please log in again.');
  return rpc(fn, a, t);
}

const msgOf = e => ((e && e.message) || String(e)).replace(/^Error:\s*/, '');
function fail(e){ const m = msgOf(e); if(/AUTH/.test(m)) signOut(); else alert(m); }

/* -------------------------------------------------------------- session UI */
function lock(){
  ME=''; ROLE='user'; BOOTED=false; ALL=[]; FUNDS=[]; INSTR=[]; STRATS=[]; MEMBERS=[]; SCOPE_TOUCHED=false;
  $('me').value='';
  document.body.classList.add('locked');
  document.body.classList.remove('onboarding','is-admin');
  $('aPw').value=''; $('authErr').textContent=''; $('authOk').textContent='';
  $('obUser').value=''; $('obInv').value=''; $('obErr').textContent='';
  $('msg').textContent=''; $('shotFile').value=''; SHOTS=[]; setConf(''); renderThumbs();
  $('lb').hidden=true; $('lbBody').innerHTML='';
  setMode('login');
}

async function signOut(){
  try{ const sb = await supa(); await sb.auth.signOut(); }catch(e){ /* local state still resets */ }
  lock();
}

/** Called once a Supabase session exists: either onboard or open the journal. */
async function enter(){
  if(BOOTED) return;
  BOOTED = true;
  try{ await load(); }
  catch(e){ BOOTED = false; fail(e); }
}

function showOnboarding(d){
  document.body.classList.add('locked','onboarding');
  $('obEmail').textContent = d.email || '';
  if(!$('obUser').value && d.suggestedUsername) $('obUser').value = d.suggestedUsername;
  if(!$('obCcy').value) $('obCcy').innerHTML = ccyOptions(guessCcy());
}

function showTab(n){
  ['journal','dash','setup','admin'].forEach(t=>{ $('tab-'+t).hidden = t!==n; });
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===n));
  if(n==='admin') loadAdmin();
}
document.querySelectorAll('[data-tab],[data-goto]').forEach(b=>b.onclick=()=>{ showTab(b.dataset.tab||b.dataset.goto); window.scrollTo({top:0}); });
$('logout').onclick = signOut;

/* ------------------------------------------------------------- login form */
let authMode='login';
function setMode(m){
  authMode=m;
  $('authTitle').textContent = m==='login' ? 'Log in' : 'Create your account';
  $('authGo').textContent    = m==='login' ? 'Log in' : 'Create account';
  $('authSwitch').textContent= m==='login' ? 'New here? Create an account' : 'Have an account? Log in';
  $('authForgot').hidden     = m!=='login';
  $('googleTxt').textContent = m==='login' ? 'Continue with Google' : 'Sign up with Google';
  $('aPw').autocomplete      = m==='login' ? 'current-password' : 'new-password';
  $('authNote').textContent  = m==='login'
    ? 'Signing in with Google works too - use whichever you set up.'
    : 'You will need an invite code from the journal owner on the next screen.';
  $('authErr').textContent=''; $('authOk').textContent='';
}
$('authSwitch').onclick = () => setMode(authMode==='login'?'register':'login');

$('googleGo').onclick = async () => {
  $('authErr').textContent=''; $('googleGo').disabled=true;
  try{
    const sb = await supa();
    const { error } = await sb.auth.signInWithOAuth({
      provider:'google',
      options:{ redirectTo: location.origin + location.pathname }
    });
    if(error) throw error;                       // otherwise the browser redirects
  }catch(e){ $('authErr').textContent = msgOf(e); $('googleGo').disabled=false; }
};

$('authForm').onsubmit = async ev => {
  ev.preventDefault();
  const email = $('aEmail').value.trim(), password = $('aPw').value;
  $('authGo').disabled=true; $('authErr').textContent=''; $('authOk').textContent='';
  try{
    const sb = await supa();
    if(authMode==='login'){
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if(error) throw error;
    }else{
      if(password.length < 8) throw new Error('Password must be at least 8 characters.');
      const { data, error } = await sb.auth.signUp({
        email, password, options:{ emailRedirectTo: location.origin + location.pathname }
      });
      if(error) throw error;
      if(!data.session){
        $('authOk').textContent = 'Check your inbox and confirm your email, then come back and log in.';
        setModeSoft('login');
      }
    }
  }catch(e){ $('authErr').textContent = msgOf(e); }
  finally{ $('authGo').disabled=false; }
};

/** Switches to login without wiping the "check your inbox" note. */
function setModeSoft(m){ const ok=$('authOk').textContent; setMode(m); $('authOk').textContent=ok; }

$('authForgot').onclick = async () => {
  const email = $('aEmail').value.trim();
  $('authErr').textContent=''; $('authOk').textContent='';
  if(!email){ $('authErr').textContent='Type your email address first.'; return; }
  try{
    const sb = await supa();
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if(error) throw error;
    $('authOk').textContent = 'Password reset link sent. Check your inbox.';
  }catch(e){ $('authErr').textContent = msgOf(e); }
};

async function changePassword(){
  const pw = prompt('Choose a new password (at least 8 characters):');
  if(pw === null) return;
  if(pw.length < 8){ alert('Password must be at least 8 characters.'); return changePassword(); }
  try{
    const sb = await supa();
    const { error } = await sb.auth.updateUser({ password: pw });
    if(error) throw error;
    alert('Password updated.');
    enter();
  }catch(e){ alert(msgOf(e)); }
}

/* -------------------------------------------------------------- onboarding */
$('onboardForm').onsubmit = async ev => {
  ev.preventDefault();
  $('obGo').disabled=true; $('obErr').textContent='';
  try{
    await api('completeOnboarding', $('obUser').value.trim(), $('obInv').value.trim(), MYTZ || BROWSER_TZ, $('obCcy').value);
    document.body.classList.remove('onboarding');
    BOOTED=false;
    await enter();
  }catch(e){ $('obErr').textContent = msgOf(e); }
  finally{ $('obGo').disabled=false; }
};
$('obCancel').onclick = signOut;


const CLAB={1:'1 – Strongly disagree',2:'2 – Disagree',3:'3 – Neutral',4:'4 – Agree',5:'5 – Strongly agree'};
function setConf(v){
  $('conf').value=v;
  document.querySelectorAll('#cbar button').forEach(b=>{ b.classList.toggle('on', v!=='' && +b.dataset.v<=+v); });
  $('clabel').textContent = v===''?'Tap a level: 1 Strongly disagree · 5 Strongly agree':CLAB[v];
}
document.querySelectorAll('#cbar button').forEach(b=>b.onclick=()=>setConf(String(b.dataset.v)));
const CCOL=['','#ef4444','#f97316','#facc15','#84cc16','#22c55e'];
const miniBar=v=>{v=+v||0; if(!v) return '–'; return '<span class="cmini" title="'+v+'/5">'+[1,2,3,4,5].map(i=>`<i style="${i<=v?'background:'+CCOL[v]:''}"></i>`).join('')+'</span>';};
$('date').value = new Date().toLocaleDateString('en-CA');
$('trendBy').addEventListener('change',render);
['fTrader','fFrom','fTo','fInstr','fStrat','fQual','fTrail','fConf','fSess','fExit'].forEach(id => $(id).addEventListener('change', render));
$('reset').onclick = () => { ['fFrom','fTo','fInstr','fStrat','fQual','fTrail','fConf','fSess','fExit'].forEach(i=>$(i).value=''); $('fTrader').value='__ALL__'; render(); };
$('refresh').onclick = () => load().catch(fail);
['entry','sl','fsl','tp','exit','risk','dir'].forEach(id => $(id).addEventListener('input', preview));

function load(){
  return api('getBootstrap').then(d => {
    if(d.needsOnboarding) return showOnboarding(d);
    ME=d.me; ROLE=d.role||'user'; $('me').value=ME;
    document.body.classList.toggle('is-admin', ROLE==='admin'||ROLE==='superadmin');
    const wasLocked = document.body.classList.contains('locked');
    document.body.classList.remove('locked','onboarding');
    MYTZ=toOffsetTz(d.tz||BROWSER_TZ); if(d.tz!==MYTZ) api('saveTimezone',MYTZ).catch(()=>{});
    MYCCY=d.ccy||guessCcy(); if(!d.ccy) api('saveCurrency',MYCCY).catch(()=>{});
    ALL=d.trades; FUNDS=d.funds||[]; INSTR=d.instruments; STRATS=d.strategies; MEMBERS=d.members||[];
    fillForm(); fillFilters();
    if(!SCOPE_TOUCHED){ $('fTrader').value = ALL.some(t=>t.trader===ME) ? ME : '__ALL__'; }
    MYRISK=+d.riskPct||1; if(!$('calcPct').value) $('calcPct').value=MYRISK;
    fillTz(); fillCcy(); fillExitReason(); render(); renderSetup(); syncRiskFromLots(); renderCalc();
    if(wasLocked) showTab('dash');
  });
}

const myInstr = () => INSTR.filter(i=>i.trader===ME).map(i=>i.name).sort();
const myStratObjs = () => STRATS.filter(s=>s.trader===ME).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
const myStrats = () => myStratObjs().map(s=>s.name);
function fillForm(sel){
  const setOpts = (el, vals, ph, pick) => {
    const cur = pick ?? el.value;
    el.innerHTML = `<option value="">${ph}</option>` + vals.map(v=>`<option>${esc(v)}</option>`).join('');
    if (vals.includes(cur)) el.value = cur;
  };
  const mi=myInstr(), ms=myStrats();
  setOpts($('instr'), mi, mi.length ? '— select —' : 'Add in My Setup', sel && sel.instr);
  setOpts($('strat'), ms, ms.length ? '— select —' : 'Add in My Setup', sel && sel.strat);
  updateQuality();
}
function fillFilters(){
  const keep=(el,vals,first)=>{const c=el.value; el.innerHTML=first+[...new Set(vals)].filter(Boolean).sort().map(v=>`<option>${esc(v)}</option>`).join(''); if([...el.options].some(o=>o.value===c)) el.value=c;};
  keep($('fTrader'), [...MEMBERS,...ALL.map(t=>t.trader)], '<option value="__ALL__">Overall (whole team)</option>');
  keep($('fInstr'), ALL.map(t=>t.instrument), '<option value="">All</option>');
  keep($('fStrat'), ALL.map(t=>t.strategy), '<option value="">All</option>');
}

// ---- screenshots ----
let SHOTS = [];                       // data URLs waiting to be saved with the new trade
const MAXSHOTS = 4;
function shrink(file){
  return new Promise((res,rej)=>{
    const url=URL.createObjectURL(file), img=new Image();
    img.onload=()=>{
      const s=Math.min(1,1600/Math.max(img.width,img.height)), c=document.createElement('canvas');
      c.width=Math.max(1,Math.round(img.width*s)); c.height=Math.max(1,Math.round(img.height*s));
      c.getContext('2d').drawImage(img,0,0,c.width,c.height); URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg',0.82));
    };
    img.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error('Could not read that image.')); };
    img.src=url;
  });
}
async function addFiles(files, target){
  const imgs=[...files].filter(f=>/^image\//.test(f.type));
  for(const f of imgs){
    if(target.length>=MAXSHOTS){ alert('Max '+MAXSHOTS+' screenshots per trade.'); break; }
    try{ target.push(await shrink(f)); }catch(e){ alert(e.message); }
  }
}
function dataUrlToBlob(d){
  const [head, b64] = String(d).split(',');
  const type = (/data:([^;]+)/.exec(head) || [])[1] || 'image/jpeg';
  const bin = atob(b64 || '');
  const buf = new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], {type});
}

/**
 * Sends the image bytes straight to Supabase Storage using short-lived signed
 * URLs, then returns the stored paths to attach to a trade. Keeps large
 * uploads out of the API function entirely.
 */
async function uploadShots(dataUrls){
  const list = (dataUrls || []).filter(Boolean);
  if(!list.length) return [];
  const blobs = list.map(dataUrlToBlob);
  const tickets = await api('createUploadTickets', blobs.map(b => b.type));
  await Promise.all(tickets.map(async (t, i) => {
    const r = await fetch(t.signedUrl, {
      method:'PUT',
      headers:{'Content-Type': blobs[i].type, 'x-upsert':'false', 'cache-control':'3600'},
      body: blobs[i]
    });
    if(!r.ok) throw new Error('A screenshot failed to upload. Try again.');
  }));
  return tickets.map(t => t.path);
}

function renderThumbs(){
  $('thumbs').innerHTML=SHOTS.map((d,i)=>`<div class="thumb"><img src="${d}" alt="Screenshot ${i+1}"><button type="button" data-rm="${i}" aria-label="Remove screenshot ${i+1}">&#10005;</button></div>`).join('');
  $('thumbs').querySelectorAll('[data-rm]').forEach(b=>b.onclick=()=>{ SHOTS.splice(+b.dataset.rm,1); renderThumbs(); });
}
$('shotBtn').onclick=()=>$('shotFile').click();
$('shotFile').onchange=async e=>{ await addFiles(e.target.files,SHOTS); e.target.value=''; renderThumbs(); };
document.addEventListener('paste',async e=>{
  if($('tab-journal').hidden||document.body.classList.contains('locked')) return;
  const files=[...(e.clipboardData&&e.clipboardData.items||[])].filter(i=>i.type.startsWith('image/')).map(i=>i.getAsFile()).filter(Boolean);
  if(!files.length) return; e.preventDefault(); await addFiles(files,SHOTS); renderThumbs();
});
// view / add screenshots on saved trades (event delegation on the table)
$('tbl').addEventListener('click',e=>{
  const v=e.target.closest('[data-view]'), a=e.target.closest('[data-addshot]');
  if(v) openLightbox(v.dataset.view.split(','));
  if(a){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*'; inp.multiple=true;
    inp.onchange=async()=>{ const arr=[]; await addFiles(inp.files,arr); if(!arr.length) return;
      try{ await api('addShots', a.dataset.addshot, await uploadShots(arr)); await load(); }
      catch(err){ fail(err); } };
    inp.click(); }
});
function openLightbox(ids){
  $('lb').hidden=false; $('lbBody').innerHTML='<div class="hint">Loading screenshots…</div>';
  Promise.all(ids.map(id=>api('getScreenshot',id))).then(urls=>{
    $('lbBody').innerHTML=urls.map((u,i)=>`<img src="${u}" alt="Screenshot ${i+1}">`).join('');
  }).catch(e=>{ $('lb').hidden=true; fail(e); });
}
$('lbClose').onclick=()=>{ $('lb').hidden=true; $('lbBody').innerHTML=''; };
$('lb').addEventListener('click',e=>{ if(e.target===$('lb')) $('lbClose').click(); });
document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&!$('lb').hidden) $('lbClose').click(); });

// ---- timezone (UTC/GMT offsets) & session ----
const offMin = tz => { const m=/^UTC(?:([+-])(\d{2}):(\d{2}))?$/.exec(tz||''); return m ? (m[1] ? (m[1]==='-'?-1:1)*(+m[2]*60+ +m[3]) : 0) : null; };
const offStr = min => { if(!min) return 'UTC'; const a=Math.abs(min); return 'UTC'+(min<0?'-':'+')+String(Math.floor(a/60)).padStart(2,'0')+':'+String(a%60).padStart(2,'0'); };
const BROWSER_TZ = offStr(-new Date().getTimezoneOffset());
const TZ_LABELS = [
 ['UTC-12:00','Baker Island'],['UTC-11:00','Samoa, Midway'],['UTC-10:00','Hawaii'],['UTC-09:30','Marquesas'],['UTC-09:00','Alaska'],
 ['UTC-08:00','Los Angeles, Vancouver (PST)'],['UTC-07:00','Denver, Phoenix (MST) · LA/Vancouver summer'],['UTC-06:00','Chicago, Mexico City (CST) · Denver summer'],
 ['UTC-05:00','New York, Toronto (EST) · Chicago summer'],['UTC-04:00','Halifax, Caracas · New York/Toronto summer (EDT)'],['UTC-03:30','Newfoundland'],
 ['UTC-03:00','São Paulo, Buenos Aires'],['UTC-02:00','Mid-Atlantic'],['UTC-01:00','Azores'],
 ['UTC','London (winter), Accra, Reykjavik'],['UTC+01:00','Lagos, Paris/Berlin (winter) · London summer'],['UTC+02:00','Cairo, Johannesburg · Paris/Berlin summer'],
 ['UTC+03:00','Moscow, Riyadh, Nairobi, Istanbul'],['UTC+03:30','Tehran'],['UTC+04:00','Dubai, Baku'],['UTC+04:30','Kabul'],['UTC+05:00','Karachi, Tashkent'],
 ['UTC+05:30','India, Sri Lanka'],['UTC+05:45','Nepal'],['UTC+06:00','Dhaka, Almaty'],['UTC+06:30','Yangon'],['UTC+07:00','Bangkok, Jakarta'],
 ['UTC+08:00','Singapore, Hong Kong, Perth'],['UTC+08:45','Eucla'],['UTC+09:00','Tokyo, Seoul'],['UTC+09:30','Adelaide, Darwin'],
 ['UTC+10:00','Brisbane · Sydney winter'],['UTC+10:30','Lord Howe'],['UTC+11:00','Sydney summer, Nouméa'],['UTC+12:00','Auckland winter, Fiji'],
 ['UTC+12:45','Chatham'],['UTC+13:00','Auckland summer, Tonga'],['UTC+14:00','Kiritimati']
];
const tzLabel = v => { const f=TZ_LABELS.find(x=>x[0]===v); return f ? `${v.replace('UTC-','UTC−')}  ·  ${f[1]}` : v; };
let MYTZ = BROWSER_TZ, MYCCY = 'USD', FUNDS = [];
const CCYS = ['USD','CAD','EUR','GBP','AUD','NZD','CHF','JPY','SGD','HKD','CNY','INR','AED','SAR','ZAR','NGN','KES','PKR','BDT','MXN','BRL','SEK','NOK','DKK','PLN','TRY','USDT'];
function guessCcy(){
  try{ const r=(navigator.language||'').split('-')[1]||''; return ({CA:'CAD',US:'USD',GB:'GBP',AU:'AUD',NZ:'NZD',IN:'INR',AE:'AED',JP:'JPY',SG:'SGD',ZA:'ZAR',NG:'NGN',PK:'PKR',DE:'EUR',FR:'EUR',IT:'EUR',ES:'EUR',NL:'EUR',IE:'EUR'})[r]||'USD'; }catch(e){ return 'USD'; }
}
const SESS = ['Asia','London','London/NY','New York','Off-hours'];
function sessionOfUtc(d){           // must match sessionOf_ in Code.gs
  const h=d.getUTCHours()+d.getUTCMinutes()/60;
  if(h>=23||h<7) return 'Asia'; if(h<12) return 'London'; if(h<16) return 'London/NY'; if(h<21) return 'New York'; return 'Off-hours';
}
function tzOffsetMs(utcMs,tz){      // legacy IANA support (old trades / old saved zones)
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:tz,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(new Date(utcMs)).map(x=>[x.type,x.value]));
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-utcMs;
}
function toOffsetTz(tz){            // converts a legacy IANA zone to an offset string; offsets pass through
  if(offMin(tz)!==null) return tz;
  try{ return offStr(Math.round(tzOffsetMs(Date.now(),tz)/60000)); }catch(e){ return BROWSER_TZ; }
}
function zonedToUtc(dateStr,timeStr,tz){          // wall-clock time at a UTC offset -> Date (UTC instant)
  const [y,m,d]=dateStr.split('-').map(Number), [hh,mm]=timeStr.split(':').map(Number);
  return new Date(Date.UTC(y,m-1,d,hh,mm)-(offMin(tz)||0)*60000);
}
/** Minutes a trade was open, or null when no close time was recorded. */
function holdMin(t){
  if(!t || !t.openedUtc || !t.closedUtc) return null;
  const a=Date.parse(t.openedUtc), b=Date.parse(t.closedUtc);
  return (isNaN(a)||isNaN(b)||b<a) ? null : Math.round((b-a)/60000);
}
function fmtDur(min){
  if(min==null||isNaN(min)) return '–';
  min=Math.round(min);
  if(min<60) return min+'m';
  const d=Math.floor(min/1440), h=Math.floor(min%1440/60), m=min%60;
  if(d) return d+'d'+(h?' '+h+'h':'');
  return h+'h'+(m?' '+m+'m':'');
}
function fmtIn(iso,tz,withDate=true){
  if(!iso) return '–';
  try{
    const o={hourCycle:'h23',hour:'2-digit',minute:'2-digit'}; if(withDate){ o.month='2-digit'; o.day='2-digit'; }
    let d=new Date(iso); const off=offMin(tz);
    if(off!==null){ d=new Date(d.getTime()+off*60000); o.timeZone='UTC'; } else o.timeZone=tz;
    return new Intl.DateTimeFormat('en-GB',o).format(d).replace(',','');
  }catch(e){ return '–'; }
}
function tzOptions(sel){
  const vals=TZ_LABELS.map(x=>x[0]); if(!vals.includes(BROWSER_TZ)) vals.push(BROWSER_TZ); if(sel && !vals.includes(sel)) vals.push(sel);
  return vals.map(v=>`<option value="${v}"${v===sel?' selected':''}>${esc(tzLabel(v))}</option>`).join('');
}
function fillTz(){
  const cur=$('tz').value; $('tz').innerHTML=tzOptions(cur||MYTZ);
  $('setTz').innerHTML=tzOptions(MYTZ); $('setTz').value=MYTZ;
  $('sess').innerHTML='<option value="">Auto (from time)</option>'+SESS.map(x=>`<option>${x}</option>`).join('');
  tzPreview();
}
function ccyOptions(sel){ return CCYS.map(c=>`<option${c===sel?' selected':''}>${c}</option>`).join(''); }
function fillCcy(){
  const cur=$('ccy').value; $('ccy').innerHTML=ccyOptions(cur||MYCCY);
  $('setCcy').innerHTML=ccyOptions(MYCCY);
  { const cur2=$('fdCcy').value; $('fdCcy').innerHTML=ccyOptions(cur2||MYCCY); }
}
function tzPreview(){
  const d=$('date').value, t=$('ttime').value, tz=$('tz').value;
  if(!d||!t||!tz){ $('tzHint').textContent = tz && tz!==MYTZ ? 'Different from your default ('+MYTZ+')' : 'Pick the offset your clock showed (daylight saving changes it)'; return; }
  try{
    const u=zonedToUtc(d,t,tz);
    let txt = `= ${fmtIn(u.toISOString(),'UTC',false)} UTC · ${$('sess').value||sessionOfUtc(u)} session`;
    const xt=$('xtime').value;
    if(xt){
      let c=zonedToUtc($('xdate').value||d, xt, tz);
      if(!$('xdate').value && c.getTime()<=u.getTime()) c=new Date(c.getTime()+86400000);
      txt += c.getTime()>=u.getTime() ? ` · held ${fmtDur((c-u)/60000)}` : ' · ⚠ closes before entry';
    }
    $('tzHint').textContent = txt;
  }
  catch(e){ $('tzHint').textContent=''; }
}
['date','ttime','xtime','xdate','tz','sess'].forEach(id=>$(id).addEventListener('input',tzPreview));
$('setTzSave').onclick=()=>{ api('saveTimezone',$('setTz').value).then(z=>{ MYTZ=z; $('setTzMsg').textContent='Saved: '+z; fillTz(); render(); }).catch(fail); };
$('setCcySave').onclick=()=>{ api('saveCurrency',$('setCcy').value).then(c=>{ MYCCY=c; $('setCcyMsg').textContent='Saved: '+c; fillCcy(); }).catch(fail); };
$('obCcy').innerHTML=ccyOptions(guessCcy());

// ---- My Setup tab ----
function renderSetup(){
  renderFunds(); if(!$('fdDate').value) $('fdDate').value=new Date().toISOString().slice(0,10);
  const ins=myInstr();
  $('myInstrList').innerHTML = ins.length
    ? ins.map(n=>`<span class="chip">${esc(n)}<button type="button" class="chip-x" data-inst="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button></span>`).join('')
    : '<span class="hint">No instruments yet – add the markets you trade.</span>';
  $('myInstrList').querySelectorAll('[data-inst]').forEach(b=>b.onclick=()=>{
    if(!confirm('Remove '+b.dataset.inst+' from your list? Past trades are kept.')) return;
    api('removeInstrument',b.dataset.inst).then(load).catch(fail);
  });
  renderInstrSpecs();
  $('setRisk').value=MYRISK;
  const ss=myStratObjs();
  $('myStratList').innerHTML = ss.length ? ss.map(s=>{
    const st=calc(ALL.filter(t=>t.trader===ME&&t.strategy===s.name));
    return `<div class="pb-item"><div class="pb-top"><b>${esc(s.name)}</b><span class="pb-meta">${st.n} trades · ${st.winRate==null?'–':fmt(st.winRate,0)+'% win'} · <span class="${cls(st.totalR)}">${fmt(st.totalR)}R</span></span></div>
      <div class="pb-desc">${esc(s.description)||'<span class="hint">No description yet</span>'}</div>
      <div class="pb-actions"><button type="button" class="ghost small" data-edit="${esc(s.name)}">Edit</button><button type="button" class="ghost small" data-del="${esc(s.name)}">Remove</button></div></div>`;
  }).join('') : '<span class="hint">No strategies yet – write your first one above.</span>';
  $('myStratList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    const s=myStratObjs().find(x=>x.name===b.dataset.edit); if(!s) return;
    $('stName').value=s.name; $('stDesc').value=s.description||''; $('stName').focus(); window.scrollTo({top:0,behavior:'smooth'});
  });
  $('myStratList').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    if(!confirm('Remove strategy "'+b.dataset.del+'"? Past trades are kept.')) return;
    api('removeStrategy',b.dataset.del).then(load).catch(fail);
  });
}

function renderInstrSpecs(){
  const ins=INSTR.filter(i=>i.trader===ME).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(!ins.length){ $('instrSpecs').innerHTML=''; return; }
  $('instrSpecs').innerHTML='<table class="spec-tbl"><tr><th>Instrument</th><th>Pip size</th><th>Value per pip (1 lot)</th><th>Lot step</th><th></th></tr>'
    + ins.map(i=>`<tr><td><b>${esc(i.name)}</b></td>`
        + `<td><input type="number" step="any" min="0" data-sp="pip" data-for="${esc(i.name)}" value="${i.pipSize??''}" placeholder="0.0001"></td>`
        + `<td><input type="number" step="any" min="0" data-sp="val" data-for="${esc(i.name)}" value="${i.valuePerPip??''}" placeholder="10"></td>`
        + `<td><input type="number" step="any" min="0" data-sp="step" data-for="${esc(i.name)}" value="${i.lotStep??0.01}"></td>`
        + `<td><button type="button" class="ghost small" data-spsave="${esc(i.name)}">Save</button> <span class="hint" data-spmsg="${esc(i.name)}"></span></td></tr>`).join('')
    + '</table>';
  $('instrSpecs').querySelectorAll('[data-spsave]').forEach(b=>b.onclick=()=>{
    const n=b.dataset.spsave, pick=k=>$('instrSpecs').querySelector(`[data-sp="${k}"][data-for="${CSS.escape(n)}"]`).value;
    const msg=$('instrSpecs').querySelector(`[data-spmsg="${CSS.escape(n)}"]`);
    msg.textContent='Saving…';
    api('saveInstrumentSpec',n,{pipSize:pick('pip'),valuePerPip:pick('val'),lotStep:pick('step')})
      .then(()=>{ msg.textContent='Saved'; return load(); })
      .catch(e=>{ msg.textContent=msgOf(e); });
  });
}
$('setRiskSave').onclick=()=>{
  api('saveRiskPct',$('setRisk').value).then(p=>{ MYRISK=p; $('calcPct').value=p; $('setRiskMsg').textContent='Saved: '+p+'% per trade'; renderCalc(); render(); }).catch(fail);
};

// ---- equity (deposits / withdrawals + trade PnL) ----
function equityInfo(){
  const by={}, get=c=>by[c]||(by[c]={c,dep:0,wd:0,pnl:0,ev:[]});
  FUNDS.forEach(f=>{ const o=get(f.currency||MYCCY), a=+f.amount||0; if(f.type==='Withdrawal'){o.wd+=a; o.ev.push({d:f.date,v:-a,k:'wd'});} else {o.dep+=a; o.ev.push({d:f.date,v:a,k:'dep'});} });
  ALL.filter(t=>t.trader===ME).forEach(t=>{ const o=get(t.currency||MYCCY), p=+t.pnl||0; o.pnl+=p; o.ev.push({d:t.date,v:p,k:'t'}); });
  Object.values(by).forEach(o=>{ o.bal=o.dep-o.wd+o.pnl; o.ev.sort((a,b)=>String(a.d).localeCompare(String(b.d))); });
  return Object.values(by).sort((a,b)=>(b.c===MYCCY)-(a.c===MYCCY)||b.ev.length-a.ev.length);
}
function renderEquity(){
  const list=equityInfo(), card=$('eqCard');
  if(!list.length){ card.hidden=false; $('eqStats').innerHTML=''; $('eqChart').innerHTML=''; $('eqNote').innerHTML='No equity yet. Open <b>My Setup</b> and record your starting deposit so the dashboard can track your account.'; return; }
  card.hidden=false;
  const main=list[0], c=(l,v,k='',st='')=>`<div class="stat"><div class="l">${l}</div><div class="v ${k}" style="${st}">${v}</div></div>`;
  const m=x=>fmt(x)+' '+esc(main.c);
  const ret=main.dep>0?main.pnl/main.dep*100:null;
  $('eqStats').innerHTML =
    c('Current equity ('+esc(main.c)+')',m(main.bal),cls(main.bal-main.dep+main.wd)) +
    c('Deposited',m(main.dep)) + c('Withdrawn',m(main.wd)) +
    c('Trading P&amp;L',m(main.pnl),cls(main.pnl)) +
    c('Return on deposits',ret==null?'–':fmt(ret,1)+'%',cls(ret));
  const others=list.slice(1);
  $('eqNote').innerHTML = others.length ? 'Other currencies (tracked separately, no conversion): '+others.map(o=>`<b>${fmt(o.bal)} ${esc(o.c)}</b>`).join(' · ') : '';
  // curve for main currency
  const W=560,H=200,P=28; let run=0; const pts=[]; main.ev.forEach(e=>{ run+=e.v; pts.push({d:e.d,y:run,k:e.k}); });
  if(pts.length<1){ $('eqChart').innerHTML=''; return; }
  const P0=[{d:pts[0].d,y:0,k:'s'},...pts];
  const xs=P0.map(p=>Date.parse(p.d)||0), t0=Math.min(...xs), t1=Math.max(...xs);
  const ys=P0.map(p=>p.y), min=Math.min(...ys,0), max=Math.max(...ys), rng=(max-min)||1;
  const X=(p,i)=>P+(t1>t0?((Date.parse(p.d)||0)-t0)/(t1-t0):(P0.length>1?i/(P0.length-1):0))*(W-2*P), Y=v=>H-P-(v-min)/rng*(H-2*P);
  const up=run>=main.dep-main.wd, col=up?'#22c55e':'#ef4444';
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-height:230px" role="img" aria-label="Equity over time"><line x1="${P}" x2="${W-P}" y1="${Y(0)}" y2="${Y(0)}" stroke="#475569" stroke-dasharray="4"/>`;
  // step-ish line through every event
  svg+=`<path d="${P0.map((p,i)=>(i?'L':'M')+X(p,i).toFixed(1)+' '+Y(p.y).toFixed(1)).join(' ')}" fill="none" stroke="${col}" stroke-width="2"/>`;
  P0.forEach((p,i)=>{ if(p.k==='dep'||p.k==='wd') svg+=`<circle cx="${X(p,i).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="4" fill="${p.k==='dep'?'#22d3ee':'#facc15'}"><title>${p.k==='dep'?'Deposit':'Withdrawal'} · ${esc(p.d)} · equity ${fmt(p.y)}</title></circle>`; });
  svg+=`<text x="${W-P}" y="${Y(run)-8}" text-anchor="end" style="fill:${col};font-size:12px">${fmt(run)} ${esc(main.c)}</text><text x="${P}" y="${Y(max)-4}">${fmt(max)}</text><text x="${P}" y="${Y(min)+12}">${fmt(min)}</text></svg>`;
  $('eqChart').innerHTML=svg+'<div class="hint"><span style="color:#22d3ee">&#9679;</span> deposit &nbsp; <span style="color:#facc15">&#9679;</span> withdrawal &nbsp; line = equity after each event/trade ('+esc(main.c)+')</div>';
}
function renderFunds(){
  const rows=FUNDS.slice().sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  $('fdList').innerHTML = rows.length ? '<table><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>'+rows.map(f=>`<tr><td>${esc(f.date)}</td><td>${esc(f.type)}</td><td class="${f.type==='Deposit'?'pos':'neg'}">${f.type==='Deposit'?'+':'−'}${fmt(f.amount)} ${esc(f.currency)}</td><td>${esc(f.note||'')}</td><td><button type="button" class="ghost small" data-fdel="${esc(f.id)}">Delete</button></td></tr>`).join('')+'</tbody></table>' : '<span class="hint">No deposits or withdrawals yet.</span>';
  $('fdList').querySelectorAll('[data-fdel]').forEach(b=>b.onclick=()=>{ if(!confirm('Delete this entry? Your equity will be recalculated.')) return; api('deleteFunds',b.dataset.fdel).then(load).catch(fail); });
}
$('fdAdd').onclick=()=>{
  const amt=parseFloat($('fdAmt').value); $('fdMsg').textContent='';
  if(!(amt>0)){ $('fdMsg').textContent='Enter an amount above 0.'; return; }
  api('addFunds',{type:$('fdType').value,amount:amt,currency:$('fdCcy').value,date:$('fdDate').value,note:$('fdNote').value.trim()})
    .then(r=>{ $('fdAmt').value=''; $('fdNote').value=''; $('fdMsg').textContent=r.type+' of '+r.amount+' '+r.currency+' recorded.'; return load(); })
    .catch(e=>{ const m=(e&&e.message)||String(e); if(/^AUTH/.test(m)) return fail(e); $('fdMsg').textContent=m.replace(/^Error:\s*/,''); });
};
$('setInstrAdd').onclick=()=>{
  const v=$('setInstr').value.trim(); if(!v) return;
  api('addInstrument',v).then(()=>{ $('setInstr').value=''; return load(); }).catch(fail);
};
$('setInstr').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('setInstrAdd').click(); } });
$('stSave').onclick=()=>{
  const n=$('stName').value.trim(); if(!n){ alert('Give the strategy a name.'); return; }
  api('saveStrategy',n,$('stDesc').value.trim()).then(()=>{ $('stName').value=''; $('stDesc').value=''; return load(); }).catch(fail);
};

// ---- live preview & quality options ----
function calcLive(){
  const e=+$('entry').value, s=+$('sl').value, x=$('exit').value, tp=$('tp').value, dir=$('dir').value;
  if(!$('entry').value || !$('sl').value) return null;
  if((dir==='Long'&&s>=e)||(dir==='Short'&&s<=e)) return {err:true};
  const d=e-s, o={};
  if(tp!=='') o.plan=Math.abs(+tp-e)/Math.abs(d);
  if(x!==''){ o.r=(+x-e)/d; o.out=o.r>0.05?'Win':o.r<-0.05?'Loss':'BE'; }
  return o;
}
function preview(){
  const o=calcLive(); const out=[];
  if(!o){ $('preview').textContent='Fill entry, initial SL and exit to preview.'; updateQuality(); return; }
  if(o.err){ $('preview').textContent='⚠ Initial SL is on the wrong side of entry.'; return; }
  if(o.plan!=null) out.push('Planned R:R 1:'+fmt(o.plan));
  if(o.r!=null) out.push('Result '+fmt(o.r)+'R ('+o.out+')');
  const f=$('fsl').value, s=$('sl').value;
  if(f!=='' && +f!==+s) out.push('SL trailed');
  $('preview').textContent=out.join('  •  ');
  updateQuality(); updateExitHint();
}
function fillExitReason(){
  const cur = $('xreason').value;
  $('xreason').innerHTML = '<option value="">Auto (from prices)</option>'
    + EXITS.map(v=>`<option>${v}</option>`).join('');
  if(EXITS.includes(cur)) $('xreason').value = cur;
}
function updateExitHint(){
  const e=$('entry').value, sl=$('sl').value, x=$('exit').value;
  if(e===''||sl===''||x===''){ $('xreasonHint').textContent='Fill entry, initial SL and exit'; return; }
  const guess = detectExit({entry:+e, sl:+sl, finalSl:$('fsl').value===''?+sl:+$('fsl').value,
                            tp:$('tp').value===''?null:+$('tp').value, exit:+x});
  $('xreasonHint').textContent = $('xreason').value
    ? 'You set this yourself · prices say ' + guess
    : 'Worked out from your prices: ' + guess;
}
$('xreason').addEventListener('change', updateExitHint);

function renderCalc(){
  const name=$('instr').value, sp=specOf(name), ccy=$('ccy').value||MYCCY;
  const entry=+$('entry').value, sl=+$('sl').value, tp=$('tp').value===''?null:+$('tp').value;
  const pct=+$('calcPct').value || MYRISK;
  const out=$('calcOut'), note=$('calcNote');
  const cell=(l,v,k='',lead=false)=>`<div class="stat${lead?' lead':''}"><div class="l">${l}</div><div class="v ${k}">${v}</div></div>`;

  if(!name){ out.innerHTML=''; note.textContent='Pick an instrument to size a position.'; return; }
  if(!hasSpec(sp)){
    out.innerHTML='';
    note.innerHTML=`Set the pip size and value per pip for <b>${esc(name)}</b> in <button type="button" class="link-btn" data-goto="setup">My Setup</button> and this will size every trade for you.`;
    note.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>{ showTab('setup'); window.scrollTo({top:0}); });
    return;
  }
  if(!$('entry').value || !$('sl').value || entry===sl){
    out.innerHTML=''; note.textContent='Fill entry and initial SL to size the position.'; return;
  }

  const equity=equityIn(ccy);
  const stopPips=Math.abs(entry-sl)/sp.pipSize;
  const riskMoney=equity>0 ? equity*pct/100 : 0;
  const lots=lotsForRisk(entry,sl,riskMoney,sp);
  const m=v=>fmt(v)+' '+esc(ccy);

  if(equity<=0){
    out.innerHTML=cell('Stop distance',fmt(stopPips,1)+' pips');
    note.innerHTML='Record your starting deposit in <b>My Setup</b> and this will work out the lot size for you.';
    return;
  }

  let html = cell('Suggested lots', lots>0?fmt(lots,2):'too small', lots>0?'':'neg', true)
    + cell('Risking', m(riskMoney)) + cell('Stop distance', fmt(stopPips,1)+' pips')
    + cell('Equity', m(equity));
  if(tp!==null && isFinite(tp)){
    const rewardPips=Math.abs(tp-entry)/sp.pipSize;
    html += cell('Target reward', m(rewardPips*sp.valuePerPip*(lots||0)))
          + cell('Planned R:R', '1:'+fmt(rewardPips/stopPips));
  }
  out.innerHTML=html;

  const typed=+$('lots').value;
  if(typed>0){
    const actual=riskOfPosition(entry,sl,typed,sp);
    const actualPct=equity>0 ? actual/equity*100 : null;
    const over=actualPct!=null && actualPct > pct*1.1;
    note.innerHTML = `You entered <b>${fmt(typed,2)}</b> lots = <b class="${over?'neg':''}">${m(actual)}</b>`
      + (actualPct!=null?` (<b class="${over?'neg':''}">${fmt(actualPct,2)}%</b> of equity)`:'')
      + (over?' &mdash; over your plan.':'');
  } else {
    note.innerHTML = lots>0
      ? `Type <b>${fmt(lots,2)}</b> in the lot size box, or your own number to check it.`
      : `Even ${fmt(sp.lotStep,2)} lots would risk more than ${fmt(pct,2)}% here. Widen the stop or lower the size.`;
  }
}

/** Keeps the risk amount in step with the lot size the trader typed. */
function syncRiskFromLots(){
  const sp=specOf($('instr').value), lots=+$('lots').value;
  const entry=+$('entry').value, sl=+$('sl').value;
  const r = ($('entry').value && $('sl').value) ? riskOfPosition(entry,sl,lots,sp) : null;
  if(r!=null){ $('risk').value=r; $('risk').readOnly=true; $('lotsHint').textContent='Risk worked out from this size'; }
  else { $('risk').readOnly=false; $('lotsHint').textContent = hasSpec(sp) ? 'Fill entry and initial SL' : "Set this instrument's pip value in My Setup"; }
  preview();
}
['lots','calcPct'].forEach(id=>$(id).addEventListener('input',()=>{ syncRiskFromLots(); renderCalc(); }));
['entry','sl','tp','instr','ccy'].forEach(id=>$(id).addEventListener('input',()=>{ syncRiskFromLots(); renderCalc(); }));
$('instr').addEventListener('change',()=>{ syncRiskFromLots(); renderCalc(); });

function updateQuality(){
  const o=calcLive(); const cur=$('quality').value;
  let opts=QUALS;
  if(o&&o.out==='Win') opts=['Good Win','Bad Win'];
  else if(o&&o.out==='Loss') opts=['Good Loss','Bad Loss'];
  $('quality').innerHTML='<option value="">— select —</option>'+opts.map(v=>`<option>${v}</option>`).join('');
  if(opts.includes(cur)) $('quality').value=cur;
}

$('add').onclick = () => {
  const t={date:$('date').value,time:$('ttime').value,closeTime:$('xtime').value,closeDate:$('xdate').value,timezone:$('tz').value,currency:$('ccy').value,session:$('sess').value,instrument:$('instr').value,strategy:$('strat').value,direction:$('dir').value,
    entry:$('entry').value,sl:$('sl').value,finalSl:$('fsl').value,tp:$('tp').value,exit:$('exit').value,
    risk:$('risk').value,lots:$('lots').value,confidence:$('conf').value,exitReason:$('xreason').value,shots:SHOTS,quality:$('quality').value,notes:$('notes').value};
  $('add').disabled=true; $('msg').textContent=SHOTS.length?'Uploading screenshots…':'Saving…';
  uploadShots(SHOTS).then(paths=>{ t.shots=paths; if(paths.length) $('msg').textContent='Saving trade…'; return api('addTrade',t); }).then(r=>{
    $('add').disabled=false; $('msg').textContent=`Saved: ${r.outcome} ${fmt(r.r)}R${r.trailed==='Yes'?' (trailed)':''} · ${r.session}`;
    ['entry','sl','fsl','tp','exit','risk','lots','notes'].forEach(i=>$(i).value=''); $('quality').value=''; $('ttime').value=''; $('xtime').value=''; $('xdate').value=''; $('xreason').value=''; $('sess').value=''; setConf(''); SHOTS=[]; renderThumbs(); preview(); tzPreview(); load().catch(fail);
  }).catch(e=>{ $('add').disabled=false; const m=(e&&e.message)||String(e); if(/AUTH/.test(m)) return fail(e); $('msg').textContent='Error: '+m; });
};
function del(id){
  if(!confirm('Delete this trade?')) return;
  api('deleteTrade',id).then(load).catch(fail);
}

// ---- stats ----
function filtered(includeTrader=true){
  const v=id=>$(id).value, tr=v('fTrader');
  return ALL.filter(t=>
    (!includeTrader||tr==='__ALL__'||t.trader===tr) &&
    (!v('fFrom')||t.date>=v('fFrom')) && (!v('fTo')||t.date<=v('fTo')) &&
    (!v('fInstr')||t.instrument===v('fInstr')) && (!v('fStrat')||t.strategy===v('fStrat')) &&
    (!v('fQual')||t.quality===v('fQual')) && (!v('fSess')||(v('fSess')==='__none'?!t.session:t.session===v('fSess'))) && (v('fConf')===''||(+t.confidence||0)===+v('fConf')) && (!v('fTrail')||t.trailed===v('fTrail')) && (!v('fExit')||exitOf(t)===v('fExit')))
    .sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:String(a.loggedAt).localeCompare(String(b.loggedAt)));
}
function calc(list){
  const n=list.length, w=list.filter(t=>t.outcome==='Win'), l=list.filter(t=>t.outcome==='Loss'), be=n-w.length-l.length;
  const rs=list.map(t=>+t.r||0), totalR=rs.reduce((a,b)=>a+b,0);
  const gw=rs.filter(x=>x>0).reduce((a,b)=>a+b,0), gl=-rs.filter(x=>x<0).reduce((a,b)=>a+b,0);
  const decided=w.length+l.length;
  const avgW=w.length?w.reduce((a,t)=>a+ +t.r,0)/w.length:0, avgL=l.length?l.reduce((a,t)=>a+ +t.r,0)/l.length:0;
  const planned=list.map(t=>+t.plannedRR).filter(x=>x>0);
  let eq=0,peak=0,dd=0; rs.forEach(x=>{eq+=x;peak=Math.max(peak,eq);dd=Math.max(dd,peak-eq);});
  const q={}; QUALS.forEach(k=>q[k]=list.filter(t=>t.quality===k).length);
  const good=q['Good Win']+q['Good Loss'];
  return { n,wins:w.length,losses:l.length,be,totalR,pnl:list.reduce((a,t)=>a+(+t.pnl||0),0), pnlBy:list.reduce((m,t)=>{ if(t.pnl!==''&&t.pnl!=null){ const k=t.currency||'n/a'; m[k]=(m[k]||0)+(+t.pnl||0); } return m; },{}),
    winRate:decided?w.length/decided*100:null, avgR:n?totalR/n:null,
    pf:gl>0?gw/gl:(gw>0?Infinity:null), avgW,avgL, realRR:avgL?Math.abs(avgW/avgL):null,
    plannedRR:planned.length?planned.reduce((a,b)=>a+b,0)/planned.length:null, maxDD:dd,
    q, discipline:n?good/n*100:null, trailed:list.filter(t=>t.trailed==='Yes').length,
    avgConf:(()=>{const c=list.map(t=>+t.confidence).filter(x=>x>0);return c.length?c.reduce((a,b)=>a+b,0)/c.length:null;})(),
    avgHold:(()=>{const h=list.map(holdMin).filter(x=>x!=null);return h.length?h.reduce((a,b)=>a+b,0)/h.length:null;})(),
    avgRiskPct:(()=>{const p=list.map(t=>+t.riskPct).filter(x=>x>0);return p.length?p.reduce((a,b)=>a+b,0)/p.length:null;})(),
    overRisked:list.filter(t=>+t.riskPct>MYRISK*1.1).length };
}
function pnlCard(s){
  const e=Object.entries(s.pnlBy);
  if(!e.length) return `<div class="stat"><div class="l">Total PnL</div><div class="v">–</div></div>`;
  const txt=e.map(([c,v])=>`${fmt(v)} ${esc(c)}`).join(' · ');
  return `<div class="stat"><div class="l">Total PnL${e.length>1?' (per currency)':''}</div><div class="v ${e.length===1?cls(e[0][1]):''}" style="${e.length>1?'font-size:16px;line-height:1.35':''}">${txt}</div></div>`;
}
function setScope(v){ SCOPE_TOUCHED=true; $('fTrader').value=v; render(); }
$('fTrader').addEventListener('change',()=>{ SCOPE_TOUCHED=true; });
function renderScope(){
  const cur=$('fTrader').value, btn=(v,l,c='')=>`<button type="button" class="${c}${cur===v?' on':''}" data-scope="${esc(v)}" aria-pressed="${cur===v}">${l}</button>`;
  const others=[...new Set([...MEMBERS,...ALL.map(t=>t.trader)])].filter(m=>m&&m!==ME).sort();
  $('scope').innerHTML = btn('__ALL__','&#128101; Team') + btn(ME,'&#128100; Me ('+esc(ME)+')','me') + others.map(m=>btn(m,esc(m))).join('');
  $('scope').querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>setScope(b.dataset.scope));
}
function vsTeam(){
  const tr=$('fTrader').value;
  if(tr==='__ALL__'){ $('vsCard').hidden=true; return; }
  const all=filtered(false), mine=calc(all.filter(t=>t.trader===tr)), team=calc(all);
  $('vsCard').hidden=false; $('vsTitle').textContent = (tr===ME?'You':tr)+' vs whole team';
  const rows=[
    ['Win rate',mine.winRate,team.winRate,v=>fmt(v,1)+'%',true],
    ['Expectancy (R/trade)',mine.avgR,team.avgR,v=>fmt(v),true],
    ['Profit factor',mine.pf===Infinity?null:mine.pf,team.pf===Infinity?null:team.pf,v=>fmt(v),true],
    ['Discipline (good trades)',mine.discipline,team.discipline,v=>fmt(v,0)+'%',true],
    ['Avg confidence (1-5)',mine.avgConf,team.avgConf,v=>fmt(v,1),true],
    ['Avg planned R:R',mine.plannedRR,team.plannedRR,v=>'1:'+fmt(v),true],
    ['Max drawdown (R)',mine.maxDD,team.maxDD,v=>fmt(v),false],
    ['Trades logged',mine.n,team.n,v=>String(v),true]
  ];
  $('vsTeam').innerHTML=`<table><tr><th>Metric</th><th>${esc(tr)}</th><th>Team (all members)</th><th>Difference</th></tr>`+
    rows.map(([l,a,b,f,up])=>{ const d=(a==null||b==null)?null:a-b, good=d==null?'':(d===0?'':((d>0)===up?'pos':'neg'));
      return `<tr><td>${l}</td><td><b>${a==null?'–':f(a)}</b></td><td>${b==null?'–':f(b)}</td><td class="diff ${good}">${d==null||l==='Trades logged'?'–':(d>0?'+':'')+fmt(d,l.includes('rate')||l.includes('Discipline')?1:2)}</td></tr>`; }).join('')+'</table>';
}
function render(){
  renderScope(); vsTeam(); renderEquity();
  const list=filtered(), s=calc(list);
  const label=$('fTrader').value==='__ALL__'?'Overall team':$('fTrader').value;
  const c=(l,v,k='')=>`<div class="stat"><div class="l">${l}</div><div class="v ${k}">${v}</div></div>`;
  $('stats').innerHTML =
    c('Viewing',esc(label)) + c('Trades',s.n) +
    c('Win rate',s.winRate==null?'–':fmt(s.winRate,1)+'%',s.winRate>=50?'pos':'neg') +
    c('W / L / BE',`${s.wins} / ${s.losses} / ${s.be}`) +
    c('Total R',fmt(s.totalR),cls(s.totalR)) + pnlCard(s) +
    c('Expectancy (R/trade)',fmt(s.avgR),cls(s.avgR)) +
    c('Avg planned R:R',s.plannedRR==null?'–':'1:'+fmt(s.plannedRR)) +
    c('Avg realised R:R',s.realRR==null?'–':'1:'+fmt(s.realRR)) +
    c('Profit factor',s.pf===Infinity?'∞':fmt(s.pf),s.pf>1?'pos':'neg') +
    c('Max drawdown (R)',fmt(s.maxDD),s.maxDD>0?'neg':'') +
    c('Discipline (good trades)',s.discipline==null?'–':fmt(s.discipline,0)+'%',s.discipline>=60?'pos':'neg') +
    c('Trades with trailed SL',s.trailed) +
    c('Avg confidence (1-5)',s.avgConf==null?'–':fmt(s.avgConf,1)) +
    c('Avg hold time',fmtDur(s.avgHold)) +
    c('Avg risk per trade',s.avgRiskPct==null?'–':fmt(s.avgRiskPct,2)+'%',s.avgRiskPct>MYRISK*1.1?'neg':'') +
    c('Over your risk plan',s.overRisked,s.overRisked?'neg':'pos');
  drawCurve(list);
  trend(list);
  qualTable(s);
  group('byInstr',list,t=>t.instrument,'Instrument');
  const allV=$('fTrader').value==='__ALL__';
  group('byStrat',list,t=>(t.strategy||'(none)')+(allV?' · '+t.trader:''),'Strategy');
  playbook();
  group('bySess',list,t=>t.session||'Not set','Session',true);
  group('byConf',list,t=>CONF[+t.confidence]||'Not rated','Confidence',true);
  group('byTrail',list,t=>t.trailed==='Yes'?'Trailed SL':'Fixed SL','Type');
  group('byExit',list,exitOf,'How it ended');
  leaderboard(); tradesTable(list);
}

// ---- improvement over time ----
const QCOL={'Good Win':'#22c55e','Good Loss':'#38bdf8','Bad Win':'#facc15','Bad Loss':'#ef4444'};
function periodKey(d,by){
  if(by==='month') return d.slice(0,7);
  const dt=new Date(d+'T00:00:00Z'), day=(dt.getUTCDay()+6)%7; dt.setUTCDate(dt.getUTCDate()-day);
  return dt.toISOString().slice(0,10);
}
function trend(list){
  const by=$('trendBy').value, g={};
  list.forEach(t=>{ if(t.date) (g[periodKey(t.date,by)]=g[periodKey(t.date,by)]||[]).push(t); });
  const keys=Object.keys(g).sort(), rows=keys.map(k=>({k,...calc(g[k])}));
  if(!rows.length){ $('trendChart').innerHTML=''; $('trendTbl').innerHTML='<span style="color:var(--mut)">No data</span>'; $('trendNote').textContent=''; return; }
  // note: latest vs previous period
  if(rows.length>1){
    const a=rows[rows.length-1], b=rows[rows.length-2], d=a.discipline-b.discipline;
    $('trendNote').innerHTML=`Latest ${by} vs previous: discipline <b class="${cls(d)}">${d>=0?'+':''}${fmt(d,0)} pts</b>`+
      ` (${fmt(b.discipline,0)}% → ${fmt(a.discipline,0)}%). Goal: fewer Bad Wins &amp; Bad Losses, even when the result is red.`;
  } else $('trendNote').textContent='Log trades across more than one period to see your trend.';
  // 100% stacked bars of the four quality types
  const W=Math.max(560,rows.length*46+60),H=200,P=26,bw=Math.min(34,(W-2*P)/rows.length-8);
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:${Math.min(W,900)}px">`;
  rows.forEach((r,i)=>{
    const x=P+i*((W-2*P)/rows.length)+4; let y=H-P;
    QUALS.forEach(q=>{ const c=r.q[q]; if(!c||!r.n) return; const h=(c/r.n)*(H-2*P); y-=h; svg+=`<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${QCOL[q]}"><title>${r.k} ${q}: ${c}</title></rect>`; });
    svg+=`<text x="${x+bw/2}" y="${H-10}" text-anchor="middle">${by==='month'?r.k.slice(2):r.k.slice(5)}</text>`;
  });
  svg+='</svg>';
  const legend=QUALS.map(q=>`<span style="margin-right:12px"><span style="display:inline-block;width:10px;height:10px;background:${QCOL[q]};border-radius:2px"></span> ${q}</span>`).join('');
  $('trendChart').innerHTML=`<div class="scroll">${svg}</div><div class="hint">${legend} · each bar = 100% of that period's trades</div>`;
  const arrow=(v,p,goodUp=true)=>p==null?'':(v>p?`<span class="${goodUp?'pos':'neg'}"> ▲</span>`:v<p?`<span class="${goodUp?'neg':'pos'}"> ▼</span>`:'');
  $('trendTbl').innerHTML=`<table><tr><th>${by==='month'?'Month':'Week of'}</th><th>Trades</th><th>Good Win</th><th>Bad Win</th><th>Good Loss</th><th>Bad Loss</th><th>Discipline</th><th>Avg conf</th><th>Win %</th><th>Total R</th></tr>`+
    rows.map((r,i)=>{const p=rows[i-1]; return `<tr><td>${r.k}</td><td>${r.n}</td><td>${r.q['Good Win']}</td><td>${r.q['Bad Win']}</td><td>${r.q['Good Loss']}</td><td>${r.q['Bad Loss']}</td><td>${fmt(r.discipline,0)}%${arrow(r.discipline,p&&p.discipline)}</td><td>${r.avgConf==null?'–':fmt(r.avgConf,1)}</td><td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td><td class="${cls(r.totalR)}">${fmt(r.totalR)}${arrow(r.totalR,p&&p.totalR)}</td></tr>`;}).reverse().join('')+'</table>';
}

function playbook(){
  const tr=$('fTrader').value, all=tr==='__ALL__', fl=filtered();
  const rows=STRATS.filter(s=>all||s.trader===tr).sort((a,b)=>String(a.trader).localeCompare(String(b.trader))||String(a.name).localeCompare(String(b.name)));
  $('playbook').innerHTML = rows.length ? '<div class="pb-list">'+rows.map(s=>{
    const st=calc(fl.filter(t=>t.trader===s.trader&&t.strategy===s.name));
    return `<div class="pb-item"><div class="pb-top"><span><b>${esc(s.name)}</b>${all?`<span class="tag">${esc(s.trader)}</span>`:''}</span><span class="pb-meta">${st.n} trades · ${st.winRate==null?'–':fmt(st.winRate,0)+'% win'} · <span class="${cls(st.totalR)}">${fmt(st.totalR)}R</span> · ${st.discipline==null?'–':fmt(st.discipline,0)+'% good'}</span></div><div class="pb-desc">${esc(s.description)||'<span class="hint">No description</span>'}</div></div>`;
  }).join('')+'</div>' : '<span style="color:var(--mut)">No strategies written yet. Add yours in the My Setup tab.</span>';
}
function qualTable(s){
  const rows=QUALS.map(k=>`<tr><td><span class="pill ${key(k)}">${k}</span></td><td>${s.q[k]}</td><td>${s.n?fmt(s.q[k]/s.n*100,0)+'%':'–'}</td></tr>`).join('');
  $('qual').innerHTML=`<table><tr><th>Type</th><th>Trades</th><th>Share</th></tr>${rows}</table>
  <div class="hint" style="margin-top:8px">Good = followed your plan/rules, Bad = broke them. Discipline % = (Good Win + Good Loss) ÷ trades.</div>`;
}
const CONF={1:'1 – Strongly disagree',2:'2 – Disagree',3:'3 – Neutral',4:'4 – Agree',5:'5 – Strongly agree'};
function group(el,list,keyFn,title,byKey){
  const g={}; list.forEach(t=>(g[keyFn(t)]=g[keyFn(t)]||[]).push(t));
  const rows=Object.entries(g).map(([k,v])=>({k,...calc(v)})).sort(byKey?((a,b)=>a.k<b.k?-1:1):((a,b)=>b.totalR-a.totalR));
  $(el).innerHTML=rows.length?`<table><tr><th>${title}</th><th>Trades</th><th>Win %</th><th>Total R</th><th>Avg R</th><th>Good %</th></tr>`+
    rows.map(r=>`<tr><td>${esc(r.k)}</td><td>${r.n}</td><td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td><td class="${cls(r.totalR)}">${fmt(r.totalR)}</td><td class="${cls(r.avgR)}">${fmt(r.avgR)}</td><td>${fmt(r.discipline,0)}%</td></tr>`).join('')+'</table>':'<span style="color:var(--mut)">No data</span>';
}
function leaderboard(){
  const list=filtered(false), sel=$('fTrader').value, g={};
  [...new Set([...MEMBERS,...list.map(t=>t.trader)])].forEach(m=>g[m]=[]);
  list.forEach(t=>g[t.trader].push(t));
  const top=(arr,key,fn)=>{ const m={}; arr.forEach(t=>{ const k=key(t); if(k) (m[k]=m[k]||[]).push(t); }); const e=Object.entries(m).map(([k,v])=>({k,...calc(v)})).sort(fn); return e[0]; };
  const pnlTxt=s=>{ const e=Object.entries(s.pnlBy); return e.length?e.map(([c,v])=>`${fmt(v)} ${esc(c)}`).join(' · '):'–'; };
  const rows=Object.entries(g).map(([k,v])=>({k,...calc(v),arr:v})).sort((a,b)=>(b.n>0)-(a.n>0)||b.totalR-a.totalR);
  const row=(r,foot)=>{
    const ts=r.arr.length?top(r.arr,t=>t.strategy,(a,b)=>b.totalR-a.totalR):null, bs=r.arr.length?top(r.arr,t=>t.session,(a,b)=>b.avgR-a.avgR):null;
    return `<tr class="${foot?'foot-row':'mrow'+(sel===r.k?' sel':'')}" ${foot?'':`data-t="${esc(r.k)}"`}><td>${esc(r.k)}${!foot&&r.k===ME?' <span class="tag">you</span>':''}</td><td>${r.n}</td><td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td><td class="${cls(r.totalR)}">${fmt(r.totalR)}</td><td class="${cls(r.avgR)}">${fmt(r.avgR)}</td><td>${r.pf===Infinity?'∞':fmt(r.pf)}</td><td>${r.discipline==null?'–':fmt(r.discipline,0)+'%'}</td><td>${r.avgConf==null?'–':fmt(r.avgConf,1)}</td><td>${r.n?fmt(r.trailed/r.n*100,0)+'%':'–'}</td><td>${pnlTxt(r)}</td><td>${ts?esc(ts.k)+' <span class="hint">('+fmt(ts.totalR)+'R)</span>':'–'}</td><td>${bs?esc(bs.k):'–'}</td></tr>`;
  };
  const team={k:'Team total',...calc(list),arr:list};
  $('board').innerHTML=rows.length?`<table><tr><th>Member</th><th>Trades</th><th>Win %</th><th>Total R</th><th>Avg R</th><th>PF</th><th>Good %</th><th>Avg conf</th><th>Trailed</th><th>PnL</th><th>Best strategy</th><th>Best session</th></tr>`+rows.map(r=>row(r,false)).join('')+row(team,true)+'</table>':'<span style="color:var(--mut)">No members yet</span>';
  $('board').querySelectorAll('tr[data-t]').forEach(tr=>tr.onclick=()=>setScope(tr.dataset.t));
}
function tradesTable(list){
  const me=$('me').value.trim().toLowerCase(), rows=[...list].reverse();
  $('tbl').innerHTML=rows.length?`<table><tr><th>Date</th><th>Time (UTC)</th><th>Time (${esc(MYTZ)})</th><th>Closed (${esc(MYTZ)})</th><th>Held</th><th>Session</th><th>Trader</th><th>Instrument</th><th>Dir</th><th>Strategy</th><th>Lots</th><th>Risk</th><th>Risk %</th><th>Entry</th><th>Init SL</th><th>Final SL</th><th>Init TP</th><th>Exit</th><th>How it ended</th><th>Plan RR</th><th>R</th><th>PnL</th><th>Result</th><th>Quality</th><th>Conf</th><th>Shots</th><th>Notes</th><th></th></tr>`+
    rows.map(t=>`<tr><td>${esc(t.date)}</td><td>${fmtIn(t.openedUtc,'UTC',false)}</td><td title="Trader's own time: ${esc(fmtIn(t.openedUtc,t.timezone||'UTC',false))} ${esc(t.timezone)}">${fmtIn(t.openedUtc,MYTZ,false)}</td><td>${t.closedUtc?fmtIn(t.closedUtc,MYTZ,false):'–'}</td><td>${fmtDur(holdMin(t))}</td><td>${esc(t.session)||'–'}</td><td>${esc(t.trader)}</td><td>${esc(t.instrument)}</td><td>${t.direction}</td><td>${esc(t.strategy)}</td><td>${t.lots===''||t.lots==null?'–':fmt(t.lots,2)}</td><td>${t.risk===''||t.risk==null?'–':fmt(t.risk)}</td><td class="${t.riskPct>MYRISK*1.1?'neg':''}">${t.riskPct===''||t.riskPct==null?'–':fmt(t.riskPct,2)+'%'}</td><td>${t.entry}</td><td>${t.sl}</td><td>${t.trailed==='Yes'?t.finalSl+' ⤴':'–'}</td><td>${t.tp}</td><td>${t.exit}</td><td>${esc(exitOf(t))}</td><td>${t.plannedRR===''?'–':'1:'+t.plannedRR}</td><td class="${cls(t.r)}">${fmt(t.r)}</td><td class="${cls(t.pnl)}">${t.pnl===''?'–':fmt(t.pnl)+' '+esc(t.currency||'')}</td><td><span class="pill ${t.outcome}">${t.outcome}</span></td><td><span class="pill ${key(t.quality)}">${esc(t.quality)}</span></td><td>${miniBar(t.confidence)}</td><td class="shot-cell">${(t.shots&&t.shots.length)?`<button type="button" class="ghost small" data-view="${esc(t.shots.join(','))}">&#128247; ${t.shots.length}</button>`:''}${(String(t.trader).toLowerCase()===me&&(!t.shots||t.shots.length<MAXSHOTS))?`<button type="button" class="ghost small" data-addshot="${t.id}" title="Add screenshot">+&#128247;</button>`:''}</td><td style="white-space:normal;max-width:220px">${esc(t.notes)}</td><td>${String(t.trader).toLowerCase()===me?`<button class="ghost small" onclick="del('${t.id}')">✕</button>`:''}</td></tr>`).join('')+'</table>'
    :'<span style="color:var(--mut)">No trades yet – log your first one above.</span>';
}
const LINECOL=['#8b6cff','#22d3ee','#f5c542','#ff5f6d','#2fd27b','#f472b6','#fb923c','#60a5fa','#a3e635','#c084fc'];
function drawCurve(list){
  const leg=$('curveLegend'); leg.innerHTML='';
  if(!list.length){ $('curve').innerHTML='<span style="color:var(--mut)">No data</span>'; return; }
  const W=560,H=220,P=28, byT={}; list.forEach(t=>(byT[t.trader]=byT[t.trader]||[]).push(t));
  const multi=$('fTrader').value==='__ALL__' && Object.keys(byT).length>1;
  const series = multi ? Object.entries(byT).map(([k,v])=>({k,v})) : [{k:'',v:list}];
  const times=list.map(t=>Date.parse(t.date)||0), t0=Math.min(...times), t1=Math.max(...times);
  const S=series.map(s=>{ let eq=0; const pts=s.v.map(t=>{ eq+=+t.r||0; return {x:Date.parse(t.date)||0,y:eq}; }); return {k:s.k,pts:[{x:t0,y:0},...pts],eq}; });
  const all=S.flatMap(s=>s.pts.map(p=>p.y)), min=Math.min(...all,0), max=Math.max(...all,0), rng=(max-min)||1;
  const X=(p,i,n)=> P+ (t1>t0 ? (p.x-t0)/(t1-t0) : (n>1?i/(n-1):0))*(W-2*P), Y=v=>H-P-(v-min)/rng*(H-2*P);
  let svg=`<svg viewBox="0 0 ${W} ${H}" width="100%"><line x1="${P}" x2="${W-P}" y1="${Y(0)}" y2="${Y(0)}" stroke="#475569" stroke-dasharray="4"/>`;
  S.forEach((s,si)=>{
    const col = multi ? LINECOL[si%LINECOL.length] : (s.eq>=0?'#22c55e':'#ef4444');
    svg+=`<path d="${s.pts.map((p,i)=>(i?'L':'M')+X(p,i,s.pts.length).toFixed(1)+' '+Y(p.y).toFixed(1)).join(' ')}" fill="none" stroke="${col}" stroke-width="2"><title>${esc(s.k||'')} ${fmt(s.eq)}R</title></path>`;
    if(!multi) svg+=`<text x="${W-P}" y="${Y(s.eq)-6}" text-anchor="end" style="fill:${col};font-size:12px">${fmt(s.eq)}R</text>`;
  });
  svg+=`<text x="${P}" y="${Y(max)-4}">${fmt(max)}R</text><text x="${P}" y="${Y(min)+12}">${fmt(min)}R</text></svg>`;
  $('curve').innerHTML=svg;
  if(multi) leg.innerHTML=S.map((s,i)=>`<span><i style="background:${LINECOL[i%LINECOL.length]}"></i>${esc(s.k)} ${fmt(s.eq)}R</span>`).join('');
}
// ---- Admin tab (superadmin / admin only) ----
let INVITES = [], USERS = [];

function loadAdmin(){
  if(ROLE!=='admin' && ROLE!=='superadmin') return;
  $('adminWho').textContent = 'Signed in as ' + ME + ' (' + ROLE + ')';
  Promise.all([api('adminListInvites'), api('adminListUsers')])
    .then(([iv, us]) => { INVITES=iv; USERS=us; renderInvites(); renderUsers(); })
    .catch(fail);
}
$('ivRefresh').onclick = loadAdmin;

const shortDate = v => { if(!v) return '–'; const d=new Date(v); return isNaN(d)?'–':d.toISOString().slice(0,10); };

function renderInvites(){
  if(!INVITES.length){ $('ivList').innerHTML='<span class="hint">No invite codes yet. Create one above.</span>'; return; }
  $('ivList').innerHTML = '<table><tr><th>Code</th><th>Status</th><th>Used</th><th>For</th><th>Expires</th><th>Redeemed by</th><th>Created</th><th></th></tr>'
    + INVITES.map(i=>{
        const state = !i.active ? '<span class="badge dead">Revoked</span>'
          : i.spent ? '<span class="badge dead">Spent</span>'
          : '<span class="badge live">Active</span>';
        return `<tr><td class="code-cell">${esc(i.code)}</td><td>${state}</td><td>${i.uses} / ${i.maxUses}</td>`
          + `<td style="white-space:normal;max-width:200px">${esc(i.note)||'–'}</td><td>${i.expiresAt?shortDate(i.expiresAt):'Never'}</td>`
          + `<td>${i.usedBy.length?esc(i.usedBy.join(', ')):'–'}</td><td>${shortDate(i.createdAt)}</td>`
          + `<td class="shot-cell"><button type="button" class="ghost small" data-ivcopy="${esc(i.code)}">Copy</button>`
          + (i.active?`<button type="button" class="ghost small" data-ivoff="${i.id}">Revoke</button>`
                     :`<button type="button" class="ghost small" data-ivon="${i.id}">Restore</button>`)
          + `<button type="button" class="ghost small" data-ivdel="${i.id}">✕</button></td></tr>`;
      }).join('') + '</table>';

  $('ivList').querySelectorAll('[data-ivcopy]').forEach(b=>b.onclick=()=>copyCode(b.dataset.ivcopy, b));
  $('ivList').querySelectorAll('[data-ivoff]').forEach(b=>b.onclick=()=>api('adminSetInviteActive',b.dataset.ivoff,false).then(loadAdmin).catch(fail));
  $('ivList').querySelectorAll('[data-ivon]').forEach(b=>b.onclick=()=>api('adminSetInviteActive',b.dataset.ivon,true).then(loadAdmin).catch(fail));
  $('ivList').querySelectorAll('[data-ivdel]').forEach(b=>b.onclick=()=>{
    if(!confirm('Delete this invite code for good?')) return;
    api('adminDeleteInvite',b.dataset.ivdel).then(loadAdmin).catch(fail);
  });
}

function copyCode(code, btn){
  const done = () => { const t=btn.textContent; btn.textContent='Copied'; setTimeout(()=>{btn.textContent=t;},1200); };
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(code).then(done, ()=>prompt('Copy this invite code:', code));
  } else prompt('Copy this invite code:', code);
}

$('ivCreate').onclick = () => {
  $('ivMsg').textContent=''; $('ivCreate').disabled=true;
  api('adminCreateInvite', {
    note: $('ivNote').value.trim(),
    maxUses: $('ivUses').value,
    expiresInDays: $('ivDays').value,
    code: $('ivCode').value.trim()
  }).then(r=>{
    $('ivNote').value=''; $('ivCode').value=''; $('ivUses').value='1'; $('ivDays').value='';
    const box=$('ivNew'); box.hidden=false;
    box.innerHTML = `New invite code: <b>${esc(r.code)}</b> `
      + `<button type="button" class="ghost small" data-newcopy="${esc(r.code)}">Copy</button>`
      + `<div class="hint" style="margin-top:8px">Good for ${r.maxUses} ${r.maxUses===1?'person':'people'}`
      + `${r.expiresAt?' · expires '+shortDate(r.expiresAt):' · never expires'}. Share it privately.</div>`;
    box.querySelectorAll('[data-newcopy]').forEach(b=>b.onclick=()=>copyCode(b.dataset.newcopy,b));
    return loadAdmin();
  }).catch(e=>{ $('ivMsg').textContent = msgOf(e); })
    .finally(()=>{ $('ivCreate').disabled=false; });
};

function renderUsers(){
  const boss = ROLE==='superadmin';
  $('usrList').innerHTML = '<table><tr><th>Member</th><th>Email</th><th>Role</th><th>Status</th><th>Trades</th><th>Last trade</th><th>Joined</th>'
    + (boss?'<th>Actions</th>':'') + '</tr>'
    + USERS.map(u=>{
        const you = u.id && u.username===ME;
        const acts = !boss ? ''
          : `<td class="shot-cell">${
              u.role==='superadmin' || you ? '<span class="hint">–</span>' : [
                u.role==='admin'
                  ? `<button type="button" class="ghost small" data-role-user="${u.id}">Make member</button>`
                  : `<button type="button" class="ghost small" data-role-admin="${u.id}">Make admin</button>`,
                u.disabled
                  ? `<button type="button" class="ghost small" data-enable="${u.id}">Enable</button>`
                  : `<button type="button" class="ghost small" data-disable="${u.id}">Disable</button>`,
                `<button type="button" class="ghost small" data-udel="${u.id}">Delete</button>`
              ].join('')
            }</td>`;
        return `<tr><td><b>${esc(u.username)}</b>${you?' <span class="tag">you</span>':''}</td>`
          + `<td>${esc(u.email)||'–'}</td>`
          + `<td><span class="badge role-${esc(u.role)}">${esc(u.role)}</span></td>`
          + `<td>${u.disabled?'<span class="badge dead">Disabled</span>':'<span class="badge live">Active</span>'}</td>`
          + `<td>${u.trades}</td><td>${u.lastTrade||'–'}</td><td>${shortDate(u.createdAt)}</td>${acts}</tr>`;
      }).join('') + '</table>';

  if(!boss) return;
  const act = (sel, fn) => $('usrList').querySelectorAll('['+sel+']').forEach(b=>b.onclick=()=>fn(b.getAttribute(sel), b));
  act('data-role-admin', id => api('adminSetRole', id, 'admin').then(loadAdmin).catch(fail));
  act('data-role-user',  id => api('adminSetRole', id, 'user').then(loadAdmin).catch(fail));
  act('data-disable',    id => api('adminSetDisabled', id, true).then(loadAdmin).catch(fail));
  act('data-enable',     id => api('adminSetDisabled', id, false).then(loadAdmin).catch(fail));
  act('data-udel', id => {
    const u = USERS.find(x=>x.id===id); if(!u) return;
    if(!confirm('Delete ' + u.username + ' permanently?\n\nTheir '+u.trades+' trade(s), strategies, equity log and screenshots are all removed. This cannot be undone.')) return;
    if(prompt('Type the username to confirm:') !== u.username) return;
    api('adminDeleteUser', id).then(loadAdmin).catch(fail);
  });
}

(function boot(){
  setMode('login');
  // Builds the Supabase client; onAuthStateChange then restores a session,
  // finishes a Google redirect, or leaves the login card showing.
  supa().catch(e => { $('authErr').textContent = msgOf(e); });
})();
