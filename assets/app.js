let ALL = [], INSTR = [], STRATS = [];

const QUALS = ['Good Win','Bad Win','Good Loss','Bad Loss'];
const EXITS = ['Target hit','Ran past target','Trailed stop hit','Stopped out','Manual close'];
// Names only; the specs behind them live server-side so there is one source of truth.
const INSTRUMENT_GROUPS = ['FX majors','FX yen pairs','Metals','Indices','Crypto'];
const MISTAKES = ['Chased entry','Entered early','No setup','Moved stop','Oversized','Closed early','Held too long','Revenge trade','Overtraded'];
const EMOTIONS = ['Calm','Confident','FOMO','Anxious','Frustrated','Bored','Tilted','Distracted'];
let PICKED = [], EDITING = null, PENDING_EMAIL = '';   // mistake tags, and the trade being edited

// localStorage throws outright in some privacy modes, so never let it take the page down.
const lsGet = k => { try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } };
const lsSet = (k,v) => { try{ v ? localStorage.setItem(k,v) : localStorage.removeItem(k); }catch(e){} };

let CAN_TEAM = false;                 // granted by the server, never assumed here
let TEAM_HIDDEN = lsGet('tj_team_hidden') === '1';   // an admin's own preference
let MYRISK = 1;                                     // planned risk per trade, % of equity
let MYBROKER = '';                                  // whose pip settings we are using
let SIZE_SRC = 'lots';                              // which of lots / risk the trader last typed
const brokerOf = () => $('brokerSel').value || '';
const specOf = name => INSTR.find(i => i.trader===ME && i.name===name && (i.broker||'')===brokerOf()) || null;
let BROKERS = [];
/** Stored list, plus any broker still attached to an instrument, plus the active one. */
const myBrokers = () => [...new Set([
  ...BROKERS,
  ...INSTR.filter(i=>i.trader===ME).map(i=>i.broker||''),
  MYBROKER,
])].sort((a,b)=>a===''?-1:b===''?1:a.localeCompare(b));
const instrCount = b => INSTR.filter(i=>i.trader===ME && (i.broker||'')===b).length;
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
/** Renders instrument, strategy and POI in their own colour wherever they appear. */
const vtag = (v, kind) => v
  ? `<span class="vtag ${kind}" title="${esc(v)}">${esc(v)}</span>`
  : '<span class="vtag none">–</span>';

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
  ME=''; ROLE='user'; CAN_TEAM=false; applyTeamVisibility(); BOOTED=false; ALL=[]; FUNDS=[]; INSTR=[]; STRATS=[]; MEMBERS=[]; SCOPE_TOUCHED=false;
  $('me').value=''; $('meName').textContent='';
  document.body.classList.add('locked');
  document.body.classList.remove('onboarding','is-admin');
  $('aPw').value=''; $('authErr').textContent=''; $('authOk').textContent='';
  $('obUser').value=''; $('obInv').value=''; $('obErr').textContent=''; PENDING_EMAIL='';
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
  // Read the panes off the page rather than a list kept in step by hand: a
  // new tab added to the markup used to stay hidden until someone remembered
  // to name it here too.
  document.querySelectorAll('.tabpane').forEach(el=>{ el.hidden = el.id !== 'tab-'+n; });
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('on', b.dataset.tab===n));
  if(n==='admin') loadAdmin();
  if(n==='risk') renderRiskTab();
  if(n==='analysis') renderAnalysis();
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
  $('authResend').hidden     = !PENDING_EMAIL;
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
        PENDING_EMAIL = email;
        $('authOk').innerHTML = 'Check your inbox and confirm your email, then come back and log in.'
          + '<br>No email after a minute? <b>Continue with Google</b> works without one.';
        setModeSoft('login');
        $('authResend').hidden = false;
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

$('authResend').onclick = async () => {
  if(!PENDING_EMAIL) return;
  $('authErr').textContent=''; $('authResend').disabled=true;
  try{
    const sb = await supa();
    const { error } = await sb.auth.resend({ type:'signup', email: PENDING_EMAIL });
    if(error) throw error;
    $('authOk').textContent = 'Sent again to ' + PENDING_EMAIL + '. Check spam too.';
  }catch(e){ $('authErr').textContent = msgOf(e); }
  finally{ $('authResend').disabled=false; }
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
function setDir(v){
  $('dir').value = v==='Short' ? 'Short' : 'Long';
  // Flips the accent token inside the log pane, so every highlight follows the side.
  document.body.classList.toggle('dir-short', $('dir').value==='Short');
  document.querySelectorAll('[data-dir]').forEach(b=>{
    const on = b.dataset.dir===$('dir').value;
    b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
  });
  preview(); recalcSize();
}
document.querySelectorAll('[data-dir]').forEach(b=>b.onclick=()=>setDir(b.dataset.dir));
const CCOL=['','#ef4444','#f97316','#facc15','#84cc16','#22c55e'];
const miniBar=v=>{v=+v||0; if(!v) return '–'; return '<span class="cmini" title="'+v+'/5">'+[1,2,3,4,5].map(i=>`<i style="${i<=v?'background:'+CCOL[v]:''}"></i>`).join('')+'</span>';};
$('date').value = new Date().toLocaleDateString('en-CA');
$('trendBy').addEventListener('change',render);
['fTrader','fFrom','fTo','fInstr','fStrat','fQual','fTrail','fConf','fSess','fExit','fEmotion','fMistake','fPoi'].forEach(id => $(id).addEventListener('change', render));
$('anDay').addEventListener('change', () => renderAnalysis());
$('reset').onclick = () => { ['fFrom','fTo','fInstr','fStrat','fQual','fTrail','fConf','fSess','fExit','fEmotion','fMistake','fPoi'].forEach(i=>$(i).value=''); $('fTrader').value='__ALL__'; render(); };
$('refresh').onclick = () => load().catch(fail);
['entry','sl','fsl','tp','exit','risk','dir'].forEach(id => $(id).addEventListener('input', preview));

function load(){
  return api('getBootstrap').then(d => {
    if(d.needsOnboarding) return showOnboarding(d);
    ME=d.me; ROLE=d.role||'user'; $('me').value=ME; $('meName').textContent=ME;
    CAN_TEAM = !!d.canSeeTeam;
    applyTeamVisibility();
    document.body.classList.toggle('is-admin', ROLE==='admin'||ROLE==='superadmin');
    const wasLocked = document.body.classList.contains('locked');
    document.body.classList.remove('locked','onboarding');
    MYTZ=toOffsetTz(d.tz||BROWSER_TZ); if(d.tz!==MYTZ) api('saveTimezone',MYTZ).catch(()=>{});
    MYCCY=d.ccy||guessCcy(); if(!d.ccy) api('saveCurrency',MYCCY).catch(()=>{});
    ALL=d.trades; FUNDS=d.funds||[]; INSTR=d.instruments; STRATS=d.strategies; MEMBERS=d.members||[];
    MYRISK=+d.riskPct||1;
    /*
     * Brokers first: the instrument list is filtered by the selected broker,
     * which is read off #brokerSel. Filling the form before that select has
     * any options read the broker as "", matched no instrument, and left the
     * instrument dropdown empty until something happened to refill it.
     */
    MYBROKER=d.broker||''; BROKERS=d.brokers||[]; POIS=d.pois||[]; fillBrokers();
    fillForm(); fillFilters();
    if(!SCOPE_TOUCHED){ $('fTrader').value = (CAN_TEAM && !TEAM_HIDDEN && !ALL.some(t=>t.trader===ME)) ? '__ALL__' : ME; }
    fillTz(); fillCcy(); fillExitReason(); fillEmotions(); renderMistakes(); renderRules(); fillPois();
    render(); renderSetup(); recalcSize();
    if(!EDITING) setDir($('dir').value || 'Long');
    if(wasLocked) showTab('dash');
  });
}

const myInstr = () => INSTR.filter(i=>i.trader===ME && (i.broker||'')===brokerOf()).map(i=>i.name).sort();
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
  keep($('fTrader'), (CAN_TEAM && !TEAM_HIDDEN) ? [...MEMBERS,...ALL.map(t=>t.trader)] : [ME],
    (CAN_TEAM && !TEAM_HIDDEN) ? '<option value="__ALL__">Overall (whole team)</option>' : '');
  keep($('fPoi'), ALL.map(t=>t.poi), '<option value="">All</option><option value="__none">Not recorded</option>');
  keep($('fEmotion'), ALL.map(t=>t.emotion), '<option value="">All</option><option value="__none">Not recorded</option>');
  keep($('fMistake'), ALL.flatMap(t=>t.mistakes||[]), '<option value="">All</option><option value="__none">Clean trades only</option>');
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
  const ins=INSTR.filter(i=>i.trader===ME && (i.broker||'')===MYBROKER).map(i=>i.name).sort();
  $('myInstrList').innerHTML = ins.length
    ? ins.map(n=>`<span class="chip instr">${esc(n)}<button type="button" class="chip-x" data-inst="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button></span>`).join('')
    : '<span class="hint">No instruments yet – add the markets you trade.</span>';
  $('myInstrList').querySelectorAll('[data-inst]').forEach(b=>b.onclick=()=>{
    if(!confirm('Remove '+b.dataset.inst+' from your list? Past trades are kept.')) return;
    api('removeInstrument',b.dataset.inst,MYBROKER).then(load).catch(fail);
  });
  fillBrokers(); renderInstrSpecs(); renderPoiList(); renderPresets(); fillPois();
  $('setRisk').value=MYRISK;
  const ss=myStratObjs();
  $('myStratList').innerHTML = ss.length ? ss.map(s=>{
    const st=calc(ALL.filter(t=>t.trader===ME&&t.strategy===s.name));
    return `<div class="pb-item"><div class="pb-top">${vtag(s.name,'strat')}<span class="pb-meta">${st.n} trades · ${st.winRate==null?'–':fmt(st.winRate,0)+'% win'} · <span class="${cls(st.totalR)}">${fmt(st.totalR)}R</span></span></div>
      <div class="pb-desc">${esc(s.description)||'<span class="hint">No description yet</span>'}</div>
      <div class="pb-actions"><button type="button" class="ghost small" data-edit="${esc(s.name)}">Edit</button><button type="button" class="ghost small" data-del="${esc(s.name)}">Remove</button></div></div>`;
  }).join('') : '<span class="hint">No strategies yet – write your first one above.</span>';
  $('myStratList').querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>{
    const s=myStratObjs().find(x=>x.name===b.dataset.edit); if(!s) return;
    $('stName').value=s.name; $('stDesc').value=s.description||''; $('stRules').value=(s.rules||[]).join('\n'); $('stName').focus(); window.scrollTo({top:0,behavior:'smooth'});
  });
  $('myStratList').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    if(!confirm('Remove strategy "'+b.dataset.del+'"? Past trades are kept.')) return;
    api('removeStrategy',b.dataset.del).then(load).catch(fail);
  });
}

function renderPresets(){
  $('instrPresets').innerHTML = '<span class="p-l">Start from</span>'
    + INSTRUMENT_GROUPS.map(g=>`<button type="button" class="ghost small" data-preset="${esc(g)}">${esc(g)}</button>`).join('');
  $('instrPresets').querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
    const g=b.dataset.preset; b.disabled=true; $('setInstrMsg').textContent='';
    api('addInstrumentPreset', g, MYBROKER)
      .then(r=>load().then(()=>{
        $('setInstrMsg').textContent = r.added.length
          ? `Added ${r.added.length} to ${MYBROKER||'(no broker set)'}. Check the pip values against your broker.`
          : 'All of those are already on this broker.';
      }))
      .catch(e=>{ $('setInstrMsg').textContent = msgOf(e); })
      .finally(()=>{ b.disabled=false; });
  });
}
$('poiPreset').onclick = () => {
  $('poiPreset').disabled=true; $('poiMsg').textContent='';
  api('addPoiPreset').then(()=>load().then(()=>{ $('poiMsg').textContent='Common levels added. Remove any you do not trade.'; }))
    .catch(e=>{ $('poiMsg').textContent=msgOf(e); })
    .finally(()=>{ $('poiPreset').disabled=false; });
};

function renderPoiList(){
  $('myPoiList').innerHTML = POIS.length
    ? POIS.map(n=>`<span class="chip poi">${esc(n)}<button type="button" class="chip-x" data-poi="${esc(n)}" aria-label="Remove ${esc(n)}">✕</button></span>`).join('')
    : '<span class="hint">No points of interest yet.</span>';
  $('myPoiList').querySelectorAll('[data-poi]').forEach(b=>b.onclick=()=>{
    const n=b.dataset.poi, used=ALL.filter(t=>t.trader===ME && t.poi===n).length;
    if(!confirm(used
      ? 'Remove "'+n+'"? '+used+' logged trade'+(used===1?'':'s')+' keep it — only the picker loses the option.'
      : 'Remove "'+n+'"?')) return;
    $('poiMsg').textContent='';
    api('removePoi',n).then(()=>load()).catch(e=>{ $('poiMsg').textContent=msgOf(e); });
  });
}
$('addPoi').onclick = () => {
  const v=$('newPoi').value.trim();
  if(!v){ $('poiMsg').textContent='Type a name first.'; $('newPoi').focus(); return; }
  $('addPoi').disabled=true; $('poiMsg').textContent='';
  api('addPoi',v).then(()=>load().then(()=>{ $('newPoi').value=''; $('poiMsg').textContent='Added "'+v+'".'; }))
    .catch(e=>{ $('poiMsg').textContent=msgOf(e); })
    .finally(()=>{ $('addPoi').disabled=false; });
};
$('newPoi').addEventListener('keydown', e => { if(e.key==='Enter'){ e.preventDefault(); $('addPoi').click(); } });

