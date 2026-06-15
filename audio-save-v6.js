// Audio Save bookmarklet - runs INSIDE cms.pocketfm.com.
// API/auth-only saver: load episodes, read episode_details, then create the
// episode from the generated TTS media using the current logged-in CMS session.
(function(){
  const VERSION='2026-06-15.2-api-auth-only';
  if(window.__ASV_PANEL&&window.__ASV_VERSION===VERSION){
    window.__ASV_PANEL.style.display='block';
    return;
  }
  if(window.__ASV_PANEL){
    try{ window.__ASV_PANEL.remove(); }catch{}
    window.__ASV_PANEL=null;
  }

  const STORE_KEY='patchstudio_audio_save_settings';
  const CMS='https://api.cms.pocketfm.com/v2/content_api';
  const CMS_SHOW_BASE='https://cms.pocketfm.com/shows/audiobooks';
  const EPISODE_LIST_WAIT_MS=30000;
  window.__ASV_VERSION=VERSION;

  function readStored(){
    try{ return JSON.parse(localStorage.getItem(STORE_KEY)||'{}')||{}; }
    catch{ return {}; }
  }
  const stored=readStored();
  const state={
    running:false,
    stop:false,
    log:[],
    eps:[],
    token:pickAuthToken(),
    uid:pickUid(),
    showInput:stored.showInput||defaultShowInput(),
    from:stored.from||'',
    to:stored.to||'',
    delayMs:Number(stored.delayMs||1800)
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
  function pickAuthToken(){
    const keys=['access-token','access_token','accessToken','token','auth_token','authToken','ps_token'];
    for(const k of keys){
      try{
        const v=localStorage.getItem(k);
        if(v&&v.length>20) return v;
      }catch{}
    }
    return '';
  }
  function pickUid(){
    const keys=['uid','user_id','userId','ps_uid'];
    for(const k of keys){
      try{
        const v=localStorage.getItem(k);
        if(v&&v.length>3) return v;
      }catch{}
    }
    return '';
  }
  function hdrs(){
    return {
      'Content-Type':'application/json',
      'access-token':state.token,
      'uid':state.uid,
      'app-client':'consumer-web',
      'app-version':'180',
      'auth-token':'web-auth',
      'source':'cms'
    };
  }
  function persist(){
    try{
      localStorage.setItem(STORE_KEY, JSON.stringify({
        showInput:state.showInput,
        from:state.from,
        to:state.to,
        delayMs:state.delayMs
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
    const currentTab=(()=>{
      try{
        const u=new URL(location.href);
        if(u.hostname==='cms.pocketfm.com'&&u.pathname.includes('/shows/audiobooks')){
          return u.searchParams.get('tab')||'published';
        }
      }catch{}
      return 'published';
    })();
    return {url:`${CMS_SHOW_BASE}?tab=${encodeURIComponent(currentTab)}&id=${encodeURIComponent(id)}`, showId:id};
  }
  function looksLikeEpisode(v){
    if(!v||typeof v!=='object') return false;
    const cd=v.chapter_details||v;
    return !!(cd&&typeof cd==='object'&&(
      cd.chapter_id||v.chapter_id||
      cd.natural_sequence_number||v.natural_sequence_number||
      cd.seq_number||v.seq_number||
      cd.chapter_title||v.chapter_title
    ));
  }
  function episodeListFromPayload(data){
    const roots=[data?.result,data?.results,data?.data,data].filter(Boolean);
    const directKeys=['episodes','chapters','chapter_details','chapter_list','stories','story_details','results','data','list','items'];
    for(const root of roots){
      for(const key of directKeys){
        const val=root?.[key];
        if(Array.isArray(val)&&val.some(looksLikeEpisode)) return val;
      }
    }
    const seen=new Set();
    function walk(obj,depth=0){
      if(!obj||typeof obj!=='object'||depth>5||seen.has(obj)) return null;
      seen.add(obj);
      if(Array.isArray(obj)){
        if(obj.some(looksLikeEpisode)) return obj;
        for(const item of obj){
          const found=walk(item,depth+1);
          if(found) return found;
        }
        return null;
      }
      for(const val of Object.values(obj)){
        const found=walk(val,depth+1);
        if(found) return found;
      }
      return null;
    }
    return walk(data)||[];
  }
  function nextListUrl(data){
    const raw=data?.result?.next_url||data?.results?.next_url||data?.data?.next_url||data?.next_url||'';
    if(!raw) return '';
    if(/^https?:\/\//i.test(raw)) return raw;
    if(raw.startsWith('/v2/content_api/')) return `https://api.cms.pocketfm.com${raw}`;
    if(raw.startsWith('/content_api/')) return `${CMS}${raw.replace(/^\/content_api/,'')}`;
    if(raw.startsWith('/')) return `${CMS}${raw}`;
    return `${CMS}/${raw}`;
  }
  function buildEpisodeListUrl(showId,view,chapPag,page){
    const params=new URLSearchParams({show_id:showId,is_novel:'0'});
    if(view) params.set('view',view);
    if(chapPag) params.set('paginate_chapters','true');
    if(page) params.set('page_no',String(page));
    return `${CMS}/book.show_episodes?${params.toString()}`;
  }
  async function fetchEps(showId){
    async function getList(url){
      const r=await fetch(url,{headers:hdrs(),credentials:'include'});
      if(!r.ok) return {status:r.status, eps:[], nextUrl:''};
      const d=await r.json();
      return {status:r.status, eps:episodeListFromPayload(d), nextUrl:nextListUrl(d)};
    }
    async function paged(label,view,chapPag){
      let eps=[], firstStatus=200;
      const seenUrls=new Set();
      const addPage=async url=>{
        if(seenUrls.has(url)) return '';
        seenUrls.add(url);
        let res;
        try{ res=await getList(url); }
        catch(e){ return ''; }
        if(seenUrls.size===1) firstStatus=res.status;
        if(res.eps.length) eps=eps.concat(res.eps);
        return res.nextUrl||'';
      };

      // CMS itself loads the first page without page_no. For some shows,
      // forcing page_no=1 returns 200 with an empty payload.
      let next=await addPage(buildEpisodeListUrl(showId,view,chapPag,0));
      let guard=0;
      while(next&&guard<2000){
        guard++;
        next=await addPage(next);
        if(guard%10===0) await sleep(300);
      }

      for(let page=1;page<=2000;page++){
        const before=eps.length;
        await addPage(buildEpisodeListUrl(showId,view,chapPag,page));
        if(eps.length===before) break;
        if(page%10===0) await sleep(300);
      }
      return {label, eps, firstStatus};
    }
    const attempts=[
      ['cms+chapPag','cms',true],
      ['cms','cms',false],
      ['plain+chapPag','',true],
      ['plain','',false]
    ];
    const results=await Promise.all(attempts.map(([label,v,c])=>paged(label,v,c)));
    const combined=results.flatMap(r=>r.eps);
    if(!combined.length){
      const allAuth=results.every(r=>r.firstStatus===401||r.firstStatus===403);
      if(allAuth) throw new Error('CMS auth failed. Run this from a logged-in cms.pocketfm.com tab.');
      throw new Error('No episodes returned from CMS API - '+results.map(r=>`${r.label}=${r.firstStatus}`).join(', '));
    }
    const seen=new Set(), merged=[];
    for(const ep of combined){
      const cd=ep.chapter_details||ep;
      const cid=cd.chapter_id||ep.chapter_id||'';
      if(!cid||seen.has(cid)) continue;
      seen.add(cid);
      merged.push({
        chapter_id:cid,
        book_id:cd.book_id||ep.book_id||'',
        chapter_title:cd.chapter_title||ep.chapter_title||'',
        seq:cd.natural_sequence_number||ep.natural_sequence_number||cd.seq_number||ep.seq_number||cd.sequence_number||ep.sequence_number||cd.episode_number||ep.episode_number||cd.sn||ep.sn||0,
        audio_duration:cd.audio_duration||ep.audio_duration||0,
        audio_status:cd.audio_status||ep.audio_status||'',
        chapter_status:cd.chapter_Status||cd.chapter_status||ep.chapter_status||''
      });
    }
    return merged.sort((a,b)=>(a.seq||0)-(b.seq||0));
  }
  function cmsDateTime(d=new Date()){
    const p=n=>String(n).padStart(2,'0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function positiveNumber(v){
    const n=Number(v);
    return Number.isFinite(n)&&n>0?n:0;
  }
  function getPath(obj,path){
    let cur=obj;
    for(const part of path){
      if(cur==null) return undefined;
      cur=cur[part];
    }
    return cur;
  }
  function safeDecode(v){
    try{ return decodeURIComponent(v); }
    catch{ return v; }
  }
  function looksLikeAudioRef(v){
    const s=String(v||'').trim();
    return !!s && (/^https?:\/\//i.test(s)||/\.(mp3|wav|m4a|aac|flac|ogg)([?#].*)?$/i.test(s)||/[a-f0-9]{20,}[_-]/i.test(s));
  }
  function keyFromMediaRef(v){
    const s=String(v||'').trim();
    if(!s) return '';
    const noQuery=s.split('?')[0].split('#')[0];
    const part=noQuery.includes('/') ? noQuery.split('/').filter(Boolean).pop() : noQuery;
    return safeDecode(part||noQuery||s).trim();
  }
  function ttsContainers(details){
    const ch=details.chapter_details||{};
    const st=details.story_details||{};
    return [
      details.text_to_speech_details,
      ch.text_to_speech_details,
      st.text_to_speech_details,
      details.tts_details,
      ch.tts_details,
      st.tts_details,
      details.ai_audio_details,
      ch.ai_audio_details,
      details.generated_audio_details,
      ch.generated_audio_details
    ].filter(Boolean);
  }
  function walkValues(root, cb, path='root', depth=0, seen=new Set()){
    if(root==null||depth>8) return null;
    if(typeof root!=='object') return null;
    if(seen.has(root)) return null;
    seen.add(root);
    if(Array.isArray(root)){
      for(let i=0;i<root.length;i++){
        const found=walkValues(root[i],cb,`${path}[${i}]`,depth+1,seen);
        if(found) return found;
      }
      return null;
    }
    for(const [k,v] of Object.entries(root)){
      const p=`${path}.${k}`;
      const hit=cb(k,v,p,root);
      if(hit) return hit;
      if(v&&typeof v==='object'){
        const found=walkValues(v,cb,p,depth+1,seen);
        if(found) return found;
      }
    }
    return null;
  }
  function findGeneratedMediaRef(details){
    const directPaths=[
      ['text_to_speech_details','job_details','s3_media_url'],
      ['text_to_speech_details','job_details','job_details','s3_media_url'],
      ['text_to_speech_details','job_details','media_url'],
      ['text_to_speech_details','job_details','audio_url'],
      ['chapter_details','text_to_speech_details','job_details','s3_media_url'],
      ['chapter_details','text_to_speech_details','job_details','job_details','s3_media_url'],
      ['story_details','text_to_speech_details','job_details','s3_media_url']
    ];
    for(const path of directPaths){
      const v=getPath(details,path);
      if(typeof v==='string'&&v.trim()) return {value:v.trim(),path:path.join('.')};
    }
    for(const container of ttsContainers(details)){
      const found=walkValues(container,(k,v,p)=>{
        if(typeof v!=='string'||!v.trim()) return null;
        const name=`${p}.${k}`.toLowerCase();
        const goodKey=/s3_media_url|s3.*media.*url|media_url|audio_url|generated.*url|current.*url|s3_unique_key|s3_key|media_key/.test(name);
        if(goodKey&&looksLikeAudioRef(v)) return {value:v.trim(),path:p};
        return null;
      },'text_to_speech_details');
      if(found) return found;
    }
    return null;
  }
  function findGeneratedDuration(details){
    const containers=ttsContainers(details);
    const durationKeys=/^(duration|audio_duration|media_duration|tts_duration|audio_length|length|total_duration)$/i;
    for(const container of containers){
      const found=walkValues(container,(k,v,p)=>{
        if(durationKeys.test(k)){
          const n=positiveNumber(v);
          if(n) return {value:Math.ceil(n),path:p};
        }
        return null;
      },'text_to_speech_details');
      if(found) return found;
    }
    const fallbackPaths=[
      ['story_details','duration'],
      ['chapter_details','audio_duration'],
      ['audio_duration'],
      ['duration']
    ];
    for(const path of fallbackPaths){
      const n=positiveNumber(getPath(details,path));
      if(n) return {value:Math.ceil(n),path:path.join('.')};
    }
    return null;
  }
  function findTtsStatus(details){
    for(const container of ttsContainers(details)){
      const direct=getPath(container,['job_details','status'])||getPath(container,['status']);
      if(direct) return String(direct);
    }
    return '';
  }
  function shortJson(obj,max=900){
    try{
      return JSON.stringify(obj,(k,v)=>{
        if(typeof v==='string'&&v.length>180) return v.slice(0,180)+'...';
        return v;
      }).slice(0,max);
    }catch{
      return String(obj||'').slice(0,max);
    }
  }
  async function fetchEpisodeDetails(ep,showId){
    const chapterId=ep.chapter_id;
    if(!chapterId) throw new Error('episode is missing chapter_id');
    const attempts=[
      {chapter_id:chapterId,show_id:showId,view:'cms',is_novel:'0'},
      {chapter_id:chapterId,show_id:showId,is_novel:'0'},
      {chapter_id:chapterId,view:'cms',is_novel:'0'},
      {chapter_id:chapterId,is_novel:'0'}
    ];
    let lastStatus='';
    for(const paramsObj of attempts){
      const params=new URLSearchParams(paramsObj);
      let r;
      try{
        r=await fetch(`${CMS}/book.episode_details?${params.toString()}`,{headers:hdrs(),credentials:'include'});
      }catch(e){
        lastStatus=e.message;
        continue;
      }
      lastStatus=String(r.status);
      if(!r.ok) continue;
      const data=await r.json();
      const details=data.result||{};
      if(details.chapter_details) return details;
    }
    throw new Error(`episode_details failed for ${chapterId} (${lastStatus})`);
  }
  async function getTtsMediaUrl(details,showId){
    const ch=details.chapter_details||{};
    const params=new URLSearchParams({type:'tts_media',media_type:'audio',event:'play'});
    if(ch.chapter_id) params.append('chapter_id',ch.chapter_id);
    params.append('show_id',details.show_id||showId);
    if(details.story_id||details.story_details?.story_id) params.append('story_id',details.story_id||details.story_details.story_id);
    const r=await fetch(`${CMS}/get_media_url?${params.toString()}`,{headers:hdrs(),credentials:'include'});
    if(!r.ok) throw new Error(`get_media_url tts_media HTTP ${r.status}`);
    const d=await r.json();
    return d.result?.media_url||d.result?.url||d.media_url||d.url||'';
  }
  function audioDurationFromUrl(url){
    return new Promise(resolve=>{
      if(!url) return resolve(0);
      let done=false;
      const finish=v=>{
        if(done) return;
        done=true;
        try{ audio.removeAttribute('src'); audio.load(); }catch{}
        resolve(v||0);
      };
      const audio=new Audio();
      const timer=setTimeout(()=>finish(0),12000);
      audio.preload='metadata';
      audio.crossOrigin='anonymous';
      audio.onloadedmetadata=()=>{
        clearTimeout(timer);
        finish(Math.ceil(audio.duration||0));
      };
      audio.onerror=()=>{
        clearTimeout(timer);
        finish(0);
      };
      audio.src=url;
    });
  }
  function pickCreatedBy(details){
    return details.story_details?.created_by ||
      details.chapter_details?.created_by ||
      details.created_by ||
      details.auditionbook?.creator_info?.creator_id ||
      details.creator_info?.creator_id ||
      '';
  }
  function isNewAiWorkflow(details){
    return details.new_ai_workflow===1 ||
      details.new_ai_workflow===true ||
      details.chapter_details?.new_ai_workflow===1 ||
      details.auditionbook?.new_ai_workflow===1;
  }
  function buildCreatePayload(details,showId,aiKey,duration,createdBy){
    const chapter={...(details.chapter_details||{})};
    const bookId=details.book_id||chapter.book_id||details.auditionbook?.book_id||details.auditionbook?.book_id_str||'';
    const resolvedShowId=details.show_id||chapter.show_id||showId;
    const title=chapter.chapter_title||details.story_details?.story_title||details.chapter_title||'';
    chapter.content_unchanged=1;
    const storyBase={
      show_id:resolvedShowId,
      story_title:title,
      s3_unique_key:aiKey,
      duration:duration||null,
      created_by:createdBy,
      is_ai_episode:true
    };
    let story;
    if(isNewAiWorkflow(details)){
      story={
        ...storyBase,
        status:chapter.status||'pending',
        audio_status:chapter.audio_status||'pending',
        audio_flow_eligible:true,
        story_scheduled_time:chapter.story_scheduled_time||null,
        auto_master_approved_date:chapter.auto_master_approved_date||null
      };
    }else{
      story={
        ...storyBase,
        status:'approved',
        audio_status:'approved',
        audio_flow_eligible:false,
        schedule_time:chapter.schedule_time||details.schedule_time||cmsDateTime()
      };
    }
    return {
      chapter_details:chapter,
      story_details:story,
      book_id:bookId,
      show_id:resolvedShowId,
      view:'cms'
    };
  }
  async function createEpisodeFromCurrentAudio(ep,showId){
    const details=await fetchEpisodeDetails(ep,showId);
    const ch=details.chapter_details||{};
    const ttsStatus=findTtsStatus(details);
    if(ttsStatus&&/pending|inprogress|failed/i.test(ttsStatus)){
      log(`Ep ${ep.seq} TTS status is ${ttsStatus}; attempting save only if media is present`,'warn');
    }

    let media=findGeneratedMediaRef(details);
    let mediaUrl=media?.value||'';
    if(!mediaUrl){
      try{
        mediaUrl=await getTtsMediaUrl(details,showId);
        if(mediaUrl) media={value:mediaUrl,path:'get_media_url(tts_media)'};
      }catch(e){
        log(`Ep ${ep.seq} TTS media lookup warning: ${e.message}`,'warn');
      }
    }
    const aiKey=keyFromMediaRef(mediaUrl);
    if(!aiKey){
      throw new Error(`AI generated audio key not found. TTS details: ${shortJson(details.text_to_speech_details||ch.text_to_speech_details||{})}`);
    }

    let durationInfo=findGeneratedDuration(details);
    let duration=durationInfo?.value||0;
    if(!duration&&mediaUrl&&/^https?:\/\//i.test(mediaUrl)){
      duration=await audioDurationFromUrl(mediaUrl);
      if(duration) durationInfo={value:duration,path:'loadedmetadata(tts_media)'};
    }
    if(!duration){
      log(`Ep ${ep.seq} duration not found; sending null like CMS does when metadata is unavailable`,'warn');
    }

    const createdBy=pickCreatedBy(details);
    if(!createdBy) log(`Ep ${ep.seq} created_by not found; CMS may reject this episode`,'warn');
    const body=buildCreatePayload(details,showId,aiKey,duration,createdBy);
    log(`Ep ${ep.seq} using ${media.path}; key=${aiKey}; duration=${duration||'null'}`);
    const r=await fetch(`${CMS}/book.create_episode?is_novel=0`,{
      method:'POST',
      headers:hdrs(),
      credentials:'include',
      body:JSON.stringify(body)
    });
    const text=await r.text();
    let data=null;
    try{ data=text?JSON.parse(text):null; }catch{}
    if(!r.ok){
      throw new Error(`book.create_episode HTTP ${r.status}${text?' - '+text.slice(0,180):''}`);
    }
    const resultKey=data?.result?.story_details?.story_info?.s3_unique_key ||
      data?.result?.story_details?.s3_unique_key ||
      data?.result?.story_info?.s3_unique_key ||
      '';
    if(resultKey&&resultKey!==aiKey){
      log(`Ep ${ep.seq} saved but response key differs: ${resultKey}`,'warn');
    }else{
      log(`Ep ${ep.seq} book.create_episode OK`,'ok');
    }
    return data;
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
  async function saveEpisodeNumber(ep,showId){
    const seq=ep.seq||'?';
    log(`Saving Ep ${seq} via CMS API (${ep.chapter_id.slice(0,8)}...)`);
    await createEpisodeFromCurrentAudio(ep,showId);
    log(`Ep ${seq} saved from current AI audio`,'ok');
  }
  function readInputs(){
    state.showInput=(document.getElementById('asv-show')?.value||'').trim();
    state.from=(document.getElementById('asv-from')?.value||'').trim();
    state.to=(document.getElementById('asv-to')?.value||'').trim();
    state.delayMs=Math.max(700,Number(document.getElementById('asv-delay')?.value||state.delayMs)||1800);
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
    state.token=pickAuthToken();
    state.uid=pickUid();
    log(`Loading episodes from CMS API for ${target.showId}`);
    let ok=0,fail=0;
    try{
      let selected=[];
      let missing=[];
      try{
        state.eps=await fetchEps(target.showId);
        const bySeq=new Map(state.eps.map(ep=>[Number(ep.seq),ep]));
        selected=eps.map(seq=>bySeq.get(Number(seq))).filter(Boolean);
        missing=eps.filter(seq=>!bySeq.has(Number(seq)));
        log(`CMS API loaded ${state.eps.length} episodes; selected ${selected.length} for ${state.from}-${state.to}`);
        if(missing.length) log(`Range not found in API: ${missing.join(', ')}`,'warn');
      }catch(apiErr){
        throw new Error(`CMS API list failed: ${apiErr.message}`);
      }

      if(!selected.length){
        throw new Error('No matching episodes found in CMS API for this range.');
      }
      for(const seq of missing){
        fail++;
        log(`Ep ${seq} skipped: not found in CMS API response`,'err');
      }
      for(const ep of selected){
        if(state.stop){ log('Stopped by user','warn'); break; }
        try{
          await saveEpisodeNumber(ep,target.showId);
          ok++;
        }catch(e){
          fail++;
          log(`Ep ${ep.seq} API save failed: ${e.message}`,'err');
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
        <div style="font-size:10px;color:#bbf7d0">CMS API current-audio save · v${VERSION}</div>
      </div>
      <button onclick="window.__ASV_close()" style="background:transparent;border:none;color:#dcfce7;font-size:20px;cursor:pointer;line-height:1">x</button>
    </div>
    <div style="padding:13px 14px">
      <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:9px;padding:10px 12px;margin-bottom:10px;color:#14532d;font-size:12px;line-height:1.45">
        Paste the CMS show ID or full CMS show URL, enter the episode range, then start. This version is API/auth-only: it uses your logged-in CMS session and never opens episode rows or clicks CMS buttons.
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
        <label>Delay <input id="asv-delay" type="number" min="700" step="100" value="${state.delayMs}" onchange="window.__ASV_set('delayMs',Math.max(700,Number(this.value)||1800))" style="width:82px;padding:4px;border:1px solid #cbd5e1;border-radius:5px"/> ms</label>
      </div>

      <div style="font-size:11px;color:#64748b;line-height:1.45;margin-bottom:10px">
        Keep this running inside a logged-in cms.pocketfm.com tab so the API calls include the right CMS auth.
      </div>

      <div style="font-size:11px;font-weight:800;margin-bottom:5px">Execution log</div>
      <div id="asv-log" style="max-height:260px;overflow:auto;background:#0f172a;color:#cbd5e1;border-radius:7px;padding:8px 10px;font-family:monospace;font-size:10px;line-height:1.5">${state.log.map(L=>{const c=L.kind==='err'?'#f87171':L.kind==='ok'?'#4ade80':L.kind==='warn'?'#fbbf24':'#cbd5e1';return `<div style="color:${c};padding:2px 0">[${esc(L.t)}] ${esc(L.msg)}</div>`;}).join('')||'<span style="color:#64748b">Waiting...</span>'}</div>
    </div>`;
  }

  render();
})();
