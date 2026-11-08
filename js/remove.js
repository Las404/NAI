// 생성 이미지 지우기 (히스토리 + 보드 연결 + 자동저장 폴더의 PNG 파일)
import { h } from './ui.js';
import { history, local } from './store.js';
import { state, save, emit } from './state.js';
import { removeSavedFiles, hasSavedFiles } from './autosave.js';

// 확인 없이 바로 지우기 (컴퓨터 파일 포함). 히스토리 페이지에서 다시 켤 수 있음
export const quickDelete = {
  get on() { return local.get('quickDelete', false); },
  set on(v) { local.set('quickDelete', !!v); emit('quickDelete'); },
};

// 확인 창: 반환 { ok, files }
function confirmDelete(items, title) {
  return new Promise((resolve) => {
    const withFiles = hasSavedFiles(items);
    const favs = items.filter((i) => i.fav).length;
    const filesCb = h('input', { type: 'checkbox', checked: local.get('deleteFiles', true) });
    const quickCb = h('input', { type: 'checkbox' });
    const ok = h('button', { class: 'primary danger-fill' }, `${items.length}장 지우기`);
    const dlg = h('dialog', {},
      h('h3', {}, title || `이미지 ${items.length}장을 지울까요?`),
      h('p', { class: 'note' }, '사이트 히스토리에서 지워지고 되돌릴 수 없어요.', favs ? ` (즐겨찾기 ${favs}장 포함)` : ''),
      withFiles
        ? h('label', { class: 'inline' }, filesCb, '컴퓨터의 자동저장 폴더에 있는 PNG 파일도 같이 지우기')
        : h('p', { class: 'note' }, '컴퓨터에 저장된 파일이 없어요 (자동저장을 "폴더에 바로 저장"으로 켜면, 지울 때 파일도 같이 지워져요).'),
      h('label', { class: 'inline', style: { marginTop: '8px' } }, quickCb, '다음부터 묻지 않고 바로 지우기 (파일 포함)'),
      h('div', { class: 'row-gap end' },
        h('button', { class: 'ghost', onclick: () => { dlg.close(); resolve({ ok: false }); } }, '취소'),
        ok));
    ok.addEventListener('click', () => {
      local.set('deleteFiles', filesCb.checked);
      if (quickCb.checked) quickDelete.on = true;
      dlg.close();
      resolve({ ok: true, files: withFiles && filesCb.checked });
    });
    dlg.addEventListener('cancel', () => resolve({ ok: false }));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    dlg.showModal();
    ok.focus();
  });
}

// items: 히스토리 항목 배열. 반환: 지운 개수 (취소하면 0)
// 여러 장을 한꺼번에 지울 때는 바로 지우기 설정이어도 확인을 받음
export async function deleteItems(items, { title } = {}) {
  if (!items.length) return 0;
  let files;
  if (quickDelete.on && items.length === 1) {
    files = hasSavedFiles(items);
  } else {
    const r = await confirmDelete(items, title);
    if (!r.ok) return 0;
    files = r.files;
  }
  let fileMsg = '';
  if (files) {
    try { fileMsg = ` · 컴퓨터 파일 ${await removeSavedFiles(items)}개 삭제`; } catch (e) { fileMsg = ` · ${e.message}`; }
  }
  const ids = new Set(items.map((i) => i.id));
  for (const id of ids) await history.remove(id);
  let boardChanged = false;
  for (const c of state.board) if (ids.has(c.historyId)) { delete c.historyId; boardChanged = true; }
  if (boardChanged) save.board();
  emit('deleted', { ids, message: `${ids.size}장 지웠어요${fileMsg}` });
  return ids.size;
}