function renderInstrSpecs(){
  const ins=INSTR.filter(i=>i.trader===ME && (i.broker||'')===MYBROKER)
    .sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  if(!ins.length){ $('instrSpecs').innerHTML=''; return; }
  /*
   * One block per instrument rather than one wide row. The five fields used
   * to run off the side of the column, which put Save behind a sideways
   * scroll - easy to miss, so edits were being typed and then lost.
   */
  const fld=(i,n,k,lbl,val,ph)=>`<div><label for="sp-${k}-${n}">${lbl}</label>`
    + `<input id="sp-${k}-${n}" type="number" step="any" min="0" data-sp="${k}" `
    + `data-for="${esc(i.name)}" value="${val??''}"${ph?` placeholder="${ph}"`:''}></div>`;
  $('instrSpecs').innerHTML='<div class="spec-list">'
    + ins.map((i,n)=>`<div class="spec-card">`
        + `<div class="spec-top">${vtag(i.name,'instr')}`
        + `<span><button type="button" class="ghost small" data-spsave="${esc(i.name)}">Save</button> `
        + `<span class="spec-msg" data-spmsg="${esc(i.name)}"></span></span></div>`
        + `<div class="spec-grid">`
        + fld(i,n,'pip','Pip size',i.pipSize,'0.0001')
        + fld(i,n,'val','Value / pip',i.valuePerPip,'10')
        + fld(i,n,'step','Lot step',i.lotStep??0.01,'')
        + fld(i,n,'comm','Commission / lot',i.commissionPerLot??0,'')
        + `</div></div>`).join('')
    + '</div>';
  $('instrSpecs').querySelectorAll('[data-spsave]').forEach(b=>b.onclick=()=>{
    const n=b.dataset.spsave, pick=k=>$('instrSpecs').querySelector(`[data-sp="${k}"][data-for="${CSS.escape(n)}"]`).value;
    const msg=$('instrSpecs').querySelector(`[data-spmsg="${CSS.escape(n)}"]`);
    msg.textContent='Saving…';
    api('saveInstrumentSpec',n,{pipSize:pick('pip'),valuePerPip:pick('val'),lotStep:pick('step'),commissionPerLot:pick('comm'),broker:MYBROKER})
      .then(()=>{ msg.textContent='Saved'; return load(); })
      .catch(e=>{ msg.textContent=msgOf(e); });
  });
}
$('setRiskSave').onclick=()=>{
  api('saveRiskPct',$('setRisk').value).then(p=>{ MYRISK=p; $('setRiskMsg').textContent='Saved: '+p+'% per trade'; recalcSize(); render(); }).catch(fail);
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
  api('addInstrument',v,MYBROKER).then(()=>{ $('setInstr').value=''; return load(); }).catch(fail);
};
$('setInstr').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); $('setInstrAdd').click(); } });
$('stSave').onclick=()=>{
  const n=$('stName').value.trim(); if(!n){ alert('Give the strategy a name.'); return; }
  api('saveStrategy',n,$('stDesc').value.trim(),$('stRules').value).then(()=>{ $('stName').value=''; $('stDesc').value=''; $('stRules').value=''; return load(); }).catch(fail);
};

// ---- live preview & quality options ----
/**
 * The prices only make sense read against the direction: a long stops out
 * below and targets above, a short the other way round. Checking it here
 * means the form says so while it is being typed, rather than the server
 * rejecting the trade after everything else has been filled in.
 */
function dirProblem(){
  const dir=$('dir').value, e=+$('entry').value, s=+$('sl').value, tp=$('tp').value;
  if($('entry').value==='' || isNaN(e)) return null;
  const long = dir!=='Short', side = long?'above':'below', other = long?'below':'above';
  if($('sl').value!=='' && !isNaN(s) && (long ? s>=e : s<=e)){
    return {msg:`${dir}: the initial stop must be ${other} the entry.`, bad:['sl']};
  }
  if(tp!=='' && !isNaN(+tp) && (long ? +tp<=e : +tp>=e)){
    return {msg:`${dir}: the take profit must be ${side} the entry.`, bad:['tp']};
  }
  return null;
}
function calcLive(){
  const e=+$('entry').value, s=+$('sl').value, x=$('exit').value, tp=$('tp').value, dir=$('dir').value;
  if(!$('entry').value || !$('sl').value) return null;
  const bad=dirProblem();
  if(bad) return {err:bad.msg};
  const d=e-s, o={};
  if(tp!=='') o.plan=Math.abs(+tp-e)/Math.abs(d);
  if(x!==''){ o.r=(+x-e)/d; o.out=o.r>0.05?'Win':o.r<-0.05?'Loss':'BE'; }
  return o;
}
/** Rings the field that is on the wrong side, so the message has a target. */
function markDirFields(){
  const bad=dirProblem(), set=new Set(bad?bad.bad:[]);
  ['sl','tp'].forEach(id=>$(id).classList.toggle('bad', set.has(id)));
  return bad;
}
function preview(){
  const out=[];
  // A price on the wrong side is worth saying before anything else, and is
  // worth saying even while the rest of the form is still blank.
  const wrongWay=markDirFields();
  $('preview').classList.toggle('bad-note', !!wrongWay);
  if(wrongWay){ $('preview').textContent='\u26a0 '+wrongWay.msg; updateQuality(); return; }
  const o=calcLive();
  if(!o){ $('preview').textContent='Fill entry, initial SL and exit to preview.'; updateQuality(); return; }
  if(o.plan!=null) out.push('Planned R:R 1:'+fmt(o.plan));
  // The server rounds R to 2dp before pricing it, so preview from the same
  // figure - otherwise the net shown here and the net saved disagree.
  const r2 = o.r==null ? null : Math.round(o.r*100)/100;
  if(r2!=null) out.push('Result '+fmt(r2)+'R ('+o.out+')');
  const f=$('fsl').value, s=$('sl').value;
  if(f!=='' && +f!==+s) out.push('SL trailed');
  const c=Math.abs(+$('comm').value||0);
  if(c){
    const gross = (r2!=null && +$('risk').value) ? Math.round(r2 * +$('risk').value * 100)/100 : null;
    out.push(gross!=null ? `Commission ${fmt(c)} · net ${fmt(Math.round((gross-c)*100)/100)}` : `Commission ${fmt(c)}`);
  }
  $('preview').textContent=out.join('  •  ');
  updateQuality(); updateExitHint();
}
const brokerLabel = b => b || 'No broker set';

function fillBrokers(){
  const list = myBrokers();
  const cur = $('brokerSel').value || MYBROKER;
  $('brokerSel').innerHTML = list
    .map(b=>`<option value="${esc(b)}"${b===(list.includes(cur)?cur:MYBROKER)?' selected':''}>${esc(brokerLabel(b))}</option>`)
    .join('');
  renderBrokerPicks();
}

/** Switching brokers is a segmented control; adding one is its own control. */
function renderBrokerPicks(){
  const list = myBrokers();
  $('brokerPicks').innerHTML = list.map(b=>{
    const on = b===MYBROKER, n = instrCount(b);
    return `<span class="bb-pick"><button type="button" class="${on?'on':''}" data-bpick="${esc(b)}" aria-pressed="${on}">`
      + `${esc(brokerLabel(b))}<span class="hint" style="margin:0 0 0 7px">${n}</span></button>`
      + (list.length>1 && b!=='' ? `<button type="button" class="bb-x" data-bdel="${esc(b)}" title="Remove ${esc(brokerLabel(b))}" aria-label="Remove ${esc(brokerLabel(b))}">&#10005;</button>` : '')
      + '</span>';
  }).join('');

  $('brokerPicks').querySelectorAll('[data-bpick]').forEach(b=>b.onclick=()=>{
    if(b.dataset.bpick===MYBROKER) return;
    $('brokerMsg').textContent='Switching…';
    api('saveBroker', b.dataset.bpick).then(()=>{ $('brokerMsg').textContent=''; return load(); }).catch(e=>{
      $('brokerMsg').textContent = msgOf(e);
    });
  });
  $('brokerPicks').querySelectorAll('[data-bdel]').forEach(b=>b.onclick=()=>{
    const name=b.dataset.bdel;
    if(!confirm('Remove the broker "'+name+'"?')) return;
    $('brokerMsg').textContent='';
    api('removeBroker', name).then(()=>load()).catch(e=>{ $('brokerMsg').textContent = msgOf(e); });
  });
}

$('newBroker').addEventListener('keydown', e => {
  if(e.key==='Enter'){ e.preventDefault(); $('addBroker').click(); }
});
$('brokerSel').addEventListener('change', () => { fillForm(); recalcSize(); });
$('addBroker').onclick = () => {
  const name = $('newBroker').value.trim();
  if(!name){ $('brokerMsg').textContent='Type a broker name first.'; $('newBroker').focus(); return; }
  $('addBroker').disabled=true; $('brokerMsg').textContent='';
  api('addBroker', name)
    .then(()=>load().then(()=>{ $('newBroker').value=''; $('brokerMsg').textContent='Added "'+name+'". Now add its instruments and pip values below.'; }))
    .catch(e=>{ $('brokerMsg').textContent = msgOf(e); })
    .finally(()=>{ $('addBroker').disabled=false; });
};

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

function renderMistakes(){
  $('mistakes').innerHTML = MISTAKES.map(m =>
    `<button type="button" class="tagpick${PICKED.includes(m)?' on':''}" data-m="${esc(m)}" aria-pressed="${PICKED.includes(m)}">${esc(m)}</button>`).join('');
  $('mistakes').querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
    const m = b.dataset.m;
    PICKED = PICKED.includes(m) ? PICKED.filter(x => x !== m) : [...PICKED, m];
    renderMistakes();
  });
}
function fillEmotions(){
  const cur = $('emotion').value;
  $('emotion').innerHTML = '<option value="">— not recorded —</option>' + EMOTIONS.map(e=>`<option>${e}</option>`).join('');
  if(EMOTIONS.includes(cur)) $('emotion').value = cur;
}
const rulesOf = name => (STRATS.find(s => s.trader===ME && s.name===name) || {}).rules || [];
let POIS = [];                      // the trader's library, usable with any strategy

/** Any POI pairs with any strategy, so the list never depends on the strategy. */
function fillPois(selected){
  const cur = selected !== undefined ? selected : $('poi').value;
  $('poi').innerHTML = '<option value="">— not recorded —</option>'
    + POIS.map(v=>`<option>${esc(v)}</option>`).join('');
  if(POIS.includes(cur)) $('poi').value = cur;
  $('poi').disabled = !POIS.length;
  $('poiHint').textContent = POIS.length
    ? 'The level this setup formed at'
    : 'No points of interest yet — add them in My Setup';
}

function renderRules(checked){
  const list = rulesOf($('strat').value);
  $('ruleBox').hidden = !list.length;
  if(!list.length){ $('rules').innerHTML=''; $('ruleHint').textContent=''; return; }
  const on = checked || [];
  $('rules').innerHTML = list.map((r,i) =>
    `<label class="rule${on.includes(r)?'':' off'}"><input type="checkbox" data-rule="${i}"${on.includes(r)?' checked':''}><span>${esc(r)}</span></label>`).join('');
  $('rules').querySelectorAll('[data-rule]').forEach(cb => cb.onchange = () => {
    cb.closest('.rule').classList.toggle('off', !cb.checked);
    updateRuleHint();
  });
  updateRuleHint();
}
function checkedRules(){
  const list = rulesOf($('strat').value);
  return [...$('rules').querySelectorAll('[data-rule]')].filter(cb=>cb.checked).map(cb=>list[+cb.dataset.rule]).filter(Boolean);
}
function updateRuleHint(){
  const list = rulesOf($('strat').value), n = checkedRules().length;
  $('ruleHint').innerHTML = !list.length ? ''
    : n === list.length ? '<span class="pos">All ' + list.length + ' followed.</span>'
    : `${n} of ${list.length} followed &mdash; <span class="neg">${list.length-n} broken</span>.`;
}
$('strat').addEventListener('change', () => renderRules());

/* ================= Risk Architect & Ledger ================= */
let CAL_MONTH = null;                       // Date pinned to the 1st of the shown month

/** Standalone sizing engine: same maths as the entry form, no trade required. */
function renderRiskCalc(){
  const list = myBrokers(), label = b => b || '(no broker set)';
  if($('rcBroker').options.length !== list.length){
    $('rcBroker').innerHTML = list.map(b=>`<option value="${esc(b)}">${esc(label(b))}</option>`).join('');
    $('rcBroker').value = MYBROKER;
  }
  const brk = $('rcBroker').value || '';
  const names = INSTR.filter(i=>i.trader===ME && (i.broker||'')===brk).map(i=>i.name).sort();
  const keep = $('rcInstr').value;
  $('rcInstr').innerHTML = '<option value="">— select —</option>' + names.map(n=>`<option>${esc(n)}</option>`).join('');
  if(names.includes(keep)) $('rcInstr').value = keep;
  if(!$('rcPct').value) $('rcPct').value = MYRISK;

  const sp = INSTR.find(i=>i.trader===ME && i.name===$('rcInstr').value && (i.broker||'')===brk) || null;
  const ccy = MYCCY, equity = equityIn(ccy);
  $('rcEquity').textContent = 'Equity slice: ' + fmt(equity) + ' ' + ccy;

  const entry=+$('rcEntry').value, sl=+$('rcSl').value;
  const tp=$('rcTp').value===''?null:+$('rcTp').value;
  const pct=+$('rcPct').value||MYRISK;
  const cell=(l,v,k='',lead=false)=>`<div class="stat${lead?' lead':''}"><div class="l">${l}</div><div class="v ${k}">${v}</div></div>`;

  if(!hasSpec(sp)){
    $('rcOut').innerHTML='';
    $('rcNote').textContent = brk || names.length
      ? 'Pick an instrument with a pip value set in My Setup.'
      : 'Add a broker and its instruments in My Setup first.';
    return;
  }
  if($('rcEntry').value===''||$('rcSl').value===''||entry===sl||equity<=0){
    $('rcOut').innerHTML='';
    $('rcNote').textContent = equity<=0
      ? 'Record your starting deposit in My Setup and this can size against it.'
      : 'Fill entry and stop loss to size a position.';
    return;
  }

  const stopPips=Math.abs(entry-sl)/sp.pipSize;
  const riskMoney=equity*pct/100;
  const lots=lotsForRisk(entry,sl,riskMoney,sp);
  const m=v=>fmt(v)+' '+esc(ccy);
  let html = cell('Recommended size', lots>0?fmt(lots,2)+' lots':'too small', lots>0?'':'neg', true)
    + cell('Risk value', m(riskMoney), 'neg')
    + cell('Stop distance', fmt(stopPips,1)+' pips')
    + cell('Equity', m(equity));
  if(tp!==null && isFinite(tp)){
    const rewardPips=Math.abs(tp-entry)/sp.pipSize;
    html += cell('Upside gain', m(rewardPips*sp.valuePerPip*(lots||0)), 'pos')
          + cell('Planned R:R', '1:'+fmt(rewardPips/stopPips));
  }
  $('rcOut').innerHTML = html;
  $('rcNote').innerHTML = riskVerdict(pct) || 'Within your plan.';
}
['rcBroker','rcInstr','rcPct','rcEntry','rcSl','rcTp'].forEach(id=>
  $(id).addEventListener('input', renderRiskCalc));
