(() => {
  'use strict';
  const ROW = '.soundList__item, .searchList__item, .sound';
  const PRELOAD_TARGET = 50;
  const PRELOAD_INTERVAL = 4000;
  const PRELOAD_TIMEOUT = 15000;
  const PROFILE_TABS = new Set(['tracks', 'popular-tracks', 'reposts', 'likes', 'sets', 'albums']);
  const RESERVED_ROOTS = new Set(['search', 'discover', 'you', 'settings', 'upload', 'stream',
    'charts', 'stations', 'users', 'tracks', 'messages', 'notifications', 'terms-of-use',
    'privacy', 'pages', 'jobs', 'pro', 'signin', 'logout']);
  const labels = [
    ['Download', /\b(?:download(?:s|ing)?|free\s*dl)\b|ダウンロード/i],
    ['購入', /\b(?:buy|purchase)\b|購入/i],
    ['Free', /\bfree\b|無料/i]
  ];
  const visible = el => !!el.getClientRects().length &&
    getComputedStyle(el).visibility !== 'hidden';
  const textReasons = text => labels.filter(([, re]) => re.test(text)).map(([label]) => label);
  const CONTROL = 'a, button, svg, [role="button"], .sc-button, [tabindex], [data-tooltip], [data-tooltip-content], .sc-button-download, .sc-button-buy';
  const normalizePath = value => value.replace(/\s+/g, '').toLowerCase();
  // Exact Download / DownloadLight / HeroDownload paths from SoundCloud's shipped icons.
  const downloadPaths = new Set([
    'M8 15A7 7 0 108 1a7 7 0 000 14zm3.47-7.53l1.06 1.06L8 13.06 3.47 8.53l1.06-1.06 2.72 2.72V3h1.5v7.19l2.72-2.72z',
    'M7 0.805664C3.13401 0.805664 0 3.93967 0 7.80566C0 11.6717 3.13401 14.8057 7 14.8057C10.866 14.8057 14 11.6717 14 7.80566C14 3.93967 10.866 0.805664 7 0.805664ZM9.97164 7.46134L11 8.49661L7 12.4876L3 8.49661L4.02836 7.46134L6.27418 9.70716V3.76025H7.72582V9.70716L9.97164 7.46134Z',
    'm13 20.0607-5.53033-5.5303 1.06066-1.0607 3.71967 3.7197v-11.1894h1.5v11.1894l3.7197-3.7197 1.0606 1.0607z',
    'M12.75 3v15.44l5.5-5.5L19.31 14 12 21.31 4.69 14l1.06-1.06 5.5 5.5V3h1.5Z'
  ].map(normalizePath));
  const HINTS = ['title', 'aria-label', 'data-tooltip', 'data-tooltip-content',
    'data-original-title', 'data-title', 'data-testid', 'data-test-id', 'data-tip'];
  const downloadIcon = /(?:^|[^a-z])download(?:track|file)?(?:$|[^a-z])/i;
  const buyIcon = /(?:^|[^a-z])(?:buy|purchase|shopping[-_ ]?cart)(?:$|[^a-z])/i;
  const normalizeHint = value => value.replace(/([a-z])([A-Z])/g, '$1 $2');
  const hoverHints = new WeakMap();
  let hoveredControl = null;
  const metadata = globalThis.SCHMetadata;
  const pageRecords = metadata.read([...document.scripts].map(script => script.textContent || '').join('\n'));
  const records = new Map(pageRecords);
  const nativeRecords = new Map();
  const detailProof = new Map();
  const waiting = [];
  const retryAfter = new Map();
  let retryTimer;
  let stopped = false;
  let scanTimer;
  let routeTimer;
  let observer;
  let storageChangeListener;
  const eventController = new AbortController();
  const hoverTimers = new Set();
  const requested = new Set([...records].filter(([, result]) => result.complete !== false || result.reasons.length > 0).map(([url]) => url));
  let activeRequests = 0;
  const evidence = new WeakMap();
  const filterSpaces = new Map();
  let cacheLoaded = false;
  const preferences = globalThis.SCHSettings;
  let settings = preferences.normalize();
  let settingsLoaded = false;
  let preload = {};
  let preloadTimer;
  const published = new Map();
  const observations = new Map();
  const observationSource = crypto.randomUUID();

  const settled = result => !!result && (result.complete !== false || result.reasons.length > 0 || result.downloadBlocked);
  const recordSignature = record => JSON.stringify({reasons: [...record.reasons].sort(), complete: record.complete !== false, ...metadata.downloadState(record)});

  function stopExtension() {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    eventController.abort();
    clearTimeout(scanTimer);
    clearTimeout(retryTimer);
    clearTimeout(preloadTimer);
    clearInterval(routeTimer);
    hoverTimers.forEach(clearTimeout);
    hoverTimers.clear();
    discardWaiting();
    retryAfter.clear();
    observations.clear();
    try { globalThis.chrome?.storage?.onChanged?.removeListener(storageChangeListener); }
    catch { /* The extension context may already be gone. */ }
    restoreListSpace();
    document.querySelectorAll('.sch-filter-hidden').forEach(row => row.classList.remove('sch-filter-hidden'));
    diagnostic?.remove();
    diagnostic = null;
  }
  function extensionRuntime() {
    if (stopped) return null;
    try {
      const runtime = globalThis.chrome?.runtime;
      if (runtime?.id && typeof runtime.sendMessage === 'function') return runtime;
    } catch { /* Reloading an extension invalidates APIs in existing tabs. */ }
    stopExtension();
    return null;
  }
  function sendExtensionMessage(message, callback) {
    const runtime = extensionRuntime();
    if (!runtime) return false;
    try {
      runtime.sendMessage(message, result => {
        let error;
        try { error = runtime.lastError; }
        catch { stopExtension(); return; }
        if (!extensionRuntime()) return;
        if (/extension context invalidated/i.test(error?.message || '')) { stopExtension(); return; }
        callback?.(result, error);
      });
      return true;
    } catch {
      stopExtension();
      return false;
    }
  }

  function observePageResult(url, localReasons) {
    if (!url) return;
    const fresh = detailProof.get(url) || nativeRecords.get(url) || pageRecords.get(url);
    const current = records.get(url);
    // Do not republish stale title/icon positives over a newer exhausted-download result.
    if (current?.downloadBlocked && !fresh?.downloadBlocked && !localReasons.size) return;
    if (!settled(fresh) && !localReasons.size) return;
    // A cached positive must not be replaced with an older listing's empty evidence.
    if (!fresh?.downloadBlocked && !fresh?.reasons.length && !localReasons.size && current?.reasons.length) return;
    const base = current?.downloadBlocked ? current : fresh;
    const reasons = [...new Set([...(base?.reasons || []), ...localReasons])].sort();
    const complete = base?.complete === true;
    const result = {reasons, complete, ...metadata.downloadState(base)};
    const signature = recordSignature(result);
    if (published.get(url) === signature) return;
    published.set(url, signature);
    observations.set(url, {url, ...result});
  }
  function publishPageResults() {
    const entries = [...observations.values()];
    observations.clear();
    for (let i = 0; i < entries.length; i += 100) {
      // Persist actual page evidence too, so export includes judgments that need no fetch.
      if (!sendExtensionMessage({type: 'sch-observed-info', source: observationSource, entries: entries.slice(i, i + 100)})) return;
    }
  }

  function requestMetadata(url) {
    if (stopped || !url || requested.has(url)) return;
    if ((retryAfter.get(url) || 0) > Date.now()) { scheduleRetry(); return; }
    requested.add(url);
    waiting.push(url);
    pump();
  }
  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (stopped) return;
    const deadlines = [...retryAfter.values()].filter(time => time > Date.now());
    if (!deadlines.length) return;
    retryTimer = setTimeout(() => {
      retryAfter.forEach((time, url) => { if (time <= Date.now()) retryAfter.delete(url); });
      schedule();
      scheduleRetry();
    }, Math.max(200, Math.min(...deadlines) - Date.now()));
  }
  function pump() {
    if (!extensionRuntime() || !cacheLoaded) return;
    if (location.pathname + location.search !== currentRoute) { discardWaiting(); return; }
    while (activeRequests < 1 && waiting.length) {
      const url = waiting.shift();
      if (settled(records.get(url))) continue;
      activeRequests++;
      // The shared background worker caches and limits requests across all tabs.
      if (!sendExtensionMessage({type: 'sch-track-info', url}, (result, error) => {
        if (!error && result?.status === 'ok') {
          const record = {reasons: result.reasons, complete: result.complete !== false, ...metadata.downloadState(result)};
          if (record.downloadBlocked) detailProof.delete(url);
          records.set(url, nativeRecords.get(url) || (record.downloadBlocked ? record : detailProof.get(url) || record));
          retryAfter.delete(url);
        } else {
          // A failed/deferred check is still unknown, and may be retried after its shared deadline.
          requested.delete(url);
          retryAfter.set(url, Math.max(Date.now() + 4000,
            Number.isFinite(result?.nextAt) ? result.nextAt : Date.now() + 10 * 60 * 1000));
          scheduleRetry();
        }
        activeRequests--;
        schedule();
        pump();
      })) { activeRequests--; return; }
    }
  }
  function discardWaiting() {
    waiting.splice(0).forEach(url => requested.delete(url));
  }
  function restoreListSpace() {
    filterSpaces.forEach((space, list) => {
      space.anchor.remove();
      list.style.minHeight = space.minHeight;
      list.style.position = space.position;
    });
    filterSpaces.clear();
  }
  function preserveListSpace(rows) {
    const groups = new Map();
    rows.forEach(row => { if (row.parentElement) {
      if (!groups.has(row.parentElement)) groups.set(row.parentElement, new Set());
      groups.get(row.parentElement).add(row);
    } });
    groups.forEach((cards, list) => {
      let space = filterSpaces.get(list);
      const initial = !space;
      if (!space) {
        const anchor = document.createElement('li');
        anchor.className = 'sch-pagination-anchor';
        anchor.setAttribute('aria-hidden', 'true');
        space = {minHeight: list.style.minHeight, position: list.style.position,
          height: Math.ceil(list.getBoundingClientRect().height), cards: new Map(), anchor, nudging: false};
        if (getComputedStyle(list).position === 'static') list.style.position = 'relative';
        filterSpaces.set(list, space);
      }
      space.cards.forEach((height, card) => { if (!cards.has(card)) {space.height -= height; space.cards.delete(card);} });
      cards.forEach(card => { if (!space.cards.has(card)) {
        const style = getComputedStyle(card);
        const height = card.getBoundingClientRect().height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
        space.cards.set(card, height);
        if (!initial) space.height += height;
      } });
      list.style.minHeight = Math.max(0, Math.ceil(space.height)) + 'px';
      if (!space.nudging) space.anchor.style.top = Math.max(0, Math.ceil(space.height)) + 'px';
      // SoundCloud checks the last child's offset, rather than the container height.
      if (list.lastElementChild !== space.anchor) list.appendChild(space.anchor);
    });
  }

  function stopPreloadNudge() {
    filterSpaces.forEach(space => {
      space.nudging = false;
      space.anchor.style.top = Math.max(0, Math.ceil(space.height)) + 'px';
    });
  }
  function schedulePreload(delay) {
    clearTimeout(preloadTimer);
    preloadTimer = setTimeout(schedule, Math.max(200, delay));
  }
  function preloadList(total) {
    clearTimeout(preloadTimer);
    const now = Date.now();
    if (!settings.autoLoad || total >= PRELOAD_TARGET || preload.done || document.hidden) {
      if (total >= PRELOAD_TARGET) preload.done = true;
      stopPreloadNudge();
      return;
    }
    if (!total) return;
    preload.startedAt ||= now;
    if (preload.pendingCount != null) {
      if (total > preload.pendingCount) {
        preload.pendingCount = null;
        stopPreloadNudge();
      } else if (now - preload.pendingAt >= PRELOAD_TIMEOUT) {
        preload.done = true;
        stopPreloadNudge();
        return;
      } else { schedulePreload(PRELOAD_TIMEOUT - (now - preload.pendingAt)); return; }
    }
    if ((preload.attempts || 0) >= 8 || now - preload.startedAt >= 90000) {
      preload.done = true;
      stopPreloadNudge();
      return;
    }
    const delay = (preload.lastStart || 0) + PRELOAD_INTERVAL - now;
    if (delay > 0) { schedulePreload(delay); return; }
    const entry = [...filterSpaces].find(([list]) =>
      list.querySelector('a.soundTitle__title') && list.closest('.lazyLoadingList'));
    if (!entry) return;
    const [list, space] = entry;
    const wrapper = list.closest('.lazyLoadingList');
    if (wrapper.querySelector(':scope > .paging-eof, :scope > .inlineError')) {
      preload.done = true;
      stopPreloadNudge();
      return;
    }
    // Briefly expose only the pagination anchor to the native debounced scroll handler.
    // The viewport and the actual track cards remain at their existing positions.
    space.nudging = true;
    space.anchor.style.top = Math.max(0, innerHeight - 50 - list.getBoundingClientRect().top) + 'px';
    preload.pendingCount = total;
    preload.pendingAt = now;
    preload.lastStart = now;
    preload.attempts = (preload.attempts || 0) + 1;
    dispatchEvent(new Event('scroll'));
    schedulePreload(PRELOAD_TIMEOUT);
  }

  function floatingTooltipText() {
    const nodes = [...document.querySelectorAll('[role="tooltip"], [data-radix-popper-content-wrapper], [class*="tooltip"], [class*="Tooltip"]')];
    // Some new layouts render an anonymous tooltip, without a semantic class.
    document.querySelectorAll('div, span').forEach(node => {
      const text = (node.textContent || '').trim();
      if (text.length < 80 && /^(?:download(?:\s+(?:track|file))?|buy(?:\s+(?:track|now))?|purchase(?:\s+track)?|ダウンロード|購入)$/i.test(text) &&
          ![...node.children].some(child => (child.textContent || '').trim() === text)) nodes.push(node);
    });
    return nodes.filter(visible).map(node => node.textContent || '').filter(text => text.length < 200).join(' ');
  }

  function tooltipText(el) {
    return ['aria-describedby', 'aria-labelledby', 'data-tooltip-id'].flatMap(attr =>
      (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '')
    ).join(' ');
  }

  const limitReached = text => /\blimit\s+reached\b|ダウンロード.{0,16}上限|上限.{0,16}ダウンロード/i.test(text);
  const controlText = el => [el.innerText || '', tooltipText(el), ...HINTS.map(attr => el.getAttribute(attr) || '')].join(' ');
  function hasLimitNotice(root) {
    return [...root.querySelectorAll(CONTROL)].some(el => limitReached(controlText(el)));
  }
  function markDownloadBlocked(url) {
    if (!url || records.get(url)?.downloadBlocked) return;
    const fresh = nativeRecords.get(url) || pageRecords.get(url) || records.get(url);
    const external = (fresh?.reasons || []).filter(reason => /リンク|購入/.test(reason));
    if (external.length && fresh?.reasons.includes('Free')) external.push('Free');
    const proof = {reasons: external, complete: fresh?.complete === true, downloadBlocked: true};
    detailProof.set(url, proof);
    records.set(url, proof);
    requested.add(url);
    retryAfter.delete(url);
  }
  function controlReasons(el, downloadBlocked = false) {
    if (el.closest('.sch-download-ui')) return new Set();
    if (el.closest('button:disabled, [disabled], [aria-disabled="true"], [data-disabled="true"], .sc-button-disabled') ||
        limitReached(controlText(el))) return new Set();
    const reasons = new Set(textReasons([el.innerText || '', tooltipText(el), ...HINTS.map(attr => el.getAttribute(attr) || '')].join(' ')));
    const paths = el.matches('svg') ? el.querySelectorAll('path') : el.querySelectorAll('svg path');
    if ([...paths].some(path => downloadPaths.has(normalizePath(path.getAttribute('d') || '')))) reasons.add('Download');
    const identity = location.pathname + '|' + (el.getAttribute('href') || '');
    if (el === hoveredControl && el.matches(':hover')) {
      const hints = textReasons(floatingTooltipText()).filter(reason => reason !== 'Free');
      if (hints.length) hoverHints.set(el, {identity, hints});
    }
    const remembered = hoverHints.get(el);
    if (remembered?.identity === identity) remembered.hints.forEach(reason => reasons.add(reason));
    // Icon-only controls can put their semantic name on the SVG or a child span.
    const parts = [el, ...el.querySelectorAll('svg, svg title, use, span, i, [data-testid], [aria-label], [title], [data-tooltip]')];
    parts.forEach(part => {
      const hint = normalizeHint(['class', 'id', 'href', 'xlink:href', ...HINTS].map(attr => part.getAttribute(attr) || '').join(' ') + ' ' + (part.matches('svg title') ? part.textContent || '' : ''));
      if (downloadIcon.test(hint)) reasons.add('Download');
      if (buyIcon.test(hint)) reasons.add('購入');
    });
    if (el.matches('a[href]')) {
      try {
        const url = new URL(el.href);
        if (/^https?:$/.test(url.protocol) && /(?:^|\/)(?:download|downloads)(?:\/|$)/i.test(url.pathname)) reasons.add('Download');
      } catch { /* Ignore malformed links. */ }
    }
    if (downloadBlocked) {
      let external = false;
      try {
        const link = el.closest('a[href]');
        const url = link && new URL(link.href);
        external = url && /^https?:$/.test(url.protocol) && !['soundcloud.com', 'www.soundcloud.com'].includes(url.hostname);
      } catch { /* Invalid link. */ }
      if (!external) {
        reasons.delete('Download');
        reasons.delete('Free');
      }
    }
    return reasons;
  }
  let scheduled = false;
  let lastURL = '';
  let diagnostic;
  let onlyCandidates = true;
  let currentRoute = location.pathname + location.search;

  function scan() {
    scheduled = false;
    if (!extensionRuntime() || !cacheLoaded || !settingsLoaded) return;
    const route = location.pathname + location.search;
    if (route !== currentRoute) {
      currentRoute = route;
      discardWaiting();
      clearTimeout(retryTimer);
      onlyCandidates = settings.defaultFilter;
      clearTimeout(preloadTimer);
      preload = {};
      restoreListSpace();
    }
    // SoundCloud navigation uses the same document; classify profile tabs before tracks.
    const searching = /^\/search(?:\/|$)/.test(location.pathname);
    const path = location.pathname.split('/').filter(Boolean);
    const profile = !RESERVED_ROOTS.has(path[0]) &&
      (path.length === 1 || path.length === 2 && PROFILE_TABS.has(path[1]));
    const listing = searching || profile;
    const detail = path.length === 2 && !RESERVED_ROOTS.has(path[0]) && !PROFILE_TABS.has(path[1]);
    if (!listing || !onlyCandidates) {
      document.querySelectorAll('.sch-filter-hidden').forEach(row => row.classList.remove('sch-filter-hidden'));
    }
    if (!listing || !onlyCandidates && (!settings.autoLoad || preload.done)) {
      restoreListSpace();
    }
    const rows = new Set();
    document.querySelectorAll(ROW).forEach(el => {
      const outer = el.closest('.soundList__item, .searchList__item');
      rows.add(outer || el);
    });
    // Keep the native pagination sentinel at its original distance from the viewport.
    if (listing && (onlyCandidates || settings.autoLoad && !preload.done)) preserveListSpace(rows);
    let matchedRows = 0;
    let totalRows = 0;
    const filteredRows = [];
    rows.forEach(row => {
      if (stopped) return;
      const title = row.querySelector('a.soundTitle__title');
      let isTrack = false;
      if (title) {
        try {
          const path = new URL(title.href).pathname.split('/').filter(Boolean);
          isTrack = path.length === 2 && path[1] !== 'sets';
        } catch { /* Ignore malformed links. */ }
      }
      const reasons = new Set();
      const trackURL = title && metadata.canonical(title.href);
      if (listing && isTrack && hasLimitNotice(row)) markDownloadBlocked(trackURL);
      const downloadBlocked = records.get(trackURL)?.downloadBlocked === true;
      let snapshot = evidence.get(row);
      let hidden = row.classList.contains('sch-filter-hidden');
      if (hidden && (snapshot?.url !== trackURL || snapshot.downloadBlocked !== downloadBlocked)) {
        row.classList.remove('sch-filter-hidden'); hidden = false;
      }
      const counted = listing && isTrack && !!trackURL && (hidden ? snapshot?.counted : visible(row));
      if (counted) totalRows++;
      if (listing && isTrack && trackURL) {
        const result = records.get(trackURL);
        if (result) { result.reasons.forEach(reason => reasons.add(reason)); }
      }
      const localReasons = new Set(hidden ? snapshot?.localReasons || [] : []);
      if (listing && isTrack && !hidden) {
        // Do not scan artist names, comments, or the extension's own badge.
        row.querySelectorAll('.soundTitle__title, .sound__description, .soundDescription, ' + CONTROL).forEach(el => {
          if (!visible(el) || el.closest('.sch-badge') || el.matches('.soundTitle__username') || el.closest('.soundTitle__username')) return;
          const isControl = el.matches(CONTROL);
          if (isControl) controlReasons(el, downloadBlocked).forEach(reason => localReasons.add(reason));
          else if (!downloadBlocked) textReasons(el.innerText || '').forEach(reason => localReasons.add(reason));
        });
      }
      localReasons.forEach(reason => reasons.add(reason));
      if (counted) observePageResult(trackURL, localReasons);
      if (counted && listing && isTrack && trackURL && !settled(records.get(trackURL)) && !localReasons.size) {
        const bounds = row.getBoundingClientRect();
        if (onlyCandidates || bounds.bottom >= -200 && bounds.top <= innerHeight + 200) {
          requestMetadata(trackURL);
        }
      }
      if (!hidden) evidence.set(row, {url: trackURL, counted, localReasons: [...localReasons], downloadBlocked});
      const matched = reasons.size > 0;
      if (matched && counted) matchedRows++;
      if (row.classList.contains('sch-match') !== matched) row.classList.toggle('sch-match', matched);
      if (listing && onlyCandidates && !matched) filteredRows.push(row);
      else if (hidden) row.classList.remove('sch-filter-hidden');
      row.querySelector(':scope > .sch-badge')?.remove();
    });
    if (stopped) return;
    filteredRows.forEach(row => row.classList.add('sch-filter-hidden'));
    if (listing) {
      preloadList(totalRows);
      if (!onlyCandidates && (!settings.autoLoad || preload.done)) restoreListSpace();
    }
    else { clearTimeout(preloadTimer); stopPreloadNudge(); }
    // The round action buttons on a track's own page live outside search rows.
    const currentURL = metadata.canonical(location.href);
    if (detail) document.querySelectorAll('.fullHero, .listenEngagement, .purchaseSection').forEach(root => {
      if (hasLimitNotice(root)) markDownloadBlocked(currentURL);
    });
    const downloadBlocked = records.get(currentURL)?.downloadBlocked === true;
    const actionControls = new Set(document.querySelectorAll('.sch-action-match'));
    // Action bars may be siblings of the hero, or use a different wrapper.
    if (detail) document.querySelectorAll(CONTROL).forEach(el => {
      if (el.closest('.fullHero, .listenEngagement, .purchaseSection') && !el.closest('.sch-status, .sch-badge')) actionControls.add(el);
    });
    if (detail && hoveredControl?.isConnected && hoveredControl.closest('.fullHero, .listenEngagement, .purchaseSection')) actionControls.add(hoveredControl);
    let detected = 0;
    actionControls.forEach(el => {
      const reasons = detail && visible(el) ? controlReasons(el, downloadBlocked) : new Set();
      const matched = reasons.has('Download') || reasons.has('購入');
      if (el.classList.contains('sch-action-match') !== matched) el.classList.toggle('sch-action-match', matched);
      if (matched && !(el.matches('svg') && el.parentElement?.closest('.sch-action-match'))) detected++;
    });
    const trackReasons = new Set(detail && currentURL ? records.get(currentURL)?.reasons || [] : []);
    const localTrackReasons = new Set();
    actionControls.forEach(el => {
      if (el.classList.contains('sch-action-match')) controlReasons(el, downloadBlocked).forEach(reason => {
        trackReasons.add(reason);
        localTrackReasons.add(reason);
      });
    });
    if (detail && currentURL) {
      if (localTrackReasons.size) {
        const fresh = records.get(currentURL) || nativeRecords.get(currentURL) || pageRecords.get(currentURL);
        const proof = {reasons: [...new Set([...(fresh?.reasons || []), ...localTrackReasons])].sort(),
          complete: fresh?.complete === true, ...metadata.downloadState(fresh)};
        // Keep live detail evidence in this document, including when returning via history.
        detailProof.set(currentURL, proof);
        records.set(currentURL, proof);
        requested.add(currentURL);
        retryAfter.delete(currentURL);
      }
      observePageResult(currentURL, localTrackReasons);
      if (!settled(records.get(currentURL)) && !localTrackReasons.size) requestMetadata(currentURL);
    }
    const hero = detail ? document.querySelector('.fullHero') : null;
    document.querySelectorAll('.sch-track-match').forEach(el => {
      if (el !== hero || !trackReasons.size) { el.classList.remove('sch-track-match'); el.querySelector(':scope > .sch-track-badge')?.remove(); }
    });
    if (hero && trackReasons.size) {
      if (!hero.classList.contains('sch-track-match')) hero.classList.add('sch-track-match');
    }
    document.querySelectorAll('.sch-badge').forEach(badge => badge.remove());
    publishPageResults();
    if (stopped) return;
    if (listing) {
      if (!diagnostic) {
        diagnostic = document.createElement('button');
        diagnostic.type = 'button';
        diagnostic.className = 'sch-status';
        diagnostic.addEventListener('click', () => {
          onlyCandidates = !onlyCandidates;
          scan();
        });
        document.body.appendChild(diagnostic);
      }
      const caption = `${matchedRows}/${totalRows}`;
      if (diagnostic.textContent !== caption) diagnostic.textContent = caption;
      diagnostic.classList.toggle('sch-filter-active', onlyCandidates);
      diagnostic.setAttribute('aria-pressed', String(onlyCandidates));
      diagnostic.title = onlyCandidates ? 'すべての曲を表示（確認が済んだ候補は自動で表示）' : '候補だけ表示';
      diagnostic.setAttribute('aria-label', caption + '、' + diagnostic.title);
    } else { diagnostic?.remove(); diagnostic = null; }
  }
  function schedule() {
    if (!extensionRuntime() || scheduled) return;
    scheduled = true;
    scanTimer = setTimeout(scan, 180);
  }
  observer = new MutationObserver(mutations => {
    const changed = mutations.filter(m => {
      const element = m.target instanceof Element ? m.target : m.target.parentElement;
      if (element?.closest('.sch-badge, .sch-status, .sch-pagination-anchor, .sch-download-ui')) return false;
      if (m.type === 'attributes' && ['class', 'style'].includes(m.attributeName)) {
        if (!element?.closest(ROW) && !element?.querySelector(ROW)) return false;
        if (m.attributeName === 'style') return m.oldValue !== element.getAttribute('style');
        const nativeClasses = value => (value || '').split(/\s+/).filter(name => name && !name.startsWith('sch-')).sort().join(' ');
        return nativeClasses(m.oldValue) !== nativeClasses(element.getAttribute('class'));
      }
      return !(m.type === 'childList' && [...m.addedNodes, ...m.removedNodes].every(node =>
        node instanceof Element && node.matches('.sch-pagination-anchor, .sch-download-ui')));
    });
    changed.forEach(m => {
      const element = m.target instanceof Element ? m.target : m.target.parentElement;
      const row = element?.closest(ROW);
      const outer = row?.closest('.soundList__item, .searchList__item') || row;
      if (outer?.classList.contains('sch-filter-hidden')) evidence.delete(outer);
    });
    if (changed.length) schedule();
  });
  observer.observe(document.body, {subtree: true, childList: true, characterData: true,
    attributes: true, attributeOldValue: true,
    attributeFilter: ['class', 'style', 'd', 'href', 'xlink:href', ...HINTS, 'aria-describedby', 'aria-labelledby', 'data-tooltip-id', 'hidden', 'disabled', 'aria-disabled', 'data-disabled']});
  // Detect pushState navigation without injecting code into the page.
  routeTimer = setInterval(() => {
    if (!extensionRuntime()) return;
    if (location.href !== lastURL) { lastURL = location.href; schedule(); }
  }, 1000);
  addEventListener('popstate', schedule, {signal: eventController.signal});
  document.addEventListener('visibilitychange', schedule, {signal: eventController.signal});
  addEventListener('scroll', schedule, {passive: true, signal: eventController.signal});
  document.addEventListener('mouseover', event => {
    if (!extensionRuntime()) return;
    if (!(event.target instanceof Element)) return;
    hoveredControl = event.target.closest('button, a, [role="button"], [tabindex], .sc-button') || event.target.closest('svg')?.parentElement || null;
    if (hoveredControl && !hoveredControl.closest('.sch-status')) {
      schedule();
      [650, 1200].forEach(delay => {
        const timer = setTimeout(() => { hoverTimers.delete(timer); schedule(); }, delay);
        hoverTimers.add(timer);
      });
    }
  }, {passive: true, signal: eventController.signal});
  window.addEventListener('message', event => {
    if (!extensionRuntime()) return;
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.channel !== 'sch-native-track-data-v1' ||
        message.type !== 'tracks' || !Array.isArray(message.entries) || message.entries.length > 100) return;
    // Accept only public track fields; no raw response, credentials or user data crosses the bridge.
    const entries = message.entries.filter(entry => entry && entry.kind === 'track' && metadata.canonical(entry.permalink_url) &&
      (entry.downloadable === undefined || typeof entry.downloadable === 'boolean') &&
      (entry.has_downloads_left === undefined || typeof entry.has_downloads_left === 'boolean') &&
      (entry.description_download === undefined || typeof entry.description_download === 'boolean') &&
      (entry.purchase_url === undefined || entry.purchase_url === null || typeof entry.purchase_url === 'string' && entry.purchase_url.length <= 2048) &&
      (entry.purchase_title === undefined || typeof entry.purchase_title === 'string' && entry.purchase_title.length <= 80)).map(entry => {
        const clean = {kind: 'track', permalink_url: metadata.canonical(entry.permalink_url)};
        ['downloadable', 'has_downloads_left', 'purchase_url', 'purchase_title', 'description_download'].forEach(key => {
          if (entry[key] !== undefined) clean[key] = entry[key];
        });
        return clean;
      });
    let changed = false;
    metadata.collect(entries).forEach((record, url) => {
      if (!settled(record)) return;
      const previous = nativeRecords.get(url);
      if (previous && recordSignature(previous) === recordSignature(record)) return;
      nativeRecords.set(url, record);
      if (typeof record.downloadBlocked === 'boolean') detailProof.delete(url);
      records.set(url, detailProof.get(url) || record);
      requested.add(url);
      retryAfter.delete(url);
      changed = true;
    });
    if (changed) schedule();
  }, {signal: eventController.signal});
  window.postMessage({channel: 'sch-native-track-data-v1', type: 'snapshot'}, location.origin);
  storageChangeListener = (changes, area) => {
    if (!extensionRuntime() || area !== 'local') return;
    if (changes[preferences.key]) applySettings(changes[preferences.key].newValue);
    const cache = changes['sch-inspections-v18']?.newValue?.cache;
    if (!cache) return;
    let changed = false;
    Object.entries(cache).forEach(([url, entry]) => {
      if (entry.expires <= Date.now() || entry.result?.status !== 'ok') return;
      const record = {reasons: entry.result.reasons, complete: entry.result.complete !== false, ...metadata.downloadState(entry.result)};
      const signature = recordSignature(record);
      // Own DOM observations are evaluated directly; late storage delivery must not freeze them.
      if (entry.source === observationSource) return;
      if (records.get(url)?.downloadBlocked && record.downloadBlocked === undefined) return;
      if (typeof record.downloadBlocked === 'boolean') detailProof.delete(url);
      else if (detailProof.has(url)) return;
      if (!record.downloadBlocked && (nativeRecords.get(url)?.reasons.length || pageRecords.get(url)?.reasons.length) && !record.reasons.length) return;
      const previous = records.get(url);
      if (!previous || recordSignature(previous) !== signature) {
        records.set(url, record);
        changed = true;
      }
    });
    if (changed) schedule();
  };
  function applySettings(value) {
    const next = preferences.normalize(value);
    if (!settingsLoaded || next.defaultFilter !== settings.defaultFilter) onlyCandidates = next.defaultFilter;
    if (next.autoLoad !== settings.autoLoad) {
      clearTimeout(preloadTimer);
      stopPreloadNudge();
      // Keep the minimum interval even when the switch is toggled rapidly.
      preload = {lastStart: preload.lastStart};
    }
    settings = next;
    settingsLoaded = true;
    schedule();
  }
  if (!extensionRuntime()) return;
  try {
    chrome.storage.onChanged.addListener(storageChangeListener);
    chrome.storage.local.get(preferences.key, stored => {
      const runtime = extensionRuntime();
      if (!runtime) return;
      void runtime.lastError;
      // A newer storage event may have arrived while the initial read was pending.
      if (!settingsLoaded) applySettings(stored?.[preferences.key]);
    });
  } catch { stopExtension(); return; }
  sendExtensionMessage({type: 'sch-cache-snapshot'}, (result, error) => {
    if (!error && result?.status === 'ok') Object.entries(result.records || {}).forEach(([url, record]) => {
      const previous = records.get(url);
      if (!detailProof.has(url) && typeof previous?.downloadBlocked !== 'boolean' &&
          (record.downloadBlocked || !settled(previous) || !previous.reasons.length && record.reasons.length)) records.set(url, record);
    });
    cacheLoaded = true;
    schedule();
    pump();
  });
  scan();
})();
