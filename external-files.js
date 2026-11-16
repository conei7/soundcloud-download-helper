(() => {
  'use strict';
  const database = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('sch-external-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('config');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  async function access(mode, value) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction('config', mode), store = transaction.objectStore('config');
        const request = mode === 'readonly' ? store.get('folder') : value === null ? store.delete('folder') : store.put(value, 'folder');
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || Error('保存できませんでした。'));
      });
    } finally { db.close(); }
  }
  const ROUTE = 'sch-external-folder-route-v1';
  let route, revision = 0;
  function cleanRoute(value) {
    const relativePath = value?.relativePath, absolutePath = value?.absolutePath;
    if (typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024 ||
        relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"\\|?*\x00-\x1f]/.test(part)) ||
        typeof absolutePath !== 'string' || !absolutePath || absolutePath.length > 4096) return null;
    return {relativePath, absolutePath};
  }
  async function publishRoute(value) {
    revision++; route = cleanRoute(value);
    if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({[ROUTE]: route});
  }
  const routeReady = (async () => {
    if (!globalThis.chrome?.storage?.local) return null;
    const initial = revision, saved = await chrome.storage.local.get(ROUTE);
    if (initial !== revision) return route;
    if (cleanRoute(saved[ROUTE])) route = cleanRoute(saved[ROUTE]);
    else {
      // Migrate the verified old folder in the background, before any download needs it.
      const config = await access('readonly');
      if (initial === revision) await publishRoute(config);
    }
    return route;
  })().catch(() => null);
  globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[ROUTE]) { revision++; route = cleanRoute(changes[ROUTE].newValue); }
  });
  const path = value => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  async function tagFile(config, item, track, artwork = null) {
    if (await config.handle.queryPermission({mode: 'readwrite'}) !== 'granted') throw Error('保存フォルダーへのアクセスを設定画面で再許可してください。');
    const fullPath = String(item.filename || '').replace(/\\/g, '/'), split = fullPath.lastIndexOf('/');
    if (path(fullPath.slice(0, split)) !== path(config.absolutePath)) throw Error('選択した保存フォルダー以外のため、通常保存のままにしました。');
    const filename = fullPath.slice(split + 1);
    const handle = await config.handle.getFileHandle(filename);
    const file = await handle.getFile();
    if (file.size > 512 * 1024 * 1024) throw Error('512MBを超えるため、通常保存のままにしました。');
    const start = Date.parse(item.startTime), end = Date.parse(item.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || file.lastModified < start - 2000 || file.lastModified > end + 10000 ||
        item.fileSize >= 0 && file.size !== item.fileSize) throw Error('保存したファイルと一致しないため、書き込みませんでした。');
    const original = await file.arrayBuffer(), type = globalThis.SCHZipTags?.isZip(original) ? 'zip' : SCHAudioTags.format(original);
    if (!['mp3', 'wav', 'flac', 'zip'].includes(type)) throw Error('この形式は自動タグ付けの対象外です。');
    let warning = '', coverPromise;
    const getArtwork = () => coverPromise ||= (async () => {
      if (track.artwork_url && artwork) try { return await artwork(track.artwork_url); }
      catch { warning = '（ジャケットは取得できませんでした）'; }
      return null;
    })();
    const fields = {title: track.title, artist: track.artist || '', album: track.title,
      genre: track.genre || '', year: track.year || '', bpm: track.bpm || '', url: track.url};
    const archive = type === 'zip' ? await SCHZipTags.write(original, fields, getArtwork) : null;
    const output = archive ? archive.output : SCHAudioTags.write(original, fields, !SCHAudioTags.hasArtwork(original, type) ? await getArtwork() : null, type);
    // Recheck after asynchronous artwork fetching. createWritable commits atomically on close.
    const latest = await handle.getFile();
    if (latest.size !== file.size || latest.lastModified !== file.lastModified) throw Error('ファイルが変更されたため、書き込みませんでした。');
    const writer = await handle.createWritable({keepExistingData: false});
    try { await writer.write(output); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
    return {filename, warning, ...(archive ? {audioCount: archive.count} : {})};
  }
  globalThis.SCHExternalFiles = Object.freeze({get: () => access('readonly'),
    async set(value) { await access('readwrite', value); await publishRoute(value); },
    routing: async () => { if (route === undefined) await routeReady; return route ? {...route} : null; }, tagFile});
})();
