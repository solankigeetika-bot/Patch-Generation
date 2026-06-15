// Audio Replace bookmarklet — runs INSIDE cms.pocketfm.com so all CMS
// API calls share the same origin/session as CMS UI itself. Loaded via the
// PatchStudio "Audio Replace" bookmarklet.
(function(){
  const VERSION='2026-06-16.3-api-auth-only';
  if(window.__AR_PANEL&&window.__AR_VERSION===VERSION){ window.__AR_PANEL.style.display='block'; return; }
  if(window.__AR_PANEL){
    try{ window.__AR_PANEL.remove(); }catch{}
    window.__AR_PANEL=null;
  }

  const CMS='https://api.cms.pocketfm.com/v2/content_api';
  const UPLOAD_BASE='https://api.cms.pocketfm.com/v2/upload';
  const CONTENT_BASES=[
    {key:'api-v2', url:CMS}
  ];
  window.__AR_VERSION=VERSION;

  // ---- auth ----
  function storageList(){
    return [localStorage,sessionStorage].filter(Boolean);
  }
  function storageVal(key){
    for(const store of storageList()){
      try{
        const v=store.getItem(key);
        if(v) return v;
      }catch{}
    }
    return '';
  }
  function storageKeys(){
    const out=[];
    for(const store of storageList()){
      try{
        for(let i=0;i<store.length;i++) out.push(store.key(i));
      }catch{}
    }
    return out.filter(Boolean);
  }
  function findNestedValue(obj,names,min,depth=0,seen=new Set()){
    if(!obj||typeof obj!=='object'||depth>5||seen.has(obj)) return '';
    seen.add(obj);
    for(const name of names){
      const v=obj[name]||(obj.user_info&&obj.user_info[name])||(obj.userInfo&&obj.userInfo[name])||(obj.auth&&obj.auth[name]);
      if(v&&String(v).length>=min) return String(v);
    }
    for(const val of Object.values(obj)){
      if(typeof val==='string'&&/^\s*[\[{]/.test(val)){
        try{
          const found=findNestedValue(JSON.parse(val),names,min,depth+1,seen);
          if(found) return found;
        }catch{}
      }else if(val&&typeof val==='object'){
        const found=findNestedValue(val,names,min,depth+1,seen);
        if(found) return found;
      }
    }
    return '';
  }
  function pickStorageValue(exact,keyRe,min){
    for(const key of exact){
      const v=storageVal(key);
      if(v&&v.length>=min) return v;
    }
    for(const key of storageKeys()){
      if(keyRe.test(key)){
        const v=storageVal(key);
        if(v&&v.length>=min) return v;
      }
    }
    for(const key of storageKeys()){
      const raw=storageVal(key);
      if(!raw||!/^\s*[\[{]/.test(raw)) continue;
      try{
        const found=findNestedValue(JSON.parse(raw),exact,min);
        if(found) return found;
      }catch{}
    }
    return '';
  }
  function pickAuthToken(){
    return pickStorageValue(['token','access-token','access_token','accessToken','auth_token','authToken','id_token','idToken','sessionToken','ps_token'],/token|auth|access/i,20);
  }
  function pickUid(){
    return pickStorageValue(['uid','user_id','userId','ps_uid'],/uid|user.?id/i,3);
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
  function headerCandidates(base){
    const token={label:'token', headers:hdrs()};
    return [token];
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
    const m=s.match(/(?:show_id|id)=([a-f0-9]{20,})/i);
    if(m) return m[1];
    const raw=s.match(/([a-f0-9]{20,})/i);
    return raw?raw[1]:'';
  }
  function firstObj(...vals){
    for(const v of vals) if(v&&typeof v==='object'&&!Array.isArray(v)) return v;
    return {};
  }
  function pick(...vals){
    for(const v of vals) if(v!==undefined&&v!==null&&v!=='') return v;
    return '';
  }
  function chapterObj(ep){
    return firstObj(
      ep?.chapter_details,
      ep?.chapterDetails,
      ep?.chapter,
      ep?.episode_details,
      ep?.episodeDetails,
      ep?.details?.chapter_details,
      ep?.chapterAndStory?.chapter_details,
      ep?.chapter_and_story?.chapter_details,
      ep?.story_show_info?.chapter_details
    );
  }
  function storyObj(ep){
    return firstObj(
      ep?.story_details,
      ep?.storyDetails,
      ep?.story,
      ep?.details?.story_details,
      ep?.chapterAndStory?.story_details,
      ep?.chapter_and_story?.story_details,
      ep?.story_show_info?.story_details,
      ep?.show_info?.story_details
    );
  }
  function looksLikeEpisode(v){
    if(!v||typeof v!=='object') return false;
    const cd=chapterObj(v);
    const sd=storyObj(v);
    return !!(
      cd.chapter_id||v.chapter_id||sd.chapter_id||
      sd.story_id||v.story_id||v.storyId||
      cd.natural_sequence_number||v.natural_sequence_number||
      cd.seq_number||v.seq_number||sd.seq_number||
      cd.chapter_title||v.chapter_title||sd.story_title||v.story_title||v.title
    );
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
  function payloadShape(data){
    function shortDiag(v){
      if(v===undefined||v===null||v==='') return '';
      if(typeof v==='object'){
        try{ v=JSON.stringify(v); }catch{ v=String(v); }
      }
      return String(v).replace(/\s+/g,' ').slice(0,120);
    }
    const roots=[['result',data?.result],['results',data?.results],['data',data?.data],['root',data]].filter(([,v])=>v&&typeof v==='object');
    const parts=[];
    const status=shortDiag(pick(data?.status,data?.code,data?.result?.status,data?.result?.code,data?.data?.status,data?.data?.code));
    const message=shortDiag(pick(data?.message,data?.error,data?.detail,data?.result?.message,data?.result?.error,data?.data?.message,data?.data?.error));
    if(status||message) parts.push(`${status?`status=${status}`:''}${message?`${status?' ':''}msg=${message}`:''}`);
    for(const [name,obj] of roots.slice(0,3)){
      if(Array.isArray(obj)){ parts.push(`${name}[${obj.length}]`); continue; }
      const keys=Object.keys(obj).slice(0,8);
      const arrs=keys.filter(k=>Array.isArray(obj[k])).map(k=>`${k}[${obj[k].length}]`);
      parts.push(`${name}{${keys.join('|')}}${arrs.length?':'+arrs.join('|'):''}`);
    }
    return parts.join(';')||typeof data;
  }
  function nextListUrl(data, base){
    const raw=data?.result?.next_url||data?.results?.next_url||data?.data?.next_url||data?.next_url||'';
    if(!raw) return '';
    if(/^https?:\/\//i.test(raw)){
      try{
        const u=new URL(raw);
        if(u.hostname==='cms.pocketfm.com'&&u.pathname.startsWith('/content_api/')){
          return `${CMS}${u.pathname.replace(/^\/content_api/,'')}${u.search}`;
        }
      }catch{}
      return raw;
    }
    if(raw.startsWith('/v2/content_api/')) return `https://api.cms.pocketfm.com${raw}`;
    if(raw.startsWith('/content_api/')) return `${CMS}${raw.replace(/^\/content_api/,'')}`;
    if(raw.startsWith('/')) return `${base?.url||CMS}${raw}`;
    return `${base?.url||CMS}/${raw}`;
  }
  function buildEpisodeListUrl(base,idKey,id,view,chapPag,page){
    const params=new URLSearchParams({[idKey]:id,is_novel:'0'});
    if(view) params.set('view',view);
    if(chapPag) params.set('paginate_chapters','true');
    if(page) params.set('page_no',String(page));
    return `${base.url}/book.show_episodes?${params.toString()}`;
  }
  function buildSequencedUrl(base,endpoint,idKey,id){
    const params=new URLSearchParams({[idKey]:id,seq_start:'1',seq_end:'5000',is_novel:'0'});
    return `${base.url}/${endpoint}?${params.toString()}`;
  }
  function buildBookDetailsUrl(base,bookId){
    const params=new URLSearchParams({book_id:bookId,view:'cms',info_level:'max',is_novel:'0'});
    return `${base.url}/book.book_details?${params.toString()}`;
  }

  async function fetchEps(inputId){
    async function getList(url, base){
      let best={status:0, eps:[], nextUrl:'', authLabel:'', shape:''};
      for(const hc of headerCandidates(base)){
        const r=await fetch(url,{headers:hc.headers,credentials:'include'});
        if(!r.ok){
          if(!best.status) best={status:r.status, eps:[], nextUrl:'', authLabel:hc.label, shape:''};
          continue;
        }
        let d;
        try{ d=await r.json(); }
        catch(e){
          const ct=(r.headers.get('content-type')||'').split(';')[0]||'unknown';
          if(!best.status) best={status:r.status, eps:[], nextUrl:'', authLabel:hc.label, shape:`non-json:${ct}`};
          continue;
        }
        const eps=episodeListFromPayload(d);
        const nextUrl=nextListUrl(d,base);
        const res={status:r.status, eps, nextUrl, authLabel:hc.label, shape:payloadShape(d)};
        if(eps.length||nextUrl) return res;
        if(!best.status||best.status!==200) best=res;
      }
      return best;
    }
    async function paged(base, label, idKey, view, chapPag){
      let eps=[], firstStatus=200, firstShape='';
      const seenUrls=new Set();
      const addPage=async url=>{
        if(seenUrls.has(url)) return '';
        seenUrls.add(url);
        let res;
        try{ res=await getList(url,base); }
        catch(e){
          if(seenUrls.size===1){ firstStatus=0; firstShape=`fetch-error:${e.name||'error'}`; }
          return '';
        }
        if(seenUrls.size===1) firstStatus=res.status;
        if(seenUrls.size===1) firstShape=res.shape||'';
        if(res.eps.length) eps=eps.concat(res.eps.map(ep=>Object.assign({}, ep, {
          __pf_lookup_key:idKey,
          __pf_lookup_id:inputId,
          __pf_lookup_label:label,
          __pf_base_key:base.key,
          __pf_base_url:base.url,
          __pf_auth_label:res.authLabel
        })));
        return res.nextUrl||'';
      };

      let next=await addPage(buildEpisodeListUrl(base,idKey,inputId,view,chapPag,0));
      let guard=0;
      while(next&&guard<2000){
        guard++;
        next=await addPage(next);
        if(guard%10===0) await new Promise(res=>setTimeout(res,300));
      }

      for(let page=1;page<=2000;page++){
        const before=eps.length;
        await addPage(buildEpisodeListUrl(base,idKey,inputId,view,chapPag,page));
        if(eps.length===before) break;
        if(page%10===0) await new Promise(res=>setTimeout(res,300));
      }
      return {label:`${base.key}:${label}`, eps, firstStatus, shape:firstShape};
    }
    async function sequenced(base, label, idKey, endpoint){
      let firstStatus=200, firstShape='';
      let res;
      try{ res=await getList(buildSequencedUrl(base,endpoint,idKey,inputId),base); }
      catch(e){ return {label:`${base.key}:${label}`, eps:[], firstStatus:0, shape:`fetch-error:${e.name||'error'}`}; }
      firstStatus=res.status;
      firstShape=res.shape||'';
      return {label:`${base.key}:${label}`, eps:res.eps.map(ep=>Object.assign({}, ep, {
        __pf_lookup_key:idKey,
        __pf_lookup_id:inputId,
        __pf_lookup_label:label,
        __pf_base_key:base.key,
        __pf_base_url:base.url,
        __pf_auth_label:res.authLabel
      })), firstStatus, shape:firstShape};
    }
    async function bookDetails(base, label){
      let eps=[], firstStatus=200, firstShape='';
      const seenUrls=new Set();
      const addPage=async url=>{
        if(seenUrls.has(url)) return '';
        seenUrls.add(url);
        let res;
        try{ res=await getList(url,base); }
        catch(e){
          if(seenUrls.size===1){ firstStatus=0; firstShape=`fetch-error:${e.name||'error'}`; }
          return '';
        }
        if(seenUrls.size===1) firstStatus=res.status;
        if(seenUrls.size===1) firstShape=res.shape||'';
        if(res.eps.length) eps=eps.concat(res.eps.map(ep=>Object.assign({}, ep, {
          __pf_lookup_key:'book_id',
          __pf_lookup_id:inputId,
          __pf_lookup_label:label,
          __pf_base_key:base.key,
          __pf_base_url:base.url,
          __pf_auth_label:res.authLabel
        })));
        return res.nextUrl||'';
      };
      let next=await addPage(buildBookDetailsUrl(base,inputId));
      let guard=0;
      while(next&&guard<2000){
        guard++;
        next=await addPage(next);
        if(guard%10===0) await new Promise(res=>setTimeout(res,300));
      }
      return {label:`${base.key}:${label}`, eps, firstStatus, shape:firstShape};
    }
    const attempts=[
      ['show:cms+chapPag','show_id','cms',true],
      ['show:cms','show_id','cms',false],
      ['show:plain+chapPag','show_id','',true],
      ['show:plain','show_id','',false],
      ['book:cms+chapPag','book_id','cms',true],
      ['book:cms','book_id','cms',false],
      ['book:plain+chapPag','book_id','',true],
      ['book:plain','book_id','',false]
    ];
    const sequencedAttempts=[
      ['show:sequenced_episodes','show_id','book.get_sequenced_episodes'],
      ['book:sequenced_episodes','book_id','book.get_sequenced_episodes'],
      ['show:sequenced_chapters','show_id','book.get_sequenced_chapters'],
      ['book:sequenced_chapters','book_id','book.get_sequenced_chapters'],
      ['book:chapter_name','book_id','book.chapter_name']
    ];
    const results=[];
    for(const base of CONTENT_BASES){
      const baseResults=[
        ...(await Promise.all(attempts.map(([label,key,v,c])=>paged(base,label,key,v,c)))),
        await bookDetails(base,'book:book_details'),
        ...(await Promise.all(sequencedAttempts.map(([label,key,endpoint])=>sequenced(base,label,key,endpoint))))
      ];
      results.push(...baseResults);
      if(baseResults.some(r=>r.eps.length)) break;
    }
    const combined=results.flatMap(r=>r.eps);
    if(!combined.length){
      const allAuth=results.every(r=>r.firstStatus===401||r.firstStatus===403);
      if(allAuth) throw new Error('CMS auth — make sure you are logged into cms.pocketfm.com');
      const details=results.map(r=>`${r.label}=${r.firstStatus}${r.shape?' '+r.shape:''}`).join(', ');
      throw new Error('No episodes returned — '+details);
    }
    const seen=new Set(); const merged=[];
    for(const ep of combined){
      const cd=chapterObj(ep);
      const sd=storyObj(ep);
      const cid=pick(cd.chapter_id,ep.chapter_id,sd.chapter_id);
      const sid=pick(sd.story_id,ep.story_id,ep.storyId,sd.storyId);
      const dedupe=cid||sid;
      if(!dedupe||seen.has(dedupe)) continue;
      seen.add(dedupe);
      const lookupKey=ep.__pf_lookup_key||'';
      const lookupId=ep.__pf_lookup_id||'';
      const lookupBaseKey=ep.__pf_base_key||'';
      const lookupBaseUrl=ep.__pf_base_url||'';
      const lookupAuthLabel=ep.__pf_auth_label||'';
      merged.push({
        chapter_id:cid,
        story_id:sid,
        book_id:pick(cd.book_id,sd.book_id,ep.book_id,lookupKey==='book_id'?lookupId:''),
        show_id:pick(cd.show_id,sd.show_id,ep.show_id,ep.entity_id,lookupKey==='show_id'?lookupId:''),
        lookup_key:lookupKey,
        lookup_id:lookupId,
        lookup_base_key:lookupBaseKey,
        lookup_base_url:lookupBaseUrl,
        lookup_auth_label:lookupAuthLabel,
        chapter_title:pick(cd.chapter_title,ep.chapter_title,sd.story_title,ep.story_title,ep.title),
        seq:pick(cd.natural_sequence_number,ep.natural_sequence_number,sd.natural_sequence_number,cd.seq_number,ep.seq_number,sd.seq_number,cd.sequence_number,ep.sequence_number,sd.sequence_number,cd.episode_number,ep.episode_number,sd.episode_number,cd.sn,ep.sn,sd.sn,ep.seq,sd.seq,0),
        audio_duration:pick(cd.audio_duration,ep.audio_duration,sd.duration,ep.duration,0),
        audio_status:pick(cd.audio_status,ep.audio_status,sd.audio_status),
        chapter_status:pick(cd.chapter_Status,cd.chapter_status,ep.chapter_status,sd.status)
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

  // Rate-limit tracking shared across the whole batch. If we just hit a 429,
  // future fetches and the inter-episode delay back off aggressively.
  let _lastRateLimitTs=0;
  let _consecutive429Episodes=0;

  // Rate-limit-aware fetch: retries on 429 with exponential backoff. Throws
  // a tagged error after 4 retries so the caller can distinguish 'CMS is
  // hammering us' from 'genuine 4xx/5xx'.
  async function rlFetch(url, opts){
    let delay=2000;
    for(let attempt=0; attempt<4; attempt++){
      const r=await fetch(url, opts);
      if(r.status!==429) return r;
      _lastRateLimitTs=Date.now();
      log(`  · rate-limited (429), waiting ${Math.round(delay/1000)}s before retry…`);
      await new Promise(res=>setTimeout(res, delay));
      delay=Math.min(delay*2, 60000);
    }
    // Tag the error so the batch loop knows to back off harder.
    const err=new Error('rate-limited by CMS (429 after 4 retries)');
    err.rateLimit=true;
    throw err;
  }

  function contentUrl(path, params, base){
    const q=new URLSearchParams();
    for(const [k,v] of Object.entries(params||{})){
      if(v!==undefined&&v!==null&&v!=='') q.set(k,String(v));
    }
    return `${(base&&base.url)||CMS}/${path}?${q.toString()}`;
  }

  function contentBaseCandidates(ep){
    const out=[]; const seen=new Set();
    const add=base=>{
      if(!base||!base.url||seen.has(base.url)) return;
      seen.add(base.url);
      out.push(base);
    };
    if(ep.lookup_base_url) add({key:ep.lookup_base_key||'episode-base', url:ep.lookup_base_url});
    for(const base of CONTENT_BASES) add(base);
    return out;
  }

  function orderedHeaderCandidates(base, ep){
    const all=headerCandidates(base);
    if(!ep?.lookup_auth_label) return all;
    return all.slice().sort((a,b)=>(a.label===ep.lookup_auth_label?-1:0)+(b.label===ep.lookup_auth_label?1:0));
  }

  function episodeIdCandidates(ep, inputId){
    const out=[]; const seen=new Set();
    const add=(key,value,label)=>{
      if(!key||!value) return;
      const sig=`${key}:${value}`;
      if(seen.has(sig)) return;
      seen.add(sig);
      out.push({key,value,label});
    };
    add('show_id', ep.show_id, 'episode show_id');
    add('book_id', ep.book_id, 'episode book_id');
    if(ep.lookup_key&&ep.lookup_id) add(ep.lookup_key, ep.lookup_id, 'list '+ep.lookup_key);
    add('show_id', inputId, 'input show_id');
    add('book_id', inputId, 'input book_id');
    return out;
  }

  async function copyOne(srcEp, tgtEp){
    // 1. Source audio download — try event=download first (raw file), fall back
    //    to event=play (which may be DRM-streamed and 403 on direct fetch).
    async function getSourceUrl(ev){
      const errors=[];
      const ids=episodeIdCandidates(srcEp, state.srcShowId).concat([{key:'',value:'',label:'chapter only'}]);
      for(const base of contentBaseCandidates(srcEp)){
        for(const id of ids){
          for(const hc of orderedHeaderCandidates(base, srcEp)){
            const params={type:'episode',media_type:'audio',event:ev};
            if(srcEp.chapter_id) params.chapter_id=srcEp.chapter_id;
            if(srcEp.story_id) params.story_id=srcEp.story_id;
            if(id.key) params[id.key]=id.value;
            const r=await rlFetch(contentUrl('get_media_url',params,base),{headers:hc.headers,credentials:'include'});
            const label=`${base.key}:${hc.label}:${id.label}`;
            if(!r.ok){ errors.push(`${label}=HTTP ${r.status}`); continue; }
            const d=await r.json();
            const url=d.result?.media_url||d.media_url||d.result?.url||'';
            if(url) return {url, err:'', via:label};
            errors.push(`${label}=empty`);
          }
        }
      }
      return {url:'', err:errors.join(', ')};
    }
    let playUrl='';
    for(const ev of ['download','play']){
      const got=await getSourceUrl(ev);
      if(got.url){ playUrl=got.url; log(`  · source URL via event=${ev} (${got.via})`); break; }
    }
    if(!playUrl) throw new Error('no media URL on source (tried download + play)');
    let dl=await fetch(playUrl);
    if(dl.status===403){
      // Retry with the play variant if we got download originally (and vice versa)
      log(`  · audio HTTP 403 — retrying with event=play`);
      const alt=await getSourceUrl('play');
      if(alt.url && alt.url!==playUrl){
        playUrl=alt.url;
        dl=await fetch(playUrl);
      }
    }
    if(!dl.ok) throw new Error('audio download HTTP '+dl.status+' — source may be DRM-protected; only chapters with raw to-be-recorded audio can be copied');
    const blob=await dl.blob();
    if(!blob||blob.size<1024) throw new Error('source blob empty/tiny ('+(blob?blob.size:0)+'B)');
    log(`  · downloaded ${(blob.size/1024).toFixed(1)} KB`);

    let duration=await blobDuration(blob);
    if(!duration) duration=srcEp.audio_duration||0;
    if(!duration) throw new Error('could not decode source audio');
    log(`  · duration ${duration}s`);

    // 2. Target episode_details (BEFORE upload)
    async function getTargetDetails(){
      const errors=[];
      const ids=episodeIdCandidates(tgtEp, state.tgtShowId);
      const attempts=[];
      for(const id of ids) attempts.push({id, view:'cms'});
      for(const id of ids) attempts.push({id, view:''});
      attempts.push({id:{key:'',value:'',label:'chapter only'}, view:''});
      for(const base of contentBaseCandidates(tgtEp)){
        for(const attempt of attempts){
          for(const hc of orderedHeaderCandidates(base, tgtEp)){
            const params={is_novel:'0'};
            if(tgtEp.chapter_id) params.chapter_id=tgtEp.chapter_id;
            if(tgtEp.story_id) params.story_id=tgtEp.story_id;
            if(attempt.view) params.view=attempt.view;
            if(attempt.id.key) params[attempt.id.key]=attempt.id.value;
            const url=contentUrl('book.episode_details',params,base);
            const r=await rlFetch(url,{headers:hc.headers,credentials:'include'});
            const label=`${base.key}:${hc.label}:${attempt.id.label}${attempt.view?'+cms':''}`;
            if(!r.ok){ errors.push(`${label}=HTTP ${r.status}`); continue; }
            const d=await r.json();
            const chapter=d.result?.chapter_details;
            const story=d.result?.story_details;
            if(chapter&&story) return {url, chapter, story, label, base, headers:hc.headers};
            errors.push(`${label}=missing`);
          }
        }
      }
      throw new Error('target details missing — '+errors.join(', '));
    }
    const targetDetails=await getTargetDetails();
    const detUrl=targetDetails.url;
    const targetHeaders=targetDetails.headers||hdrs();
    let tgtChapter=targetDetails.chapter;
    let tgtStory=targetDetails.story;
    log(`  · target details via ${targetDetails.label}`);
    const beforeKey=tgtStory.s3_unique_key||'(empty)';
    log(`  · target story_id=${tgtStory.story_id||'?'} key-before=${beforeKey}`);

    // 3. Presigned URL
    const ext=(blob.type||'').includes('wav')?'wav':'mp3';
    const title=encodeURIComponent(tgtChapter.chapter_title||tgtEp.chapter_title||'audio');
    const resolvedTargetChapterId=tgtChapter.chapter_id||tgtEp.chapter_id;
    if(!resolvedTargetChapterId) throw new Error('target chapter_id missing after episode_details');
    const presignUrl=`${UPLOAD_BASE}/get_presigned_url?tags=media&image_extension=${ext}&title=${title}&chapter_id=${resolvedTargetChapterId}`;
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

    // 5. Single re-fetch after a short wait to see what CMS registered.
    await new Promise(r=>setTimeout(r, 1500));
    let postKey=beforeKey;
    try{
      const a=await rlFetch(detUrl,{headers:targetHeaders,credentials:'include'});
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

    // Use the server's current key if it changed, otherwise our presigned key.
    const commitKey=(postKey!==beforeKey&&postKey!=='(empty)') ? postKey : policy.s3_unique_key;

    // 6. update_episode — using the canonical key from server state
    const cmsNow=()=>{const d=new Date(),p=n=>String(n).padStart(2,'0');return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;};
    const resolvedBookId=tgtChapter.book_id||tgtEp.book_id||(tgtEp.lookup_key==='book_id'?tgtEp.lookup_id:'');
    const resolvedShowId=tgtChapter.show_id||tgtEp.show_id||(tgtEp.lookup_key==='show_id'?tgtEp.lookup_id:'');
    const body={
      chapter_details: {...tgtChapter, audio_duration: duration, media_timestamp: cmsNow()},
      story_details: {...tgtStory, s3_unique_key: commitKey, duration: duration},
      view: 'cms'
    };
    if(resolvedBookId) body.book_id=resolvedBookId;
    if(resolvedShowId) body.show_id=resolvedShowId;
    const notify=await rlFetch(contentUrl('book.update_episode',{is_novel:'0'},targetDetails.base),{
      method:'POST',
      headers:targetHeaders,
      credentials:'include',
      body: JSON.stringify(body)
    });
    if(!notify.ok) throw new Error('book.update_episode HTTP '+notify.status);
    log(`  · update_episode OK`);

    // 7. Verify by re-fetching — log only, don't throw on binding warning.
    try{
      const v=await rlFetch(detUrl,{headers:targetHeaders,credentials:'include'});
      if(v.ok){
        const vd=await v.json();
        const persistedKey=vd.result?.story_details?.s3_unique_key||'';
        log(`  · final key=${persistedKey||'(empty)'}`);
        if(persistedKey===commitKey || persistedKey===policy.s3_unique_key){
          log(`  ✓ binding confirmed`,'ok');
        } else {
          log(`  ⚠ binding NOT confirmed — server has "${persistedKey||'empty'}"`,'err');
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
    log(`Starting ${enabled.length} copies — 5 per minute…`);
    const failedEps=[]; const okEps=[];
    // Throttle: 5 episodes per 60-second window. After every 5 copies, sleep
    // until the minute mark before kicking off the next 5. This matches the
    // CMS rate limit and avoids the cascading 429s seen on big batches.
    const BATCH_SIZE=5;
    const BATCH_INTERVAL_MS=60000;
    let batchStart=Date.now();
    for(let i=0;i<enabled.length;i++){
      if(i>0 && i%BATCH_SIZE===0){
        // Finished a batch of 5 — wait out the rest of the minute.
        const elapsed=Date.now()-batchStart;
        const remaining=BATCH_INTERVAL_MS-elapsed;
        if(remaining>0){
          log(`  ⏳ Batch of ${BATCH_SIZE} done. Waiting ${Math.round(remaining/1000)}s before the next batch…`);
          await new Promise(r=>setTimeout(r, remaining));
        }
        batchStart=Date.now();
      }
      const p=enabled[i];
      const s=state.srcEps[p.srcIdx], t=state.tgtEps[p.tgtIdx];
      const tag=`Ep ${s.seq||'?'} → Ep ${t.seq||'?'}`;
      log(`[${i+1}/${enabled.length}] ${tag}`);
      try{ await copyOne(s,t); okEps.push(t.seq||s.seq||'?'); log(`  ✓ copied`,'ok'); }
      catch(e){
        failedEps.push({tgtSeq:t.seq||'?', srcSeq:s.seq||'?', reason:e.message});
        log(`  ✗ ${e.message}`,'err');
      }
      // Tiny gap between episodes within a batch so the 5 calls don't fire
      // back-to-back the instant copyOne returns.
      if(i<enabled.length-1 && (i+1)%BATCH_SIZE!==0) await new Promise(r=>setTimeout(r, 1000));
    }
    log(`Done — ${okEps.length} succeeded, ${failedEps.length} failed`, failedEps.length?'err':'ok');
    if(failedEps.length){
      const list=failedEps.map(f=>`Ep ${f.tgtSeq}`).join(', ');
      log(`  Failed episodes: ${list}`, 'err');
      // Group failures by reason so the user knows what to retry
      const byReason={};
      for(const f of failedEps){
        const k=(f.reason||'unknown').split('—')[0].trim().substring(0,80);
        if(!byReason[k]) byReason[k]=[];
        byReason[k].push('Ep '+f.tgtSeq);
      }
      for(const [reason, eps] of Object.entries(byReason)){
        log(`    • ${reason}: ${eps.join(', ')}`, 'err');
      }
    }
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