$('rcBroker').addEventListener('change', renderRiskCalc);

/** A month of trading at a glance: the shape of your discipline, day by day. */
function renderCalendar(){
  const mine = myTrades();
  if(!CAL_MONTH){
    const last = mine.length ? mine[mine.length-1].date : null;
    CAL_MONTH = last ? new Date(last+'T00:00:00Z') : new Date();
    CAL_MONTH = new Date(Date.UTC(CAL_MONTH.getUTCFullYear(), CAL_MONTH.getUTCMonth(), 1));
  }
  const y=CAL_MONTH.getUTCFullYear(), mo=CAL_MONTH.getUTCMonth();
  const name = CAL_MONTH.toLocaleDateString('en-GB',{month:'long',year:'numeric',timeZone:'UTC'});
  $('calLabel').textContent = name.toUpperCase();
  $('calTitle').textContent = name + ' performance ledger';

  const byDay = {};
  mine.forEach(t=>{
    const d = new Date(t.date+'T00:00:00Z');
    if(d.getUTCFullYear()!==y || d.getUTCMonth()!==mo) return;
    (byDay[t.date] = byDay[t.date] || []).push(t);
  });
  const days = Object.values(byDay);
  const green = days.filter(d=>d.reduce((a,t)=>a+(+t.r||0),0) > 0).length;
  const red   = days.filter(d=>d.reduce((a,t)=>a+(+t.r||0),0) < 0).length;
  const all   = Object.values(byDay).flat();
  const st    = calc(all);
  const pnl   = all.reduce((a,t)=>a+(+t.pnl||0),0);
  const cell=(l,v,k='')=>`<div class="stat"><div class="l">${l}</div><div class="v ${k}">${v}</div></div>`;
  $('calStats').innerHTML =
    cell('Traded days', days.length) + cell('Green days', green, green?'pos':'') +
    cell('Red days', red, red?'neg':'') +
    cell('Win rate', st.winRate==null?'–':fmt(st.winRate,1)+'%', st.winRate>=50?'pos':'neg') +
    cell('Net R', fmt(st.totalR), cls(st.totalR)) +
    cell('Net P&L', all.length?fmt(pnl)+' '+esc(MYCCY):'–', cls(pnl));

  // Monday-first grid, weekends folded away: markets and journals both rest.
  const first = new Date(Date.UTC(y,mo,1));
  const lead = (first.getUTCDay()+6)%7;
  const start = new Date(Date.UTC(y,mo,1-lead));
  const end = new Date(Date.UTC(y,mo+1,0));
  const weeks = [];
  for(let cur=new Date(start); cur<=end || cur.getUTCDay()!==1; cur.setUTCDate(cur.getUTCDate()+1)){
    if(cur.getUTCDay()===1) weeks.push([]);
    if(cur.getUTCDay()===0 || cur.getUTCDay()===6) continue;
    if(!weeks.length) weeks.push([]);
    weeks[weeks.length-1].push(new Date(cur));
    if(cur > end && cur.getUTCDay()===5) break;
  }
  const iso = d => d.toISOString().slice(0,10);
  let html = '<table class="cal"><tr><th>Mon</th><th>Tue</th><th>Wed</th><th>Thu</th><th>Fri</th><th style="text-align:right">Week</th></tr>';
  // A leading or trailing week wholly outside the month is just an empty row.
  const shown = weeks.filter(wk => wk.some(d => d.getUTCMonth()===mo));
  shown.forEach((wk,i)=>{
    if(!wk.length) return;
    let wr=0, wp=0, any=false;
    html += '<tr>';
    wk.forEach(d=>{
      const inMonth = d.getUTCMonth()===mo;
      const rows = inMonth ? (byDay[iso(d)]||[]) : [];
      const r = rows.reduce((a,t)=>a+(+t.r||0),0);
      const money = rows.reduce((a,t)=>a+(+t.pnl||0),0);
      if(rows.length){ wr+=r; wp+=money; any=true; }
      const klass = !inMonth ? 'out' : rows.length ? (r>0?'win':r<0?'loss':'') : '';
      html += `<td class="${klass}">`
        + `<span class="dnum">${inMonth?d.getUTCDate():''}</span>`
        + (rows.length?`<span class="dr ${cls(r)}">${r>0?'+':''}${fmt(r,1)}R</span>`:'')
        + (rows.length
            ? `<span class="dpnl ${cls(money)}">${money?fmt(money)+' '+esc(MYCCY):fmt(r,2)+'R'}</span>`
              + `<span class="dn">${rows.length} execution${rows.length>1?'s':''}</span>`
            : inMonth ? '<span class="dn" style="margin-top:16px;display:block">no trades</span>' : '')
        + '</td>';
    });
    html += `<td class="week"><span class="dn">Week ${i+1}</span>`
      + (any?`<span class="dpnl ${cls(wp||wr)}">${wp?fmt(wp)+' '+esc(MYCCY):fmt(wr,2)+'R'}</span><span class="dn">${wr>0?'+':''}${fmt(wr,1)}R net</span>`:'<span class="dpnl" style="color:var(--mut-2)">—</span>')
      + '</td></tr>';
  });
  $('calGrid').innerHTML = html + '</table>';

  // Recent run: the last ten sessions, newest on the right.
  const recent = Object.keys(byDay).sort().slice(-10)
    .map(k => byDay[k].reduce((a,t)=>a+(+t.r||0),0));
  $('calNote').innerHTML = days.length
    ? `Recent run <span class="runstrip">${recent.map(r=>`<i style="background:${r>0?'var(--g)':r<0?'var(--r)':'var(--mut-2)'}"></i>`).join('')}</span>`
    : 'No trades logged this month.';
}
$('calPrev').onclick = () => { CAL_MONTH.setUTCMonth(CAL_MONTH.getUTCMonth()-1); renderCalendar(); };
$('calNext').onclick = () => { CAL_MONTH.setUTCMonth(CAL_MONTH.getUTCMonth()+1); renderCalendar(); };

function renderRiskTab(){ renderRiskCalc(); renderCalendar(); }

/* ---------------- risk intelligence ----------------
 * Everything here is measured from the trader's OWN history. Sizing advice
 * from a textbook is easy to ignore; "you lose money above 2%, here is the
 * number" is not.
 */
const RISK_BANDS = [
  { k:'under 0.5%', lo:0,   hi:0.5 },
  { k:'0.5-1%',     lo:0.5, hi:1 },
  { k:'1-2%',       lo:1,   hi:2 },
  { k:'2-3%',       lo:2,   hi:3 },
  { k:'over 3%',    lo:3,   hi:Infinity },
];
const MIN_BAND_SAMPLE = 5;                 // below this, a band is noise

function riskBands(list){
  const scoped = list.filter(t => +t.riskPct > 0);
  return RISK_BANDS.map(b => {
    const hit = scoped.filter(t => +t.riskPct > b.lo && +t.riskPct <= b.hi);
    return hit.length ? { ...b, ...calc(hit), avgRiskPct: hit.reduce((a,t)=>a+ +t.riskPct,0)/hit.length } : null;
  }).filter(Boolean);
}

/** The band with the best expectancy, ignoring ones too small to trust. */
function sweetSpot(list){
  const solid = riskBands(list).filter(b => b.n >= MIN_BAND_SAMPLE && b.avgR != null);
  if(!solid.length) return null;
  return solid.reduce((best,b) => b.avgR > best.avgR ? b : best);
}

const myTrades = () => ALL.filter(t => t.trader === ME);

/** What happens to this trader when they size above a given risk level. */
function aboveBelow(list, pct){
  const scoped = list.filter(t => +t.riskPct > 0);
  const above = scoped.filter(t => +t.riskPct > pct);
  const below = scoped.filter(t => +t.riskPct <= pct);
  return { above: above.length?calc(above):null, below: below.length?calc(below):null,
           nAbove: above.length, nBelow: below.length };
}

/**
 * The warning that matters: at this size, what has actually happened to this
 * trader before? Silent unless their own record says something.
 */
function riskVerdict(pct){
  if(pct==null || !(pct>0)) return '';
  const mine = myTrades();
  const spot = sweetSpot(mine);
  const bits = [];

  if(spot){
    if(pct > spot.hi){
      const cut = aboveBelow(mine, spot.hi);
      if(cut.above && cut.below && cut.nAbove >= MIN_BAND_SAMPLE){
        const wrDrop = (cut.below.winRate!=null && cut.above.winRate!=null)
          ? cut.below.winRate - cut.above.winRate : null;
        bits.push(`<br>Your best results come from <b>${spot.k}</b> risk `
          + `(${fmt(spot.avgR)}R a trade over ${spot.n}). `
          + `Above ${fmt(spot.hi,1)}% you have won <b class="neg">${fmt(cut.above.winRate,0)}%</b> `
          + `versus ${fmt(cut.below.winRate,0)}%`
          + (wrDrop!=null && wrDrop>0 ? ` &mdash; a <b class="neg">${fmt(wrDrop,0)} point</b> drop` : '')
          + `, at ${fmt(cut.above.avgR)}R a trade.`);
      } else {
        bits.push(`<br>Your best results come from <b>${spot.k}</b> risk (${fmt(spot.avgR)}R a trade over ${spot.n}).`);
      }
    } else {
      bits.push(`<br><span class="pos">In line with your best band (${spot.k}, ${fmt(spot.avgR)}R a trade).</span>`);
    }
  } else if(mine.filter(t=>+t.riskPct>0).length){
    bits.push('<br>Not enough sized trades yet to tell you your best risk level.');
  }

  // Sizing frozen at an old account size is the quiet one nobody notices.
  const recent = mine.slice(-10).filter(t=>+t.riskPct>0);
  if(recent.length >= 3){
    const avg = recent.reduce((a,t)=>a+ +t.riskPct,0)/recent.length;
    if(avg < MYRISK*0.7){
      bits.push(`<br>Your last ${recent.length} trades averaged <b>${fmt(avg,2)}%</b> against a `
        + `${fmt(MYRISK,2)}% plan &mdash; your size has not kept up with your equity.`);
    }
  }
  return bits.join('');
}


/**
 * Lot size and risk amount are two views of the same decision, so whichever
 * the trader typed last drives the other. Sizing by money ("I'll risk 200")
 * is how most people actually think, and it was previously impossible.
 */
function recalcSize(){
  const sp=specOf($('instr').value), entry=+$('entry').value, sl=+$('sl').value;
  const priced = $('entry').value!=='' && $('sl').value!=='' && entry!==sl && hasSpec(sp);

  if(priced){
    if(SIZE_SRC==='risk' && $('risk').value!==''){
      const lots = lotsForRisk(entry, sl, +$('risk').value, sp);
      $('lots').value = lots>0 ? lots : '';
      $('lotsHint').textContent = lots>0
        ? 'Sized from your risk amount'
        : 'Even the smallest lot risks more than that';
      $('riskHint').textContent = 'You set this';
    } else if($('lots').value!==''){
      const r = riskOfPosition(entry, sl, +$('lots').value, sp);
      if(r!=null) $('risk').value = r;
      $('lotsHint').textContent = 'You set this';
      $('riskHint').textContent = 'Worked out from your lot size';
    } else {
      $('lotsHint').textContent='Type either this or the risk amount';
      $('riskHint').textContent='Type a risk and the lot size follows';
    }
  } else {
    $('lotsHint').textContent = hasSpec(sp) ? 'Fill entry and initial SL' : "Set this instrument's pip value in My Setup";
    $('riskHint').textContent = 'Type a risk and the lot size follows';
  }
  syncCommission();
  renderPipStrip();
  preview();
}

/**
 * Prefills commission from the instrument's rate, but stops the moment the
 * trader types their own - a rate that changed for one trade should not be
 * overwritten by the next keystroke elsewhere on the form.
 */
let COMM_TOUCHED = false;
function syncCommission(){
  const sp = specOf($('instr').value), lots = +$('lots').value;
  const rate = sp && sp.commissionPerLot > 0 ? sp.commissionPerLot : 0;
  if(!COMM_TOUCHED){
    $('comm').value = (rate && lots > 0) ? Math.round(Math.abs(rate) * lots * 100) / 100 : '';
  }
  const typed = +$('comm').value || 0;
  $('commHint').textContent = COMM_TOUCHED
    ? (typed < 0
        ? 'You set this — read as a cost of ' + fmt(Math.abs(typed))
        : 'You set this for this trade')
    : rate ? fmt(rate) + ' per lot from My Setup'
           : 'No rate set for this instrument';
}
$('comm').addEventListener('input', () => { COMM_TOUCHED = true; syncCommission(); preview(); });
$('lots').addEventListener('input',()=>{ SIZE_SRC='lots'; recalcSize(); });
$('risk').addEventListener('input',()=>{ SIZE_SRC='risk'; recalcSize(); });
['entry','sl','tp','ccy'].forEach(id=>$(id).addEventListener('input',()=>recalcSize()));
$('instr').addEventListener('change',()=>recalcSize());

