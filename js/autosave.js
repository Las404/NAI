// 생성 이미지 자동저장
//  - folder: 고른 폴더에 바로 저장 (File System Access API, Chrome·Edge)
//  - download: 브라우저 다운로드 폴더로 자동 다운로드 (모든 브라우저)
import { local } from './store.js';
import { mixLabel } from './prompt.js';
import { emit } from './state.js';

export const supportsFolder = typeof window.showDirectoryPicker === 'function';

export const autosave = {
  get mode() { return local.get('autosaveMode', 'off'); },
  set mode(v) { local.set('autosaveMode', v); emit('autosave'); },
  get byDate() { return local.get('autosaveByDate', true); },
  set byDate(v) { local.set('autosaveByDate', !!v); emit('autosave'); },
  get folderName() { return local.get('autosaveFolderName', ''); },
};

// 폴더 핸들은 IndexedDB에 보관 (localStorage엔 못 넣음)
function kv(mode, fn) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('geukkak-fs', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', mode);
      const r = fn(tx.objectStore('kv'));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
const getDir = () => kv('readonly', (s) => s.get('dir'));

export async function chooseFolder() {
  const dir = await window.showDirectoryPicker({ id: 'nai-autosave', mode: 'readwrite', startIn: 'pictures' });
  await kv('readwrite', (s) => s.put(dir, 'dir'));
  local.set('autosaveFolderName', dir.name);
  autosave.mode = 'folder';
  return dir.name;
}

// 버튼 클릭 직후(사용자 동작 안에서) 불러야 권한 창을 띄울 수 있음
let ready = null;
export async function prepareAutosave() {
  ready = null;
  if (autosave.mode !== 'folder') return;
  try {
    const dir = await getDir();
    if (!dir) return;
    let p = await dir.queryPermission({ mode: 'readwrite' });
    if (p !== 'granted') p = await dir.requestPermission({ mode: 'readwrite' });
    if (p === 'granted') ready = dir;
  } catch {
    ready = null;
  }
}

const pad = (n) => String(n).padStart(2, '0');
export function fileName(item) {
  const d = new Date(item.time);
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const who = mixLabel(item.mix).replace(/\(작가 없음\)/, 'noartist').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s*\+\s*/g, '+').replace(/\s+/g, ' ').slice(0, 80).trim();
  return `${stamp}_${item.request.seed}_${who}.png`;
}

function dateFolder(item) {
  const d = new Date(item.time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 자동저장 폴더에 저장된 파일 지우기 (폴더 저장으로 저장된 것만). 반환: 지운 개수
export async function removeSavedFiles(items) {
  const targets = items.filter((it) => Array.isArray(it.savedRel));
  if (!targets.length) return 0;
  const dir = await getDir();
  if (!dir) return 0;
  let p = await dir.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted') p = await dir.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('저장 폴더 권한이 없어서 파일은 지우지 못했어요');
  let n = 0;
  for (const it of targets) {
    try {
      let d = dir;
      const parts = it.savedRel.slice();
      const name = parts.pop();
      for (const sub of parts) d = await d.getDirectoryHandle(sub);
      await d.removeEntry(name);
      n++;
    } catch { /* 이미 없거나 옮겨진 파일 */ }
  }
  return n;
}

export const hasSavedFiles = (items) => items.some((it) => Array.isArray(it.savedRel));

// 반환: 저장된 경로 문자열 또는 null
export async function saveImage(item) {
  const mode = autosave.mode;
  if (mode === 'off') return null;
  const safeScene = item.sceneName ? item.sceneName.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 60) || 'scene' : null;
  const name = (mode === 'download' && safeScene ? `${safeScene}_` : '') + fileName(item);
  if (mode === 'folder') {
    if (!ready) throw new Error('저장 폴더 권한이 없어요. 자동저장 설정에서 폴더를 다시 골라주세요');
    let dir = ready;
    let path = name;
    if (safeScene) {
      // 씬 모드: 저장 폴더/씬/씬 이름/파일
      dir = await (await dir.getDirectoryHandle('씬', { create: true })).getDirectoryHandle(safeScene, { create: true });
      path = `씬/${safeScene}/${name}`;
    } else if (autosave.byDate) {
      const sub = dateFolder(item);
      dir = await dir.getDirectoryHandle(sub, { create: true });
      path = `${sub}/${name}`;
    }
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(item.blob);
    await w.close();
    item.savedRel = path.split('/'); // 나중에 파일까지 지울 때 사용
    return `${autosave.folderName}/${path}`;
  }
  // download
  const url = URL.createObjectURL(item.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return `다운로드/${name}`;
}
