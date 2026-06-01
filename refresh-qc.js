(async function(){
  const CMS='https://api.cms.pocketfm.com/v2/content_api';
  const DB='https://patch-generation-default-rtdb.firebaseio.com';
  const params=new URL(document.currentScript.src).searchParams;
  const showId=params.get('show_id')||'';
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
  async function fbDel(path){
    await fetch(`${DB}/${dbPath(path)}.json`,{method:'DELETE'});
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

  try{
    status(`Loading show ${showId}...`);
    let eps=[], page=1, showTitle='';
    while(page<=2000){
      const d=await cmsGet(`book.show_episodes?show_id=${encodeURIComponent(showId)}&view=cms&is_novel=0&paginate_chapters=true&page_no=${page}`,`show page ${page}`,3);
      const list=d.result?.episodes||[];
      if(!list.length) break;
      eps=eps.concat(list);
      showTitle=showTitle||d.result?.show_title||list[0]?.chapter_details?.show_title||'';
      status(`Loaded episode list: ${eps.length} episodes...`);
      page++;
      if(page%10===0) await sleep(400);
    }
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
          if(qcDetails.length){
            qcCount++;
            const remarkData=qcDetails.map((qc,i)=>({
              idx:i,time:qc.time||'',issueType:qc.issue_type||'',
              userEmail:qc.user_email||'',scriptLine:extractLine(qc.remarks||''),
              note:extractNote(qc.remarks||''),rawRemarks:qc.remarks||'',
              needsPatch:!!extractLine(qc.remarks||'')
            }));
            await fbPut(`episodeRemarks/${chapId}`,{
              title:ch.chapter_title||cd.chapter_title||'Episode',
              showId,
              remarks:remarkData,
              updatedAt:Date.now()
            });
          }else{
            await fbDel(`episodeRemarks/${chapId}`);
          }
          epData.push({
            chapter_id:chapId,
            chapter_title:ch.chapter_title||cd.chapter_title||'',
            audio_status:ch.audio_status||cd.audio_status||ep.audio_available||'',
            audio_duration:ep.audio_duration||ch.audio_duration||cd.audio_duration||0,
            natural_sequence_number:ep.natural_sequence_number||ch.natural_sequence_number||cd.seq_number||0,
            qcCount:qcDetails.length,
            hasQC:qcDetails.length>0
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
    if(showKey) await fbPatch(`shows/${showKey}/stats`,{total:epData.length,qc:qcCount});
    status(`Done: ${epData.length} episodes synced, ${qcCount} with QC. Go back to PatchStudio and hard refresh.`);
    alert(`PatchStudio QC Refresh complete:\n${epData.length} episodes synced\n${qcCount} episodes with QC remarks\n\nGo back to PatchStudio and hard refresh.`);
  }catch(e){
    console.error(e);
    status(`Failed: ${e.message}`);
    alert(`PatchStudio QC Refresh failed:\n${e.message}`);
  }
})();