/** The numbers a trader checks before clicking, kept at the top of the form. */
function renderPipStrip(){
  const sp=specOf($('instr').value), entry=+$('entry').value, sl=+$('sl').value;
  const tp=$('tp').value===''?null:+$('tp').value, lots=+$('lots').value, risk=+$('risk').value;
  const ccy=$('ccy').value||MYCCY, equity=equityIn(ccy);
  const px = $('entry').value!=='' && $('sl').value!=='' && entry!==sl;
  const unit = hasSpec(sp) ? sp.pipSize : null;

  const stopPips = px && unit ? Math.abs(entry-sl)/unit : null;
  const tpPips   = px && unit && tp!==null ? Math.abs(tp-entry)/unit : null;
  $('pipSl').textContent = stopPips==null ? '–' : fmt(stopPips,1)+' pips';
  $('pipTp').textContent = tpPips==null ? '–' : fmt(tpPips,1)+' pips';
  $('pipRr').textContent = (stopPips&&tpPips) ? '1:'+fmt(tpPips/stopPips) : '–';
  $('pipLots').textContent = lots>0 ? fmt(lots,2) : '–';
  $('pipRisk').textContent = risk>0 ? fmt(risk)+' '+esc(ccy) : '–';

  const pct = (risk>0 && equity>0) ? risk/equity*100 : null;
  const over = pct!=null && pct > MYRISK*1.1;
  $('pipPct').textContent = pct==null ? '–' : fmt(pct,2)+'%';
  $('pipPct').classList.toggle('over', !!over);

  // What this size has historically done to this trader - the one reading the
  // strip cannot show, and the only part of the old panel worth keeping.
  const verdict = riskVerdict(pct);
  const lead = over ? `<b class="neg">${fmt(pct,2)}% is past your ${fmt(MYRISK,2)}% plan.</b>` : '';
  // riskVerdict separates its clauses with <br>; with no lead the first is stray.
  $('pipNote').innerHTML = verdict ? lead + (lead ? verdict : verdict.replace(/^<br>/, '')) : '';
}

function updateQuality(){
  const o=calcLive(); const cur=$('quality').value;
  let opts=QUALS;
  if(o&&o.out==='Win') opts=['Good Win','Bad Win'];
  else if(o&&o.out==='Loss') opts=['Good Loss','Bad Loss'];
  $('quality').innerHTML='<option value="">— select —</option>'+opts.map(v=>`<option>${v}</option>`).join('');
  if(opts.includes(cur)) $('quality').value=cur;
}

/* ------------------------------------------------------------------
 * Balance tally. After a trade is logged the account is the thing the
 * trader actually cares about, so it is counted from the old figure to
 * the new one in the middle of the screen - green if the trade added,
 * red if it took away.
 *
 * It runs off the P&L the save returns rather than waiting for the
 * reload to come back, so it lands with the button press instead of a
 * round trip later, and shows up even if the reload is slow or fails.
 * ---------------------------------------------------------------- */
let TALLY_TIMER = null, TALLY_RAF = null;
function hideTally(){
  clearTimeout(TALLY_TIMER); cancelAnimationFrame(TALLY_RAF);
  TALLY_TIMER = null; TALLY_RAF = null;
  $('tally').hidden = true;
}
$('tally').onclick = hideTally;
document.addEventListener('keydown', e => { if(e.key==='Escape' && !$('tally').hidden) hideTally(); });

/**
 * @param from   balance before the trade, in `ccy`
 * @param delta  money the trade moved the account by; null when the trade
 *               carries no P&L at all, which is worth saying rather than
 *               silently showing nothing
 * @param note   the R line, shown under the figure
 * @param won    colours the panel when there is no money to colour it by
 */
function showTally(from, delta, ccy, note, won){
  const el = $('tally');
  hideTally();
  const money = delta !== null && isFinite(delta);
  const up = money ? delta >= 0 : !!won;
  el.classList.toggle('pos', up);
  el.classList.toggle('neg', !up);
  $('tallyLbl').textContent = money
    ? 'Balance' + (ccy ? ' \u00b7 ' + ccy : '')
    : 'Trade logged';
  $('tallyDelta').textContent = money
    ? (delta >= 0 ? '+' : '\u2212') + fmt(Math.abs(delta)) + (note ? '  \u00b7  ' + note : '')
    : (note || '') + ' \u00b7 no P&L: set a risk amount or lot size';
  el.hidden = false;

  if(!money){
    // Nothing to count, so show the result itself and leave it a moment.
    $('tallyNum').textContent = note ? note.replace(/\s.*$/, '') : '\u2013';
    TALLY_TIMER = setTimeout(hideTally, 2600);
    return;
  }

  const to = from + delta;
  // Paint the starting figure before the first frame, so the panel never
  // opens on the placeholder dash.
  $('tallyNum').textContent = fmt(from);
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const land = () => { $('tallyNum').textContent = fmt(to); TALLY_TIMER = setTimeout(hideTally, 2600); };
  if(still || Math.abs(delta) < 0.005){ land(); return; }

  const ms = 900, t0 = performance.now();
  const step = now => {
    const p = Math.min(1, (now - t0) / ms);
    // Fast out of the gate, settling onto the final figure.
    const e = 1 - Math.pow(1 - p, 3);
    $('tallyNum').textContent = fmt(from + delta * e);
    if(p < 1) TALLY_RAF = requestAnimationFrame(step); else land();
  };
  TALLY_RAF = requestAnimationFrame(step);
}

$('add').onclick = () => {
  const t={broker:brokerOf(),date:$('date').value,time:$('ttime').value,closeTime:$('xtime').value,closeDate:$('xdate').value,timezone:$('tz').value,currency:$('ccy').value,session:$('sess').value,instrument:$('instr').value,strategy:$('strat').value,direction:$('dir').value,
    entry:$('entry').value,sl:$('sl').value,finalSl:$('fsl').value,tp:$('tp').value,exit:$('exit').value,
    risk:$('risk').value,lots:$('lots').value,commission:$('comm').value,confidence:$('conf').value,mistakes:PICKED,emotion:$('emotion').value,rulesFollowed:checkedRules(),poi:$('poi').value,exitReason:$('xreason').value,shots:SHOTS,quality:$('quality').value,notes:$('notes').value};
  const wrongWay=markDirFields();
  if(wrongWay){
    $('msg').textContent='⚠ '+wrongWay.msg;
    $(wrongWay.bad[0]).focus();
    return;
  }
  /*
   * Read the balance before the trade lands, so the tally has somewhere to
   * count from. An edit only moves the account by the difference it makes,
   * so its previous P&L comes off the delta.
   */
  const tallyCcy = $('ccy').value, balBefore = equityIn(tallyCcy);
  const wasPnl = EDITING ? (Number((ALL.find(x=>x.id===EDITING)||{}).pnl) || 0) : 0;
  $('add').disabled=true; $('msg').textContent=SHOTS.length?'Uploading screenshots…':'Saving…';
  const saving = EDITING
    ? api('updateTrade', EDITING, t)
    : uploadShots(SHOTS).then(paths=>{ t.shots=paths; if(paths.length) $('msg').textContent='Saving trade…'; return api('addTrade',t); });
  saving.then(r=>{
    $('add').disabled=false;
    const verb = EDITING ? 'Updated' : 'Saved';
    if(EDITING) endEdit();
    $('msg').textContent=`${verb}: ${r.outcome} ${fmt(r.r)}R${r.trailed==='Yes'?' (trailed)':''} · ${r.session}`;
    ['entry','sl','fsl','tp','exit','risk','lots','comm','notes'].forEach(i=>$(i).value=''); COMM_TOUCHED=false; $('quality').value=''; $('ttime').value=''; $('xtime').value=''; $('xdate').value=''; $('xreason').value=''; $('emotion').value=''; $('sess').value=''; fillPois(''); PICKED=[]; renderMistakes(); renderRules(); setConf(''); SHOTS=[]; renderThumbs(); preview(); tzPreview();
    // Straight off the save response, so it lands with the press rather than
    // after the reload; '' means the trade carries no P&L at all.
    const gained = (r.pnl === '' || r.pnl == null || isNaN(Number(r.pnl))) ? null : Number(r.pnl) - wasPnl;
    showTally(balBefore, gained, tallyCcy, `${fmt(r.r)}R ${r.outcome}`, Number(r.r) >= 0);
    load().catch(fail);
  }).catch(e=>{ $('add').disabled=false; const m=(e&&e.message)||String(e); if(/AUTH/.test(m)) return fail(e); $('msg').textContent='Error: '+m; });
};
function startEdit(id){
  const t = ALL.find(x => x.id === id);
  if(!t) return;
  EDITING = id;
  document.body.classList.add('editing');
  $('entryTitle').textContent = 'Edit trade';
  $('editBadge').hidden = false;
  $('add').textContent = 'Save changes';
  $('cancelEdit').hidden = false;

  $('date').value=t.date; $('ttime').value=fmtIn(t.openedUtc,t.timezone||'UTC',false)||'';
  $('xtime').value = t.closedUtc ? fmtIn(t.closedUtc,t.timezone||'UTC',false) : '';
  $('xdate').value = t.closedUtc && t.closedUtc.slice(0,10)!==t.date ? t.closedUtc.slice(0,10) : '';
  fillTz(); $('tz').value=t.timezone||MYTZ; $('sess').value=t.session||'';
  fillBrokers(); $('brokerSel').value = t.broker || '';
  fillForm({instr:t.instrument, strat:t.strategy});
  setDir(t.direction);
  $('entry').value=t.entry; $('sl').value=t.sl; $('fsl').value=t.trailed==='Yes'?t.finalSl:'';
  $('tp').value=t.tp===''?'':t.tp; $('exit').value=t.exit; $('risk').value=t.risk===''?'':t.risk;
  $('lots').value=t.lots===''?'':t.lots; $('ccy').value=t.currency||MYCCY;
  fillExitReason(); $('xreason').value = EXITS.includes(t.exitReason) ? t.exitReason : '';
  setConf(String(t.confidence||''));
  SIZE_SRC='lots';
  $('comm').value = t.commission || ''; COMM_TOUCHED = !!t.commission;
  PICKED = (t.mistakes||[]).filter(m=>MISTAKES.includes(m)); renderMistakes();
  fillEmotions(); $('emotion').value = EMOTIONS.includes(t.emotion) ? t.emotion : '';
  renderRules(t.rulesFollowed||[]); fillPois(t.poi||'');
  $('notes').value=t.notes||'';
  SHOTS=[]; renderThumbs();
  $('msg').textContent='Screenshots stay as they are.';
  preview(); tzPreview(); recalcSize(); updateQuality(); $('quality').value=t.quality;
  showTab('journal'); window.scrollTo({top:0,behavior:'smooth'});
}
function endEdit(){
  EDITING = null;
  document.body.classList.remove('editing');
  $('entryTitle').textContent = 'Log a completed trade';
  $('editBadge').hidden = true;
  $('add').textContent = 'Add trade';
  $('cancelEdit').hidden = true;
  ['entry','sl','fsl','tp','exit','risk','lots','notes'].forEach(i=>$(i).value='');
  $('quality').value=''; $('ttime').value=''; $('xtime').value=''; $('xdate').value='';
  $('xreason').value=''; $('emotion').value=''; $('sess').value=''; fillPois('');
  $('comm').value=''; COMM_TOUCHED=false;
  SIZE_SRC='lots'; setDir('Long');
  PICKED=[]; renderMistakes(); renderRules(); setConf(''); SHOTS=[]; renderThumbs();
  $('msg').textContent=''; preview(); tzPreview(); recalcSize();
}
$('cancelEdit').onclick = endEdit;
$('strat').addEventListener('change', updateRuleHint);

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
    (!v('fQual')||t.quality===v('fQual')) && (!v('fSess')||(v('fSess')==='__none'?!t.session:t.session===v('fSess'))) && (v('fConf')===''||(+t.confidence||0)===+v('fConf')) && (!v('fTrail')||t.trailed===v('fTrail')) && (!v('fExit')||exitOf(t)===v('fExit')) &&
    (!v('fEmotion')||(v('fEmotion')==='__none'?!t.emotion:t.emotion===v('fEmotion'))) &&
    (!v('fMistake')||(v('fMistake')==='__none'?!(t.mistakes||[]).length:(t.mistakes||[]).includes(v('fMistake')))) &&
    (!v('fPoi')||(v('fPoi')==='__none'?!t.poi:t.poi===v('fPoi'))))
    .sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:String(a.loggedAt).localeCompare(String(b.loggedAt)));
}
function calc(list){
  const n=list.length, w=list.filter(t=>t.outcome==='Win'), l=list.filter(t=>t.outcome==='Loss'), be=n-w.length-l.length;
  const w_=w, l_=l;
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
    overRisked:list.filter(t=>+t.riskPct>MYRISK*1.1).length,
    commission:list.reduce((a,t)=>a+(+t.commission||0),0),
    // Per-trade Sharpe: expectancy divided by how wildly results scatter.
    sharpe:(()=>{ if(rs.length<2) return null;
      const m=totalR/rs.length, v=rs.reduce((a,x)=>a+(x-m)**2,0)/(rs.length-1);
      return v>0 ? m/Math.sqrt(v) : null; })(),
    // Sortino ignores upside volatility - only losses are the risk.
    sortino:(()=>{ if(rs.length<2) return null;
      const m=totalR/rs.length, d=rs.filter(x=>x<0);
      if(!d.length) return null;
      const dv=d.reduce((a,x)=>a+x*x,0)/d.length;
      return dv>0 ? m/Math.sqrt(dv) : null; })(),
    recovery: dd>0 ? totalR/dd : null,
    // Kelly: the edge-weighted fraction, given how much wins beat losses by.
    kelly:(()=>{ const w=w_.length, l=l_.length;
      if(!w || !l || !avgL) return null;
      const p=w/(w+l), b=Math.abs(avgW/avgL);
      return b>0 ? p-(1-p)/b : null; })() };
}
function pnlCard(s){
  const e=Object.entries(s.pnlBy);
  if(!e.length) return `<div class="stat"><div class="l">Total PnL</div><div class="v">–</div></div>`;
  const txt=e.map(([c,v])=>`${fmt(v)} ${esc(c)}`).join(' · ');
  return `<div class="stat"><div class="l">Total PnL${e.length>1?' (per currency)':''}</div><div class="v ${e.length===1?cls(e[0][1]):''}" style="${e.length>1?'font-size:16px;line-height:1.35':''}">${txt}</div></div>`;
}
function setScope(v){ SCOPE_TOUCHED=true; $('fTrader').value=v; render(); }
$('fTrader').addEventListener('change',()=>{ SCOPE_TOUCHED=true; });
const QCOLOR={'Good Win':'#00E676','Good Loss':'#38BDF8','Bad Win':'#FFBA79','Bad Loss':'#FF334B'};

