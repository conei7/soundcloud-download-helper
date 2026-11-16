(() => {
  'use strict';
  const canonical = value => {
    try {
      const url = new URL(value, 'https://soundcloud.com');
      const parts = url.pathname.split('/').filter(Boolean);
      if (!['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) || parts.length !== 2 ||
          ['search', 'discover', 'you', 'settings', 'upload'].includes(parts[0]) || parts[1] === 'sets') return null;
      return 'https://soundcloud.com/' + parts.join('/');
    } catch { return null; }
  };
  function descriptionLinks(value) {
    if(typeof value!=='string')return [];
    const found=new Set(),text=value.slice(0,30000),urls=/https?:\/\/[^\s<>"']+/gi;let match;
    while((match=urls.exec(text))){
      try{
        const url=new URL(match[0].replace(/[.,;!。]+$/,'')),host=url.hostname.toLowerCase();
        if(/(^|\.)(?:soundcloud\.com|youtube\.com|youtu\.be|spotify\.com|instagram\.com|twitter\.com|x\.com|facebook\.com|tiktok\.com)$/.test(host))continue;
        if(url.username||url.password||url.href.length>2048)continue;
        const known=/(^|\.)(?:dropbox\.com|dropboxusercontent\.com|hypeddit\.com|toneden\.io)$/.test(host)||host==='drive.google.com'&&/^\/(?:file|drive\/folders|open|uc)(?:\/|$)/.test(url.pathname)||/\.(?:mp3|wav|flac|aiff?|m4a|ogg|zip|rar|7z)$/i.test(url.pathname);
        const prefix=text.slice(Math.max(0,match.index-180),match.index).split(/\r?\n\s*\r?\n/).at(-1);
        if(known||/\b(?:free\s*(?:download|dl)|download\s*(?:link|here)?|dl\s*(?:link|here))\b|ダウンロード|配布(?:先|リンク)/i.test(prefix))found.add(url.href);
        if(found.size>=20)break;
      }catch{/* Ignore malformed links. */}
    }
    return [...found];
  }
  const descriptionDownload = value => descriptionLinks(value).length > 0;
  function externalDestination(value) {
    try {
      const url = new URL(value);
      if (url.username || url.password) return null;
      // Old public Bandcamp links redirect to HTTPS. Normalize only artist track/album pages.
      if (url.protocol === 'http:' && !url.port && /(^|\.)bandcamp\.com$/.test(url.hostname) && /^\/(?:track|album)\/[^/]+\/?$/.test(url.pathname)) url.protocol = 'https:';
      return url.protocol === 'https:' ? url.href : null;
    } catch { return null; }
  }
  function collect(value) {
    const tracks = new Map(), stack = [{value, depth: 0}];
    let visited = 0;
    while (stack.length && visited++ < 20000) {
      const {value: item, depth} = stack.pop();
      if (!item || typeof item !== 'object' || depth > 12) continue;
      const track = item.kind === 'track' || item.kind == null &&
        (typeof item.downloadable === 'boolean' || Object.prototype.hasOwnProperty.call(item, 'purchase_url'));
      const url = track && canonical(item.permalink_url);
      if (url) {
        const reasons = [];
        if (item.downloadable === true && item.has_downloads_left !== false) reasons.push('Download');
        let purchase = false;
        try { purchase = /^https?:$/.test(new URL(item.purchase_url).protocol); } catch { /* No link. */ }
        if (purchase) {
          const label = String(item.purchase_title || '');
          reasons.push(/\b(?:download|dl)\b|ダウンロード/i.test(label) ? 'Download リンク' : 'Buy リンク');
          if (/\bfree\b|無料/i.test(label)) reasons.push('Free');
        }
        if((item.description_download===true||descriptionDownload(item.description))&&!reasons.includes('Download リンク'))reasons.push('Download リンク');
        const complete = typeof item.downloadable === 'boolean' &&
          Object.prototype.hasOwnProperty.call(item, 'purchase_url') &&
          (item.downloadable !== true || typeof item.has_downloads_left === 'boolean');
        const previous = tracks.get(url);
        if (!previous?.complete || complete) tracks.set(url, {reasons, complete,
          ...(typeof item.has_downloads_left === 'boolean' ? {downloadBlocked: item.downloadable!==false&&!item.has_downloads_left} : {})});
      }
      if (depth < 12) Object.values(item).forEach(child => {
        if (child && typeof child === 'object') stack.push({value: child, depth: depth + 1});
      });
    }
    return tracks;
  }
  function collectFiles(value) {
    const tracks = new Map(), stack = [{value, depth: 0}]; let visited = 0;
    while (stack.length && visited++ < 20000) {
      const {value: item, depth} = stack.pop();
      if (!item || typeof item !== 'object' || depth > 12) continue;
      const url = item.kind === 'track' && canonical(item.permalink_url);
      if (url && typeof item.title === 'string') {
        const record = {url, title: item.title.slice(0, 1024)};
        for (const key of ['downloadable', 'has_downloads_left']) if (typeof item[key] === 'boolean') record[key] = item[key];
        for (const key of ['waveform_url', 'artwork_url']) if (typeof item[key] === 'string') record[key] = item[key].slice(0, 2048);
        const artist = item.publisher_metadata?.artist || item.artist || item.user?.username || item.user?.full_name;
        if (typeof artist === 'string') record.artist = artist.slice(0, 512);
        if (!record.artwork_url && typeof item.user?.avatar_url === 'string') record.artwork_url = item.user.avatar_url.slice(0, 2048);
        if (typeof item.genre === 'string') record.genre = item.genre.slice(0, 256);
        const year = String(item.release_date || item.release_year || item.created_at || '').match(/^\d{4}/)?.[0];
        if (year) record.year = year;
        if (Number.isFinite(item.bpm) && item.bpm > 0) record.bpm = String(item.bpm);
        tracks.set(url, record);
      }
      if (depth < 12) Object.values(item).forEach(child => { if (child && typeof child === 'object') stack.push({value: child, depth: depth + 1}); });
    }
    return tracks;
  }
  function read(text, collector = collect) {
    const marker = /(?:window\s*\.\s*)?__sc_hydration\s*=\s*/g;
    const tracks = new Map();
    let match;
    while ((match = marker.exec(text))) {
      const start = marker.lastIndex;
      if (text[start] !== '[') continue;
      let depth = 0, quoted = false, escaped = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') quoted = false;
        } else {
          if (ch === '"') quoted = true;
          else if (ch === '[' || ch === '{') depth++;
          else if (ch === ']' || ch === '}') {
            if (--depth === 0) {
              try {
                collector(JSON.parse(text.slice(start, i + 1))).forEach((record, url) => {
                  if (!tracks.get(url)?.complete || record.complete) tracks.set(url, record);
                });
              } catch { /* Unknown metadata is never treated as a match. */ }
              marker.lastIndex = i + 1;
              break;
            }
          }
        }
      }
    }
    return tracks;
  }
  const downloadState = record => typeof record?.downloadBlocked === 'boolean' ? {downloadBlocked: record.downloadBlocked} : {};
  globalThis.SCHMetadata = {canonical, read, collect, downloadState, descriptionDownload, descriptionLinks, externalDestination, readFiles: text => read(text, collectFiles)};
})();
