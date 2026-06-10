(async function(){
  const CMS='https://api.cms.pocketfm.com/v2/content_api';
  const DB='https://patch-generation-default-rtdb.firebaseio.com';
  const params=new URL(document.currentScript.src).searchParams;
  function extractShowId(input){
    if(!input) return '';
    const s=String(input);
    return s.match(/show_id=([a-f0-9]{20,})/i)?.[1] ||
           s.match(/[?&]id=([a-f0-9]{20,})/i)?.[1] ||
           s.match(/\/([a-f0-9]{30,})(?:[/?#]|$)/i)?.[1] ||
           s.match(/[a-f0-9]{30,}/i)?.[0] ||
           '';
  }
  function detectShowId(){
    let id=extractShowId(location.href);
    if(id) return id;
    const links=[...document.querySelectorAll('a[href]')].slice(0,500);
    for(const a of links){
      id=extractShowId(a.getAttribute('href')||'');
      if(id) return id;
    }
    return '';
  }
  const detectedShowId=detectShowId();
  const promptShowId=!params.get('show_id') && !detectedShowId
    ? extractShowId(prompt('Could not detect show_id from this CMS page. Paste show_id or full CMS show URL:')||'')
    : '';
  const showId=params.get('show_id')||detectedShowId||promptShowId||'';
  const country=params.get('country')||'fr';
  const showKey=params.get('show_key')||'';
  const dbPath=p=>(country&&country!=='fr')?`${country}/${p}`:p;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  function box(){
    let el=document.getElementById('ps-refresh-qc-box');
    if(el) return el;
    el=document.createElement('div');
    el.id='ps-refresh-qc-box';
    el.style.cssText='position:fixed;right:18px;bottom:18px;z-index:999999;background:#111827;color:#fff;padding:14px 16px;border-radius:10px;font:12px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:360px';
    document.body.appendChild(el);
    return el;
  }
  function status(msg){ console.log('[PatchStudio Refresh]',msg); box().innerHTML=`<b>PatchStudio QC Refresh</b><br>${msg}`; }
  function val(k){
    for(const s of [localStorage,sessionStorage]){
      try{ const v=s.getItem(k); if(v) return v; }catch{}
    }
    return '';
  }
  function keys(){
    const out=[];
    for(const s of [localStorage,sessionStorage]){
      try{ for(let i=0;i<s.length;i++) out.push(s.key(i)); }catch{}
    }
    return out;
  }
  function pick(exact,re,min){
    for(const k of exact){ const v=val(k); if(v&&v.length>=min) return v; }
    for(const k of keys()){ if(re.test(k)){ const v=val(k); if(v&&v.length>=min) return v; } }
    for(const k of keys()){
      const raw=val(k);
      if(!raw||raw[0]!=='{') continue;
      try{
        const o=JSON.parse(raw);
        for(const n of exact.concat(['access_token','accessToken','authToken','id_token','user_id','userId'])){
          const x=o[n]||(o.user_info&&o.user_info[n]);
          if(x&&String(x).length>=min) return String(x);
        }
      }catch{}
    }
    return '';
  }
  const authToken=pick(['access-token','access_token','accessToken','token','auth_token','authToken','ps_token'],/token|auth|access/i,20);
  const uid=pick(['uid','user_id','userId','ps_uid'],/uid|user.?id/i,3);
  if(!showId){ alert('PatchStudio Refresh: missing show_id. Re-create the bookmark from PatchStudio.'); return; }
  if(!authToken||!uid){ alert('PatchStudio Refresh: CMS token/uid not found. Log into CMS first, then click this bookmark again.'); return; }
  const hdrs=()=>({
    'Content-Type':'application/json',
    'access-token':authToken,
    'uid':uid,
    'app-client':'consumer-web',
    'app-version':'180',
    'auth-token':'web-auth',
    'source':'cms'
  });
  async function cmsGet(path,label,retries=3){
    for(let i=1;i<=retries;i++){
      try{
        const r=await fetch(`${CMS}/${path}`,{headers:hdrs(),credentials:'include'});
        if((r.status===429||r.status>=500)&&i<retries){ await sleep(1500*i); continue; }
        if(!r.ok){
          const t=await r.text().catch(()=>'');
          throw new Error(`${label} HTTP ${r.status} ${t.slice(0,160)}`);
        }
        return await r.json();
      }catch(e){
        if(i<retries){ await sleep(1500*i); continue; }
        throw e;
      }
    }
  }
  async function fbPut(path,data){
    const r=await fetch(`${DB}/${dbPath(path)}.json`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!r.ok) throw new Error(`Firebase PUT ${path} HTTP ${r.status}`);
  }
  async function fbPatch(path,data){
    const r=await fetch(`${DB}/${dbPath(path)}.json`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    if(!r.ok) throw new Error(`Firebase PATCH ${path} HTTP ${r.status}`);
  }
  async function fbGet(path){
    const r=await fetch(`${DB}/${dbPath(path)}.json`);
    if(!r.ok) throw new Error(`Firebase GET ${path} HTTP ${r.status}`);
    return await r.json();
  }
  async function fbDel(path){
    await fetch(`${DB}/${dbPath(path)}.json`,{method:'DELETE'});
  }
  async function findShowKey(){
    if(showKey) return showKey;
    try{
      const shows=await fbGet('shows')||{};
      for(const [key,s] of Object.entries(shows)){
        const input=s?.showInput||'';
        const sid=extractShowId(input)||String(s?.id||'');
        if(sid===showId || input.includes(showId)) return key;
      }
    }catch(e){ console.warn('Could not resolve PatchStudio show key:',e); }
    return '';
  }
  function extractLine(remarks){
    if(!remarks) return '';
    const open=['"','\u201c','\u00ab','\u2018','\u201e'];
    const close=['"','\u201d','\u00bb','\u2019','\u201d'];
    const m=remarks.match(/[Ll]ine\s+from\s+[Ss]cript\s*[\-\u2013\u2014:]+\s*/);
    if(m){
      const after=remarks.slice(m.index+m[0].length);
      for(let i=0;i<open.length;i++){
        const oi=after.indexOf(open[i]);
        if(oi!==-1){
          const ci=after.indexOf(close[i],oi+1);
          if(ci!==-1) return after.slice(oi+1,ci).trim();
          const stops=[after.indexOf(';',oi+1),after.search(/QC\s*[Nn]ote/i),after.indexOf('\n',oi+1)].filter(x=>x>oi).sort((a,b)=>a-b);
          return after.slice(oi+1,stops[0]||after.length).trim();
        }
      }
      const stops=[after.indexOf(';'),after.indexOf('\n'),after.search(/QC\s*[Nn]ote/i)].filter(x=>x>0).sort((a,b)=>a-b);
      return after.slice(0,stops[0]||after.length).trim();
    }
    return '';
  }
  function extractNote(remarks){
    if(!remarks) return '';
    const m=remarks.match(/QC\s*[Nn]ote\s*[\-\u2013\u2014:]+\s*([\s\S]*)/i);
    if(!m) return '';
    let note=m[1].replace(/^["\u201c\u00ab]|["\u201d\u00bb]$/g,'').trim();
    const stop=note.search(/[Ll]ine\s+from\s+[Ss]cript/i);
    if(stop>-1) note=note.slice(0,stop).trim();
    return note.split('\n')[0].replace(/["\u201d\u00bb]$/g,'').trim();
  }
  function durationSeconds(v){
    if(v==null||v==='') return 0;
    if(typeof v==='string'){
      const s=v.trim();
      const hms=s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if(hms){
        const a=parseInt(hms[1],10), b=parseInt(hms[2],10), c=hms[3]==null?0:parseInt(hms[3],10);
        return hms[3]==null ? (a*60+b) : (a*3600+b*60+c);
      }
      v=s.replace(/,/g,'');
    }
    let n=Number(v);
    if(!Number.isFinite(n)||n<=0) return 0;
    if(n>86400) n=n/1000;
    return n>0?n:0;
  }
  function maxDuration(){
    const keys=['audio_duration','audioDuration','raw_audio_duration','rawAudioDuration','rm_audio_duration','rm_duration','fm_audio_duration','fm_duration','ready_to_master_duration','readyToMasterDuration','latest_duration','duration','duration_sec','duration_secs','duration_seconds','durationInSec','duration_in_sec','length','audio_length','audioLength','track_duration','trackDuration','chapter_duration','chapterDuration','media_duration','play_duration','generated_audio_duration'];
    const nestKeys=['raw_media_assets','media_details','audio_details','rm_media','fm_media','raw_media','ready_to_master','assets','audio','media','tts_job_details','current_audio','currentAudio','audio_file','audioFile','generated_audio'];
    let best=0;
    function scan(obj, depth=0){
      if(!obj||typeof obj!=='object'||depth>4) return;
      if(Array.isArray(obj)){ for(const item of obj.slice(0,50)) scan(item, depth+1); return; }
      for(const k of keys){ const v=durationSeconds(obj[k]); if(v>best) best=v; }
      for(const nk of nestKeys) if(obj[nk]&&typeof obj[nk]==='object') scan(obj[nk], depth+1);
    }
    for(const obj of arguments) scan(obj);
    return best;
  }
  function parseTs(v){
    if(!v&&v!==0) return 0;
    if(typeof v==='number') return v<1e12?v*1000:v;
    const s=String(v).trim();
    if(!s) return 0;
    if(/^\d+$/.test(s)){ const n=parseInt(s,10); return n<1e12?n*1000:n; }
    const ms=Date.parse(s);
    return isNaN(ms)?0:ms;
  }
  function qcReportedAt(qc={}){
    return qc.reportedAt||qc.timestamp||qc.created_at||qc.createdAt||qc.updated_at||qc.updatedAt||qc.qc_time||qc.time_stamp||qc.ts||'';
  }
  function latestKnownTs(values){
    let best=0;
    for(const v of values||[]){ const ms=parseTs(v); if(ms>best) best=ms; }
    return best||0;
  }
  function addStatusWorker(list, email, label, changedAt='', extra={}){
    email=String(email||'').trim();
    if(!email||!/@/.test(email)) return;
    list.push({email,label:label||'Status update',changedAt:changedAt||'',...extra});
  }
  function extractCMSStatusWorkers(ch={}, cd={}){
    const out=[];
    const fieldGroups=[
      ['raw_audio_approve_email','raw_audio_approve_time','Raw audio approval'],
      ['raw_audio_approved_by_email','raw_audio_approved_at','Raw audio approval'],
      ['raw_audio_qc_email','raw_audio_qc_time','Raw under QC'],
      ['raw_audio_qc_by_email','raw_audio_qc_at','Raw under QC'],
      ['qc_approve_email','qc_approve_time','QC approval'],
      ['qc_approved_by_email','qc_approved_at','QC approval'],
      ['audio_approve_email','audio_approve_time','Audio approval'],
      ['approved_by_email','approved_at','Approval'],
      ['reviewer_email','reviewed_at','Review'],
      ['status_updated_by_email','status_updated_at','Status update'],
      ['updated_by_email','updated_at','Update'],
      ['last_updated_by_email','last_updated_at','Update']
    ];
    for(const src of [ch, cd]){
      if(!src||typeof src!=='object') continue;
      for(const [emailKey,timeKey,label] of fieldGroups){
        addStatusWorker(out, src[emailKey], label, src[timeKey]||src.updated_at||src.update_time||'', {field:emailKey,status:src.audio_status||src.chapter_status||src.status||''});
      }
      for(const arrKey of ['editorial_qc_details','status_history','status_logs','status_change_logs','audit_logs','activity_logs']){
        const arr=Array.isArray(src[arrKey])?src[arrKey]:[];
        for(const x of arr){
          if(!x||typeof x!=='object') continue;
          addStatusWorker(out, x.user_email||x.email||x.updated_by_email||x.approved_by_email||x.reviewer_email, x.action||x.event||x.status||x.audio_status||x.chapter_status||arrKey, x.timestamp||x.created_at||x.updated_at||x.time||x.ts||'', {
            field:arrKey,
            fromStatus:x.from_status||x.old_status||x.previous_status||'',
            toStatus:x.to_status||x.new_status||x.status||x.audio_status||''
          });
        }
      }
    }
    const seen=new Set();
    return out.filter(w=>{
      const key=[w.email,w.label,w.changedAt,w.field,w.fromStatus,w.toStatus].join('|').toLowerCase();
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function statusText(){ return Array.from(arguments).filter(Boolean).join(' ').replace(/[_-]/g,' ').toLowerCase(); }
  function isBeyondRawUnderQC(){
    const text=statusText(...arguments);
    if(!text) return false;
    if(/raw\s+under\s+qc/.test(text) && !/approve|approved|ready|master|complete|completed|done|live|publish|published|upload|uploaded|final|generated/.test(text)) return false;
    return /approve|approved|ready|master|complete|completed|done|live|publish|published|upload|uploaded|final|generated|qc\s+pass|passed/.test(text);
  }
  function countRegenerationEvents(){
    let count=0;
    const seen=new Set();
    function scan(obj, depth=0){
      if(!obj||typeof obj!=='object'||depth>4) return;
      if(Array.isArray(obj)){ for(const x of obj.slice(0,80)) scan(x, depth+1); return; }
      const txt=Object.entries(obj).map(([k,v])=>v&&typeof v==='object'?k:`${k}:${v}`).join(' ').toLowerCase();
      if(/regen|regenerat|re-generate/.test(txt)){
        const key=obj.id||obj._id||obj.created_at||obj.updated_at||obj.time||txt.slice(0,120);
        if(!seen.has(key)){ seen.add(key); count++; }
      }
      for(const v of Object.values(obj)) if(v&&typeof v==='object') scan(v, depth+1);
    }
    for(const obj of arguments) scan(obj);
    return count;
  }
  function historyDuration(h={}){ return durationSeconds(h.duration)||durationSeconds(h.maxDuration)||durationSeconds(h.latestDuration)||durationSeconds(h.audioDuration)||0; }
  function historySeq(h={}){ return Number(h.seq||h.natural_sequence_number||h.seq_number||0)||0; }
  function buildQCHistory(showId, showName, ep={}, ch={}, qcDetails=[]){
    const cd=ep.chapter_details||ep||{};
    const statusWorkers=extractCMSStatusWorkers(ch, cd);
    const duration=maxDuration(ch, cd, ep);
    const seq=Number(ch.natural_sequence_number||cd.natural_sequence_number||ep.natural_sequence_number||ch.seq_number||cd.seq_number||0)||0;
    const statuses=[
      ch.audio_status,ch.chapter_status,ch.status,ch.audio_available,
      cd.audio_status,cd.chapter_status,cd.status,ep.audio_status,ep.audio_available,
      ...statusWorkers.map(w=>[w.label,w.status,w.fromStatus,w.toStatus].filter(Boolean).join(' '))
    ];
    const qcedAt=latestKnownTs([...(qcDetails||[]).map(qcReportedAt), ...statusWorkers.map(w=>w.changedAt).filter(Boolean)])||0;
    const qcCompleted=!!((qcDetails||[]).length||isBeyondRawUnderQC(...statuses));
    return {
      chapterId:cd.chapter_id||ch.chapter_id||ep.chapter_id||'',
      showId,
      showName:showName||showId,
      title:ch.chapter_title||cd.chapter_title||ep.chapter_title||'Episode',
      seq,
      duration,
      latestDuration:duration,
      audioDuration:durationSeconds(ch.audio_duration)||durationSeconds(cd.audio_duration)||durationSeconds(ep.audio_duration)||0,
      audioStatus:ch.audio_status||cd.audio_status||ep.audio_status||ep.audio_available||'',
      chapterStatus:ch.chapter_status||cd.chapter_status||ch.status||cd.status||'',
      qcCount:(qcDetails||[]).length,
      hasQC:(qcDetails||[]).length>0,
      qcCompleted,
      qcedAt:qcCompleted?(qcedAt||Date.now()):0,
      statusWorkers,
      regenerationCount:countRegenerationEvents(ch, cd, ep),
      qc:(qcDetails||[]).map((qc,i)=>({idx:i,time:qc.time||'',issueType:qc.issue_type||'',userEmail:qc.user_email||'',reportedAt:qcReportedAt(qc),rawRemarks:qc.remarks||''})),
      firstSeenAt:Date.now(),
      lastCmsSyncAt:Date.now(),
      source:'cms_bookmarklet_refresh'
    };
  }
  function mergeQCHistory(prev={}, next={}){
    const bestDuration=Math.max(historyDuration(prev), historyDuration(next));
    const existingQc=Array.isArray(prev.qc)?prev.qc:[];
    const nextQc=Array.isArray(next.qc)?next.qc:[];
    const key=q=>[q.idx,q.time,q.userEmail,q.issueType,String(q.rawRemarks||'').slice(0,160)].join('|').toLowerCase();
    const seen=new Set(existingQc.map(key));
    const qc=[...existingQc];
    for(const q of nextQc){ const k=key(q); if(!seen.has(k)){ seen.add(k); qc.push(q); } }
    return {
      ...prev,
      ...next,
      firstSeenAt:prev.firstSeenAt||next.firstSeenAt||Date.now(),
      duration:bestDuration,
      maxDuration:bestDuration,
      latestDuration:durationSeconds(next.latestDuration)||durationSeconds(prev.latestDuration)||bestDuration,
      audioDuration:durationSeconds(next.audioDuration)||durationSeconds(prev.audioDuration)||0,
      seq:historySeq(next)||historySeq(prev),
      qcCount:Math.max(Number(prev.qcCount||0), Number(next.qcCount||0)),
      hasQC:!!(prev.hasQC||next.hasQC||next.qcCount>0||prev.qcCount>0),
      qcCompleted:!!(prev.qcCompleted||next.qcCompleted||next.qcCount>0||prev.qcCount>0),
      qcedAt:prev.qcedAt||next.qcedAt||(prev.qcCompleted||next.qcCompleted||next.qcCount>0||prev.qcCount>0?Date.now():0),
      regenerationCount:Math.max(Number(prev.regenerationCount||0), Number(next.regenerationCount||0)),
      statusWorkers:Array.isArray(next.statusWorkers)&&next.statusWorkers.length?next.statusWorkers:(prev.statusWorkers||[]),
      qc,
      lastCmsSyncAt:Date.now()
    };
  }

  try{
    status(`Loading show ${showId}...`);
    let showTitle='';
    async function fetchEpisodeFlavor(label, view, paginateChapters){
      let out=[], page=1;
      let lastSig='';
      while(page<=2000){
        const parts=[`show_id=${encodeURIComponent(showId)}`,'is_novel=0',`page_no=${page}`];
        if(view) parts.push(`view=${encodeURIComponent(view)}`);
        if(paginateChapters) parts.push('paginate_chapters=true');
        let d;
        try{
          d=await cmsGet(`book.show_episodes?${parts.join('&')}`,`${label} page ${page}`,3);
        }catch(e){
          // Some CMS list flavors 404 when a page/flavor does not exist. That
          // means "this flavor is done", not "the whole refresh failed".
          console.warn(`${label} stopped at page ${page}:`, e.message);
          break;
        }
        const list=d.result?.episodes||[];
        if(!list.length) break;
        const sig=list.map(ep=>{
          const cd=ep.chapter_details||ep;
          return cd.chapter_id||ep.chapter_id||'';
        }).join('|');
        if(sig&&sig===lastSig){
          console.warn(`${label} stopped at page ${page}: repeated previous page`);
          break;
        }
        lastSig=sig;
        out=out.concat(list);
        showTitle=showTitle||d.result?.show_title||list[0]?.chapter_details?.show_title||'';
        status(`Loaded ${label}: ${out.length} episodes (${showTitle||showId})...`);
        if(!d.result?.next_url && list.length<10) break;
        page++;
        if(page%10===0) await sleep(400);
      }
      return out;
    }

    // CMS exposes different episode sets through different list flavours.
    // Fetch all known flavours and merge, otherwise QC shows with >10 eps can
    // look like they only have page 1.
    const flavorResults=await Promise.all([
      fetchEpisodeFlavor('cms', 'cms', false),
      fetchEpisodeFlavor('cms+chapters', 'cms', true),
      fetchEpisodeFlavor('plain', '', false),
      fetchEpisodeFlavor('plain+chapters', '', true),
    ]);
    const seenChap=new Set();
    const eps=[];
    for(const ep of flavorResults.flat()){
      const cd=ep.chapter_details||ep;
      const cid=cd.chapter_id||ep.chapter_id||'';
      if(!cid||seenChap.has(cid)) continue;
      seenChap.add(cid);
      eps.push(ep);
    }
    if(!eps.length) throw new Error('No episodes found for this show ID across CMS list flavors.');
    status(`Merged ${eps.length} unique episodes from CMS (${flavorResults.map(x=>x.length).join(' + ')})...`);
    let qcCount=0;
    const epData=[];
    const BATCH=2;
    for(let b=0;b<eps.length;b+=BATCH){
      const slice=eps.slice(b,b+BATCH);
      await Promise.all(slice.map(async ep=>{
        const cd=ep.chapter_details||ep;
        const chapId=cd.chapter_id||ep.chapter_id||'';
        if(!chapId) return;
        try{
          const dd=await cmsGet(`book.episode_details?chapter_id=${encodeURIComponent(chapId)}&is_novel=0`,`episode ${chapId}`,2);
          const ch=dd.result?.chapter_details||{};
          const qcDetails=ch.qc_details||[];
          const hist=buildQCHistory(showId, showTitle, ep, ch, qcDetails);
          const prevHist=await fbGet(`qcHistory/${chapId}`).catch(()=>({}));
          await fbPut(`qcHistory/${chapId}`,mergeQCHistory(prevHist||{},hist));
          if(qcDetails.length){
            qcCount++;
            const remarkData=qcDetails.map((qc,i)=>({
              idx:i,time:qc.time||'',issueType:qc.issue_type||'',
              userEmail:qc.user_email||'',scriptLine:extractLine(qc.remarks||''),
              note:extractNote(qc.remarks||''),rawRemarks:qc.remarks||'',
              needsPatch:!!extractLine(qc.remarks||''),
              timestamp:qcReportedAt(qc)||Date.now(),
              reportedAt:qcReportedAt(qc)||''
            }));
            await fbPut(`episodeRemarks/${chapId}`,{
              title:ch.chapter_title||cd.chapter_title||'Episode',
              showId,
              showName:showTitle||showId,
              seq:hist.seq||0,
              duration:hist.duration||0,
              audioStatus:hist.audioStatus||'',
              chapterStatus:hist.chapterStatus||'',
              qcCompleted:hist.qcCompleted,
              qcedAt:hist.qcedAt||Date.now(),
              statusWorkers:hist.statusWorkers||[],
              regenerationCount:hist.regenerationCount||0,
              remarks:remarkData,
              updatedAt:Date.now()
            });
          }
          epData.push({
            chapter_id:chapId,
            chapter_title:ch.chapter_title||cd.chapter_title||'',
            audio_status:ch.audio_status||cd.audio_status||ep.audio_available||'',
            chapter_status:ch.chapter_status||ch.status||cd.chapter_status||'',
            audio_duration:hist.duration||ep.audio_duration||ch.audio_duration||cd.audio_duration||0,
            natural_sequence_number:hist.seq||ep.natural_sequence_number||ch.natural_sequence_number||cd.seq_number||0,
            qcCount:qcDetails.length,
            hasQC:qcDetails.length>0,
            statusWorkers:hist.statusWorkers||[],
            regenerationCount:hist.regenerationCount||0
          });
        }catch(e){
          console.warn('Episode refresh failed',chapId,e);
        }
      }));
      status(`Checking QC status: ${Math.min(b+BATCH,eps.length)}/${eps.length} episodes (${qcCount} with QC)...`);
      await sleep(500);
    }
    epData.sort((a,b)=>(a.natural_sequence_number||999999)-(b.natural_sequence_number||999999));
    await fbPut(`showEpisodes/${showId}`,epData);
    const resolvedShowKey=await findShowKey();
    if(resolvedShowKey) await fbPatch(`shows/${resolvedShowKey}/stats`,{total:epData.length,qc:qcCount});
    status(`Done: ${epData.length} episodes synced, ${qcCount} with QC. Go back to PatchStudio and hard refresh.`);
    alert(`PatchStudio QC Refresh complete:\n${epData.length} episodes synced\n${qcCount} episodes with QC remarks\n\nGo back to PatchStudio and hard refresh.`);
  }catch(e){
    console.error(e);
    status(`Failed: ${e.message}`);
    alert(`PatchStudio QC Refresh failed:\n${e.message}`);
  }
})();