/** A compact trend line for a KPI tile - shape only, no axes. */
function sparkline(vals, col){
  if(vals.length<2) return '';
  const W=150,H=34, min=Math.min(...vals), max=Math.max(...vals), rng=(max-min)||1;
  const pts=vals.map((v,i)=>[i/(vals.length-1)*W, H-2-((v-min)/rng)*(H-4)]);
  const d=pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" aria-hidden="true">`
    + `<path d="${d} L ${W} ${H} L 0 ${H} Z" fill="${col}" opacity=".12"/>`
    + `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"/></svg>`;
}

function kpiRow(list, s){
  const tile = (label, value, vclass, sub, extra='') =>
    `<div class="kpi"><div class="k-top"><span class="k-l">${label}</span>${extra}</div>`
    + `<div class="k-v ${vclass}">${value}</div>`
    + (sub?`<div class="k-sub">${sub}</div>`:'') + '</div>';
  const bar = (pct, col) =>
    `<div class="k-bar"><i style="width:${Math.max(0,Math.min(100,pct))}%;background:${col}"></i></div>`;
  const chip = (txt, col) => `<span class="badge" style="color:${col};border-color:${col}44">${txt}</span>`;

  let run=0; const curveVals=list.map(t=>(run+= +t.r||0));
  const pnlTxt = Object.entries(s.pnlBy).map(([c,v])=>fmt(v)+' '+esc(c)).join(' · ');

  $('kpis').innerHTML =
    tile('Net P&amp;L', pnlTxt||'–', cls(s.pnl),
         `${fmt(s.totalR)}R banked`, '') +
    tile('Win rate', s.winRate==null?'–':fmt(s.winRate,1)+'%', s.winRate>=50?'pos':'neg',
         `${s.wins}W / ${s.losses}L / ${s.be}BE` + bar(s.winRate||0, s.winRate>=50?'#00E676':'#FF334B')) +
    tile('Profit factor', s.pf===Infinity?'∞':fmt(s.pf), s.pf>1?'pos':'neg',
         `Expectancy ${fmt(s.avgR)}R a trade`,
         s.pf>=1.5?chip('Stable','#00E676'):s.pf>1?chip('Thin','#FFBA79'):chip('Bleeding','#FF334B')) +
    tile('Avg risk : reward', s.realRR==null?'–':'1 : '+fmt(s.realRR), '',
         s.plannedRR==null?'No targets set':`Planned 1:${fmt(s.plannedRR)}`) +
    tile('Max drawdown', fmt(s.maxDD)+'R', s.maxDD>0?'neg':'',
         s.recovery==null?'No drawdown yet':`Recovery ${fmt(s.recovery)}x`) +
    tile('Discipline', s.discipline==null?'–':fmt(s.discipline,0)+'%', s.discipline>=60?'pos':'neg',
         `${s.q['Good Win']+s.q['Good Loss']}/${s.n} followed the plan`
         + bar(s.discipline||0, s.discipline>=60?'#00E676':'#FF334B'),
         s.discipline>=90?chip('Pristine','#00E676'):'');

  // the sparkline belongs to the P&L tile
  const first=$('kpis').querySelector('.kpi');
  if(first && curveVals.length>1){
    first.insertAdjacentHTML('beforeend', sparkline(curveVals, s.totalR>=0?'#00E676':'#FF334B'));
  }
  $('curveBadge').textContent = (s.totalR>=0?'+':'') + fmt(s.totalR) + ' R';
  $('curveStats').innerHTML =
    `<div class="stat"><div class="l">Sharpe (per trade)</div><div class="v">${fmt(s.sharpe)}</div></div>`
  + `<div class="stat"><div class="l">Sortino</div><div class="v">${fmt(s.sortino)}</div></div>`
  + `<div class="stat"><div class="l">Avg hold</div><div class="v">${fmtDur(s.avgHold)}</div></div>`
  + `<div class="stat"><div class="l">Kelly fraction</div><div class="v">${s.kelly==null?'–':fmt(s.kelly*100,1)+'%'}</div></div>`;
}

/** Donut of the four quality types - the process score, not the P&L. */
function qualityDonut(s){
  if(!s.n){ $('qualDonut').innerHTML=''; $('qual').innerHTML='<span style="color:var(--mut)">No data</span>'; $('directive').innerHTML=''; return; }
  const R=62, C=2*Math.PI*R, SW=16;
  let off=0, arcs='';
  QUALS.forEach(q=>{
    const share=s.q[q]/s.n; if(!share) return;
    const len=share*C;
    arcs += `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${QCOLOR[q]}" stroke-width="${SW}"`
      + ` stroke-dasharray="${len.toFixed(2)} ${(C-len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"`
      + ` transform="rotate(-90 80 80)"><title>${q}: ${s.q[q]}</title></circle>`;
    off += len;
  });
  $('qualDonut').innerHTML =
    `<svg viewBox="0 0 160 160" width="100%" style="max-width:190px;margin:4px auto 0" role="img" aria-label="Trade quality split">`
    + `<circle cx="80" cy="80" r="${R}" fill="none" stroke="var(--line)" stroke-width="${SW}"/>${arcs}`
    + `<text x="80" y="76" text-anchor="middle" style="fill:var(--txt-strong);font-family:var(--font-mono);font-size:26px;font-weight:600">${fmt(s.discipline,0)}%</text>`
    + `<text x="80" y="94" text-anchor="middle" style="fill:var(--mut-2);font-family:var(--font-mono);font-size:8.5px;letter-spacing:.1em">A+ PROCESS</text></svg>`;

  $('qual').innerHTML = '<div class="qlegend">' + QUALS.map(q=>{
    const pct = s.n ? s.q[q]/s.n*100 : 0;
    return `<div class="qrow"><span class="n"><i style="background:${QCOLOR[q]}"></i>${q}</span>`
      + `<span class="p" style="color:${QCOLOR[q]}">${fmt(pct,1)}% <span style="color:var(--mut-2)">(${s.q[q]})</span></span>`
      + `<span class="bar"><i style="width:${pct}%;background:${QCOLOR[q]}"></i></span></div>`;
  }).join('') + '</div>';
}

/** One concrete, costed instruction - not a restatement of the chart. */
function renderDirective(list, s){
  const bad = list.filter(t => t.quality==='Bad Loss' || t.quality==='Bad Win');
  if(!bad.length){
    $('directive').innerHTML = '<span class="h">Execution directive</span>'
      + 'Every trade in this view followed your plan. Nothing to strip out.';
    return;
  }
  const badR = bad.reduce((a,t)=>a+(+t.r||0),0);
  const badMoney = bad.reduce((a,t)=>a+(+t.pnl||0),0);
  const cleanR = s.totalR - badR;
  $('directive').innerHTML = '<span class="h">Execution directive</span>'
    + `<b>${bad.length}</b> of ${s.n} trades broke your plan, costing `
    + `<b class="${cls(badR)}">${fmt(badR)}R</b>`
    + (badMoney ? ` (<b class="${cls(badMoney)}">${fmt(badMoney)} ${esc(Object.keys(s.pnlBy)[0]||'')}</b>)` : '')
    + `. Remove them and this view reads <b class="${cls(cleanR)}">${fmt(cleanR)}R</b> instead of `
    + `<b class="${cls(s.totalR)}">${fmt(s.totalR)}R</b>.`;
}

/** The most recent executions, dense, newest first. */
function renderBlotter(list){
  const rows = [...list].reverse().slice(0, 6);
  $('blotterCount').textContent = list.length ? `Showing ${rows.length} of ${list.length}` : '';
  if(!rows.length){ $('blotter').innerHTML='<span style="color:var(--mut)">No executions in this view</span>'; return; }
  $('blotter').innerHTML = '<table><tr><th>Date</th><th>Instrument</th><th>Strategy</th><th>Plan</th><th>PnL</th><th>R</th><th>Quality</th></tr>'
    + rows.map(t=>`<tr><td>${esc(t.date)}</td>`
      + `<td>${vtag(t.instrument,'instr')} <span class="pill ${t.direction==='Long'?'Win':'Loss'}">${t.direction==='Long'?'Long':'Short'}</span></td>`
      + `<td>${vtag(t.strategy,'strat')}</td><td>${t.plannedRR===''?'–':'1:'+t.plannedRR}</td>`
      + `<td class="${cls(t.pnl)}">${t.pnl===''?'–':fmt(t.pnl)}</td>`
      + `<td class="${cls(t.r)}">${t.r>0?'+':''}${fmt(t.r)}R</td>`
      + `<td><span class="pill ${key(t.quality)}">${esc(t.quality)}</span></td></tr>`).join('')
    + '</table>';
}

/**
 * Team views appear only for admins, and only while they have them showing.
 * The flag comes from the server, which has already withheld the data itself -
 * this just keeps the page from offering views with nothing behind them.
 */
function applyTeamVisibility(){
  const on = CAN_TEAM && !TEAM_HIDDEN;
  document.body.classList.toggle('can-team', on);
  $('teamToggle').textContent = TEAM_HIDDEN ? 'Show team data' : 'Hide team data';
  $('teamToggle').hidden = !CAN_TEAM;
  if(!on && $('fTrader').value !== ME){ $('fTrader').value = ME; SCOPE_TOUCHED = true; }
}
$('teamToggle').onclick = () => {
  TEAM_HIDDEN = !TEAM_HIDDEN;
  lsSet('tj_team_hidden', TEAM_HIDDEN ? '1' : '');
  applyTeamVisibility();
  fillFilters();          // the View list must not keep offering hidden members
  render();
};

function renderScope(){
  if(!CAN_TEAM || TEAM_HIDDEN){ $('scope').innerHTML=''; return; }
  const cur=$('fTrader').value, btn=(v,l,c='')=>`<button type="button" class="${c}${cur===v?' on':''}" data-scope="${esc(v)}" aria-pressed="${cur===v}">${l}</button>`;
  const others=[...new Set([...MEMBERS,...ALL.map(t=>t.trader)])].filter(m=>m&&m!==ME).sort();
  $('scope').innerHTML = btn('__ALL__','&#128101; Team') + btn(ME,'&#128100; Me ('+esc(ME)+')','me') + others.map(m=>btn(m,esc(m))).join('');
  $('scope').querySelectorAll('[data-scope]').forEach(b=>b.onclick=()=>setScope(b.dataset.scope));
}
function vsTeam(){
  if(!CAN_TEAM || TEAM_HIDDEN){ $('vsCard').hidden=true; return; }
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
    c('Over your risk plan',s.overRisked,s.overRisked?'neg':'pos') +
    c('Commission paid',s.commission?fmt(s.commission):'–',s.commission?'neg':'');
  kpiRow(list, s);
  drawCurve(list);
  trend(list);
  qualityDonut(s); renderDirective(list, s); renderBlotter(list);
  group('byInstr',list,t=>t.instrument,'Instrument',false,'instr');
  const allV=$('fTrader').value==='__ALL__';
  group('byStrat',list,t=>(t.strategy||'(none)')+(allV?' · '+t.trader:''),'Strategy',false,'strat');
  playbook();
  (function(){
    const rows = STRATS.filter(x=>$('fTrader').value==='__ALL__'||x.trader===$('fTrader').value)
      .map(x=>({name:x.name, ...calc(list.filter(t=>t.trader===x.trader&&t.strategy===x.name))}))
      .filter(x=>x.n).sort((a,b)=>b.totalR-a.totalR);
    $('topAlpha').textContent = rows.length ? 'Top alpha: ' + rows[0].name : '';
  })();
  group('bySess',list,t=>t.session||'Not set','Session',true);
  group('byConf',list,t=>CONF[+t.confidence]||'Not rated','Confidence',true);
  group('byTrail',list,t=>t.trailed==='Yes'?'Trailed SL':'Fixed SL','Type');
  group('byExit',list,exitOf,'How it ended');
  group('byEmotion',list,t=>t.emotion||'Not recorded','Feeling',true);
  group('byPoi',list,t=>t.poi||'Not recorded','Point of interest',false,'poi');
  poiStrategyTable(list);
  mistakeTable(list); ruleTable(list); riskTable(list);
  leaderboard(); tradesTable(list); renderAnalysis(); renderChrome();
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
    return `<div class="pb-item"><div class="pb-top"><span>${vtag(s.name,'strat')}${all?`<span class="tag">${esc(s.trader)}</span>`:''}</span><span class="pb-meta">${st.n} trades · ${st.winRate==null?'–':fmt(st.winRate,0)+'% win'} · <span class="${cls(st.totalR)}">${fmt(st.totalR)}R</span> · ${st.discipline==null?'–':fmt(st.discipline,0)+'% good'}</span></div><div class="pb-desc">${esc(s.description)||'<span class="hint">No description</span>'}</div></div>`;
  }).join('')+'</div>' : '<span style="color:var(--mut)">No strategies written yet. Add yours in the My Setup tab.</span>';
}
const CONF={1:'1 – Strongly disagree',2:'2 – Disagree',3:'3 – Neutral',4:'4 – Agree',5:'5 – Strongly agree'};
function group(el,list,keyFn,title,byKey,tagKind){
  const g={}; list.forEach(t=>(g[keyFn(t)]=g[keyFn(t)]||[]).push(t));
  const rows=Object.entries(g).map(([k,v])=>({k,...calc(v)})).sort(byKey?((a,b)=>a.k<b.k?-1:1):((a,b)=>b.totalR-a.totalR));
  $(el).innerHTML=rows.length?`<table><tr><th>${title}</th><th>Trades</th><th>Win %</th><th>Total R</th><th>Avg R</th><th>Good %</th></tr>`+
    rows.map(r=>`<tr><td>${tagKind?vtag(r.k,tagKind):esc(r.k)}</td><td>${r.n}</td><td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td><td class="${cls(r.totalR)}">${fmt(r.totalR)}</td><td class="${cls(r.avgR)}">${fmt(r.avgR)}</td><td>${fmt(r.discipline,0)}%</td></tr>`).join('')+'</table>':'<span style="color:var(--mut)">No data</span>';
}
/**
 * What each mistake actually costs. A mistake's own total R is not the answer,
 * because some trades still win: the honest figure is how far its average R
 * falls below your average, multiplied by how often you do it.
 */
