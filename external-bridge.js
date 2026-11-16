(() => {
  'use strict';
  function context(){return{page:location.origin+location.pathname,documentTitle:document.title,heading:document.querySelector('h1')?.textContent?.trim()||'',top:window===window.top,scripts:document.scripts.length,
    hydrationScripts:[...document.scripts].filter(script=>/__sc_hydration\s*=/.test(script.textContent||'')).length,iframes:document.querySelectorAll('iframe').length};}
  function debug(stage,info){try{const runtime=globalThis.chrome?.runtime;if(runtime?.id)runtime.sendMessage({type:'sch-native-debug',stage,info},()=>{void runtime.lastError;});}catch{/* An old tab is disconnected. */}}
  addEventListener('pointerdown',event=>{
    if(!event.isTrusted)return;
    const target=event.composedPath().find(node=>node instanceof Element);
    if(!target||target.closest('input,textarea,select,[contenteditable="true"]'))return;
    const control=target.closest('button,a,[role="button"],[role="menuitem"]')||target.closest('svg')||target;
    debug('page-input',{...context(),tag:control.tagName,class:control.getAttribute('class')||'',id:control.id||'',
      label:control.getAttribute('aria-label')||'',title:control.getAttribute('title')||'',
      text:control.matches('button,a,[role="button"],[role="menuitem"]')?(control.textContent||'').trim().slice(0,160):'',
      paths:[...control.querySelectorAll('svg path,path')].slice(0,4).map(node=>(node.getAttribute('d')||'').slice(0,350))});
  },true);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>debug('page-ready',context()),{once:true});else debug('page-ready',context());
  addEventListener('message', event => {
    if(event.source===window&&event.origin===location.origin&&event.data?.channel==='sch-native-debug-v1'&&['main-ready','api-request','download-response'].includes(event.data.stage)){
      debug(event.data.stage,{...event.data.info,page:location.origin+location.pathname});return;
    }
    if (event.source === window && event.origin === location.origin && event.data?.channel === 'sch-native-track-data-v1' && event.data.type === 'tracks' && Array.isArray(event.data.entries)) {
      try {
        const runtime = globalThis.chrome?.runtime;
        if (runtime?.id) runtime.sendMessage({type:'sch-native-catalog', context:context(),entries:event.data.entries.slice(0,100).map(entry => ({...entry,url:entry.permalink_url}))}, () => { void runtime.lastError; });
      } catch { /* Extension was reloaded. */ }
      return;
    }
    if (event.source !== window || event.origin !== location.origin || !['sch-external-link-v1', 'sch-native-file-v1'].includes(event.data?.channel)) return;
    if (event.data.type === 'snapshot') return;
    try {
      const runtime = globalThis.chrome?.runtime;
      if (!runtime?.id) return;
      runtime.sendMessage(event.data.channel === 'sch-native-file-v1' ? {type: 'sch-native-file', destination: event.data.destination, track: event.data.track} :
        event.data.type === 'native-click' ? {type: 'sch-native-click', track: event.data.track} :
        event.data.type === 'catalog' ? {type: 'sch-external-catalog', entries: event.data.entries} :
        {type: 'sch-external-link', destination: event.data.destination, track: event.data.track}, () => { void runtime.lastError; });
    } catch { /* An old tab after extension reload must remain usable. */ }
  });
  window.postMessage({channel: 'sch-external-link-v1', type: 'snapshot'}, location.origin);
})();
