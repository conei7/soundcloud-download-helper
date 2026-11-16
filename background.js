'use strict';
importScripts('metadata.js');
importScripts('audio-tags.js', 'zip-tags.js', 'external-files.js', 'external-downloads.js');
const STORAGE_KEY = 'sch-inspections-v18';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const ERROR_TTL = 10 * 60 * 1000;
const INTERVAL = 4000;
const HOURLY_LIMIT = 60;
const pending = new Map();
let serial = Promise.resolve();
let state;
const ready = chrome.storage.local.get(STORAGE_KEY).then(saved => {
  state = saved[STORAGE_KEY] || {};
  state.cache ||= {};
  state.windowStart ||= Date.now();
  state.count ||= 0;
  state.lastStart ||= 0;
  state.cooldownUntil ||= 0;
});
async function save() {
  const now = Date.now();
  Object.keys(state.cache).forEach(url => { if (state.cache[url].expires <= now) delete state.cache[url]; });
  const keys = Object.keys(state.cache);
  while (keys.length > 1000) delete state.cache[keys.shift()];
  await chrome.storage.local.set({[STORAGE_KEY]: state});
}
async function inspect(url) {
  await ready;
  let now = Date.now();
  const cached = state.cache[url];
  if (cached?.expires > now) return cached.result.status === 'error' ?
    {...cached.result, nextAt: cached.expires} : cached.result;
  if (now - state.windowStart >= 60 * 60 * 1000) { state.windowStart = now; state.count = 0; }
  if (state.cooldownUntil > now) return {status: 'deferred', nextAt: state.cooldownUntil};
  if (state.count >= HOURLY_LIMIT) return {status: 'deferred', nextAt: state.windowStart + 60 * 60 * 1000};
  const delay = state.lastStart + INTERVAL - now;
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  state.lastStart = Date.now();
  state.count++;
  // Persist the rate budget before fetching, so worker restarts cannot reset it.
  await save();
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 10000);
  let result;
  try {
    const response = await fetch(url, {credentials: 'omit', signal: abort.signal});
    if (response.status === 429 || response.status === 403) {
      const retrySeconds = Number(response.headers.get('Retry-After'));
      state.cooldownUntil = Date.now() + Math.max(30 * 60 * 1000, Number.isFinite(retrySeconds) ? retrySeconds * 1000 : 0);
      result = {status: 'deferred', nextAt: state.cooldownUntil};
    } else if (!response.ok) {
      result = {status: 'error'};
    } else {
      const data = SCHMetadata.read(await response.text()).get(url);
      result = data && (data.complete || data.reasons.length || data.downloadBlocked) ?
        {status: 'ok', reasons: data.reasons, complete: data.complete, ...SCHMetadata.downloadState(data)} : {status: 'error'};
    }
  } catch { result = {status: 'error'}; }
  finally { clearTimeout(timeout); }
  const expires = result.status === 'ok' ? Date.now() + CACHE_TTL : result.nextAt || Date.now() + ERROR_TTL;
  state.cache[url] = {expires, result};
  await save();
  return result.status === 'error' ? {...result, nextAt: expires} : result;
}

