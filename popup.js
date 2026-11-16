'use strict';
const preferences = globalThis.SCHSettings;
const filterToggle = document.getElementById('default-filter');
const loadToggle = document.getElementById('auto-load');
const settingsStatus = document.getElementById('settings-status');
let savedSettings = preferences.normalize();
function displaySettings() {
  filterToggle.checked = savedSettings.defaultFilter;
  loadToggle.checked = savedSettings.autoLoad;
}
function lockSettings(value) { filterToggle.disabled = value; loadToggle.disabled = value; }
async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(preferences.key);
    savedSettings = preferences.normalize(stored[preferences.key]);
    displaySettings();
    lockSettings(false);
  } catch {
    settingsStatus.textContent = '設定を読み込めませんでした。開き直してください。';
    settingsStatus.classList.add('error');
  }
}
async function saveSettings() {
  lockSettings(true);
  try {
    const next = {defaultFilter: filterToggle.checked, autoLoad: loadToggle.checked};
    await chrome.storage.local.set({[preferences.key]: next});
    savedSettings = next;
    settingsStatus.textContent = '保存しました';
    settingsStatus.classList.remove('error');
  } catch {
    displaySettings();
    settingsStatus.textContent = '保存できませんでした。もう一度切り替えてください。';
    settingsStatus.classList.add('error');
  } finally { lockSettings(false); }
}
filterToggle.addEventListener('change', saveSettings);
loadToggle.addEventListener('change', saveSettings);
loadSettings();
document.getElementById('external-setup').addEventListener('click', () => chrome.tabs.create({url: chrome.runtime.getURL('external-setup.html')}));
chrome.storage.local.get(['sch-external-auto-v1', 'sch-external-status-v1']).then(value => {
  const state = value['sch-external-status-v1'];
  document.getElementById('external-status').textContent = (value['sch-external-auto-v1'] ? '自動タグ付け：オン' : '自動タグ付け：オフ') + (state ? '\n' + state.message : '');
});
const status = document.getElementById('status');
const exportButton = document.getElementById('export');
const importInput = document.getElementById('import');
function show(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
function busy(value) { exportButton.disabled = value; importInput.disabled = value; }
async function send(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result || result.status !== 'ok') throw new Error(result?.message || 'データを読み込めませんでした。');
  return result;
}
exportButton.addEventListener('click', async () => {
  busy(true);
  show('書き出し中…');
  try {
    const {backup} = await send({type: 'sch-backup-export'});
    const blob = new Blob([JSON.stringify(backup, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'soundcloud-highlight-data-' + new Date().toISOString().slice(0, 10) + '.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const count = backup.cache.filter(entry => entry.result.status === 'ok').length;
    show(`${count}曲の判定を含むファイルを保存しました。別PCへこのファイルを移してください。`);
  } catch (error) { show(error.message, true); }
  finally { busy(false); }
});
importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  busy(true);
  show('読み込み中…');
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('書き出した判定データのJSONファイルを選んでください。');
    let backup;
    try { backup = JSON.parse(await file.text()); } catch { throw new Error('JSONファイルを読み込めませんでした。'); }
    const result = await send({type: 'sch-backup-import', backup});
    show(`${result.added}件を読み込みました。既存の${result.kept}件を保持、期限切れ${result.expired}件を除外。SoundCloudを再読み込みしてください。`);
  } catch (error) { show(error.message, true); }
  finally { busy(false); importInput.value = ''; }
});
