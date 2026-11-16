(() => {
  'use strict';
  const KEY = 'sch-external-auto-v1', SESSION = 'sch-external-links-v1', TTL = 30 * 60 * 1000;
  let links = {pending: {}, tabs: {}, targets: [], jobs: {}, catalogs: {}, parents: {}, native: {}, selections: {}, assets: {}, bandcamp: {}, drive: {}}, queue = Promise.resolve(), fileQueue = Promise.resolve(), attached = false;
  const markerRequests = new Map();
  const nativeWaiters = new Map();
  let diagnosticQueue = Promise.resolve();
  let diagnosticPending=[], diagnosticTimer;
  function trace(stage, data = {}) {
    const entry = {time:Date.now(), version:chrome.runtime.getManifest?.().version, stage, ...data};
    return new Promise(resolve=>{
      diagnosticPending.push({entry,resolve});
      if(diagnosticTimer)return;
      diagnosticTimer=setTimeout(()=>{
        diagnosticTimer=null;const pending=diagnosticPending;diagnosticPending=[];
        const job=diagnosticQueue.then(async()=>{
          const saved = await chrome.storage.local.get('sch-external-debug-v1');
          const history = Array.isArray(saved['sch-external-debug-v1']) ? saved['sch-external-debug-v1'] : [];
          const events = [...history.filter(event => event.time > Date.now()-86400000), ...pending.map(value=>value.entry)].slice(-120);
          while (events.length > 1 && JSON.stringify(events).length > 500000) events.shift();
          await chrome.storage.local.set({'sch-external-debug-v1':events});
        });
        diagnosticQueue=job.catch(()=>{}).then(()=>{pending.forEach(value=>value.resolve());});
      },150);
    });
  }
  function pagePath(value) { const url=https(value); return url && ['soundcloud.com','www.soundcloud.com'].includes(url.hostname) ? url.origin+url.pathname : null; }
  function diagnosticContext(value) {
    const result = {page:pagePath(value?.page)};
    for(const key of['heading','documentTitle'])if(typeof value?.[key]==='string')result[key]=value[key].slice(0,160);
    for (const key of ['scripts','hydrationScripts','iframes','records']) if (Number.isInteger(value?.[key]) && value[key]>=0) result[key]=Math.min(value[key],10000);
    if (typeof value?.top==='boolean') result.top=value.top;
    return result;
  }
  const loaded = chrome.storage.session.get(SESSION).then(value => { if (value[SESSION]) links = value[SESSION]; links.catalogs ||= {}; links.parents ||= {}; links.native ||= {}; links.selections ||= {}; links.assets ||= {}; links.bandcamp ||= {}; links.drive ||= {}; });
  function https(value) { try { const url = new URL(value); return url.protocol === 'https:' ? url : null; } catch { return null; } }
  function supported(value) {
    const url = https(value);
    return !!url && !url.username && !url.password && !/(^|\.)soundcloud\.com$/.test(url.hostname) && !authenticationPage(value);
  }
  function cleanTrack(value) {
    const url = https(value?.url);
    if (!url || !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) || url.pathname.split('/').filter(Boolean).length !== 2 ||
        typeof value.title !== 'string' || !value.title.trim()) return null;
    const result = {url: 'https://soundcloud.com' + url.pathname, title: value.title.slice(0, 1024)};
    for (const [key, size] of [['artist', 512], ['genre', 256], ['year', 4], ['bpm', 16]]) if (typeof value[key] === 'string') result[key] = value[key].slice(0, size);
    const image = https(value.artwork_url);
    if (image && /(^|\.)sndcdn\.com$/.test(image.hostname)) result.artwork_url = image.href;
    return result;
  }
  function navigationTarget(value) {
    value = globalThis.SCHMetadata?.externalDestination(value) || value;
    const url = https(value);
    if (url?.hostname === 'gate.sc') {
      const target = globalThis.SCHMetadata?.externalDestination(url.searchParams.get('url')) || url.searchParams.get('url');
      if (supported(target)) value = target;
    }
    const drive = driveFileId(value);
    if (drive) return 'https://drive.google.com/file/d/' + drive + '/view';
    const id = bandcampPageId(value);
    if (id) return 'https://bandcamp.com/download?type=track&id=' + id;
    const page = https(value);
    return page && /(^|\.)bandcamp\.com$/.test(page.hostname) && page.pathname === '/download' ? page.origin + page.pathname : value;
  }
  function bandcampPageId(value) {
    const url = https(value);
    if (!url || url.username || url.password || url.port || !/(^|\.)bandcamp\.com$/.test(url.hostname) || url.pathname !== '/download' ||
        url.searchParams.getAll('type').length !== 1 || url.searchParams.get('type') !== 'track' || url.searchParams.getAll('id').length !== 1) return null;
    const id = url.searchParams.get('id'); return /^[1-9]\d{0,14}$/.test(id || '') ? id : null;
  }
  function bandcampAudioId(value) {
    const url = https(value);
    if (!url || url.username || url.password || url.port || !/(^|\.)bcbits\.com$/.test(url.hostname)) return null;
    return url.pathname.match(/^\/download\/track\/[a-f0-9]{16,128}\/[a-z0-9-]{1,32}\/([1-9]\d{0,14})\/?$/)?.[1] || null;
  }
  function driveFileId(value) {
    const url = https(value);
    if (!url || url.username || url.password || url.port || url.searchParams.getAll('id').length > 1) return null;
    let id;
    if (url.hostname === 'drive.google.com') id = url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)(?:\/|$)/)?.[1] || (/^\/(?:open|uc|download)$/.test(url.pathname) ? url.searchParams.get('id') : null);
    else if (url.hostname === 'drive.usercontent.google.com' && /^\/(?:download|uc|u\/\d+\/uc)$/.test(url.pathname)) id = url.searchParams.get('id');
    return typeof id === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
  }
  function authenticationPage(value) {
    const url = https(value);
    return !!url && (['accounts.google.com', 'accounts.spotify.com', 'accounts.soundcloud.com', 'secure.soundcloud.com'].includes(url.hostname) ||
      url.hostname === 'soundcloud.com' && /^\/(?:connect|signin|oauth2)(?:\/|$)/.test(url.pathname));
  }
  function pageKey(value) { const url = https(navigationTarget(value)); if (!url) return ''; url.hash = ''; return url.href; }
  function nativeKey(value) { const url = https(value); return url && /(^|\.)sndcdn\.com$/.test(url.hostname) ? url.origin + url.pathname : ''; }
  function waveformAsset(value) {
    const url = https(value);
    return url?.hostname === 'wave.sndcdn.com' ? url.pathname.match(/^\/([a-zA-Z0-9_-]{8,128})_m\.(?:json|js)$/)?.[1] : null;
  }
  function downloadAsset(value) {
    const url = https(value);
    return url?.hostname === 'cf-media.sndcdn.com' ? url.pathname.match(/^\/([a-zA-Z0-9_-]{8,128})$/)?.[1] : null;
  }
  async function awaitNative(item) {
    const key = nativeKey(item.finalUrl) || nativeKey(item.url); if (!key || !await enabled()) return;
    await loaded;
    if (links.native[key]?.expires > Date.now()) return;
    // The browser can start saving before the passive response clone reaches the isolated bridge.
    await new Promise(resolve => {
      let timer;
      const done = () => { clearTimeout(timer); nativeWaiters.get(key)?.delete(done); if (!nativeWaiters.get(key)?.size) nativeWaiters.delete(key); resolve(); };
      if (!nativeWaiters.has(key)) nativeWaiters.set(key, new Set());
      nativeWaiters.get(key).add(done); timer = setTimeout(done, 1000);
    });
  }
  function transact(job) {
    const next = queue.then(async () => { await loaded; return job(); });
    queue = next.catch(() => {}); return next;
  }
  async function save() {
    const now = Date.now();
    for (const group of [links.pending, links.tabs, links.jobs, links.catalogs, links.parents, links.native, links.selections, links.assets, links.bandcamp, links.drive]) for (const [key, value] of Object.entries(group)) if (value.expires <= now) delete group[key];
    links.targets = links.targets.filter(value => value.expires > now).slice(-50);
    for (const group of [links.pending, links.tabs, links.jobs, links.catalogs, links.parents, links.native, links.selections, links.assets, links.bandcamp, links.drive]) while (Object.keys(group).length > 100) delete group[Object.keys(group)[0]];
    await chrome.storage.session.set({[SESSION]: links});
  }
  async function enabled() { return (await chrome.storage.local.get(KEY))[KEY] === true && await chrome.permissions.contains({permissions: ['downloads', 'webNavigation']}); }
  async function status(message, error = false, details) {
    const entry = {message, error, time: Date.now(), ...(details ? {details} : {})}, previous = await chrome.storage.local.get('sch-external-history-v1');
    const history = Array.isArray(previous['sch-external-history-v1']) ? previous['sch-external-history-v1'] : [];
    await chrome.storage.local.set({'sch-external-status-v1': entry, 'sch-external-history-v1': [...history, entry].slice(-20)});
  }
  function bind(tabId, entry, url) {
    links.tabs[tabId] = {track: entry.track, expires: entry.expires, pages: [...new Set([...(entry.pages || []), pageKey(url)])].filter(Boolean).slice(-30)};
    const id = bandcampPageId(url);
    if (id) {
      const previous = links.bandcamp[id], now = Date.now();
      const tracks = Object.fromEntries(Object.entries(previous?.tracks || {}).filter(([, value]) => value.expires > now));
      tracks[entry.track.url] = {track:entry.track, expires:Math.min(entry.expires, now + 10 * 60 * 1000)};
      links.bandcamp[id] = {tracks, expires:Math.max(...Object.values(tracks).map(value => value.expires))};
      trace('bandcamp-track',{tabId,trackId:id,url:entry.track.url});
    }
    rememberDrive(tabId,entry,url,'page');
  }
  function rememberDrive(tabId, entry, url, source, frameId = 0) {
    const id = driveFileId(url); if (!id || entry.expires <= Date.now()) return;
    const now = Date.now(), previous = links.drive[id];
    const tracks = Object.fromEntries(Object.entries(previous?.tracks || {}).filter(([, value]) => value.expires > now));
    tracks[entry.track.url] = {track:entry.track, expires:Math.min(entry.expires, now + 10 * 60 * 1000)};
    links.drive[id] = {tracks, expires:Math.max(...Object.values(tracks).map(value => value.expires))};
    trace('drive-file',{tabId,frameId,fileId:id,url:entry.track.url,source});
  }
  function sourceFor(tabId, url, inherit = false) {
    const pending = links.pending[tabId];
    if (pending?.expires > Date.now() && pageKey(pending.destination) === pageKey(url)) return pending;
    const catalog = links.catalogs[tabId], found = new Map();
    if (catalog?.expires > Date.now()) for (const entry of catalog.entries) if (pageKey(entry.destination) === pageKey(url)) found.set(entry.track.url, entry);
    if (found.size) return found.size === 1 ? {...found.values().next().value, expires: catalog.expires} : null;
    const parent = links.tabs[tabId];
    return inherit && parent?.expires > Date.now() ? parent : null;
  }
  async function boundStatus(entry) { await status('配布先を追跡中：' + entry.track.title); }
  function clearSelections(tabId) { for (const [key, value] of Object.entries(links.selections)) if (value.tabId === tabId) delete links.selections[key]; }
  function match(item, report) {
    let referrer = pageKey(item.referrer);
    if (!referrer && item.url?.startsWith('blob:https://')) { try { referrer = new URL(item.url).origin + '/'; } catch { /* Unknown origin. */ } }
    const found = new Map();
    const proofs = new Map();
    function add(track, source) { found.set(track.url,track); if(!proofs.has(track.url))proofs.set(track.url,new Set());proofs.get(track.url).add(source); }
    const bandcampIds = new Set([item.url,item.finalUrl].map(bandcampAudioId).filter(Boolean));
    const driveIds = new Set([item.url,item.finalUrl].map(driveFileId).filter(Boolean));
    for (const id of bandcampIds) for (const entry of Object.values(links.bandcamp[id]?.tracks || {})) if (entry.expires > Date.now()) add(entry.track,'bandcamp-track-id');
    for (const id of driveIds) for (const entry of Object.values(links.drive[id]?.tracks || {})) if (entry.expires > Date.now()) add(entry.track,'drive-file-id');
    for (const entry of Object.values(links.tabs)) {
      if (entry.expires <= Date.now()) continue;
      if (bandcampIds.size || driveIds.size) continue; // Identified files require proof for that exact resource.
      if (referrer && entry.pages.includes(referrer)) add(entry.track,'external-referrer');
      // Referrer policies sometimes expose only an origin. Accept it only if all matching tabs agree.
      else if (referrer && new URL(referrer).pathname === '/' && entry.pages.some(page => new URL(page).origin === new URL(referrer).origin)) add(entry.track,'external-origin');
    }
    for (const entry of Object.values(links.pending)) if (entry.expires > Date.now() && [item.url, item.finalUrl].some(url => pageKey(url) === pageKey(entry.destination))) add(entry.track,'external-target');
    let exactNative = false;
    for (const url of [item.url, item.finalUrl]) {
      const entry = links.native[nativeKey(url)];
      if (entry?.expires > Date.now()) { exactNative = true; for (const track of Object.values(entry.tracks)) add(track,'native-response'); }
    }
    const ref = https(item.referrer);
    const fromSoundCloud = ref && ['soundcloud.com', 'www.soundcloud.com'].includes(ref.hostname);
    if (!exactNative && fromSoundCloud) {
      const assets = [item.url, item.finalUrl].map(downloadAsset).filter(Boolean);
      for (const entry of Object.values(links.assets)) if (entry.expires > Date.now() && entry.asset && assets.includes(entry.asset)) {
        exactNative = true; add(entry.track,'waveform-asset');
      }
    }
    if (!exactNative && (nativeKey(item.url) || nativeKey(item.finalUrl)) && fromSoundCloud) {
      // A trusted click on Download, rather than merely viewing a song, identifies this standard download.
      for (const entry of Object.values(links.selections)) if (entry.expires > Date.now()) add(entry.track,'native-click');
    }
    const conflict = bandcampIds.size > 1 || driveIds.size > 1;
    if(report) Object.assign(report,{reason:conflict?'ambiguous':found.size===1?'matched':found.size?'ambiguous':'missing',candidateCount:found.size,
      ...(conflict ? {fileConflict:true} : {}),
      candidates:[...found.values()].slice(0,100).map(track=>({url:track.url,title:track.title,sources:[...proofs.get(track.url)]}))});
    return !conflict && found.size === 1 ? [...found.values()][0] : null;
  }
  function audioExtension(item) {
    const name = item.filename || https(item.finalUrl || item.url)?.pathname || '';
    return name.match(/\.(mp3|wav|flac|zip)$/i)?.[1]?.toLowerCase() || ({'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'application/zip':'zip', 'application/x-zip-compressed':'zip'})[item.mime];
  }
  async function artwork(value) {
    const source = https(value);
    if (!source || !/(^|\.)sndcdn\.com$/.test(source.hostname)) return null;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(source.href.replace(/-large(?=\.)/, '-t500x500'), {credentials: 'omit', signal: controller.signal});
      if (!response.ok || Number(response.headers.get('content-length')) > 10 * 1024 * 1024) throw Error('Artwork unavailable');
      const mime = (response.headers.get('content-type') || '').split(';')[0];
      if (!['image/png', 'image/jpeg'].includes(mime)) throw Error('Artwork format');
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
        if (length > 10 * 1024 * 1024) { await reader.cancel(); throw Error('Artwork too large'); } chunks.push(part.value); }
      const blob = new Blob(chunks, {type: mime}), bitmap = await createImageBitmap(blob);
      const result = {data: await blob.arrayBuffer(), mime, width: bitmap.width, height: bitmap.height}; bitmap.close(); return result;
    } finally { clearTimeout(timeout); }
  }
  function attach() {
    if (attached || !chrome.downloads?.onDeterminingFilename || !chrome.webNavigation?.onCommitted) return;
    attached = true;
    chrome.webNavigation.onBeforeNavigate?.addListener(details=>{
      if (!driveFileId(details.url)) return;
      // Drive folders can start a file download in a hidden frame without a referrer
      // or a committed navigation. Record its ID only in a proven distribution tab.
      transact(async()=>{
        if(!await enabled())return;
        const entry=links.tabs[details.tabId] || sourceFor(details.tabId,navigationTarget(details.url));
        const id=driveFileId(details.url),known=entry && ((entry.pages||[]).some(page=>driveFileId(page)===id) || driveFileId(entry.destination)===id);
        // A top-level typed URL is not evidence that a folder owns an arbitrary file.
        if(entry?.expires>Date.now() && (details.frameId>0 || known)){rememberDrive(details.tabId,entry,details.url,'navigation',details.frameId);await save();}
      }).catch(()=>{});
    });
    chrome.webNavigation.onHistoryStateUpdated?.addListener(details=>{
      if(details.frameId!==0)return;
      if(pagePath(details.url))enabled().then(active=>{if(active)trace('route',{tabId:details.tabId,page:pagePath(details.url)});}).catch(()=>{});
      else if(bandcampPageId(details.url)||driveFileId(details.url))transact(async()=>{if(!await enabled())return;const entry=links.tabs[details.tabId];if(entry?.expires>Date.now()){bind(details.tabId,entry,navigationTarget(details.url));await save();}}).catch(()=>{});
    });
    chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
      transact(async () => {
        const targetURL = navigationTarget(details.url);
        if (!await enabled()) return;
        // window.open may create about:blank first and navigate it afterwards.
        links.parents[details.tabId] = {sourceTabId: details.sourceTabId, expires: Date.now() + 10000};
        const source = sourceFor(details.sourceTabId, targetURL, true);
        if (source && supported(targetURL)) { bind(details.tabId, source, targetURL); await boundStatus(source); }
        else if (source && targetURL === 'about:blank') bind(details.tabId, source, '');
        else if (supported(targetURL)) links.targets.push({...details, url: targetURL, expires: Date.now() + 10000});
        await save();
      }).catch(() => {});
    });
    chrome.webNavigation.onCommitted.addListener(details => {
      if (details.frameId !== 0) return;
      transact(async () => {
        if (!await enabled()) return;
        const targetURL = navigationTarget(details.url);
        const entry = links.tabs[details.tabId], parent = links.parents[details.tabId];
        const source = sourceFor(details.tabId, targetURL) || (parent?.expires > Date.now() ? sourceFor(parent.sourceTabId, targetURL, true) : null);
        if (['typed', 'auto_bookmark', 'generated'].includes(details.transitionType)) {
          for (const group of [links.tabs, links.parents, links.pending, links.catalogs]) delete group[details.tabId];
          clearSelections(details.tabId);
        }
        else if (source && supported(targetURL)) { bind(details.tabId, source, targetURL); await boundStatus(source); }
        else if (entry?.expires > Date.now() && targetURL === 'about:blank' && parent?.expires > Date.now()) { /* Preserve a proven opener while its empty child is being navigated. */ }
        else if (entry?.expires > Date.now() && supported(targetURL)) bind(details.tabId, entry, targetURL);
        else if (entry?.expires > Date.now() && authenticationPage(targetURL)) { /* Keep the binding through the user's login; never inspect authentication pages. */ }
        else {
          delete links.tabs[details.tabId];
          if (supported(targetURL)) links.targets.push({sourceTabId: parent?.expires > Date.now() ? parent.sourceTabId : details.tabId, tabId: details.tabId, url: targetURL, expires: Date.now() + 10000});
        }
        await save();
      }).catch(() => {});
    });
    chrome.tabs.onRemoved.addListener(tabId => { transact(async () => { for (const group of [links.tabs, links.pending, links.catalogs, links.parents]) delete group[tabId]; clearSelections(tabId); await save(); }).catch(() => {}); });
    chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
      const receivedAt = Date.now();
      const marker = markerRequests.get(item.url);
      if (marker && item.byExtensionId === chrome.runtime.id) {
        markerRequests.delete(item.url);
        clearTimeout(marker.timeout);
        suggest({filename: marker.filename, conflictAction: 'uniquify'});
        return;
      }
      // Blob downloads made by our standard SoundCloud tagged button are excluded.
      (async () => { await awaitNative(item); return transact(async () => {
        if ((!https(item.url) && !item.url?.startsWith('blob:https://')) || !await enabled()) return;
        if (item.url?.startsWith('blob:https://') && !supported(item.url.slice(5))) return;
        const report={}, extension = audioExtension(item), track = match(item,report);
        if (!extension) return;
        trace('filename-match',{downloadId:item.id,filename:item.filename?.split(/[\\/]/).at(-1),mime:item.mime,
          audioAsset:downloadAsset(item.finalUrl)||downloadAsset(item.url)||null,referrerHost:https(item.referrer)?.hostname||null,
          ...report, observedFiles:Object.keys(links.native).length,pendingClicks:Object.values(links.selections).filter(entry=>entry.expires>Date.now()).length,
          assets:Object.values(links.assets).slice(0,100).map(entry=>({url:entry.track.url,title:entry.track.title,asset:entry.asset,expires:entry.expires,fresh:entry.fresh}))});
        if (!track) { await status((item.filename?.split(/[\\/]/).at(-1) || '音声ファイル') + '：曲との紐づけを確認できないため、通常保存しました。', true,
          {version:chrome.runtime.getManifest?.().version, observedFiles:Object.keys(links.native).length,
            publicAssets:Object.values(links.assets).filter(entry=>entry.asset&&entry.expires>Date.now()).length,
            pendingClicks:Object.values(links.selections).filter(entry=>entry.expires>Date.now()).length,
            audioAsset:downloadAsset(item.finalUrl)||downloadAsset(item.url)||null,...report}); return; }
        // Filename determination has a browser deadline. Never open IndexedDB or
        // query FileSystemHandle permissions here; validate the real file on completion.
        const config = await SCHExternalFiles.routing();
        if (!config) {
          await status('自動タグ付けには保存フォルダーの設定・再許可が必要です。', true); return;
        }
        links.jobs[item.id] = {track, expires: Date.now() + 24 * 60 * 60 * 1000};
        for (const [tabId, selection] of Object.entries(links.selections)) if (selection.track.url === track.url) delete links.selections[tabId];
        save().catch(() => {});
        trace('filename-suggest',{downloadId:item.id,url:track.url,filename:config.relativePath+'/'+SCHAudioTags.filename(track.title,extension),elapsedMs:Date.now()-receivedAt});
        return {filename: config.relativePath + '/' + SCHAudioTags.filename(track.title, extension), conflictAction: 'uniquify'};
      }); })().then(value => suggest(value), () => suggest());
      return true;
    });
    chrome.downloads.onChanged.addListener(delta => {
      if (delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted') return;
      transact(async () => {
        const job = links.jobs[delta.id]; if (!job) return;
        delete links.jobs[delta.id]; await save();
        if (delta.state.current !== 'complete') { await status('ダウンロードが中断されたため、タグは書き込んでいません。', true); return; }
        const run = fileQueue.then(async () => {
          if (!await enabled()) return;
          const [item] = await chrome.downloads.search({id: delta.id}), config = await SCHExternalFiles.get();
          if (!item || !config || item.danger !== 'safe') { await status('保存状況を確認できないため、タグは書き込んでいません。', true); return; }
          try {
            const result = await SCHExternalFiles.tagFile(config, item, job.track, artwork);
            trace('tag-result',{downloadId:item.id,url:job.track.url,result:'success',filename:result.filename,warning:result.warning});
            await status(result.filename + '：' + (result.audioCount ? 'ZIP内の音声' + result.audioCount + '件にタグを保存しました' : 'タグを保存しました') + result.warning, !!result.warning);
          } catch (error) { trace('tag-result',{downloadId:item.id,url:job.track.url,result:'error',message:String(error.message||'').slice(0,300),actualFolder:String(item.filename||'').replace(/\\/g,'/').split('/').slice(0,-1).join('/'),expectedFolder:config.absolutePath});await status(item.filename.split(/[\\/]/).at(-1) + '：' + (error.message || 'タグを保存できませんでした。元ファイルはそのままです。'), true); }
        });
        fileQueue = run.catch(() => {});
      }).catch(() => {});
    });
  }
  chrome.permissions.onAdded.addListener(attach);
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if(message?.type==='sch-native-debug') {
      const source=https(sender.url);
      if(!sender.tab||!source||!['soundcloud.com','www.soundcloud.com'].includes(source.hostname)||!['page-ready','page-input','main-ready','api-request','download-response'].includes(message.stage))return;
      (async()=>{
        if(!await enabled())return {status:'off'};
        const info=message.info||{},data={tabId:sender.tab.id,senderPage:pagePath(sender.url),...diagnosticContext(info)};
        for(const key of['tag','class','label','title','text','id','apiHost','apiPath','result','kind'])if(typeof info[key]==='string')data[key]=info[key].slice(0,300).split('?')[0].split('#')[0];
        if(Array.isArray(info.paths))data.paths=info.paths.filter(value=>typeof value==='string').slice(0,4).map(value=>value.slice(0,350));
        for(const key of['supported','trackFound','redirectFound'])if(typeof info[key]==='boolean')data[key]=info[key];
        await trace(message.stage,data);return {status:'ok'};
      })().then(reply,()=>reply({status:'error'}));return true;
    }
    if (message?.type === 'sch-native-catalog') {
      const source = https(sender.url);
      if (!sender.tab || !source || !['soundcloud.com', 'www.soundcloud.com'].includes(source.hostname) || !Array.isArray(message.entries)) return;
      const received = message.entries.slice(0,100).map(value => ({track:cleanTrack(value),url:pagePath(value?.url),titlePresent:typeof value?.title==='string'&&!!value.title.trim(),waveform:nativeKey(value?.waveform_url)||null, asset:waveformAsset(value?.waveform_url), downloadable:value?.downloadable, left:value?.has_downloads_left}));
      const entries = received.filter(entry => entry.track);
      transact(async () => {
        if (!await enabled()) return {status:'off'};
        const audit=received.filter(entry=>!entry.track).map(entry=>({url:entry.url,titlePresent:entry.titlePresent,waveform:entry.waveform,outcome:'invalid-title-or-url'}));
        for (const entry of entries) {
          const previous = links.assets[entry.track.url];
          let outcome='incomplete';
          if (message.initial === true && previous?.fresh && previous.expires > Date.now()) outcome='older-initial';
          else if (entry.downloadable === false || entry.left === false) {links.assets[entry.track.url] = {track:entry.track, asset:null, fresh:message.initial !== true, expires:Date.now()+TTL};outcome='blocked';}
          else if (entry.downloadable === true && entry.left === true && entry.asset) {links.assets[entry.track.url] = {track:entry.track, asset:entry.asset, fresh:message.initial !== true, expires:Date.now()+TTL};outcome='accepted';}
          audit.push({url:entry.track.url,title:entry.track.title,asset:entry.asset||null,waveform:entry.waveform,downloadable:entry.downloadable,left:entry.left,outcome});
        }
        trace('catalog',{tabId:sender.tab.id,senderPage:pagePath(sender.url),...diagnosticContext(message.context),initial:message.initial===true,
          received:message.entries.length,valid:entries.length,entries:audit});
        await save(); return {status:'ok'};
      }).then(reply, () => reply({status:'error'}));
      return true;
    }
    if (message?.type === 'sch-external-folder-check') {
      if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('external-setup.html') ||
          typeof message.token !== 'string' || !/^[a-f0-9-]{36}$/.test(message.token) ||
          typeof message.filename !== 'string' || !/(?:^|\/)sch-folder-check-[a-f0-9-]+\.txt$/.test(message.filename) ||
          message.filename.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part))) {
        reply({status: 'error', message: '確認ファイルの保存要求を確認できませんでした。'}); return;
      }
      (async () => {
        if (!await chrome.permissions.contains({permissions: ['downloads', 'webNavigation']})) throw Error('設定画面で権限を許可してください。');
        attach();
        // Keep the tiny marker entirely in the download request. No page-owned Blob URL crosses contexts.
        const url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(message.token);
        const timeout = setTimeout(() => markerRequests.delete(url), 60000);
        markerRequests.set(url, {filename: message.filename, timeout});
        try {
          const id = await chrome.downloads.download({url, filename: message.filename, saveAs: false, conflictAction: 'uniquify'});
          return {status: 'ok', id};
        } catch (error) { clearTimeout(timeout); markerRequests.delete(url); throw error; }
      })().then(reply, error => reply({status: 'error', message: error.message || '確認ファイルを保存できませんでした。'}));
      return true;
    }
    if (message?.type === 'sch-native-click') {
      const source = https(sender.url), track = cleanTrack(message.track);
      if (!sender.tab || !source || !['soundcloud.com', 'www.soundcloud.com'].includes(source.hostname) || !track) return;
      transact(async () => {
        if (!await enabled()) return {status: 'off'};
        const previous = links.selections[sender.tab.id + ':' + track.url];
        links.selections[sender.tab.id + ':' + track.url] = {tabId: sender.tab.id, track, expires: Date.now() + 60000};
        trace('native-click',{tabId:sender.tab.id,url:track.url,title:track.title});
        await save();
        if (!previous || previous.expires <= Date.now()) await status('標準ダウンロード待ち：' + track.title);
        return {status: 'ok'};
      }).then(reply, () => reply({status: 'error'}));
      return true;
    }
    if (message?.type === 'sch-native-file') {
      const source = https(sender.url), track = cleanTrack(message.track), destination = nativeKey(message.destination);
      if (!sender.tab || !source || !['soundcloud.com', 'www.soundcloud.com'].includes(source.hostname) || !track || !destination) return;
      transact(async () => {
        if (!await enabled()) return {status: 'off'};
        const previous = links.native[destination];
        const tracks = previous?.expires > Date.now() ? previous.tracks : {};
        tracks[track.url] = track;
        links.native[destination] = {tracks, expires: Date.now() + 10 * 60 * 1000};
        trace('native-response',{tabId:sender.tab.id,destination,url:track.url,title:track.title});
        await save();
        for (const done of [...(nativeWaiters.get(destination) || [])]) done();
        return {status: 'ok'};
      }).then(reply, () => reply({status: 'error'}));
      return true;
    }
    if (message?.type === 'sch-external-catalog') {
      const source = https(sender.url);
      if (!sender.tab || !source || !['soundcloud.com', 'www.soundcloud.com'].includes(source.hostname) || !Array.isArray(message.entries)) return;
      const entries = message.entries.slice(0, 100).map(value => ({track: cleanTrack(value?.track), destination: pageKey(navigationTarget(value?.destination))})).filter(value => value.track && supported(value.destination));
      transact(async () => {
        if (!await enabled()) return {status: 'off'};
        links.catalogs[sender.tab.id] = {entries, expires: Date.now() + TTL};
        for (const target of links.targets) {
          if (target.expires <= Date.now() || target.sourceTabId !== sender.tab.id) continue;
          const entry = sourceFor(sender.tab.id, target.url);
          if (entry) { bind(target.tabId, entry, target.url); await boundStatus(entry); }
        }
        await save(); return {status: 'ok'};
      }).then(reply, () => reply({status: 'error'}));
      return true;
    }
    if (message?.type !== 'sch-external-link') return;
    const source = https(sender.url), track = cleanTrack(message.track), destination = pageKey(message.destination);
    if (!sender.tab || !source || !['soundcloud.com', 'www.soundcloud.com'].includes(source.hostname) || !track || !supported(destination)) return;
    transact(async () => {
      if (!await enabled()) return {status: 'off'};
      const entry = {track, destination, expires: Date.now() + TTL};
      links.pending[sender.tab.id] = entry;
      for (const target of links.targets) if (target.expires > Date.now() && target.sourceTabId === sender.tab.id && pageKey(target.url) === entry.destination) { bind(target.tabId, entry, target.url); await boundStatus(entry); }
      await save(); return {status: 'ok'};
    }).then(reply, () => reply({status: 'error'}));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]?.newValue === false) transact(async () => { links.pending = {}; links.tabs = {}; links.targets = []; links.catalogs = {}; links.parents = {}; links.native = {}; links.selections = {}; links.assets = {}; links.bandcamp = {}; links.drive = {}; await save(); }).catch(() => {});
  });
  enabled().then(active=>{if(active)trace('worker-ready');}).catch(()=>{});
  attach();
})();
