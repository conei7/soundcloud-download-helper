(() => {
  'use strict';
  const tags = globalThis.SCHAudioTags;
  const tracks = globalThis.SCHDownloadTracks;
  const ROW = '.soundList__item, .searchList__item, .trackItem, .playableTile, .sound';
  const DOWNLOAD_PATHS = new Set([
    'M8 15A7 7 0 108 1a7 7 0 000 14zm3.47-7.53l1.06 1.06L8 13.06 3.47 8.53l1.06-1.06 2.72 2.72V3h1.5v7.19l2.72-2.72z',
    'M7 0.805664C3.13401 0.805664 0 3.93967 0 7.80566C0 11.6717 3.13401 14.8057 7 14.8057C10.866 14.8057 14 11.6717 14 7.80566C14 3.93967 10.866 0.805664 7 0.805664ZM9.97164 7.46134L11 8.49661L7 12.4876L3 8.49661L4.02836 7.46134L6.27418 9.70716V3.76025H7.72582V9.70716L9.97164 7.46134Z',
    'm13 20.0607-5.53033-5.5303 1.06066-1.0607 3.71967 3.7197v-11.1894h1.5v11.1894l3.7197-3.7197 1.0606 1.0607z',
    'M12.75 3v15.44l5.5-5.5L19.31 14 12 21.31 4.69 14l1.06-1.06 5.5 5.5V3h1.5Z'
  ].map(value => value.replace(/\s/g, '').toLowerCase()));
  let lastTrack = null, busy = false, cooldownUntil = 0, scheduled = false;
  const buttons = new Map();
  let catalogSignature = '';
  function publishCatalog(force = false) {
    const urls = new Set([canonical(location.href)]);
    document.querySelectorAll(ROW).forEach(row => urls.add(canonical(row.querySelector('a.soundTitle__title, a.trackItem__trackTitle, a.playableTile__mainHeading')?.href)));
    const entries = [];
    for (const url of urls) {
      if (!url || entries.length >= 100) continue;
      const record = tracks.get(url);
      if (!record?.title) continue;
      for (const value of new Set([record.purchase_url, ...(record.description_links || [])])) try {
        if (!value || entries.length >= 100) continue;
        let destination = new URL(value);
        if (destination.hostname === 'gate.sc' && destination.searchParams.get('url')) destination = new URL(destination.searchParams.get('url'));
        destination = new URL(globalThis.SCHMetadata?.externalDestination(destination.href) || destination.href);
        if (destination.protocol === 'https:' && !/(^|\.)soundcloud\.com$/.test(destination.hostname)) entries.push({destination: destination.href, track: {...record, url}});
      } catch { /* Ignore malformed public distribution URLs. */ }
    }
    const signature = location.pathname + location.search + JSON.stringify(entries);
    if (!force && signature === catalogSignature) return;
    catalogSignature = signature;
    window.postMessage({channel: 'sch-external-link-v1', type: 'catalog', entries}, location.origin);
  }
  function canonical(value) {
    if (!value) return null;
    try {
      const url = new URL(value, location.href), parts = url.pathname.split('/').filter(Boolean);
      if (!['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname) || parts.length !== 2 ||
          ['search', 'you', 'discover', 'settings'].includes(parts[0]) ||
          ['tracks', 'popular-tracks', 'likes', 'reposts', 'albums', 'sets'].includes(parts[1])) return null;
      return 'https://soundcloud.com/' + parts.join('/');
    } catch { return null; }
  }
  function fromScope(element) {
    const row = element?.closest(ROW);
    if (row) return canonical(row.querySelector('a.soundTitle__title, a.trackItem__trackTitle, a.playableTile__mainHeading')?.href) || (row.querySelector('h1') ? canonical(location.href) : null);
    return canonical(location.href);
  }
  function forMenu(menu) {
    if (menu.id) {
      const trigger = document.querySelector(`[aria-owns="${CSS.escape(menu.id)}"], [aria-controls="${CSS.escape(menu.id)}"]`);
      if (trigger) return fromScope(trigger);
    }
    return fromScope(menu) || (lastTrack?.route === location.pathname + location.search ? lastTrack.url : null);
  }
  function disabled(element) {
    return !!element.closest('[disabled], [aria-disabled="true"], [data-disabled="true"], .sc-button-disabled') ||
      /limit\s+reached|上限/i.test([element.textContent, element.title, element.getAttribute('aria-label')].join(' '));
  }
  function nativeDownload(element) {
    if (element.closest('.sch-download-ui') || disabled(element)) return false;
    if (element.matches('.sc-button-download')) return true;
    const descriptions = (element.getAttribute('aria-describedby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '');
    if ([element.title, element.getAttribute('aria-label'), element.getAttribute('data-tooltip'), element.textContent, ...descriptions]
      .some(value => /^(?:download(?:\s+(?:this\s+)?(?:file|track))?|ダウンロード)$/i.test((value || '').trim()))) return true;
    return [...element.querySelectorAll('svg path')].some(path => DOWNLOAD_PATHS.has((path.getAttribute('d') || '').replace(/\s/g, '').toLowerCase()));
  }
  function toast(message, error = false) {
    document.querySelector('.sch-download-toast')?.remove();
    const element = document.createElement('div');
    element.className = 'sch-download-ui sch-download-toast' + (error ? ' sch-download-error' : '');
    element.setAttribute('role', error ? 'alert' : 'status'); element.textContent = message;
    document.body.append(element); setTimeout(() => element.remove(), error ? 9000 : 5000);
  }
  function addButton(native, url) {
    if (!url) return;
    const record = tracks.get(url);
    if (record?.has_downloads_left === false) return;
    let button = buttons.get(native);
    if (button?.isConnected && button.dataset.trackUrl === url) return;
    button?.remove();
    button = document.createElement('button'); button.type = 'button';
    button.className = 'sch-download-ui sch-tag-download sc-button-secondary sc-button sc-button-medium sc-button-tertiary';
    if (native.classList.contains('moreActions__button')) button.classList.add('moreActions__button');
    button.textContent = 'タグ付きで保存'; button.title = '曲名・アーティスト・ジャケット付きで保存';
    button.dataset.trackUrl = url; button.disabled = busy;
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (event.isTrusted) download(url);
    });
    native.insertAdjacentElement('afterend', button); buttons.set(native, button);
  }
  function scan() {
    scheduled = false;
    publishCatalog();
    buttons.forEach((button, native) => {
      const record = tracks.get(button.dataset.trackUrl);
      if (!native.isConnected || !button.isConnected || disabled(native) || record?.has_downloads_left === false) {
        button.remove(); buttons.delete(native);
      }
    });
    document.querySelectorAll('.dropdownMenu, [role="menu"]').forEach(menu => {
      menu.querySelectorAll('button, a, [role="menuitem"]').forEach(native => {
        if (nativeDownload(native)) addButton(native, forMenu(menu));
      });
    });
    if (canonical(location.href)) document.querySelectorAll('.listenEngagement button, .listenEngagement a, .fullHero button').forEach(native => {
      if (!native.closest(ROW) && nativeDownload(native)) addButton(native, canonical(location.href));
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; setTimeout(scan, 100); } }
  function apiSession() {
    const clientId = window.__sc_hydration?.find(item => item?.hydratable === 'apiClient')?.data?.id;
    if (!clientId) throw Error('SoundCloudを再読み込みしてから、もう一度お試しください。');
    const headers = {};
    const token = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/)?.[1];
    if (token) headers.Authorization = 'OAuth ' + decodeURIComponent(token);
    return {clientId, version: window.__sc_version, headers};
  }
  async function api(path, session, signal) {
    const url = new URL(path, 'https://api-v2.soundcloud.com');
    url.searchParams.set('client_id', session.clientId);
    if (session.version) url.searchParams.set('app_version', session.version);
    url.searchParams.set('app_locale', 'en');
    const response = await fetch(url, {credentials: 'include', headers: session.headers, signal});
    if (!response.ok) {
      if ([403, 429].includes(response.status)) cooldownUntil = Date.now() + 30 * 60 * 1000;
      throw Error(response.status === 401 ? 'SoundCloudにログインしてからお試しください。' :
        response.status === 429 ? 'SoundCloudが通信を制限しています。時間を置いてください。' : 'SoundCloudからダウンロードできませんでした（' + response.status + '）。');
    }
    return response.json();
  }
  async function trackInfo(url, session, signal) {
    let record = tracks.get(url);
    if (!record?.id || !record.title || record.downloadable !== true) {
      const resolved = await api('/resolve?url=' + encodeURIComponent(url), session, signal);
      if (resolved.kind !== 'track' || canonical(resolved.permalink_url) !== url) throw Error('曲を確認できませんでした。');
      record = {id: resolved.id, title: resolved.title, artist: resolved.publisher_metadata?.artist || resolved.user?.username || '',
        genre: resolved.genre || '', artwork_url: resolved.artwork_url || resolved.user?.avatar_url, original_format: resolved.original_format,
        year: String(resolved.release_date || resolved.release_year || resolved.created_at || '').match(/^\d{4}/)?.[0],
        bpm: resolved.bpm > 0 ? String(resolved.bpm) : '', downloadable: resolved.downloadable, has_downloads_left: resolved.has_downloads_left};
    }
    if (!Number.isSafeInteger(record.id) || !record.title || record.downloadable !== true || record.has_downloads_left === false) {
      throw Error('この曲はSoundCloud標準のダウンロードを利用できません。');
    }
    return record;
  }
  function cdnURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !/(^|\.)sndcdn\.com$/.test(url.hostname)) throw Error('ダウンロード先を確認できませんでした。');
    return url;
  }
  async function readFile(response, signal) {
    const limit = 512 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) throw Error('このファイルは512MBを超えるため、通常のダウンロードをご利用ください。');
    const reader = response.body.getReader(), parts = []; let length = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        length += part.value.length;
        if (length > limit) throw Error('このファイルは512MBを超えるため、通常のダウンロードをご利用ください。');
        parts.push(part.value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    const output = new Uint8Array(length); let offset = 0;
    parts.forEach(part => { output.set(part, offset); offset += part.length; });
    if (!length) throw Error('ファイルが空でした。');
    return output.buffer;
  }
  async function artwork(value, signal) {
    if (!value) return null;
    const source = cdnURL(value), variants = [...new Set([source.href.replace(/-large(?=\.)/, '-t500x500'), source.href])];
    for (const url of variants) {
      const response = await fetch(url, {credentials: 'omit', signal});
      if (!response.ok) continue;
      const mime = (response.headers.get('content-type') || '').split(';')[0];
      if (!['image/jpeg', 'image/png'].includes(mime)) throw Error('Unsupported artwork');
      const blob = await response.blob(); if (blob.size > 10 * 1024 * 1024) throw Error('Artwork too large');
      const bitmap = await createImageBitmap(blob);
      const result = {data: await blob.arrayBuffer(), mime, width: bitmap.width, height: bitmap.height};
      bitmap.close(); return result;
    }
    throw Error('Artwork unavailable');
  }
  function extension(type, mime, record, response) {
    if (type !== 'other') return type;
    const known = {'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/aac': 'aac'};
    return known[mime.split(';')[0]] || record.original_format?.toLowerCase() ||
      response.headers.get('content-disposition')?.match(/\.([a-z0-9]{2,5})(?:[";\s]|$)/i)?.[1] || 'bin';
  }
  async function download(url) {
    if (busy) return;
    if (cooldownUntil > Date.now()) { toast('通信の制限中です。時間を置いてからお試しください。', true); return; }
    busy = true; document.querySelectorAll('.sch-tag-download').forEach(button => { button.disabled = true; });
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 180000);
    toast('ファイルを取得しています…');
    try {
      const session = apiSession(), record = await trackInfo(url, session, abort.signal);
      const result = await api('/tracks/' + record.id + '/download', session, abort.signal);
      if (!result.redirectUri) throw Error('ダウンロード先を取得できませんでした。');
      const response = await fetch(cdnURL(result.redirectUri), {credentials: 'omit', signal: abort.signal});
      if (!response.ok) throw Error('音声ファイルを取得できませんでした。');
      const original = await readFile(response, abort.signal), mime = response.headers.get('content-type') || '';
      const type = tags.format(original, mime); let output = original, warning = '';
      if (type !== 'other') {
        let cover = null;
        try {
          if (!tags.hasArtwork(original, type) && record.artwork_url) {
            try { cover = await artwork(record.artwork_url, abort.signal); }
            catch { warning = 'ジャケットは取得できませんでした。'; }
          }
          output = tags.write(original, {title: record.title, artist: record.artist || '', album: record.title,
            genre: record.genre || '', year: record.year || '', bpm: record.bpm || '', url}, cover, type);
        } catch { output = original; warning = 'タグを書き込めなかったため、元ファイルを保存しました。'; }
      } else warning = 'この形式はタグ付けに未対応のため、元ファイルを保存しました。';
      const blobURL = URL.createObjectURL(new Blob([output], {type: mime || 'application/octet-stream'}));
      const link = document.createElement('a'); link.href = blobURL;
      link.download = tags.filename(record.title, extension(type, mime, record, response));
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(blobURL), 60000);
      toast(warning || 'タグ付きファイルを保存しました。', !!warning);
    } catch (error) { toast(error.name === 'AbortError' ? '取得がタイムアウトしました。通常のダウンロードもお試しください。' : error.message || '保存できませんでした。', true); }
    finally {
      clearTimeout(timeout); busy = false;
      document.querySelectorAll('.sch-tag-download').forEach(button => { button.disabled = false; });
      schedule();
    }
  }
  function rememberExternal(event) {
      const target = event.composedPath().find(node => node instanceof Element) || event.target;
      if (!event.isTrusted || !(target instanceof Element) || target.closest('.sch-download-ui')) return;
      if (event.type === 'pointerdown' && event.button !== 0 || event.type === 'keydown' && (!['Enter', ' '].includes(event.key) || event.repeat)) return;
      const menu = target.closest('.dropdownMenu, [role="menu"]');
      const url = menu ? forMenu(menu) : fromScope(target); if (url) lastTrack = {url, route: location.pathname + location.search};
      if (url && target.closest('button, a, [role="button"]')) publishCatalog(true);
      const anchor = target.closest('a[href]');
      const native = target.closest('button, a, [role="button"], [role="menuitem"]');
      let nativeAnchor = !anchor || !!canonical(anchor.href);
      if (anchor && !nativeAnchor) {
        try { const dest = new URL(anchor.href); nativeAnchor = dest.protocol === 'https:' && /(^|\.)sndcdn\.com$/.test(dest.hostname) || dest.protocol === 'blob:' && dest.origin === location.origin; } catch { /* Not a standard file link. */ }
      }
      if (['pointerdown', 'keydown', 'click'].includes(event.type) && url && native && nativeDownload(native) && nativeAnchor) {
        const record = tracks.get(url) || {};
        const scope = target.closest(ROW) || [...document.querySelectorAll(ROW)].find(row => canonical(row.querySelector('a.soundTitle__title, a.trackItem__trackTitle, a.playableTile__mainHeading')?.href) === url) || (canonical(location.href) === url ? document : null);
        const detail = canonical(location.href) === url;
        const title = record.title || (detail ? scope?.querySelector('h1') : null)?.textContent?.trim() || scope?.querySelector('.soundTitle__title, .trackItem__trackTitle, .playableTile__mainHeading, .soundTitle__titleText')?.textContent?.trim();
        const publicMeta = detail && canonical(document.querySelector('meta[property="og:url"]')?.content) === url;
        const cover = record.artwork_url || (publicMeta ? document.querySelector('meta[property="og:image"]')?.content : '');
        if (title && record.has_downloads_left !== false) window.postMessage({channel: 'sch-external-link-v1', type: 'native-click',
          track: {...record, title, artwork_url: cover, artist: record.artist || scope?.querySelector('.soundTitle__username, .trackItem__username, .soundTitle__usernameText')?.textContent?.trim() || '', url}}, location.origin);
      }
      if (anchor && url && ['click', 'auxclick', 'contextmenu'].includes(event.type)) {
        try {
          let destination = new URL(anchor.href);
          if (destination.hostname === 'gate.sc' && destination.searchParams.get('url')) destination = new URL(destination.searchParams.get('url'));
          destination = new URL(globalThis.SCHMetadata?.externalDestination(destination.href) || destination.href);
          if (destination.protocol === 'https:' && !/(^|\.)soundcloud\.com$/.test(destination.hostname)) {
            const record = tracks.get(url) || {};
            const scope = target.closest(ROW) || document;
            const title = record.title || scope.querySelector('.soundTitle__title, .trackItem__trackTitle, .playableTile__mainHeading, .soundTitle__titleText, .fullHero h1')?.textContent?.trim();
            if (title) window.postMessage({channel: 'sch-external-link-v1', destination: destination.href,
              track: {...record, title, artist: record.artist || scope.querySelector('.soundTitle__username, .trackItem__username, .soundTitle__usernameText')?.textContent?.trim() || '', url}}, location.origin);
          }
        } catch { /* Ordinary links keep their normal behavior. */ }
      }
      if (document.body) schedule();
  }
  // Capture a standard download before page handlers can replace its icon or stop the click.
  for (const name of ['pointerdown', 'keydown', 'click', 'auxclick', 'contextmenu']) addEventListener(name, rememberExternal, true);
  function start() {
    new MutationObserver(mutations => {
      if (mutations.some(item => {
        const element = item.target instanceof Element ? item.target : item.target.parentElement;
        if (element?.closest('.sch-download-ui')) return false;
        return item.type !== 'childList' || [...item.addedNodes, ...item.removedNodes].some(node => !(node instanceof Element) || !node.matches('.sch-download-ui'));
      })) schedule();
    }).observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'aria-controls', 'aria-owns', 'title', 'aria-label']});
    addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin) return;
      if (event.data?.channel === 'sch-native-track-data-v1') schedule();
      if (event.data?.channel === 'sch-external-link-v1' && event.data.type === 'snapshot') publishCatalog(true);
    });
    addEventListener('popstate', schedule); scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
})();