function mistakeTable(list){
  const base = calc(list).avgR;
  const rows = MISTAKES.map(m => {
    const hit = list.filter(t => (t.mistakes||[]).includes(m));
    if(!hit.length) return null;
    const st = calc(hit);
    return { m, n: st.n, winRate: st.winRate, totalR: st.totalR, avgR: st.avgR,
             cost: base==null||st.avgR==null ? null : (st.avgR - base) * st.n };
  }).filter(Boolean).sort((a,b)=>(a.cost??0)-(b.cost??0));

  const clean = list.filter(t => !(t.mistakes||[]).length);
  if(!rows.length){
    $('byMistake').innerHTML = list.length
      ? '<span class="pos">No mistakes tagged in this view. Keep it that way.</span>'
      : '<span style="color:var(--mut)">No data</span>';
    return;
  }
  $('byMistake').innerHTML = '<table><tr><th>Mistake</th><th>Trades</th><th>Win %</th><th>Total R</th><th>Avg R</th><th>Cost vs your average</th></tr>'
    + rows.map(r=>`<tr><td>${esc(r.m)}</td><td>${r.n}</td><td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td>`
      + `<td class="${cls(r.totalR)}">${fmt(r.totalR)}</td><td class="${cls(r.avgR)}">${fmt(r.avgR)}</td>`
      + `<td class="${cls(r.cost)}">${r.cost==null?'–':fmt(r.cost)+'R'}</td></tr>`).join('')
    + `<tr class="foot-row"><td>Clean trades</td><td>${clean.length}</td><td>${calc(clean).winRate==null?'–':fmt(calc(clean).winRate,0)+'%'}</td>`
    + `<td class="${cls(calc(clean).totalR)}">${fmt(calc(clean).totalR)}</td><td class="${cls(calc(clean).avgR)}">${fmt(calc(clean).avgR)}</td><td>–</td></tr></table>`
    + '<div class="hint" style="margin-top:8px">Cost = how far that mistake\'s average R sits below your overall average, across every trade you tagged it on.</div>';
}

/** Per rule: what happens when you keep it versus when you do not. */
function ruleTable(list){
  const mine = STRATS.filter(s => s.trader===ME && (s.rules||[]).length);
  const scoped = list.filter(t => t.rulesTotal > 0);
  if(!mine.length){
    $('byRule').innerHTML = '<span style="color:var(--mut)">Add a rules checklist to a strategy in My Setup and your adherence shows up here.</span>';
    return;
  }
  if(!scoped.length){
    $('byRule').innerHTML = '<span style="color:var(--mut)">No trades logged against a checklist yet.</span>';
    return;
  }
  const rows = [];
  mine.forEach(st => (st.rules||[]).forEach(rule => {
    const rel = scoped.filter(t => t.strategy===st.name && t.trader===ME);
    if(!rel.length) return;
    const kept = rel.filter(t => (t.rulesFollowed||[]).includes(rule));
    const broke = rel.filter(t => !(t.rulesFollowed||[]).includes(rule));
    rows.push({ strat: st.name, rule, n: rel.length, kept: kept.length,
                keptR: kept.length?calc(kept).avgR:null, brokeR: broke.length?calc(broke).avgR:null });
  }));
  if(!rows.length){ $('byRule').innerHTML='<span style="color:var(--mut)">No data</span>'; return; }
  $('byRule').innerHTML = '<table><tr><th>Strategy</th><th>Rule</th><th>Kept</th><th>Avg R when kept</th><th>Avg R when broken</th><th>Difference</th></tr>'
    + rows.map(r=>{
        const d = (r.keptR==null||r.brokeR==null) ? null : r.keptR-r.brokeR;
        return `<tr><td>${vtag(r.strat,'strat')}</td><td style="white-space:normal;max-width:280px">${esc(r.rule)}</td>`
          + `<td>${r.kept}/${r.n} <span class="hint">(${fmt(r.kept/r.n*100,0)}%)</span></td>`
          + `<td class="${cls(r.keptR)}">${fmt(r.keptR)}</td><td class="${cls(r.brokeR)}">${fmt(r.brokeR)}</td>`
          + `<td class="diff ${cls(d)}">${d==null?'–':(d>0?'+':'')+fmt(d)+'R'}</td></tr>`;
      }).join('') + '</table>';
}

/** Results by how much was risked, with the best band called out. */
function riskTable(list){
  const bands = riskBands(list);
  if(!bands.length){
    $('byRisk').innerHTML = '<span style="color:var(--mut)">No sized trades yet. '
      + 'Log lot sizes and this shows which risk level actually works for you.</span>';
    return;
  }
  const spot = sweetSpot(list);
  $('byRisk').innerHTML = '<table><tr><th>Risk taken</th><th>Trades</th><th>Win %</th><th>Avg R</th><th>Total R</th><th>Avg risk</th></tr>'
    + bands.map(b=>{
        const best = spot && b.k===spot.k;
        return `<tr${best?' class="mrow sel"':''}><td>${esc(b.k)}${best?' <span class="tag">best</span>':''}</td>`
          + `<td>${b.n}${b.n<MIN_BAND_SAMPLE?' <span class="hint">(thin)</span>':''}</td>`
          + `<td>${b.winRate==null?'–':fmt(b.winRate,0)+'%'}</td>`
          + `<td class="${cls(b.avgR)}">${fmt(b.avgR)}</td><td class="${cls(b.totalR)}">${fmt(b.totalR)}</td>`
          + `<td>${fmt(b.avgRiskPct,2)}%</td></tr>`;
      }).join('') + '</table>'
    + `<div class="hint" style="margin-top:8px">A band needs ${MIN_BAND_SAMPLE} trades before it counts as signal rather than noise.</div>`;
}

/** Every POI x strategy pairing that has actually been traded, best first. */
function poiStrategyTable(list){
  const scoped = list.filter(t => t.poi);
  if(!scoped.length){
    $('byPoiStrat').innerHTML = '<span style="color:var(--mut)">Tag a point of interest on your trades and the pairings show up here.</span>';
    return;
  }
  const g = {};
  scoped.forEach(t => { const k = t.poi + ' \u0000 ' + t.strategy; (g[k] = g[k] || []).push(t); });
  const rows = Object.entries(g)
    .map(([k,v]) => { const [poi,strat] = k.split(' \u0000 '); return { poi, strat, ...calc(v) }; })
    .sort((a,b) => b.avgR - a.avgR);

  $('byPoiStrat').innerHTML = '<table><tr><th>Point of interest</th><th>Strategy</th><th>Trades</th><th>Win %</th><th>Avg R</th><th>Total R</th></tr>'
    + rows.map((r,i)=>`<tr${i===0&&r.n>1?' class="mrow sel"':''}><td>${vtag(r.poi,'poi')}${i===0&&r.n>1?' <span class="tag">best pair</span>':''}</td>`
      + `<td>${vtag(r.strat,'strat')}</td><td>${r.n}</td>`
      + `<td>${r.winRate==null?'–':fmt(r.winRate,0)+'%'}</td>`
      + `<td class="${cls(r.avgR)}">${fmt(r.avgR)}</td><td class="${cls(r.totalR)}">${fmt(r.totalR)}</td></tr>`).join('')
    + '</table>';
}

function leaderboard(){
  if(!CAN_TEAM || TEAM_HIDDEN){ $('board').innerHTML=''; return; }
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
/* ==================================================================
 * ANALYSIS ENGINE
 *
 * Arithmetic over trades already logged. No model is called, nothing
 * runs on a schedule and nothing is stored: the tab recomputes from
 * the same rows the dashboard is showing, each time it is opened.
 *
 * Every what-if below is a RE-SLICE of trades that really happened -
 * dropping some, or repricing them at a different stake. None of them
 * invents an outcome for a trade you did not take, because there is no
 * honest way to know one.
 * ================================================================ */

const anDays = list => [...new Set(list.map(t => t.date).filter(Boolean))].sort();
const sumR = l => l.reduce((a, t) => a + (+t.r || 0), 0);
const sumP = l => l.reduce((a, t) => a + (+t.pnl || 0), 0);
const median = a => { if(!a.length) return null;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };
const brokeRules = t => +t.rulesTotal > 0 && (t.rulesFollowed || []).length < +t.rulesTotal;
const hasMistake = t => (t.mistakes || []).length > 0;
/** Average share of each trade's own checklist that was ticked. */
function adherence(l){
  const w = l.filter(t => +t.rulesTotal > 0);
  if(!w.length) return null;
  return w.reduce((a, t) => a + (t.rulesFollowed || []).length / (+t.rulesTotal), 0) / w.length * 100;
}
function localHour(t){
  const s = fmtIn(t.openedUtc, MYTZ, false);
  const h = parseInt(String(s).slice(0, 2), 10);
  return isNaN(h) ? null : h;
}
const DOW = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function dowOf(t){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date || '');
  if(!m) return null;
  return DOW[new Date(Date.UTC(+m[1], +m[2]-1, +m[3])).getUTCDay()];
}

/* ------------------------------------------------------------------ 1. day */
/**
 * One session against everything before it. The baseline is per-day for
 * anything that scales with volume (net R, trade count) and per-trade for
 * everything else, so a busy day is not flattered by its own busyness.
 */
function dailyReview(list, day){
  const cur = list.filter(t => t.date === day);
  if(!cur.length) return null;
  const past = list.filter(t => t.date < day);
  const c = calc(cur), p = calc(past);
  const pd = anDays(past);
  const perDayR = pd.length ? sumR(past) / pd.length : null;
  const perDayN = pd.length ? median(pd.map(d => past.filter(t => t.date === d).length)) : null;
  const rows = [];
  const cmp = (label, now, was, hi, unit, note) =>
    rows.push({ label, now, was, hi, unit: unit || '', note: note || '' });

  cmp('Net R',              sumR(cur),        perDayR,      true,  'R', 'against your average day');
  cmp('Trades taken',       cur.length,       perDayN,      null,  '',  'against your median day');
  cmp('Win rate',           c.winRate,        p.winRate,    true,  '%');
  cmp('Expectancy',         c.avgR,           p.avgR,       true,  'R', 'per trade');
  cmp('Profit factor',      c.pf === Infinity ? null : c.pf,
                            p.pf === Infinity ? null : p.pf, true,  '');
  cmp('Good trades',        c.discipline,     p.discipline, true,  '%', 'your own grading');
  cmp('Rules ticked',       adherence(cur),   adherence(past), true, '%');
  cmp('Avg risk',           c.avgRiskPct,     p.avgRiskPct, null,  '%', 'your plan is ' + fmt(MYRISK, 2) + '%');
  cmp('Avg confidence',     c.avgConf,        p.avgConf,    true,  '');
  cmp('Avg hold',           c.avgHold,        p.avgHold,    null,  'min');
  cmp('Commission',         c.commission,     pd.length ? p.commission / pd.length : null, false, '', 'per day');
  return { day, cur, past, c, p, rows, flags: dayFlags(cur, list, day) };
}

/**
 * The behavioural reads. These are the ones worth catching, because they are
 * invisible in a total: the day can finish green and still contain the habit
 * that empties the account next week.
 */
