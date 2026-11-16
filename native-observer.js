(() => {
  'use strict';
  // Runs in the page world before SoundCloud starts its own fetch/XHR requests.
  // Observe existing responses only; never request API data or read request headers.
  const channel = 'sch-native-track-data-v1';
  const records = new Map(), changed = new Map();
  let timer;
  let debugCount=0;
  function debug(stage,info={}){if(debugCount++<160)window.postMessage({channel:'sch-native-debug-v1',stage,info},location.origin);}
  function noteRequest(value,kind){
    try{const url=new URL(value,location.href);if(/^api[^.]*\.soundcloud\.com$/.test(url.hostname)&&/^\/(?:tracks|resolve|search|users)(?:\/|$)/.test(url.pathname))debug('api-request',{kind,apiHost:url.hostname,apiPath:url.pathname,supported:allowed(value)});}catch{/* No request parameters or credentials are logged. */}
  }
  function trackURL(value) {
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) ||
          !/^https?:$/.test(url.protocol) || parts.length !== 2 || parts[1] === 'sets') return null;
      return 'https://soundcloud.com/' + parts.join('/');
    } catch { return null; }
  }
  function emit(entries) {
    // Distribution URLs are used only by the dedicated external-download catalog.
    // Highlighting receives a boolean, never the public share URL or raw description.
    entries = entries.map(({description_links, ...entry}) => entry);
    for (let i = 0; i < entries.length; i += 100) {
      window.postMessage({channel, type: 'tracks', entries: entries.slice(i, i + 100)}, location.origin);
    }
  }
  function flush() {
    timer = null;
    const entries = [...changed.values()];
    changed.clear();
    emit(entries);
  }
  function collect(value, initial = false) {
    const stack = [{value, depth: 0}];
    let visited = 0;
    while (stack.length && visited++ < 20000) {
      const {value: item, depth} = stack.pop();
      if (!item || typeof item !== 'object' || depth > 12) continue;
      const isTrack = item.kind === 'track' || item.kind == null &&
        (typeof item.downloadable === 'boolean' || Object.prototype.hasOwnProperty.call(item, 'purchase_url'));
      const url = isTrack && trackURL(item.permalink_url);
      if (url) {
        const entry = {kind: 'track', permalink_url: url};
        for (const key of ['downloadable', 'has_downloads_left']) {
          if (typeof item[key] === 'boolean') entry[key] = item[key];
        }
        if (item.purchase_url === null) entry.purchase_url = null;
        else if (typeof item.purchase_url === 'string' && item.purchase_url.length <= 2048) {
          try { if (/^https?:$/.test(new URL(item.purchase_url).protocol)) entry.purchase_url = item.purchase_url; } catch { /* Ignore invalid destinations. */ }
        }
        if (typeof item.purchase_title === 'string') entry.purchase_title = item.purchase_title.slice(0, 80);
        if(typeof item.description==='string'||item.description===null){
          entry.description_links=globalThis.SCHMetadata?.descriptionLinks(item.description)||[];
          entry.description_download=entry.description_links.length>0;
        }
        // Public fields used for the user's manual or enabled automatic tagging.
        const id = typeof item.id === 'number' ? item.id : Number(String(item.id || item.urn || '').match(/^(?:soundcloud:tracks:)?(\d+)$/)?.[1]);
        if (Number.isSafeInteger(id) && id > 0) entry.id = id;
        for (const [key, limit] of [['title', 1024], ['genre', 256], ['original_format', 16]]) {
          if (typeof item[key] === 'string') entry[key] = item[key].slice(0, limit);
        }
        const artist = item.publisher_metadata?.artist || item.user?.username || item.user?.full_name;
        if (typeof artist === 'string') entry.artist = artist.slice(0, 512);
        const artwork = item.artwork_url || item.user?.avatar_url;
        if (typeof artwork === 'string') {
          try { const image = new URL(artwork); if (image.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(image.hostname)) entry.artwork_url = image.href; } catch { /* No artwork. */ }
        }
        if (typeof item.waveform_url === 'string') {
          try { const wave = new URL(item.waveform_url); if (wave.protocol === 'https:' && wave.hostname === 'wave.sndcdn.com') entry.waveform_url = wave.href; } catch { /* No public waveform. */ }
        }
        const year = String(item.release_date || item.release_year || item.created_at || '').match(/^\d{4}/)?.[0];
        if (year) entry.year = year;
        if (Number.isFinite(item.bpm) && item.bpm > 0) entry.bpm = String(item.bpm);
        if (Object.keys(entry).length > 2) {
          const previous = records.get(url);
          const merged = initial ? {...entry, ...previous} : {...previous, ...entry};
          if (!previous || JSON.stringify(previous) !== JSON.stringify(merged)) {
            records.delete(url);
            records.set(url, merged);
            changed.set(url, merged);
            while (records.size > 1000) {
              const oldest = records.keys().next().value;
              records.delete(oldest);
              changed.delete(oldest);
            }
            if (!timer) timer = setTimeout(flush, 50);
          }
        }
      }
      if (depth < 12) Object.values(item).forEach(child => {
        if (child && typeof child === 'object') stack.push({value: child, depth: depth + 1});
      });
    }
  }
  globalThis.SCHDownloadTracks = Object.freeze({
    get(value) {
      const url = trackURL(value);
      if (!url) return null;
      collect(window.__sc_hydration, true);
      const record = records.get(url);
      return record ? {...record} : null;
    }
  });
  function allowed(value) {
    try { return new URL(value, location.href).hostname === 'api-v2.soundcloud.com'; }
    catch { return false; }
  }
  function observeDownload(value, request) {
    try {
      const requestURL = new URL(request, location.href);
      const id = requestURL.hostname === 'api-v2.soundcloud.com' && decodeURIComponent(requestURL.pathname).match(/^\/tracks\/(?:soundcloud:tracks:)?(\d+)\/download\/?$/)?.[1];
      if (!id) return;
      collect(window.__sc_hydration, true);
      const track = [...records.values()].find(entry => String(entry.id) === id);
      debug('download-response',{apiHost:requestURL.hostname,apiPath:requestURL.pathname,trackFound:!!track?.title,
        redirectFound:typeof value?.redirectUri==='string',result:!track?.title?'missing-track':typeof value?.redirectUri!=='string'?'missing-redirect':'observed'});
      if(typeof value?.redirectUri!=='string')return;
      const destination = new URL(value.redirectUri);
      if (!track?.title || destination.protocol !== 'https:' || !/(^|\.)sndcdn\.com$/.test(destination.hostname)) return;
      // Only the public file identity leaves the page. Never transfer signed query parameters.
      window.postMessage({channel: 'sch-native-file-v1', destination: destination.origin + destination.pathname,
        track: {...track, url: track.permalink_url}}, location.origin);
    } catch { /* Passive observation must not affect the standard download. */ }
  }
  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') window.fetch = function (...args) {
    const response = Reflect.apply(nativeFetch, this, args);
    try {
      const input = args[0];
      const url = typeof input === 'string' || input instanceof URL ? input : input?.url;
      noteRequest(url,'fetch');
      if (allowed(url)) response.then(result => {
        if (result.ok) return result.clone().json().then(value => { collect(value); observeDownload(value, url); });
      }).catch(() => {});
    } catch { /* Observation must never alter the page's fetch result. */ }
    return response;
  };
  const prototype = window.XMLHttpRequest?.prototype;
  if (prototype) {
    const nativeOpen = prototype.open, nativeSend = prototype.send;
    const targets = new WeakMap(), attached = new WeakSet();
    prototype.open = function (...args) {
      const result = Reflect.apply(nativeOpen, this, args);
      noteRequest(args[1],'xhr');
      targets.set(this, allowed(args[1]) ? args[1] : null);
      return result;
    };
    prototype.send = function (...args) {
      if (!attached.has(this)) {
        attached.add(this);
        this.addEventListener('load', () => {
          if (!targets.get(this) || this.status < 200 || this.status >= 300) return;
          try {
            if (this.responseType === 'json') { collect(this.response); observeDownload(this.response, targets.get(this)); }
            else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= 8 * 1024 * 1024) {
              const value = JSON.parse(this.responseText); collect(value); observeDownload(value, targets.get(this));
            }
          } catch { /* Non-JSON responses carry no track evidence. */ }
        });
      }
      return Reflect.apply(nativeSend, this, args);
    };
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== channel || event.data.type !== 'snapshot') return;
    debug('main-ready',{records:records.size});
    // The isolated content script starts later; replay responses observed before it existed.
    collect(window.__sc_hydration, true);
    emit([...records.values()]);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => collect(window.__sc_hydration, true), {once: true});
  else collect(window.__sc_hydration, true);
  debug('main-ready',{records:records.size});
})();
