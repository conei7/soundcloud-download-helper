(() => {
  'use strict';
  let lastPublished = 0;
  function publish(force = false) {
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id) return;
      if (!force && Date.now() - lastPublished < 60000) return;
      lastPublished = Date.now();
      // Parse public inline data in the isolated world; never execute page JavaScript.
      const records = [...SCHMetadata.readFiles([...document.scripts].map(script => script.textContent || '').join('\n')).values()];
      const context={page:location.origin+location.pathname,documentTitle:document.title,heading:document.querySelector('h1')?.textContent?.trim()||'',top:window===window.top,scripts:document.scripts.length,
        hydrationScripts:[...document.scripts].filter(script=>/__sc_hydration\s*=/.test(script.textContent||'')).length,iframes:document.querySelectorAll('iframe').length,records:records.length};
      // Send empty batches too: zero records is useful evidence, not a positive match.
      for (let i = 0; i < Math.max(records.length,1); i += 100) runtime.sendMessage({type: 'sch-native-catalog', initial: true,context, entries: records.slice(i, i + 100)}, () => { void runtime.lastError; });
      window.postMessage({channel: 'sch-native-track-data-v1', type: 'snapshot'}, location.origin);
    } catch { /* Old tabs after an extension reload must remain usable. */ }
  }
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes['sch-external-auto-v1']?.newValue === true) publish(true); });
  addEventListener('focus', () => publish());
  addEventListener('pointerdown', event => { if (event.isTrusted) publish(); }, true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) publish(); });
  publish(true);
})();