function dayFlags(cur, all, day){
  const out = [];
  // 'bad' | 'warn' | 'ok'. warn is for a habit that happened to pay: marking
  // it green would congratulate the trader for the thing costing them money.
  const flag = (kind, head, body) => out.push({ kind, head, body });
  const byOpen = [...cur].sort((a, b) => String(a.openedUtc).localeCompare(String(b.openedUtc)));

  // Straight back in after a loss.
  const REVENGE_MIN = 15;
  const quick = [];
  byOpen.forEach(t => {
    const prior = byOpen.filter(x => x.closedUtc && x.closedUtc < t.openedUtc && +x.r < 0);
    if(!prior.length) return;
    const last = prior[prior.length - 1];
    const gap = (new Date(t.openedUtc) - new Date(last.closedUtc)) / 60000;
    if(gap >= 0 && gap <= REVENGE_MIN) quick.push(t);
  });
  if(quick.length){
    const r = sumR(quick);
    flag(r < 0 ? 'bad' : 'warn', `${quick.length} trade${quick.length>1?'s':''} taken within ${REVENGE_MIN} min of a loss`,
      `They came to ${fmt(r)}R between them. ` + (r < 0
        ? 'Re-entering straight after a loss cost you on this day.'
        : 'They paid this time, which is not the same as it being a good habit.'));
  }

  // Betting bigger after a loss.
  const after = (sign) => {
    const v = [];
    byOpen.forEach((t, i) => {
      const prev = byOpen.slice(0, i).filter(x => x.closedUtc && x.closedUtc < t.openedUtc);
      if(!prev.length) return;
      const last = prev[prev.length - 1];
      if(sign < 0 ? +last.r < 0 : +last.r > 0) v.push(+t.riskPct);
    });
    const f = v.filter(x => x > 0);
    return f.length ? f.reduce((a, b) => a + b, 0) / f.length : null;
  };
  const afterLoss = after(-1), afterWin = after(1);
  if(afterLoss != null && afterWin != null && afterLoss > afterWin * 1.25){
    flag('bad', 'Your stake went up after losses',
      `${fmt(afterLoss,2)}% of the account after a loss against ${fmt(afterWin,2)}% after a win. `
      + 'Size drifting with the last result is how one bad session becomes a bad month.');
  }

  // Does the day decay as it goes on.
  if(byOpen.length >= 6){
    const h = Math.floor(byOpen.length / 2);
    const a = sumR(byOpen.slice(0, h)) / h, b = sumR(byOpen.slice(h)) / (byOpen.length - h);
    if(a - b >= 0.25) flag('bad', 'The session got worse as it went on',
      `First half ${fmt(a)}R a trade, second half ${fmt(b)}R. Stopping earlier would have kept ${fmt(a-b)}R a trade.`);
    else if(b - a >= 0.25) flag('ok', 'You traded better later in the session',
      `First half ${fmt(a)}R a trade, second half ${fmt(b)}R.`);
  }

  // Plan breaches and self-graded mistakes.
  const over = cur.filter(t => +t.riskPct > MYRISK * 1.1);
  if(over.length) flag('bad', `${over.length} trade${over.length>1?'s':''} over your risk plan`,
    `Largest was ${fmt(Math.max(...over.map(t => +t.riskPct)), 2)}% against a plan of ${fmt(MYRISK,2)}%.`);
  const broke = cur.filter(brokeRules);
  if(broke.length) flag('bad', `${broke.length} trade${broke.length>1?'s':''} taken with the checklist unfinished`,
    `They came to ${fmt(sumR(broke))}R. The ones you completed came to ${fmt(sumR(cur.filter(t => !brokeRules(t))))}R.`);
  const mis = {};
  cur.forEach(t => (t.mistakes || []).forEach(m => { mis[m] = (mis[m] || 0) + 1; }));
  const misTop = Object.entries(mis).sort((a, b) => b[1] - a[1]);
  if(misTop.length) flag('bad', 'Mistakes you tagged',
    misTop.map(([m, n]) => `${esc(m)} (${n})`).join(' · '));

  // One trade doing all the damage, or all the good.
  if(cur.length >= 3){
    const worst = [...cur].sort((a, b) => (+a.r) - (+b.r))[0];
    const rest = sumR(cur) - (+worst.r || 0);
    if(+worst.r < 0 && sumR(cur) < 0 && rest > 0)
      flag('bad', 'One trade turned the day red',
        `Without ${esc(worst.instrument)} at ${fmt(worst.r)}R the day is ${fmt(rest)}R.`);
    const best = [...cur].sort((a, b) => (+b.r) - (+a.r))[0];
    const restB = sumR(cur) - (+best.r || 0);
    if(+best.r > 0 && sumR(cur) > 0 && restB < 0)
      flag('warn', 'One trade carried the day',
        `Without ${esc(best.instrument)} at ${fmt(best.r)}R the day is ${fmt(restB)}R. `
        + 'A green day resting on a single trade is not a repeatable one.');
  }
  if(!out.length) flag('ok', 'Nothing stood out', 'No plan breaches, no revenge entries, no size drift.');
  return out;
}

/* -------------------------------------------------------------- 2. what if */
/**
 * Each row drops or reprices real trades. The money column uses the P&L
 * actually booked, so a row is only shown when every trade it touches has one.
 */
function whatIf(list){
  const base = { r: sumR(list), pnl: sumP(list), n: list.length };
  const out = [];
  const keep = (name, why, kept) => {
    if(kept.length === list.length || !kept.length) return;
    out.push({ name, why, n: kept.length,
      r: sumR(kept), pnl: sumP(kept),
      dr: sumR(kept) - base.r, dpnl: sumP(kept) - base.pnl });
  };

  keep('You had skipped the trades that broke your checklist',
       `${list.filter(brokeRules).length} dropped`, list.filter(t => !brokeRules(t)));
  keep('You had skipped every trade you tagged a mistake on',
       `${list.filter(hasMistake).length} dropped`, list.filter(t => !hasMistake(t)));
  keep('You had only taken your 4s and 5s for confidence',
       `${list.filter(t => +t.confidence && +t.confidence < 4).length} dropped`,
       list.filter(t => !+t.confidence || +t.confidence >= 4));
  keep('You had never traded over your risk plan',
       `${list.filter(t => +t.riskPct > MYRISK * 1.1).length} dropped`,
       list.filter(t => !(+t.riskPct > MYRISK * 1.1)));

  const worst = [...list].sort((a, b) => (+a.r) - (+b.r))[0];
  if(worst) keep('Your single worst trade had not happened',
    `${esc(worst.instrument)} on ${esc(worst.date)}, ${fmt(worst.r)}R`, list.filter(t => t !== worst));
  const best = [...list].sort((a, b) => (+b.r) - (+a.r))[0];
  if(best) keep('Your single best trade had not happened',
    `${esc(best.instrument)} on ${esc(best.date)}, ${fmt(best.r)}R - how much rests on one trade`,
    list.filter(t => t !== best));

  // Worst slice by dimension, dropped.
  [['instrument', t => t.instrument, 'instrument'],
   ['strategy',   t => t.strategy,   'strategy'],
   ['session',    t => t.session,    'session'],
   ['point of interest', t => t.poi, 'POI']].forEach(([, keyFn, word]) => {
    const g = {};
    list.forEach(t => { const k = keyFn(t); if(k) (g[k] = g[k] || []).push(t); });
    const rows = Object.entries(g).filter(([, v]) => v.length >= 4)
      .map(([k, v]) => ({ k, r: sumR(v) })).sort((a, b) => a.r - b.r);
    if(rows.length > 1 && rows[0].r < 0)
      keep(`You had left the ${esc(rows[0].k)} ${word} alone`,
           `${g[rows[0].k].length} trades, ${fmt(rows[0].r)}R`,
           list.filter(t => keyFn(t) !== rows[0].k));
  });

  // Same stake every time: what the edge is worth with sizing taken out of it.
  const risks = list.map(t => +t.risk).filter(x => x > 0);
  const flat = median(risks);
  if(flat && risks.length >= Math.max(3, list.length * 0.6)){
    const even = base.r * flat;
    out.push({ name: 'Every trade had risked the same amount',
      why: `at your median stake of ${fmt(flat)} - this is your edge with position sizing taken out`,
      n: list.length, r: base.r, pnl: even, dr: 0, dpnl: even - base.pnl, flat: true });
  }
  return { base, rows: out.sort((a, b) => b.dr - a.dr) };
}

/* ------------------------------------------------------------- 3. the edge */
/** Best and worst slice of each dimension, with the sample size next to it. */
function edgeFinder(list, minN){
  minN = minN || 4;
  const dims = [
    ['Instrument', t => t.instrument],
    ['Strategy',   t => t.strategy],
    ['Point of interest', t => t.poi],
    ['Session',    t => t.session],
    ['Direction',  t => t.direction],
    ['Day',        dowOf],
    ['Hour opened', t => { const h = localHour(t); return h == null ? null : String(h).padStart(2,'0') + ':00'; }],
    ['Confidence', t => +t.confidence ? CONF[+t.confidence] : null],
    ['How it ended', t => exitOf(t)],
    ['Stop moved', t => t.trailed === 'Yes' ? 'Trailed' : 'Left alone'],
    ['Hold time',  t => { const h = holdMin(t); if(h == null) return null;
                          return h < 15 ? 'Under 15 min' : h < 60 ? '15-60 min' : h < 240 ? '1-4 hours' : 'Over 4 hours'; }],
  ];
  return dims.map(([label, keyFn]) => {
    const g = {};
    list.forEach(t => { const k = keyFn(t); if(k) (g[k] = g[k] || []).push(t); });
    const rows = Object.entries(g).map(([k, v]) => ({ k, n: v.length, r: sumR(v), avg: sumR(v)/v.length }))
      .filter(x => x.n >= minN).sort((a, b) => b.avg - a.avg);
    if(rows.length < 2) return null;
    return { label, best: rows[0], worst: rows[rows.length - 1], spread: rows[0].avg - rows[rows.length-1].avg };
  }).filter(Boolean).sort((a, b) => b.spread - a.spread);
}

/* ---------------------------------------------------------- 4. the habits */
function habits(list){
  const byTime = [...list].sort((a, b) => String(a.openedUtc).localeCompare(String(b.openedUtc)));
  let run = 0, sign = 0, bestW = 0, bestL = 0;
  byTime.forEach(t => {
    const s = +t.r > 0 ? 1 : +t.r < 0 ? -1 : 0;
    if(s === 0) return;
    run = s === sign ? run + 1 : 1; sign = s;
    if(s > 0) bestW = Math.max(bestW, run); else bestL = Math.max(bestL, run);
  });
  const days = anDays(list);
  const dayR = days.map(d => ({ d, r: sumR(list.filter(t => t.date === d)) }));
  const green = dayR.filter(x => x.r > 0).length;
  let eq = 0, peak = 0, dd = 0, ddAt = null;
  dayR.forEach(x => { eq += x.r; if(eq > peak) peak = eq;
    if(peak - eq > dd){ dd = peak - eq; ddAt = x.d; } });
  return {
    days: days.length, green, greenPct: days.length ? green / days.length * 100 : null,
    bestW, bestL, curRun: run, curSign: sign,
    bestDay: dayR.slice().sort((a,b)=>b.r-a.r)[0],
    worstDay: dayR.slice().sort((a,b)=>a.r-b.r)[0],
    maxDD: dd, maxDDAt: ddAt, dayR,
  };
}

/* --------------------------------------------------------- 5. the caveats */
/**
 * The part a dashboard usually leaves out. Three numbers decide whether any
 * of the above is worth acting on: how much of your expectancy is noise, what
 * win rate your own payoff ratio actually requires, and whether you are
 * closing winners before the target you set yourself.
 */
function realityCheck(list){
  const rs = list.map(t => +t.r || 0);
  const n = rs.length;
  const out = { n };
  if(n >= 2){
    const m = rs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(rs.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1));
    const se = sd / Math.sqrt(n);
    out.expectancy = m; out.se = se;
    // Two standard errors either side is the rough 95% band.
    out.lo = m - 2 * se; out.hi = m + 2 * se;
    out.proven = out.lo > 0 || out.hi < 0;
    // Trades needed before the band clears zero, at the scatter seen so far.
    out.needed = m !== 0 ? Math.ceil((2 * sd / Math.abs(m)) ** 2) : null;
  }
  const wins = list.filter(t => +t.r > 0), losses = list.filter(t => +t.r < 0);
  if(wins.length && losses.length){
    const aw = wins.reduce((a, t) => a + +t.r, 0) / wins.length;
    const al = Math.abs(losses.reduce((a, t) => a + +t.r, 0) / losses.length);
    out.avgWin = aw; out.avgLoss = al; out.payoff = al ? aw / al : null;
    out.breakEven = al ? al / (aw + al) * 100 : null;
    out.actualRate = wins.length / (wins.length + losses.length) * 100;
  }
  // Winners closed before the target that was set on them.
  const planned = wins.filter(t => +t.plannedRR > 0);
  if(planned.length >= 3){
    out.plannedOnWins = planned.reduce((a, t) => a + +t.plannedRR, 0) / planned.length;
    out.gotOnWins = planned.reduce((a, t) => a + +t.r, 0) / planned.length;
    out.shortBy = out.plannedOnWins - out.gotOnWins;
    out.shortN = planned.length;
  }
  return out;
}

function renderReality(list){
  const q = realityCheck(list);
  const box = [];
  if(q.expectancy == null){
    $('anReality').innerHTML = '<span style="color:var(--mut)">Two trades needed before this says anything.</span>';
    return;
  }
  box.push(`<div class="an-flag ${q.proven ? 'ok' : 'bad'}"><b>`
    + `Expectancy ${fmt(q.expectancy)}R per trade, give or take ${fmt(2 * q.se)}R</b><span>`
    + (q.proven
        ? `Across ${q.n} trades that band sits entirely ${q.expectancy > 0 ? 'above' : 'below'} zero, `
          + 'so the edge is unlikely to be luck.'
        : `Across ${q.n} trades the band runs ${fmt(q.lo)}R to ${fmt(q.hi)}R, which straddles zero. `
          + 'On this sample you cannot yet tell this apart from a coin toss'
          + (q.needed ? `; around ${q.needed} trades at this scatter would settle it.` : '.'))
    + '</span></div>');
  if(q.breakEven != null){
    const ok = q.actualRate >= q.breakEven;
    box.push(`<div class="an-flag ${ok ? 'ok' : 'bad'}"><b>`
      + `You need to win ${fmt(q.breakEven, 1)}% and you win ${fmt(q.actualRate, 1)}%</b><span>`
      + `Your winners average ${fmt(q.avgWin)}R and your losers ${fmt(q.avgLoss)}R, a payoff of `
      + `${fmt(q.payoff)} to 1. At that payoff ${fmt(q.breakEven, 1)}% is break-even, and you are `
      + `${ok ? 'above it by ' + fmt(q.actualRate - q.breakEven, 1) : 'under it by ' + fmt(q.breakEven - q.actualRate, 1)}`
      + ' points.</span></div>');
  }
  if(q.shortBy != null){
    const cut = q.shortBy > 0.25;
    box.push(`<div class="an-flag ${cut ? 'bad' : 'ok'}"><b>`
      + `Winners ${cut ? 'closed short of' : 'held to'} their target</b><span>`
      + `On ${q.shortN} winning trades you aimed for ${fmt(q.plannedOnWins)}R and took ${fmt(q.gotOnWins)}R`
      + (cut ? `, leaving ${fmt(q.shortBy)}R a trade on the table against your own plan.`
             : '. You are taking what you set out to take.')
      + '</span></div>');
  }
  $('anReality').innerHTML = box.join('');
}

/* ------------------------------------------------------------- rendering */
function fillAnalysisDays(list){
  const days = anDays(list).reverse();
  const cur = $('anDay').value;
  $('anDay').innerHTML = days.map(d => `<option>${esc(d)}</option>`).join('');
  if(days.includes(cur)) $('anDay').value = cur;
}

function renderAnalysis(){
  const list = filtered();
  fillAnalysisDays(list);
  if(!list.length){
    ['anVerdict','anDaily','anFlags','anReality','anWhatIf','anEdges','anHabits','anWhen']
      .forEach(id => { $(id).innerHTML = ''; });
    $('anVerdict').innerHTML = '<span style="color:var(--mut)">No trades in this view yet.</span>';
    return;
  }
  renderDaily(list, $('anDay').value || anDays(list).slice(-1)[0]);
  renderReality(list);
  renderWhatIf(list);
  renderEdges(list);
  renderHabits(list);
}

