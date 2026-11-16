'use strict';
const statusElement = document.getElementById('external-status'), choose = document.getElementById('choose-folder');
const permission = {permissions: ['downloads', 'webNavigation'], origins: ['https://*.sndcdn.com/*']};
function show(message, error = false) { statusElement.textContent = message; statusElement.classList.toggle('error', error); }
choose.addEventListener('click', async () => {
  choose.disabled = true;
  let markerName, folder, completed, downloadId;
  try {
    const relativePath = document.getElementById('relative-path').value.trim().replace(/\\/g, '/');
    if (!relativePath || relativePath.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*\x00-\x1f]/.test(part))) throw Error('ダウンロード先の中の専用フォルダー名を入力してください。');
    if (!await chrome.permissions.contains(permission)) {
      if (!await chrome.permissions.request(permission)) throw Error('ダウンロードの検知とタブの追跡への許可が必要です。');
      show('権限を許可しました。もう一度ボタンを押してフォルダーを選んでください。'); return;
    }
    folder = await showDirectoryPicker({id: 'sch-download-folder', mode: 'readwrite', startIn: 'downloads'});
    markerName = 'sch-folder-check-' + crypto.randomUUID() + '.txt';
    const token = crypto.randomUUID();
    show('保存フォルダーを確認しています…');
    const markerResult = await chrome.runtime.sendMessage({type: 'sch-external-folder-check', token, filename: relativePath + '/' + markerName});
    if (markerResult?.status !== 'ok') throw Error(markerResult?.message || '確認ファイルを保存できませんでした。');
    downloadId = markerResult.id;
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const [item] = await chrome.downloads.search({id: downloadId});
      if (item?.state === 'interrupted') throw Error('確認ファイルの保存が中断されました。\n理由：' + (item.error || '不明') + (item.filename ? '\n保存先：' + item.filename : ''));
      if (item?.state === 'complete') { completed = item; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!completed) throw Error('保存の確認がタイムアウトしました。');
    const fullPath = completed.filename.replace(/\\/g, '/'), absolutePath = fullPath.slice(0, fullPath.lastIndexOf('/'));
    if (!absolutePath.toLowerCase().endsWith('/' + relativePath.toLowerCase())) {
      throw Error('確認ファイルの保存先が指定どおりになりませんでした。\n指定：通常のダウンロード先/' + relativePath + '\n実際：' + absolutePath +
        '\n別の拡張機能の保存先指定と競合している可能性があります。\n拡張機能の管理画面で「SoundCloud 入手リンク強調」を最後に再読み込みし、この設定画面を開き直してください。\nその後も、選ぶのは ' + relativePath.split('/').at(-1) + ' フォルダーです。');
    }
    const expected = await folder.getFileHandle(fullPath.slice(fullPath.lastIndexOf('/') + 1)).catch(() => null);
    if (!expected || await (await expected.getFile()).text() !== token) throw Error('保存先と選択フォルダーが一致しませんでした。\n選ぶフォルダー：' + absolutePath + '\n今回選んだフォルダー名：' + folder.name);
    await SCHExternalFiles.set({handle: folder, relativePath, absolutePath});
    await chrome.storage.local.set({'sch-external-auto-v1': true, 'sch-external-setup-status-v1': {error: false, time: Date.now(), message: '設定完了', path: absolutePath}});
    show('設定完了・自動タグ付け：オン\n保存先：' + absolutePath + '\n次に、SoundCloudを再読み込みし、通常のDownloadボタン、または曲の外部配布リンクからダウンロードしてください。');
  } catch (error) {
    if (error.name !== 'AbortError') {
      const message = error.message || '設定できませんでした。'; show(message, true);
      await chrome.storage.local.set({'sch-external-setup-status-v1': {error: true, time: Date.now(), message}}).catch(() => {});
    }
  }
  finally {
    if (downloadId !== undefined) {
      if (!completed) await chrome.downloads.cancel(downloadId).catch(() => {});
      await chrome.downloads.removeFile(downloadId).catch(() => {});
      await chrome.downloads.erase({id: downloadId}).catch(() => {});
    }
    choose.disabled = false;
  }
});
document.getElementById('disable').addEventListener('click', async () => {
  await chrome.storage.local.set({'sch-external-auto-v1': false});
  show('自動タグ付けをオフにしました。');
});
Promise.all([chrome.storage.local.get(['sch-external-auto-v1', 'sch-external-status-v1']), SCHExternalFiles.get()]).then(([value, config]) => {
  if (config) document.getElementById('relative-path').value = config.relativePath;
  show((value['sch-external-auto-v1'] ? '自動タグ付け：オン' : '自動タグ付け：オフ') + (value['sch-external-status-v1'] ? '\n' + value['sch-external-status-v1'].message : ''));
});
