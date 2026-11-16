(() => {
  'use strict';
  const defaults = Object.freeze({defaultFilter: false, autoLoad: false});
  globalThis.SCHSettings = Object.freeze({
    // Start both options OFF once on this update, then retain subsequent choices.
    key: 'sch-settings-v2',
    normalize(value) {
      return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
        [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
    }
  });
})();
