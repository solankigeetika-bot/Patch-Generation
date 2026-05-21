// Audio Save bookmarklet - runs INSIDE cms.pocketfm.com and automates:
// open show by CMS id/url -> open each episode in range -> Use Current Audio
// -> Save Audio -> optional page Save.
(function(){
  if(window.__ASV_PANEL){
    window.__ASV_PANEL.style.display='block';
    return;
  }

  const STORE_KEY='patchstudio_audio_save_settings';
  const CMS_SHOW_BASE='https://cms.pocketfm.com/shows/audiobooks';

  function readStored(){
    try{ return JSON.parse(localStorage.getItem(STORE_KEY)||'{}')||{}; }
    catch{ return {}; }
  }
  const stored=readStored();
  const state={
    running:false,
    stop:false,
    log:[],
    workWin:null,
    showInput:stored.showInput||defaultShowInput(),
    from:stored.from||'',
    to:stored.to||'',
    delayMs:Number(stored.delayMs||1800),
    clickMainSave:stored.clickMainSave!==false
  };

  const panel=document.createElement('div');
  panel.id='asv-panel';
  window.__ASV_PANEL=panel;
  panel.style.cssText=[
    'position:fixed',
    'top:62px',
    'right:20px',
    'width:540px',
    'max-height:86vh',
    'overflow:auto',
    'background:#fff',
    'border:1px solid #cbd5e1',
    'border-radius:12px',
    'box-shadow:0 12px 44px rgba(15,23,42,.28)',
    'z-index:999999',
    'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    'font-size:13px',
    'color:#0f172a'
  ].join(';');
  document.body.appendChild(panel);

  function defaultShowInput(){
    try{
      const u=new URL(location.href);
      return u.searchParams.get('id')||u.searchParams.get('show_id')||'';
    }catch{ return ''; }
  }
  function esc(s){
    return String(s==null?'':s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }
  function norm(s){ return String(s||'').replace(/\s+/g,' ').trim(); }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function persist(){
    try{
      localStorage.setItem(STORE_KEY, JSON.stringify({
        showInput:state.showInput,
        from:state.from,
        to:state.to,
        delayMs:state.delayMs,
        clickMainSave:state.clickMainSave
      }));
    }catch{}
  }
  function parseShowTarget(input){
    const s=String(input||'').trim();
    if(!s) return null;
    try{
      if(/^https?:\/\//i.test(s)){
        const u=new URL(s);
        const id=u.searchParams.get('id')||u.searchParams.get('show_id')||'';
        return {url:u.href, showId:id||s};
      }
    }catch{}
    const m=s.match(/(?:show_id|id)=([a-f0-9]{20,})/i)||s.match(/([a-f0-9]{20,})/i);
    if(!m) return null;
    const id=m[1];
    return {url:`${CMS_SHOW_BASE}?tab=to_be_recorded&id=${encodeURIComponent(id)}`, showId:id};
  }
  function log(msg,kind='info'){
    const t=new Date().toLocaleTimeString();
    state.log.push({msg,kind,t});
    const el=document.getElementById('asv-log');
    if(el){
      const color=kind==='err'?'#dc2626':kind==='ok'?'#16a34a':kind==='warn'?'#b45309':'#334155';
      el.innerHTML+=`<div style="color:${color};padding:2px 0">[${t}] ${esc(msg)}</div>`;
      el.scrollTop=el.scrollHeight;
    }
  }
  function ownerWin(el){ return el?.ownerDocument?.defaultView||window; }
  function sameDocAsPanel(el){ return el?.ownerDocument===panel.ownerDocument; }
  function isVisible(el){
    if(!el) return false;
    if(sameDocAsPanel(el)&&panel.contains(el)) return false;
    const w=ownerWin(el);
    const st=w.getComputedStyle(el);
    if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity)===0) return false;
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<w.innerHeight&&r.left<w.innerWidth;
  }
  function isDisabled(el){
    if(!el) return true;
    return !!(el.disabled||el.getAttribute('aria-disabled')==='true'||/\bdisabled\b/i.test(el.className||''));
  }
  function clickEl(el){
    if(!el) return;
    const w=ownerWin(el);
    try{ el.scrollIntoView({block:'center',inline:'center'}); }catch{}
    const r=el.getBoundingClientRect();
    const opts={bubbles:true,cancelable:true,view:w,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
    for(const type of ['mouseover','mousedown','mouseup','click']){
      if(type==='click') continue;
      try{ el.dispatchEvent(new w.MouseEvent(type,opts)); }catch{}
    }
    try{ el.click(); }
    catch{ try{ el.dispatchEvent(new w.MouseEvent('click',opts)); }catch{} }
  }
  async function waitFor(fn,timeout=12000,interval=250){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const v=fn();
      if(v) return v;
      await sleep(interval);
    }
    return null;
  }
  function docOf(w){
    try{ return w?.document||document; }
    catch{ return document; }
  }
  function actionCandidates(re,w){
    const doc=docOf(w);
    const raw=[...doc.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"],div,span')];
    const out=[];
    const seen=new Set();
    for(const el of raw){
      if(!isVisible(el)) continue;
      const text=norm(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||el.title||'');
      if(!text||!re.test(text)) continue;
      const target=el.closest('button,[role="button"],a,input,[tabindex]')||el;
      if(!isVisible(target)||seen.has(target)) continue;
      seen.add(target);
      const exact=re.test(norm(target.innerText||target.textContent||target.value||''));
      const tag=target.tagName.toLowerCase();
      const buttonScore=(tag==='button'||target.getAttribute('role')==='button'||tag==='input')?0:10;
      out.push({target,score:buttonScore+(exact?0:3)+text.length/1000});
    }
    out.sort((a,b)=>a.score-b.score);
    return out.map(x=>x.target);
  }
  function findAction(re,w){
    return actionCandidates(re,w).find(el=>!isDisabled(el))||null;
  }

  async function saveCurrentEpisode(w){
    const useBtn=await waitFor(()=>findAction(/\buse current audio\b/i,w),15000);
    if(!useBtn) throw new Error('Use Current Audio button not found');
    clickEl(useBtn);
    log('Clicked Use Current Audio');

    const saveAudioBtn=await waitFor(()=>findAction(/^save audio$/i,w),10000);
    if(!saveAudioBtn) throw new Error('Save Audio confirmation button not found');
    clickEl(saveAudioBtn);
    log('Clicked Save Audio');
    await sleep(1200);

    if(state.clickMainSave){
      const saveBtn=await waitFor(()=>findAction(/^save$/i,w),7000,300);
      if(saveBtn&&!isDisabled(saveBtn)){
        clickEl(saveBtn);
        log('Clicked page Save');
        await sleep(1500);
      }else{
        log('Page Save was not available/enabled after Save Audio','warn');
      }
    }
  }

  function episodeRegex(seq){
    const n=String(seq).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(^|\\s)(episode\\s*)?${n}(\\b|\\s*:|\\s*-|\\s+)`,'i');
  }
  function candidateText(el){
    return norm(el.innerText||el.textContent||el.getAttribute('aria-label')||el.title||'');
  }
  function rowCandidatesFromElement(el,re,w){
    const win=w||ownerWin(el);
    const out=[];
    const seen=new Set();
    let cur=el;
    let depth=0;
    while(cur&&cur.nodeType===1&&cur!==cur.ownerDocument.body&&depth<9){
      if(isVisible(cur)&&!seen.has(cur)){
        seen.add(cur);
        const text=candidateText(cur);
        if(text&&re.test(text)){
          const r=cur.getBoundingClientRect();
          const cs=win.getComputedStyle(cur);
          const tooLarge=r.height>220||(r.width*r.height)>win.innerWidth*win.innerHeight*.45;
          const tooTiny=r.height<16||r.width<28;
          const leftBias=r.left<win.innerWidth*.72 ? 0 : 600;
          const sizePenalty=tooLarge?900:tooTiny?160:Math.abs(Math.min(r.height,120)-72);
          const pointerBonus=(cs.cursor==='pointer'||cur.getAttribute('role')==='button'||cur.onclick)?-80:0;
          const titlePenalty=/script document|creator|generate ai voice|current audio|save audio/i.test(text)?700:0;
          out.push({
            target:cur,
            score:leftBias+sizePenalty+titlePenalty+text.length/18+r.width/180+pointerBonus
          });
        }
      }
      cur=cur.parentElement;
      depth++;
    }
    return out;
  }
  function textNodeEpisodeCandidates(seq,w){
    const doc=docOf(w);
    const win=doc.defaultView||window;
    const re=episodeRegex(seq);
    const out=[];
    const walker=doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT, {
      acceptNode(node){
        const txt=norm(node.nodeValue||'');
        if(!txt||!re.test(txt)) return win.NodeFilter.FILTER_REJECT;
        const parent=node.parentElement;
        if(!parent||!isVisible(parent)) return win.NodeFilter.FILTER_REJECT;
        return win.NodeFilter.FILTER_ACCEPT;
      }
    });
    let node;
    while((node=walker.nextNode())){
      out.push(...rowCandidatesFromElement(node.parentElement,re,win));
    }
    return out;
  }
  function findEpisodeRow(seq,w){
    const doc=docOf(w);
    const win=doc.defaultView||window;
    const re=episodeRegex(seq);
    const els=[...doc.querySelectorAll('li,tr,td,button,[role="button"],a,div,span,p,h1,h2,h3,h4,[class*="episode"],[class*="Episode"]')];
    const matches=[];
    const seen=new Set();
    for(const el of els){
      if(!isVisible(el)) continue;
      const text=candidateText(el);
      if(!text||!re.test(text)) continue;
      const target=el.closest('li,tr,button,[role="button"],a,[tabindex],.ant-list-item')||el;
      if(!isVisible(target)||seen.has(target)) continue;
      seen.add(target);
      const r=target.getBoundingClientRect();
      const leftListBias=r.left<win.innerWidth*.66 ? 0 : 700;
      const titlePenalty=/script document|creator|generate ai voice|current audio|save audio/i.test(text)?650:0;
      const area=Math.max(1,r.width*r.height);
      matches.push({target,score:leftListBias+titlePenalty+area/1000+text.length/10});
      for(const cand of rowCandidatesFromElement(el,re,win)){
        if(!seen.has(cand.target)){
          seen.add(cand.target);
          matches.push(cand);
        }
      }
    }
    for(const cand of textNodeEpisodeCandidates(seq,w)){
      if(!seen.has(cand.target)){
        seen.add(cand.target);
        matches.push(cand);
      }
    }
    matches.sort((a,b)=>a.score-b.score);
    return matches[0]?.target||null;
  }
  function scrollContainers(w){
    const doc=docOf(w);
    const win=doc.defaultView||window;
    const els=[doc.scrollingElement||doc.documentElement,...doc.querySelectorAll('aside,main,section,div,[role="list"],[class*="list"],[class*="List"],[class*="drawer"],[class*="Drawer"],[class*="episode"],[class*="Episode"]')];
    const seen=new Set();
    return els.filter(el=>{
      if(!el||seen.has(el)||!isVisible(el)) return false;
      seen.add(el);
      if(el.scrollHeight<=el.clientHeight+80) return false;
      const text=norm(el.innerText||el.textContent||'');
      return /episode\s*\d+/i.test(text)||el===doc.scrollingElement||el===doc.documentElement;
    }).sort((a,b)=>{
      const ar=a.getBoundingClientRect?a.getBoundingClientRect():{left:0,width:win.innerWidth,height:win.innerHeight};
      const br=b.getBoundingClientRect?b.getBoundingClientRect():{left:0,width:win.innerWidth,height:win.innerHeight};
      return ar.left-br.left || (ar.width*ar.height)-(br.width*br.height);
    });
  }
  async function openEpisode(seq,w){
    let row=findEpisodeRow(seq,w);
    if(row){
      clickEl(row);
      await sleep(state.delayMs);
      return true;
    }
    for(const c of scrollContainers(w)){
      const max=Math.max(0,c.scrollHeight-c.clientHeight);
      let last=-1;
      try{ c.scrollTop=0; }catch{}
      await sleep(250);
      while(c.scrollTop!==last){
        row=findEpisodeRow(seq,w);
        if(row){
          clickEl(row);
          await sleep(state.delayMs);
          return true;
        }
        last=c.scrollTop;
        try{ c.scrollTop=Math.min(max,c.scrollTop+Math.max(180,Math.floor(c.clientHeight*.78))); }catch{ break; }
        await sleep(280);
      }
    }
    row=findEpisodeRow(seq,w);
    if(row){
      clickEl(row);
      await sleep(state.delayMs);
      return true;
    }
    throw new Error(`Episode ${seq} row not found on the show page`);
  }
  async function saveEpisodeNumber(seq,w){
    log(`Opening Ep ${seq}`);
    await openEpisode(seq,w);
    await saveCurrentEpisode(w);
    log(`Ep ${seq} saved`,'ok');
  }
  async function waitForWorkWindow(w){
    const ok=await waitFor(()=>{
      try{ return w&&!w.closed&&w.document&&w.document.body; }
      catch{ return null; }
    },30000,300);
    if(!ok) throw new Error('Could not access CMS automation window. Run this bookmarklet from cms.pocketfm.com and allow popups.');
    await waitFor(()=>{
      try{ return w.document.readyState!=='loading'; }
      catch{ return false; }
    },30000,300);
    await sleep(2500);
    return w;
  }
  async function openWorkWindow(url){
    const w=window.open(url,'patchstudio_audio_save','width=1360,height=900');
    if(!w) throw new Error('Popup blocked. Allow popups for cms.pocketfm.com and try again.');
    state.workWin=w;
    try{ w.focus(); }catch{}
    log(`Opened CMS show page: ${url}`);
    return waitForWorkWindow(w);
  }
  function readInputs(){
    state.showInput=(document.getElementById('asv-show')?.value||'').trim();
    state.from=(document.getElementById('asv-from')?.value||'').trim();
    state.to=(document.getElementById('asv-to')?.value||'').trim();
    state.delayMs=Math.max(700,Number(document.getElementById('asv-delay')?.value||state.delayMs)||1800);
    state.clickMainSave=!!document.getElementById('asv-main-save')?.checked;
    persist();
  }
  function buildRange(from,to){
    const f=Number(from), t=Number(to);
    if(!f||!t||t<f) return [];
    const list=[];
    for(let n=f;n<=t;n++) list.push(n);
    return list;
  }
  async function runAuto(){
    if(state.running) return;
    readInputs();
    const target=parseShowTarget(state.showInput);
    if(!target){ alert('Enter a valid CMS show ID or full CMS show URL'); return; }
    const eps=buildRange(state.from,state.to);
    if(!eps.length){ alert('Enter a valid episode range'); return; }

    state.running=true;
    state.stop=false;
    render();
    log(`Starting audio save for ${target.showId}, episodes ${state.from}-${state.to}`);
    let ok=0,fail=0;
    try{
      const w=await openWorkWindow(target.url);
      for(const seq of eps){
        if(state.stop){ log('Stopped by user','warn'); break; }
        try{
          await saveEpisodeNumber(seq,w);
          ok++;
        }catch(e){
          fail++;
          log(`Ep ${seq} failed: ${e.message}`,'err');
        }
        if(!state.stop) await sleep(state.delayMs);
      }
      log(`Done - ${ok} succeeded, ${fail} failed`, fail?'warn':'ok');
    }catch(e){
      log(e.message,'err');
      alert(e.message);
    }finally{
      state.running=false;
      render();
    }
  }

  window.__ASV_close=()=>{ panel.style.display='none'; };
  window.__ASV_stop=()=>{ state.stop=true; log('Stop requested; finishing current episode first','warn'); };
  window.__ASV_start=runAuto;
  window.__ASV_set=(key,val)=>{ state[key]=val; persist(); };

  function render(){
    panel.innerHTML=`<div style="padding:12px 14px;background:#14532d;color:#fff;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:14px;font-weight:800">Audio Save</div>
        <div style="font-size:10px;color:#bbf7d0">Show ID + range -> automatic CMS clicks</div>
      </div>
      <button onclick="window.__ASV_close()" style="background:transparent;border:none;color:#dcfce7;font-size:20px;cursor:pointer;line-height:1">x</button>
    </div>
    <div style="padding:13px 14px">
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 12px;margin-bottom:10px;color:#14532d;font-size:12px;line-height:1.45">
        Paste the CMS show ID or full CMS show URL, enter the episode range, then start. The tool opens the show page and performs Use Current Audio -> Save Audio for each episode.
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:10px 12px;margin-bottom:10px">
        <label style="display:block;font-size:11px;font-weight:800;color:#334155;margin-bottom:5px">CMS show ID or full CMS URL</label>
        <input id="asv-show" value="${esc(state.showInput)}" placeholder="show id or https://cms.pocketfm.com/shows/audiobooks?..." style="width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-family:monospace;font-size:11px"/>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:9px">
          <label style="font-size:11px;color:#475569">From <input id="asv-from" value="${esc(state.from)}" type="number" min="1" style="width:76px;margin-left:4px;padding:6px;border:1px solid #cbd5e1;border-radius:5px"/></label>
          <label style="font-size:11px;color:#475569">To <input id="asv-to" value="${esc(state.to)}" type="number" min="1" style="width:76px;margin-left:4px;padding:6px;border:1px solid #cbd5e1;border-radius:5px"/></label>
          <button onclick="window.__ASV_start()" ${state.running?'disabled':''} style="padding:8px 14px;border:none;background:#16a34a;color:#fff;border-radius:7px;font-weight:800;cursor:pointer">${state.running?'Running...':'Start Auto Save'}</button>
          <button onclick="window.__ASV_stop()" ${state.running?'':'disabled'} style="padding:8px 12px;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:7px;font-weight:700;cursor:pointer">Stop</button>
        </div>
      </div>

      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:#475569">
        <label><input id="asv-main-save" type="checkbox" ${state.clickMainSave?'checked':''} onchange="window.__ASV_set('clickMainSave',this.checked)"/> click main Save after Save Audio</label>
        <label>Delay <input id="asv-delay" type="number" min="700" step="100" value="${state.delayMs}" onchange="window.__ASV_set('delayMs',Math.max(700,Number(this.value)||1800))" style="width:82px;padding:4px;border:1px solid #cbd5e1;border-radius:5px"/> ms</label>
      </div>

      <div style="font-size:11px;color:#64748b;line-height:1.45;margin-bottom:10px">
        If a plain show ID opens the wrong tab in your CMS, paste the exact CMS show URL instead.
      </div>

      <div style="font-size:11px;font-weight:800;margin-bottom:5px">Execution log</div>
      <div id="asv-log" style="max-height:260px;overflow:auto;background:#0f172a;color:#cbd5e1;border-radius:7px;padding:8px 10px;font-family:monospace;font-size:10px;line-height:1.5">${state.log.map(L=>{const c=L.kind==='err'?'#f87171':L.kind==='ok'?'#4ade80':L.kind==='warn'?'#fbbf24':'#cbd5e1';return `<div style="color:${c};padding:2px 0">[${esc(L.t)}] ${esc(L.msg)}</div>`;}).join('')||'<span style="color:#64748b">Waiting...</span>'}</div>
    </div>`;
  }

  render();
})();
