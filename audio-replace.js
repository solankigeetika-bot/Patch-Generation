// Audio Replace bookmarklet — runs INSIDE cms.pocketfm.com so all CMS
// API calls share the same origin/session as CMS UI itself. Loaded via the
// PatchStudio "Audio Replace" bookmarklet.
(function(){
  if(window.__AR_PANEL){ window.__AR_PANEL.style.display='block'; return; }

  const CMS='https://api.cms.pocketfm.com/v2/content_api';
  const UPLOAD_BASE='https://api.cms.pocketfm.com/v2/upload';

  // ---- auth ----
  function pickAuthToken(){
    // Try common storage keys
    const keys=['access-token','access_token','accessToken','token','auth_token','authToken','ps_token'];
    for(const k of keys){
      const v=localStorage.getItem(k);
      if(v && v.length>20) return v;
    }
    return '';
  }
  function pickUid(){
    const keys=['uid','user_id','userId','ps_uid'];
    for(const k of keys){
      const v=localStorage.getItem(k);
      if(v && v.length>3) return v;
    }
    return '';
  }
  const state={
    token: pickAuthToken(),
    uid: pickUid(),
    srcShowId:'', srcEps:[],
    tgtShowId:'', tgtEps:[],
    pairs:[],
    srcFrom:'', srcTo:'', tgtFrom:'', tgtTo:'',
    log:[], running:false
  };
  function hdrs(){
    return {
      'Content-Type':'application/json',
      'access-token': state.token,
      'uid': state.uid,
      'app-client':'consumer-web',
      'app-version':'180',
      'auth-token':'web-auth',
      'source':'cms'
    };
  }
  function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

  // ---- panel ----
  const panel=document.createElement('div');
  panel.id='ar-panel';
  window.__AR_PANEL=panel;
  panel.style.cssText='position:fixed;top:60px;right:20px;width:680px;max-height:85vh;overflow-y:auto;background:#fff;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,.25);z-index:999999;font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:#0f172a';
  document.body.appendChild(panel);

  function _parseShowId(input){
    if(!input) return '';
    const s=String(input).trim();
    const m=s.match(/show_id=([a-f0-9]{20,})/i);
    if(m) return m[1];
    if(/^[a-f0-9]{20,}$/i.test(s)) return s;
    return '';
  }

  async function fetchEps(showId){
    async function paged(view, chapPag){
      let eps=[], page=1, firstStatus=200;
      while(page<=500){
        const params=[`show_id=${showId}`,'is_novel=0',`page_no=${page}`];
        if(view) params.push(`view=${view}`);
        if(chapPag) params.push('paginate_chapters=true');
        let r; try{ r=await fetch(`${CMS}/book.show_episodes?${params.join('&')}`,{headers:hdrs(),credentials:'include'}); }catch(e){ break; }
        if(!r.ok){ if(page===1) firstStatus=r.status; break; }
        const d=await r.json();
        const list=d.result?.episodes||[];
        if(!list.length) break;
        eps=eps.concat(list);
        if(!d.result?.next_url) break;
        page++;
      }
      return {eps, firstStatus};
    }
    const attempts=[['cms',false],['cms',true],['',false],['',true]];
    const results=await Promise.all(attempts.map(([v,c])=>paged(v,c)));
    const combined=results.flatMap(r=>r.eps);
    if(!combined.length){
      const allAuth=results.every(r=>r.firstStatus===401||r.firstStatus===403);
      if(allAuth) throw new Error('CMS auth — make sure you are logged into cms.pocketfm.com');
      throw new Error('No episodes returned — '+results.map((r,i)=>`${attempts[i][0]||'(none)'}${attempts[i][1]?'+chapPag':''}=${r.firstStatus}`).join(', '));
    }
    const seen=new Set(); const merged=[];
    for(const ep of combined){
      const cd=ep.chapter_details||ep;
      const cid=cd.chapter_id||ep.chapter_id||'';
      if(!cid||seen.has(cid)) continue;
      seen.add(cid);
      merged.push({
        chapter_id:cid,
        book_id:cd.book_id||ep.book_id||'',
        chapter_title:cd.chapter_title||ep.chapter_title||'',
        seq:cd.natural_sequence_number||ep.natural_sequence_number||0,
        audio_duration:cd.audio_duration||ep.audio_duration||0,
        audio_status:cd.audio_status||ep.audio_status||'',
        chapter_status:cd.chapter_Status||cd.chapter_status||ep.chapter_status||''
      });
    }
    return merged.sort((a,b)=>(a.seq||0)-(b.seq||0));
  }

  async function blobDuration(blob){
    return new Promise(resolve=>{
      const a=new Audio(); let done=false;
      const finish=v=>{ if(!done){done=true; try{URL.revokeObjectURL(a.src);}catch{} resolve(v);}};
      a.preload='metadata';
      a.onloadedmetadata=()=>finish(Math.round(a.duration||0));
      a.onerror=()=>finish(0);
      a.src=URL.createObjectURL(blob);
      setTimeout(()=>finish(0),8000);
    });
  }

  function log(msg, kind){
    const t=new Date().toLocaleTimeString();
    state.log.push({msg,kind,t});
    const lo=document.getElementById('ar-log');
    if(lo){
      const c=kind==='err'?'#ef4444':kind==='ok'?'#10b981':'#cbd5e1';
      lo.innerHTML+=`<div style="color:${c};padding:2px 0">[${t}] ${esc(msg)}</div>`;
      lo.scrollTop=lo.scrollHeight;
    }
  }

  // Rate-limit-aware fetch: retries on 429 with exponential backoff
  async function rlFetch(url, opts){
    let delay=2000;
    for(let attempt=0; attempt<5; attempt++){
      const r=await fetch(url, opts);
      if(r.status!==429) return r;
      log(`  · rate-limited (429), waiting ${Math.round(delay/1000)}s before retry…`);
      await new Promise(res=>setTimeout(res, delay));
      delay=Math.min(delay*2, 60000);
    }
    return await fetch(url, opts); // last try
  }

  async function copyOne(srcEp, tgtEp){
    // 1. Source audio download
    const muResp=await rlFetch(`${CMS}/get_media_url?type=episode&media_type=audio&event=play&chapter_id=${srcEp.chapter_id}&show_id=${state.srcShowId}`,{headers:hdrs(),credentials:'include'});
    if(!muResp.ok) throw new Error('source media URL HTTP '+muResp.status);
    const muData=await muResp.json();
    const playUrl=muData.result?.media_url||muData.media_url||muData.result?.url;
    if(!playUrl) throw new Error('no media URL on source');
    const dl=await fetch(playUrl);
    if(!dl.ok) throw new Error('audio download HTTP '+dl.status);
    const blob=await dl.blob();
    if(!blob||blob.size<1024) throw new Error('source blob empty/tiny ('+(blob?blob.size:0)+'B)');
    log(`  · downloaded ${(blob.size/1024).toFixed(1)} KB`);

    let duration=await blobDuration(blob);
    if(!duration) duration=srcEp.audio_duration||0;
    if(!duration) throw new Error('could not decode source audio');
    log(`  · duration ${duration}s`);

    // 2. Target episode_details (BEFORE upload)
    const detUrl=`${CMS}/book.episode_details?chapter_id=${tgtEp.chapter_id}&view=cms&show_id=${state.tgtShowId}&is_novel=0`;
    const detResp=await rlFetch(detUrl,{headers:hdrs(),credentials:'include'});
    if(!detResp.ok) throw new Error('target episode_details HTTP '+detResp.status);
    const det=await detResp.json();
    let tgtChapter=det.result?.chapter_details;
    let tgtStory=det.result?.story_details;
    if(!tgtChapter||!tgtStory) throw new Error('target details missing');
    const beforeKey=tgtStory.s3_unique_key||'(empty)';
    log(`  · target story_id=${tgtStory.story_id||'?'} key-before=${beforeKey}`);

    // 3. Presigned URL
    const ext=(blob.type||'').includes('wav')?'wav':'mp3';
    const title=encodeURIComponent(tgtChapter.chapter_title||tgtEp.chapter_title||'audio');
    const presignUrl=`${UPLOAD_BASE}/get_presigned_url?tags=media&image_extension=${ext}&title=${title}&chapter_id=${tgtEp.chapter_id}`;
    const up=await rlFetch(presignUrl,{headers:hdrs(),credentials:'include'});
    if(!up.ok) throw new Error('presigned URL HTTP '+up.status);
    const upData=await up.json();
    const policy=upData.result?.[0];
    if(!policy||!policy.url||!policy.fields) throw new Error('no S3 policy in response');
    log(`  · presigned s3_unique_key=${policy.s3_unique_key}`);

    // 4. S3 POST
    const fd=new FormData();
    for(const [k,v] of Object.entries(policy.fields)) fd.append(k,v);
    fd.append('file', blob, policy.fields.key||`audio.${ext}`);
    const s3=await fetch(policy.url,{method:'POST', body:fd});
    if(!s3.ok) throw new Error('S3 POST HTTP '+s3.status);
    log(`  · S3 upload OK (${s3.status})`);

    // 5. Wait, then re-fetch episode_details to see what CMS registered.
    //    Hypothesis: CMS auto-updates story_details.s3_unique_key once the
    //    file lands. If so, we use whatever the server now reports rather
    //    than overriding with the presigned key.
    await new Promise(r=>setTimeout(r, 1500));
    let postKey=beforeKey;
    try{
      const a=await rlFetch(detUrl,{headers:hdrs(),credentials:'include'});
      if(a.ok){
        const ad=await a.json();
        if(ad.result?.story_details){
          tgtStory=ad.result.story_details;
          tgtChapter=ad.result.chapter_details||tgtChapter;
          postKey=tgtStory.s3_unique_key||'(empty)';
        }
      }
    }catch{}
    log(`  · key-after-upload=${postKey}`);
    if(postKey===policy.s3_unique_key){
      log(`  ✓ CMS auto-registered our upload`,'ok');
    } else if(postKey!==beforeKey){
      log(`  ℹ CMS picked a different key than presigned — using server's: ${postKey}`);
    } else {
      log(`  ⚠ CMS did NOT register our upload (key unchanged). update_episode will likely fail.`,'err');
    }

    // Use the server's current key if it changed, otherwise our presigned key.
    const commitKey=(postKey!==beforeKey&&postKey!=='(empty)') ? postKey : policy.s3_unique_key;

    // 6. update_episode — using the canonical key from server state
    const cmsNow=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;};
    const body={
      chapter_details: {...tgtChapter, audio_duration: duration, media_timestamp: cmsNow()},
      story_details: {...tgtStory, s3_unique_key: commitKey, duration: duration},
      book_id: tgtChapter.book_id||tgtEp.book_id,
      show_id: state.tgtShowId,
      view: 'cms'
    };
    const notify=await rlFetch(`${CMS}/book.update_episode?is_novel=0`,{
      method:'POST',
      headers:hdrs(),
      credentials:'include',
      body: JSON.stringify(body)
    });
    if(!notify.ok) throw new Error('book.update_episode HTTP '+notify.status);
    log(`  · update_episode OK`);

    // 7. Verify by re-fetching
    try{
      const v=await rlFetch(detUrl,{headers:hdrs(),credentials:'include'});
      if(v.ok){
        const vd=await v.json();
        const persistedKey=vd.result?.story_details?.s3_unique_key||'';
        log(`  · final key=${persistedKey||'(empty)'}`);
        if(persistedKey===commitKey){
          log(`  ✓ binding confirmed`,'ok');
        } else if(persistedKey===policy.s3_unique_key){
          log(`  ✓ binding confirmed (presigned key)`,'ok');
        } else {
          log(`  ⚠ binding NOT confirmed — server has "${persistedKey||'empty'}" instead of "${commitKey}"`,'err');
        }
      }
    }catch{}
  }

  function rebuildPairs(){
    const src=state.srcEps, tgt=state.tgtEps;
    if(!src.length||!tgt.length){ state.pairs=[]; return; }
    const tgtBySeq={};
    tgt.forEach((t,i)=>{ if(t.seq) tgtBySeq[t.seq]=i; });
    state.pairs=src.map((s,i)=>{
      let tgtIdx=(s.seq && tgtBySeq[s.seq]!=null) ? tgtBySeq[s.seq] : i;
      if(tgtIdx>=tgt.length) tgtIdx=-1;
      return {srcIdx:i, tgtIdx, enabled:tgtIdx>=0};
    });
  }
  function inRange(p){
    const s=state.srcEps[p.srcIdx], t=p.tgtIdx>=0?state.tgtEps[p.tgtIdx]:null;
    if(s){
      if(state.srcFrom!==''&&s.seq<state.srcFrom) return false;
      if(state.srcTo!==''&&s.seq>state.srcTo) return false;
    }
    if(t){
      if(state.tgtFrom!==''&&t.seq<state.tgtFrom) return false;
      if(state.tgtTo!==''&&t.seq>state.tgtTo) return false;
    }
    return true;
  }

  async function loadSrc(){
    const v=document.getElementById('ar-src').value;
    const id=_parseShowId(v);
    if(!id){ alert('Bad show id/URL'); return; }
    state.srcShowId=id;
    const btn=document.getElementById('ar-src-btn');
    btn.textContent='Loading…'; btn.disabled=true;
    try{
      state.srcEps=await fetchEps(id);
      rebuildPairs();
      render();
    }catch(e){ alert('Source load failed: '+e.message); }
    finally{ btn.textContent='Load Source'; btn.disabled=false; }
  }
  async function loadTgt(){
    const v=document.getElementById('ar-tgt').value;
    const id=_parseShowId(v);
    if(!id){ alert('Bad show id/URL'); return; }
    state.tgtShowId=id;
    const btn=document.getElementById('ar-tgt-btn');
    btn.textContent='Loading…'; btn.disabled=true;
    try{
      state.tgtEps=await fetchEps(id);
      rebuildPairs();
      render();
    }catch(e){ alert('Target load failed: '+e.message); }
    finally{ btn.textContent='Load Target'; btn.disabled=false; }
  }
  function setPair(i, field, val){
    const p=state.pairs[i]; if(!p) return;
    if(field==='tgt'){ p.tgtIdx=parseInt(val,10); if(isNaN(p.tgtIdx)||p.tgtIdx<0) p.tgtIdx=-1; p.enabled=p.enabled&&p.tgtIdx>=0; }
    else if(field==='enabled') p.enabled=!!val;
  }
  function setRange(side,bound,value){
    const v=value===''?'':parseInt(value,10);
    state[(side==='src'?'src':'tgt')+(bound==='from'?'From':'To')]=(v===''||isNaN(v))?'':v;
  }
  function applyRange(){
    for(const p of state.pairs){
      let ok=inRange(p);
      p.enabled=ok&&p.tgtIdx>=0;
    }
    render();
  }
  function clearRange(){
    state.srcFrom=''; state.srcTo=''; state.tgtFrom=''; state.tgtTo='';
    for(const p of state.pairs) p.enabled=p.tgtIdx>=0;
    render();
  }
  function setAll(on){
    for(const p of state.pairs) if(p.tgtIdx>=0&&inRange(p)) p.enabled=!!on;
    render();
  }
  async function run(){
    const enabled=state.pairs.filter(p=>p.enabled&&p.tgtIdx>=0&&inRange(p));
    if(!enabled.length){ alert('No pairs enabled'); return; }
    if(!confirm(`Copy audio for ${enabled.length} episode(s)?\nSource → Target.\nThis modifies CMS data.`)) return;
    state.running=true; state.log=[]; render();
    log(`Starting ${enabled.length} copies…`);
    let ok=0, fail=0;
    for(let i=0;i<enabled.length;i++){
      const p=enabled[i];
      const s=state.srcEps[p.srcIdx], t=state.tgtEps[p.tgtIdx];
      log(`[${i+1}/${enabled.length}] Ep ${s.seq||'?'} → Ep ${t.seq||'?'}`);
      try{ await copyOne(s,t); ok++; log(`  ✓ copied`,'ok'); }
      catch(e){ fail++; log(`  ✗ ${e.message}`,'err'); }
      // Polite delay between pairs to avoid CMS rate-limiting (kicks in after
      // ~5 rapid uploads). 4s feels safe without making big batches painful.
      if(i<enabled.length-1) await new Promise(r=>setTimeout(r, 4000));
    }
    log(`Done — ${ok} succeeded, ${fail} failed`, fail?'err':'ok');
    state.running=false;
  }
  window.__AR_load_src=loadSrc;
  window.__AR_load_tgt=loadTgt;
  window.__AR_set_pair=setPair;
  window.__AR_set_range=setRange;
  window.__AR_apply_range=applyRange;
  window.__AR_clear_range=clearRange;
  window.__AR_set_all=setAll;
  window.__AR_run=run;
  window.__AR_close=()=>{ panel.style.display='none'; };
  window.__AR_token=()=>{
    const t=prompt('Paste access-token (leave blank to keep current):', state.token||'');
    if(t!==null) state.token=t.trim();
    const u=prompt('Paste uid (leave blank to keep current):', state.uid||'');
    if(u!==null) state.uid=u.trim();
    render();
  };

  function render(){
    const en=state.pairs.filter(p=>p.enabled&&p.tgtIdx>=0&&inRange(p)).length;
    const tokenOk=state.token && state.uid;
    let h=`<div style="padding:12px 14px;background:#1e293b;color:#fff;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center">
      <div><span style="font-size:14px;font-weight:800">🔀 Audio Replace</span>
        <span style="margin-left:8px;font-family:monospace;font-size:10px;color:${tokenOk?'#10b981':'#ef4444'}">${tokenOk?'auth ✓':'auth ✗'}</span>
        <button onclick="window.__AR_token()" style="margin-left:6px;font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid #475569;background:transparent;color:#cbd5e1;cursor:pointer">edit token</button>
      </div>
      <button onclick="window.__AR_close()" style="background:transparent;border:none;color:#cbd5e1;font-size:18px;cursor:pointer">×</button>
    </div>
    <div style="padding:12px 14px">`;

    if(!tokenOk){
      h+=`<div style="background:#fef3c7;border:1px solid #fde68a;color:#92400e;padding:10px;border-radius:8px;font-size:11px;margin-bottom:10px">⚠ access-token / uid not auto-detected. Click "edit token" above and paste from PatchStudio's sidebar.</div>`;
    }

    h+=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">
      <div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <div style="font-size:11px;font-weight:700;margin-bottom:4px">Source (QC show — read FROM)</div>
        <input id="ar-src" placeholder="show_id or CMS URL" value="${esc(state.srcShowId)}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:5px;font-family:monospace;font-size:11px"/>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <button id="ar-src-btn" onclick="window.__AR_load_src()" style="padding:5px 10px;font-size:11px;border:none;background:#2563eb;color:#fff;border-radius:5px;cursor:pointer">Load Source</button>
          <span style="font-family:monospace;font-size:10px;color:#64748b">${state.srcEps.length} loaded</span>
        </div>
      </div>
      <div style="padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px">
        <div style="font-size:11px;font-weight:700;margin-bottom:4px">Target (Live show — write INTO)</div>
        <input id="ar-tgt" placeholder="show_id or CMS URL" value="${esc(state.tgtShowId)}" style="width:100%;padding:5px 8px;border:1px solid #cbd5e1;border-radius:5px;font-family:monospace;font-size:11px"/>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <button id="ar-tgt-btn" onclick="window.__AR_load_tgt()" style="padding:5px 10px;font-size:11px;border:none;background:#2563eb;color:#fff;border-radius:5px;cursor:pointer">Load Target</button>
          <span style="font-family:monospace;font-size:10px;color:#64748b">${state.tgtEps.length} loaded</span>
        </div>
      </div>
    </div>`;

    if(state.pairs.length){
      h+=`<div style="display:flex;gap:6px;align-items:center;background:#f1f5f9;border:1px solid #cbd5e1;border-radius:6px;padding:6px 10px;margin-bottom:8px;font-family:monospace;font-size:10px;flex-wrap:wrap">
        <span style="font-weight:700">Filter Ep #:</span>
        <span>Src</span>
        <input type="number" min="1" placeholder="from" value="${state.srcFrom}" onchange="window.__AR_set_range('src','from',this.value)" style="width:54px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px;font-size:10px"/>
        <input type="number" min="1" placeholder="to" value="${state.srcTo}" onchange="window.__AR_set_range('src','to',this.value)" style="width:54px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px;font-size:10px"/>
        <span>Tgt</span>
        <input type="number" min="1" placeholder="from" value="${state.tgtFrom}" onchange="window.__AR_set_range('tgt','from',this.value)" style="width:54px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px;font-size:10px"/>
        <input type="number" min="1" placeholder="to" value="${state.tgtTo}" onchange="window.__AR_set_range('tgt','to',this.value)" style="width:54px;padding:2px 4px;border:1px solid #cbd5e1;border-radius:4px;font-size:10px"/>
        <button onclick="window.__AR_apply_range()" style="padding:3px 8px;font-size:10px;border:none;background:#2563eb;color:#fff;border-radius:4px;cursor:pointer">Apply</button>
        <button onclick="window.__AR_clear_range()" style="padding:3px 8px;font-size:10px;border:1px solid #cbd5e1;background:#fff;border-radius:4px;cursor:pointer">Clear</button>
        <span style="margin-left:auto;font-weight:700">${en} enabled</span>
      </div>`;

      h+=`<div style="display:flex;gap:6px;margin-bottom:8px">
        <button onclick="window.__AR_set_all(true)" style="padding:5px 10px;font-size:11px;border:1px solid #cbd5e1;background:#fff;border-radius:5px;cursor:pointer">Check All</button>
        <button onclick="window.__AR_set_all(false)" style="padding:5px 10px;font-size:11px;border:1px solid #cbd5e1;background:#fff;border-radius:5px;cursor:pointer">Uncheck All</button>
        <button onclick="window.__AR_run()" ${state.running?'disabled':''} style="padding:6px 14px;font-size:12px;border:none;background:#ea580c;color:#fff;border-radius:5px;cursor:pointer;margin-left:auto;font-weight:700">${state.running?'Running…':`▶ Run Replace (${en})`}</button>
      </div>`;

      h+=`<div style="max-height:240px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px">
        <table style="width:100%;border-collapse:collapse;font-family:monospace;font-size:10px">
          <thead><tr style="background:#f1f5f9;position:sticky;top:0">
            <th style="padding:5px;text-align:center;width:28px">✓</th>
            <th style="padding:5px;text-align:left">Src Ep</th>
            <th style="padding:5px;text-align:center">→</th>
            <th style="padding:5px;text-align:left">Tgt Ep</th>
            <th style="padding:5px;text-align:left">Override</th>
          </tr></thead><tbody>`;
      for(let i=0;i<state.pairs.length;i++){
        const p=state.pairs[i];
        if(!inRange(p)) continue;
        const s=state.srcEps[p.srcIdx], t=p.tgtIdx>=0?state.tgtEps[p.tgtIdx]:null;
        h+=`<tr style="border-bottom:1px solid #e2e8f0;${p.enabled?'':'opacity:.5'}">
          <td style="padding:3px;text-align:center"><input type="checkbox" ${p.enabled?'checked':''} ${p.tgtIdx<0?'disabled':''} onchange="window.__AR_set_pair(${i},'enabled',this.checked); window.__AR_render_partial && window.__AR_render_partial()"/></td>
          <td style="padding:3px">Ep ${s.seq||'?'}</td>
          <td style="padding:3px;text-align:center;color:#2563eb">→</td>
          <td style="padding:3px">${t?'Ep '+(t.seq||'?'):'<span style="color:#ef4444">none</span>'}</td>
          <td style="padding:3px">
            <select onchange="window.__AR_set_pair(${i},'tgt',this.value); window.__AR_render && window.__AR_render()" style="font-size:10px;max-width:200px">
              <option value="-1" ${p.tgtIdx<0?'selected':''}>— skip —</option>
              ${state.tgtEps.map((te,ti)=>`<option value="${ti}" ${ti===p.tgtIdx?'selected':''}>Ep ${te.seq||'?'} · ${esc((te.chapter_title||'').substring(0,30))}</option>`).join('')}
            </select>
          </td>
        </tr>`;
      }
      h+=`</tbody></table></div>`;

      h+=`<div style="margin-top:8px"><div style="font-size:10px;font-weight:700;margin-bottom:4px">Execution log</div>
        <div id="ar-log" style="max-height:200px;overflow-y:auto;font-family:monospace;font-size:10px;line-height:1.5;background:#0f172a;color:#cbd5e1;padding:6px 8px;border-radius:5px">${state.log.length?state.log.map(L=>{const c=L.kind==='err'?'#ef4444':L.kind==='ok'?'#10b981':'#cbd5e1'; return `<div style="color:${c}">[${L.t}] ${esc(L.msg)}</div>`;}).join(''):'<span style="color:#64748b">Waiting…</span>'}</div></div>`;
    }
    h+=`</div>`;
    panel.innerHTML=h;
  }
  window.__AR_render=render;
  window.__AR_render_partial=render;
  render();
})();
