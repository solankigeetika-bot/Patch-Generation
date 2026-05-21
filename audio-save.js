// Audio Save bookmarklet - runs INSIDE cms.pocketfm.com so it can click the
// CMS-only "Use Current Audio" and "Save Audio" controls for the active show.
(function(){
  if(window.__ASV_PANEL){
    window.__ASV_PANEL.style.display='block';
    return;
  }

  const state={
    running:false,
    stop:false,
    log:[],
    delayMs:1600,
    clickMainSave:true,
    visibleEps:[]
  };

  const panel=document.createElement('div');
  panel.id='asv-panel';
  window.__ASV_PANEL=panel;
  panel.style.cssText=[
    'position:fixed',
    'top:62px',
    'right:20px',
    'width:520px',
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
  function isVisible(el){
    if(!el||panel.contains(el)) return false;
    const st=getComputedStyle(el);
    if(st.display==='none'||st.visibility==='hidden'||Number(st.opacity)===0) return false;
    const r=el.getBoundingClientRect();
    return r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth;
  }
  function isDisabled(el){
    if(!el) return true;
    return !!(el.disabled||el.getAttribute('aria-disabled')==='true'||/\bdisabled\b/i.test(el.className||''));
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
  function clickEl(el){
    if(!el) return;
    try{ el.scrollIntoView({block:'center',inline:'center'}); }catch{}
    const r=el.getBoundingClientRect();
    const opts={bubbles:true,cancelable:true,view:window,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
    try{ el.dispatchEvent(new MouseEvent('mouseover',opts)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('mousedown',opts)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('mouseup',opts)); }catch{}
    try{ el.dispatchEvent(new MouseEvent('click',opts)); }catch{ try{ el.click(); }catch{} }
  }
  async function waitFor(fn,timeout=10000,interval=250){
    const start=Date.now();
    while(Date.now()-start<timeout){
      const v=fn();
      if(v) return v;
      await sleep(interval);
    }
    return null;
  }
  function actionCandidates(re){
    const raw=[...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"],div,span')];
    const out=[];
    const seen=new Set();
    for(const el of raw){
      if(!isVisible(el)) continue;
      const text=norm(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||el.title||'');
      if(!text||!re.test(text)) continue;
      const target=el.closest('button,[role="button"],a,input,[tabindex]')||el;
      if(!isVisible(target)||panel.contains(target)||seen.has(target)) continue;
      seen.add(target);
      const exact=re.test(norm(target.innerText||target.textContent||target.value||''));
      const tag=target.tagName.toLowerCase();
      const buttonScore=(tag==='button'||target.getAttribute('role')==='button'||tag==='input')?0:10;
      out.push({target,score:buttonScore+(exact?0:3)+text.length/1000});
    }
    out.sort((a,b)=>a.score-b.score);
    return out.map(x=>x.target);
  }
  function findAction(re){
    return actionCandidates(re).find(el=>!isDisabled(el))||null;
  }

  async function saveCurrentEpisode(){
    const useBtn=await waitFor(()=>findAction(/\buse current audio\b/i),12000);
    if(!useBtn) throw new Error('Use Current Audio button not found on the open episode');
    clickEl(useBtn);
    log('Clicked Use Current Audio');

    const saveAudioBtn=await waitFor(()=>findAction(/^save audio$/i),9000);
    if(!saveAudioBtn) throw new Error('Save Audio confirmation button not found');
    clickEl(saveAudioBtn);
    log('Clicked Save Audio');
    await sleep(1200);

    if(state.clickMainSave){
      const saveBtn=await waitFor(()=>findAction(/^save$/i),6000,300);
      if(saveBtn&&!isDisabled(saveBtn)){
        clickEl(saveBtn);
        log('Clicked page Save');
        await sleep(1400);
      }else{
        log('Page Save was not available/enabled after Save Audio', 'warn');
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
  function findEpisodeRow(seq){
    const re=episodeRegex(seq);
    const els=[...document.querySelectorAll('li,tr,button,[role="button"],a,div,span')];
    const panelRect=panel.getBoundingClientRect();
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
      const leftListBias=(r.right<panelRect.left-10||r.left<innerWidth*0.62)?0:800;
      const titlePenalty=/script document|creator|generate ai voice|current audio/i.test(text)?600:0;
      const area=Math.max(1,r.width*r.height);
      matches.push({target,score:leftListBias+titlePenalty+area/1000+text.length/10});
    }
    matches.sort((a,b)=>a.score-b.score);
    return matches[0]?.target||null;
  }
  function scrollContainers(){
    const els=[document.scrollingElement||document.documentElement,...document.querySelectorAll('aside,main,section,div,[role="list"],[class*="list"],[class*="List"],[class*="drawer"],[class*="Drawer"],[class*="episode"],[class*="Episode"]')];
    const seen=new Set();
    return els.filter(el=>{
      if(!el||seen.has(el)||panel.contains(el)) return false;
      seen.add(el);
      if(el!==document.scrollingElement&&!isVisible(el)) return false;
      if(el.scrollHeight<=el.clientHeight+80) return false;
      const text=norm(el.innerText||el.textContent||'');
      return /episode\s*\d+/i.test(text)||el===document.scrollingElement;
    }).sort((a,b)=>{
      const ar=a.getBoundingClientRect?a.getBoundingClientRect():{left:0,width:innerWidth,height:innerHeight};
      const br=b.getBoundingClientRect?b.getBoundingClientRect():{left:0,width:innerWidth,height:innerHeight};
      return ar.left-br.left || (ar.width*ar.height)-(br.width*br.height);
    });
  }
  async function openEpisode(seq){
    let row=findEpisodeRow(seq);
    if(row){
      clickEl(row);
      await sleep(state.delayMs);
      return true;
    }
    for(const c of scrollContainers()){
      const max=Math.max(0,c.scrollHeight-c.clientHeight);
      let last=-1;
      try{ c.scrollTop=0; }catch{}
      await sleep(220);
      while(c.scrollTop!==last){
        row=findEpisodeRow(seq);
        if(row){
          clickEl(row);
          await sleep(state.delayMs);
          return true;
        }
        last=c.scrollTop;
        try{ c.scrollTop=Math.min(max,c.scrollTop+Math.max(180,Math.floor(c.clientHeight*.78))); }catch{ break; }
        await sleep(260);
      }
    }
    row=findEpisodeRow(seq);
    if(row){
      clickEl(row);
      await sleep(state.delayMs);
      return true;
    }
    throw new Error(`Episode ${seq} row not found in the CMS list`);
  }
  async function saveEpisodeNumber(seq){
    log(`Opening Ep ${seq}`);
    await openEpisode(seq);
    await saveCurrentEpisode();
    log(`Ep ${seq} saved`, 'ok');
  }
  function scanVisibleEpisodes(){
    const nums=new Set();
    const panelRect=panel.getBoundingClientRect();
    for(const el of [...document.querySelectorAll('li,tr,button,[role="button"],a,div')]){
      if(!isVisible(el)) continue;
      const r=el.getBoundingClientRect();
      if(!(r.right<panelRect.left-10||r.left<innerWidth*.62)) continue;
      const text=candidateText(el);
      const m=text.match(/\bEpisode\s*(\d{1,5})\b/i)||text.match(/^\s*(\d{1,5})\s+Episode\b/i);
      if(m) nums.add(Number(m[1]));
    }
    return [...nums].filter(n=>Number.isFinite(n)).sort((a,b)=>a-b);
  }
  function readSettings(){
    state.delayMs=Math.max(500,Number(document.getElementById('asv-delay')?.value||state.delayMs)||1600);
    state.clickMainSave=!!document.getElementById('asv-main-save')?.checked;
  }
  async function runList(list,label){
    if(state.running) return;
    readSettings();
    if(!list.length){ alert('No episodes selected'); return; }
    if(!confirm(`Audio-save ${list.length} episode(s)?\n\n${label}\n\nThis will click CMS buttons and modify CMS data.`)) return;
    state.running=true;
    state.stop=false;
    render();
    log(`Starting ${label}: ${list.join(', ')}`);
    let ok=0,fail=0;
    for(const seq of list){
      if(state.stop){ log('Stopped by user','warn'); break; }
      try{
        await saveEpisodeNumber(seq);
        ok++;
      }catch(e){
        fail++;
        log(`Ep ${seq} failed: ${e.message}`,'err');
      }
      if(!state.stop) await sleep(state.delayMs);
    }
    log(`Done - ${ok} succeeded, ${fail} failed`, fail?'warn':'ok');
    state.running=false;
    render();
  }

  window.__ASV_close=()=>{ panel.style.display='none'; };
  window.__ASV_set=(key,val)=>{ state[key]=val; };
  window.__ASV_stop=()=>{ state.stop=true; log('Stop requested; finishing current click sequence','warn'); };
  window.__ASV_save_current=async()=>{
    if(state.running) return;
    readSettings();
    state.running=true;
    render();
    try{
      await saveCurrentEpisode();
      log('Current open episode saved','ok');
    }catch(e){
      log(e.message,'err');
      alert(e.message);
    }finally{
      state.running=false;
      render();
    }
  };
  window.__ASV_scan=()=>{
    state.visibleEps=scanVisibleEpisodes();
    render();
    log(state.visibleEps.length?`Visible episodes: ${state.visibleEps.join(', ')}`:'No visible episode rows detected', state.visibleEps.length?'info':'warn');
  };
  window.__ASV_run_visible=()=>{
    const list=state.visibleEps.length?state.visibleEps:scanVisibleEpisodes();
    runList(list,'visible episode rows');
  };
  window.__ASV_run_range=()=>{
    const from=Number(document.getElementById('asv-from')?.value||0);
    const to=Number(document.getElementById('asv-to')?.value||0);
    if(!from||!to||to<from){ alert('Enter a valid From and To episode number'); return; }
    const list=[];
    for(let n=from;n<=to;n++) list.push(n);
    runList(list,`episode range ${from}-${to}`);
  };

  function render(){
    const visibleLabel=state.visibleEps.length?state.visibleEps.join(', '):'none scanned yet';
    panel.innerHTML=`<div style="padding:12px 14px;background:#14532d;color:#fff;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center">
      <div>
        <div style="font-size:14px;font-weight:800">Audio Save</div>
        <div style="font-size:10px;color:#bbf7d0">Use Current Audio -> Save Audio</div>
      </div>
      <button onclick="window.__ASV_close()" style="background:transparent;border:none;color:#dcfce7;font-size:20px;cursor:pointer;line-height:1">x</button>
    </div>
    <div style="padding:13px 14px">
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 12px;margin-bottom:10px;color:#14532d;font-size:12px;line-height:1.45">
        Open the CMS show on the episode list, open one episode, then use this panel. Batch mode finds episode rows by number and clicks the same CMS buttons you click manually.
      </div>

      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
        <button onclick="window.__ASV_save_current()" ${state.running?'disabled':''} style="padding:8px 12px;border:none;background:#16a34a;color:#fff;border-radius:7px;font-weight:700;cursor:pointer">Save Current Open Episode</button>
        <button onclick="window.__ASV_stop()" ${state.running?'':'disabled'} style="padding:8px 12px;border:1px solid #fecaca;background:#fef2f2;color:#dc2626;border-radius:7px;font-weight:700;cursor:pointer">Stop</button>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:800;margin-bottom:7px">Batch by episode number</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label style="font-size:11px;color:#475569">From <input id="asv-from" type="number" min="1" style="width:72px;margin-left:4px;padding:5px;border:1px solid #cbd5e1;border-radius:5px"/></label>
          <label style="font-size:11px;color:#475569">To <input id="asv-to" type="number" min="1" style="width:72px;margin-left:4px;padding:5px;border:1px solid #cbd5e1;border-radius:5px"/></label>
          <button onclick="window.__ASV_run_range()" ${state.running?'disabled':''} style="padding:7px 12px;border:none;background:#2563eb;color:#fff;border-radius:7px;font-weight:700;cursor:pointer">Run Range</button>
        </div>
      </div>

      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px;padding:10px 12px;margin-bottom:10px">
        <div style="font-size:12px;font-weight:800;margin-bottom:7px">Visible rows helper</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:7px;line-height:1.45">Use this when CMS has only a small loaded/visible slice. Scroll the list, scan, then run visible rows.</div>
        <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
          <button onclick="window.__ASV_scan()" style="padding:7px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:7px;font-weight:700;cursor:pointer">Scan Visible</button>
          <button onclick="window.__ASV_run_visible()" ${state.running?'disabled':''} style="padding:7px 10px;border:none;background:#0f172a;color:#fff;border-radius:7px;font-weight:700;cursor:pointer">Run Visible</button>
          <span style="font-family:monospace;font-size:10px;color:#64748b;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Detected: ${esc(visibleLabel)}</span>
        </div>
      </div>

      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:#475569">
        <label><input id="asv-main-save" type="checkbox" ${state.clickMainSave?'checked':''} onchange="window.__ASV_set('clickMainSave',this.checked)"/> click main Save after Save Audio</label>
        <label>Delay <input id="asv-delay" type="number" min="500" step="100" value="${state.delayMs}" onchange="window.__ASV_set('delayMs',Math.max(500,Number(this.value)||1600))" style="width:82px;padding:4px;border:1px solid #cbd5e1;border-radius:5px"/> ms</label>
      </div>

      <div style="font-size:11px;font-weight:800;margin-bottom:5px">Execution log</div>
      <div id="asv-log" style="max-height:230px;overflow:auto;background:#0f172a;color:#cbd5e1;border-radius:7px;padding:8px 10px;font-family:monospace;font-size:10px;line-height:1.5">${state.log.map(L=>{const c=L.kind==='err'?'#f87171':L.kind==='ok'?'#4ade80':L.kind==='warn'?'#fbbf24':'#cbd5e1';return `<div style="color:${c};padding:2px 0">[${esc(L.t)}] ${esc(L.msg)}</div>`;}).join('')||'<span style="color:#64748b">Waiting...</span>'}</div>
    </div>`;
  }

  render();
})();