function exportBackup() {
  const now = Date.now();
  return {format: 'soundcloud-highlight-backup', version: 1, exportedAt: now,
    cache: Object.entries(state.cache).filter(([, entry]) => entry.expires > now)
      .map(([url, entry]) => ({url, expires: entry.expires, result: {...entry.result}})),
    limits: {windowStart: state.windowStart, count: state.count,
      lastStart: state.lastStart, cooldownUntil: state.cooldownUntil}};
}
function validateBackup(backup) {
  if (!backup || backup.format !== 'soundcloud-highlight-backup' || backup.version !== 1 ||
      !Array.isArray(backup.cache) || backup.cache.length > 1000) throw new Error('この拡張機能の書き出しファイルを選んでください。');
  const now = Date.now(), cache = {}, seen = new Set();
  let expired = 0;
  backup.cache.forEach(entry => {
    const url = entry && SCHMetadata.canonical(entry.url);
    const result = entry?.result;
    if (!url || url !== entry.url || seen.has(url) || !Number.isFinite(entry.expires) ||
        !result || !['ok', 'error', 'deferred'].includes(result.status)) throw new Error('判定データの形式が正しくありません。');
    seen.add(url);
    let cleaned;
    if (result.status === 'ok') {
      if (!Array.isArray(result.reasons) || result.reasons.length > 8 ||
          result.reasons.some(reason => typeof reason !== 'string' || reason.length > 80) ||
          result.complete !== undefined && typeof result.complete !== 'boolean' ||
          result.downloadBlocked !== undefined && typeof result.downloadBlocked !== 'boolean') throw new Error('判定理由の形式が正しくありません。');
      cleaned = {status: 'ok', reasons: [...result.reasons], complete: result.complete !== false, ...SCHMetadata.downloadState(result)};
      // Import keeps the original lifetime; it does not turn stale results into fresh ones.
      if (entry.expires > now + CACHE_TTL + 5 * 60 * 1000) throw new Error('有効期限を確認できません。PCの時刻を確認してください。');
    } else if (result.status === 'deferred') {
      if (!Number.isFinite(result.nextAt)) throw new Error('通信待機の形式が正しくありません。');
      cleaned = {status: 'deferred', nextAt: result.nextAt};
    } else cleaned = {status: 'error'};
    if (entry.expires <= now) expired++;
    else cache[url] = {expires: entry.expires, result: cleaned};
  });
  const limits = backup.limits;
  if (!limits || !Number.isFinite(limits.windowStart) || !Number.isInteger(limits.count) ||
      limits.count < 0 || limits.count > HOURLY_LIMIT || !Number.isFinite(limits.lastStart) ||
      !Number.isFinite(limits.cooldownUntil) || limits.windowStart > now + 5 * 60 * 1000 ||
      limits.lastStart > now + 5 * 60 * 1000) throw new Error('通信制限の形式が正しくありません。');
  return {cache, limits, expired};
}
async function importBackup(backup) {
  const imported = validateBackup(backup);
  const now = Date.now();
  let added = 0, kept = 0;
  Object.entries(imported.cache).forEach(([url, entry]) => {
    const existing = state.cache[url];
    if (existing?.expires > now && (existing.result.status === 'ok' && entry.result.status !== 'ok' ||
        existing.result.downloadBlocked && entry.result.downloadBlocked === undefined ||
        existing.result.status === entry.result.status && existing.expires >= entry.expires)) { kept++; return; }
    state.cache[url] = entry;
    added++;
  });
  const currentWindow = now - state.windowStart < 60 * 60 * 1000;
  const importedWindow = now - imported.limits.windowStart < 60 * 60 * 1000;
  state.count = Math.max(currentWindow ? state.count : 0, importedWindow ? imported.limits.count : 0);
  state.windowStart = currentWindow || importedWindow ?
    Math.max(currentWindow ? state.windowStart : 0, importedWindow ? imported.limits.windowStart : 0) : now;
  state.lastStart = Math.max(state.lastStart, imported.limits.lastStart);
  state.cooldownUntil = Math.max(state.cooldownUntil, imported.limits.cooldownUntil);
  await save();
  return {status: 'ok', added, kept, expired: imported.expired};
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (['sch-backup-export', 'sch-backup-import'].includes(message?.type)) {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) {
      reply({status: 'error', message: '移行画面から操作してください。'});
      return;
    }
    const job = serial.then(async () => {
      await ready;
      return message.type === 'sch-backup-export' ? {status: 'ok', backup: exportBackup()} : importBackup(message.backup);
    });
    serial = job.catch(() => {});
    job.then(reply, error => reply({status: 'error', message: error.message || 'データを保存できませんでした。'}));
    return true;
  }
  if (!['sch-track-info', 'sch-cache-snapshot', 'sch-observed-info'].includes(message?.type)) return;
  let allowed = false;
  try { allowed = ['soundcloud.com', 'www.soundcloud.com'].includes(new URL(sender.url).hostname); } catch { /* Invalid sender. */ }
  if (!sender.tab || !allowed) { reply({status: 'error'}); return; }
  if (message.type === 'sch-observed-info') {
    const entries = message.entries;
    if (message.source !== undefined && (typeof message.source !== 'string' || message.source.length > 80) ||
      !Array.isArray(entries) || entries.length > 100 || entries.some(entry =>
      !entry || !SCHMetadata.canonical(entry.url) || SCHMetadata.canonical(entry.url) !== entry.url || !Array.isArray(entry.reasons) ||
      entry.reasons.length > 8 || entry.reasons.some(reason => typeof reason !== 'string' || reason.length > 80) ||
      typeof entry.complete !== 'boolean' || entry.downloadBlocked !== undefined && typeof entry.downloadBlocked !== 'boolean' ||
      !entry.complete && !entry.reasons.length && !entry.downloadBlocked)) {
      reply({status: 'error'});
      return;
    }
    const job = serial.then(async () => {
      await ready;
      entries.forEach(entry => {
        const existing = state.cache[entry.url];
        // Older tabs/backups without download-state information cannot undo a known limit.
        if (existing?.expires > Date.now() && existing.result.downloadBlocked && entry.downloadBlocked === undefined) return;
        state.cache[entry.url] = {expires: Date.now() + CACHE_TTL, source: message.source,
          result: {status: 'ok', reasons: [...entry.reasons], complete: entry.complete, ...SCHMetadata.downloadState(entry)}};
      });
      await save();
      return {status: 'ok'};
    });
    serial = job.catch(() => {});
    job.then(reply, () => reply({status: 'error'}));
    return true;
  }
  if (message.type === 'sch-cache-snapshot') {
    ready.then(() => {
      const records = {};
      Object.entries(state.cache).forEach(([url, entry]) => {
        if (entry.expires > Date.now() && entry.result.status === 'ok') records[url] = {
          reasons: entry.result.reasons, complete: entry.result.complete !== false, ...SCHMetadata.downloadState(entry.result)};
      });
      reply({status: 'ok', records});
    }, () => reply({status: 'error'}));
    return true;
  }
  const url = SCHMetadata.canonical(message.url);
  if (!url) { reply({status: 'error'}); return; }
  if (!pending.has(url)) {
    const job = serial.then(() => inspect(url));
    serial = job.catch(() => {});
    pending.set(url, job);
    job.finally(() => pending.delete(url)).catch(() => {});
  }
  pending.get(url).then(reply, () => reply({status: 'error'}));
  return true;
});
