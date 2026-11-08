// 생성 이미지 지우기 (히스토리 + 보드 연결 + 선택적으로 자동저장 파일)
import { h } from './ui.js';
import { history } from './store.js';
import { state, save, emit } from './state.js';
import { removeSavedFiles, hasSavedFiles } from './autosave.js';

// 확인 창: 반환 { ok, files }
function confirmDelete(items, title) {
  return new Promise((resolve) => {
    const withFiles = hasSavedFiles(items);
    const favs = items.filter((i) => i.fav).length;
    const cb = h('input', { type: 'checkbox', checked: true });
    const dlg = h('dialog', {},
      h('h3', {}, title || `이미지 ${items.length}장을 지울까요?`),
      h('p', { class: 'note' }, '사이트 히스토리에서 지워지고 되돌릴 수 없어요.', favs ? ` (즐겨찾기 ${favs}장 포함)` : ''),
      withFiles ? h('label', { class: 'inline' }, cb, '자동저장 폴더에 저장된 PNG 파일도 같이 지우기') : h('p', { class: 'note' }, '다운로드 폴더로 받은 파일은 지워지지 않아요.'),
      h('div', { class: 'row-gap end' },
        h('button', { class: 'ghost', onclick: () => { dlg.close(); resolve({ ok: false }); } }, '취소'),
        h('button', { class: 'primary danger-fill', onclick: () => { dlg.close(); resolve({ ok: true, files: withFiles && cb.checked }); } }, `${items.length}장 지우기`)));
    dlg.addEventListener('cancel', () => resolve({ ok: false }));
    dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
    document.body.append(dlg);
    dlg.showModal();
  });
}

// items: 히스토리 항목 배열. 반환: 지운 개수 (취소하면 0)
export async function deleteItems(items, { title, skipConfirm = false } = {}) {
  if (!items.length) return 0;
  let files = false;
  if (!skipConfirm) {
    const r = await confirmDelete(items, title);
    if (!r.ok) return 0;
    files = r.files;
  }
  let fileMsg = '';
  if (files) {
    try { fileMsg = ` · 파일 ${await removeSavedFiles(items)}개 삭제`; } catch (e) { fileMsg = ` · ${e.message}`; }
  }
  const ids = new Set(items.map((i) => i.id));
  for (const id of ids) await history.remove(id);
  let boardChanged = false;
  for (const c of state.board) if (ids.has(c.historyId)) { delete c.historyId; boardChanged = true; }
  if (boardChanged) save.board();
  emit('deleted', { ids, message: `${ids.size}장 지웠어요${fileMsg}` });
  return ids.size;
}