function renderDaily(list, day){
  const d = dailyReview(list, day);
  if(!d){ $('anVerdict').innerHTML = '<span style="color:var(--mut)">No trades on that day.</span>';
    $('anDaily').innerHTML = ''; $('anFlags').innerHTML = ''; return; }

  const net = sumR(d.cur), money = sumP(d.cur);
  const better = d.rows.filter(r => r.hi !== null && r.now != null && r.was != null
    && (r.hi ? r.now > r.was : r.now < r.was)).length;
  const worse = d.rows.filter(r => r.hi !== null && r.now != null && r.was != null
    && (r.hi ? r.now < r.was : r.now > r.was)).length;
  $('anVerdict').innerHTML =
    `<div class="an-head">`
    + `<div class="an-big ${cls(net)}">${fmt(net)}R<small>${d.cur.length} trade${d.cur.length>1?'s':''} · ${fmt(money)} ${esc(d.cur[0].currency||'')}</small></div>`
    + `<div class="an-tally"><span class="pos">${better} better</span><span class="neg">${worse} worse</span>`
    + `<span class="hint">vs your ${d.past.length} earlier trade${d.past.length===1?'':'s'}</span></div></div>`;

  const cell = (r, v) => {
    if(v == null) return '–';
    if(r.unit === 'min') return fmtDur(v);
    return fmt(v, r.unit === '%' ? 1 : 2) + r.unit;
  };
  $('anDaily').innerHTML = '<table><tr><th>Measure</th><th>This session</th><th>Before</th><th>Change</th></tr>'
    + d.rows.map(r => {
      let arrow = '–', k = '';
      if(r.now != null && r.was != null){
        const diff = r.now - r.was;
        const shown = r.unit === 'min' ? fmtDur(Math.abs(diff)) : fmt(Math.abs(diff), r.unit === '%' ? 1 : 2) + r.unit;
        arrow = (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '') + shown;
        if(r.hi !== null && Math.abs(diff) > 1e-9) k = (r.hi ? diff > 0 : diff < 0) ? 'pos' : 'neg';
      }
      return `<tr><td>${esc(r.label)}${r.note ? ` <span class="hint">${esc(r.note)}</span>` : ''}</td>`
        + `<td>${cell(r, r.now)}</td><td>${cell(r, r.was)}</td><td class="${k}">${arrow}</td></tr>`;
    }).join('') + '</table>';

  $('anFlags').innerHTML = d.flags.map(f =>
    `<div class="an-flag ${f.kind}"><b>${f.head}</b><span>${f.body}</span></div>`).join('');
}

function renderWhatIf(list){
  const w = whatIf(list);
  if(!w.rows.length){ $('anWhatIf').innerHTML =
    '<span style="color:var(--mut)">Not enough variation in these trades to run a counterfactual.</span>'; return; }
  const ccy = esc(list.find(t => t.currency)?.currency || '');
  $('anWhatIf').innerHTML =
    `<table><tr><th>If…</th><th>Trades</th><th>Total R</th><th>Change</th><th>Money</th></tr>`
    + `<tr class="foot-row"><td>What actually happened</td><td>${w.base.n}</td>`
    + `<td class="${cls(w.base.r)}">${fmt(w.base.r)}</td><td>–</td>`
    + `<td class="${cls(w.base.pnl)}">${fmt(w.base.pnl)} ${ccy}</td></tr>`
    + w.rows.map(r => `<tr><td>${r.name}<span class="hint"> ${r.why}</span></td>`
      + `<td>${r.n}</td><td class="${cls(r.r)}">${fmt(r.r)}</td>`
      + `<td class="${cls(r.dr)}">${r.flat ? '–' : (r.dr >= 0 ? '+' : '') + fmt(r.dr) + 'R'}</td>`
      + `<td class="${cls(r.dpnl)}">${(r.dpnl >= 0 ? '+' : '') + fmt(r.dpnl)} ${ccy}</td></tr>`).join('')
    + '</table>';
}

function renderEdges(list){
  const e = edgeFinder(list);
  if(!e.length){ $('anEdges').innerHTML =
    '<span style="color:var(--mut)">Not enough trades yet - four in a group before it is worth reading.</span>'; return; }
  $('anEdges').innerHTML = '<table><tr><th>Split by</th><th>Best</th><th>R/trade</th>'
    + '<th>Worst</th><th>R/trade</th><th>Spread</th></tr>'
    + e.map(x => `<tr><td>${esc(x.label)}</td>`
      + `<td>${esc(x.best.k)} <span class="hint">n=${x.best.n}</span></td>`
      + `<td class="${cls(x.best.avg)}">${fmt(x.best.avg)}</td>`
      + `<td>${esc(x.worst.k)} <span class="hint">n=${x.worst.n}</span></td>`
      + `<td class="${cls(x.worst.avg)}">${fmt(x.worst.avg)}</td>`
      + `<td>${fmt(x.spread)}R</td></tr>`).join('') + '</table>';
}

function renderHabits(list){
  const h = habits(list);
  const c = (l, v, k) => `<div class="stat"><div class="l">${l}</div><div class="v ${k||''}">${v}</div></div>`;
  $('anHabits').innerHTML = '<div class="grid">'
    + c('Sessions traded', h.days)
    + c('Green sessions', h.greenPct == null ? '–' : fmt(h.greenPct, 0) + '%', h.greenPct >= 50 ? 'pos' : 'neg')
    + c('Longest win run', h.bestW, 'pos')
    + c('Longest losing run', h.bestL, 'neg')
    + c('Running now', (h.curSign > 0 ? h.curRun + ' win' : h.curSign < 0 ? h.curRun + ' loss' : '–')
        + (h.curRun > 1 ? 'es' : ''), h.curSign > 0 ? 'pos' : h.curSign < 0 ? 'neg' : '')
    + c('Best session', h.bestDay ? fmt(h.bestDay.r) + 'R' : '–', 'pos')
    + c('Worst session', h.worstDay ? fmt(h.worstDay.r) + 'R' : '–', 'neg')
    + c('Deepest drawdown', fmt(h.maxDD) + 'R', h.maxDD > 0 ? 'neg' : '')
    + '</div>'
    + (h.maxDDAt ? `<div class="hint" style="margin-top:10px">Deepest drawdown bottomed out on ${esc(h.maxDDAt)}.</div>` : '');

  const rows = h.dayR.slice().reverse();
  $('anWhen').innerHTML = '<table><tr><th>Session</th><th>Trades</th><th>Net R</th><th>Running R</th></tr>'
    + (() => { let run = sumR(list); return rows.map(x => {
        const n = list.filter(t => t.date === x.d).length;
        const at = run; run -= x.r;
        return `<tr><td>${esc(x.d)}</td><td>${n}</td><td class="${cls(x.r)}">${fmt(x.r)}</td>`
          + `<td class="${cls(at)}">${fmt(at)}</td></tr>`;
      }).join(); })() + '</table>';
}

function tradesTable(list){
  const me=$('me').value.trim().toLowerCase(), rows=[...list].reverse();
  $('tbl').innerHTML=rows.length?`<table><tr><th>Date</th><th>Time (UTC)</th><th>Time (${esc(MYTZ)})</th><th>Closed (${esc(MYTZ)})</th><th>Held</th><th>Session</th><th>Trader</th><th>Instrument</th><th>Dir</th><th>Strategy</th><th>POI</th><th>Lots</th><th>Risk</th><th>Risk %</th><th>Entry</th><th>Init SL</th><th>Final SL</th><th>Init TP</th><th>Exit</th><th>How it ended</th><th>Plan RR</th><th>R</th><th>PnL</th><th>Result</th><th>Quality</th><th>Conf</th><th>Shots</th><th></th></tr>`+
    rows.map(t=>`<tr class="${t.notes?'has-note':''}"><td>${esc(t.date)}</td><td>${fmtIn(t.openedUtc,'UTC',false)}</td><td title="Trader's own time: ${esc(fmtIn(t.openedUtc,t.timezone||'UTC',false))} ${esc(t.timezone)}">${fmtIn(t.openedUtc,MYTZ,false)}</td><td>${t.closedUtc?fmtIn(t.closedUtc,MYTZ,false):'–'}</td><td>${fmtDur(holdMin(t))}</td><td>${esc(t.session)||'–'}</td><td>${esc(t.trader)}</td><td>${vtag(t.instrument,'instr')}</td><td>${t.direction}</td><td>${vtag(t.strategy,'strat')}</td><td>${vtag(t.poi,'poi')}</td><td>${t.lots===''||t.lots==null?'–':fmt(t.lots,2)}</td><td>${t.risk===''||t.risk==null?'–':fmt(t.risk)}</td><td class="${t.riskPct>MYRISK*1.1?'neg':''}">${t.riskPct===''||t.riskPct==null?'–':fmt(t.riskPct,2)+'%'}</td><td>${t.entry}</td><td>${t.sl}</td><td>${t.trailed==='Yes'?t.finalSl+' ⤴':'–'}</td><td>${t.tp}</td><td>${t.exit}</td><td>${esc(exitOf(t))}</td><td>${t.plannedRR===''?'–':'1:'+t.plannedRR}</td><td class="${cls(t.r)}">${fmt(t.r)}</td><td class="${cls(t.pnl)}">${t.pnl===''?'–':fmt(t.pnl)+' '+esc(t.currency||'')}</td><td><span class="pill ${t.outcome}">${t.outcome}</span></td><td><span class="pill ${key(t.quality)}">${esc(t.quality)}</span></td><td>${miniBar(t.confidence)}</td><td class="shot-cell">${(t.shots&&t.shots.length)?`<button type="button" class="ghost small" data-view="${esc(t.shots.join(','))}">&#128247; ${t.shots.length}</button>`:''}${(String(t.trader).toLowerCase()===me&&(!t.shots||t.shots.length<MAXSHOTS))?`<button type="button" class="ghost small" data-addshot="${t.id}" title="Add screenshot">+&#128247;</button>`:''}</td><td class="shot-cell">${String(t.trader).toLowerCase()===me?`<button type="button" class="ghost small" data-edit-trade="${t.id}">Edit</button><button class="ghost small" onclick="del('${t.id}')">✕</button>`:''}</td></tr>`
      /*
       * The note gets its own full-width line under the trade instead of a
       * 220px column squeezed between Shots and the buttons. It sticks to the
       * left edge so it stays readable however far the table is scrolled.
       */
      + (t.notes ? `<tr class="note-row"><td colspan="28"><div class="note-in"><b>Note</b> ${esc(t.notes)}</div></td></tr>` : '')).join('')+'</table>'
    :'<span style="color:var(--mut)">No trades yet – log your first one above.</span>';
  $('tbl').querySelectorAll('[data-edit-trade]').forEach(b=>b.onclick=()=>startEdit(b.dataset.editTrade));
}
/** Exports exactly what the dashboard is showing, filters and all. */
function exportCsv(){
  const rows = filtered();
  if(!rows.length){ alert('Nothing to export in this view.'); return; }
  const cols = [
    ['Date',t=>t.date], ['Opened (UTC)',t=>t.openedUtc], ['Closed (UTC)',t=>t.closedUtc],
    ['Held (min)',t=>holdMin(t)??''], ['Session',t=>t.session], ['Trader',t=>t.trader],
    ['Instrument',t=>t.instrument], ['Direction',t=>t.direction], ['Strategy',t=>t.strategy],
    ['Lots',t=>t.lots], ['Risk',t=>t.risk], ['Risk %',t=>t.riskPct], ['Commission',t=>t.commission], ['Currency',t=>t.currency],
    ['Entry',t=>t.entry], ['Initial SL',t=>t.sl], ['Final SL',t=>t.finalSl], ['SL trailed',t=>t.trailed],
    ['Initial TP',t=>t.tp], ['Exit',t=>t.exit], ['How it ended',t=>exitOf(t)],
    ['Planned RR',t=>t.plannedRR], ['R',t=>t.r], ['PnL',t=>t.pnl], ['Outcome',t=>t.outcome],
    ['Quality',t=>t.quality], ['Confidence',t=>t.confidence], ['Feeling',t=>t.emotion],
    ['Mistakes',t=>(t.mistakes||[]).join('; ')],
    ['Rules followed',t=>(t.rulesFollowed||[]).join('; ')], ['Rules total',t=>t.rulesTotal],
    ['Notes',t=>t.notes],
  ];
  // Excel reads a leading = + - @ as a formula, so prefix those with a quote.
  const cell = v => {
    let x = v===null||v===undefined ? '' : String(v);
    if(/^[=+\-@]/.test(x)) x = "'" + x;
    return /[",\n\r]/.test(x) ? '"' + x.replace(/"/g,'""') + '"' : x;
  };
  const csv = [cols.map(c=>cell(c[0])).join(','), ...rows.map(t=>cols.map(c=>cell(c[1](t))).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8'}));
  const a = document.createElement('a');
  a.href = url; a.download = `vrv-trades-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
$('exportCsv').onclick = exportCsv;

/** Live readouts in the terminal chrome: equity, desk clock, footer telemetry. */
function renderChrome(){
  const list = equityInfo();
  const main = list[0];
  if(main){
    $('hdrEquity').innerHTML = fmt(main.bal) + ' ' + esc(main.c)
      + (main.dep>0 ? `<small class="${main.pnl<0?'neg':''}">${main.pnl>=0?'+':''}${fmt(main.pnl/main.dep*100,1)}%</small>` : '');
  } else {
    $('hdrEquity').textContent = '–';
  }
  $('ftTrades').textContent = ALL.filter(t=>t.trader===ME).length;
  $('ftBroker').textContent = MYBROKER || 'none set';
  $('ftRisk').textContent = fmt(MYRISK,2) + '% per trade';
  const scope = $('fTrader').value;
  if($('crumbScope')) $('crumbScope').textContent = scope==='__ALL__' ? 'Whole team' : scope;
}
function tickClock(){
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  $('deskClock').textContent = `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}
setInterval(tickClock, 1000); tickClock();

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
