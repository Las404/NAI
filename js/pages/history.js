// 히스토리 페이지 (검색·즐겨찾기·여러 장 골라서 지우기)
import { $, h, toast, openLightbox } from '../ui.js';
import { state, save, on } from '../state.js';
import { MODELS } from '../nai.js';
import { mixLabel, cloneMix } from '../prompt.js';
import { history } from '../store.js';
import { deleteItems } from '../remove.js';

const urls = new Map();
const filter = { fav: false, q: '' };
const selected = new Set();
let rows = [];   // 화면에 보이는 항목
let allRows = [];

export function mount(el) {
  el.append(
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: '작가·프롬프트·씬 이름으로 찾기', oninput: (e) => { filter.q = e.target.value.toLowerCase(); render(); } }),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', onchange: (e) => { filter.fav = e.target.checked; render(); } }), '즐겨찾기만'),
      h('span', { id: 'hCount', class: 'note' })),
    h('div', { class: 'toolbar' },
      h('button', { class: 'ghost small', onclick: () => { rows.forEach((r) => selected.add(r.id)); paintSel(); } }, '보이는 것 모두 선택'),
      h('button', { class: 'ghost small', onclick: () => { selected.clear(); paintSel(); } }, '선택 해제'),
      h('button', { id: 'hDelSel', class: 'small danger', onclick: delSelected }, '🗑 선택 삭제'),
      h('span', { class: 'sep' }),
      h('button', { class: 'ghost small danger', onclick: delNonFav }, '🗑 즐겨찾기 아닌 것 모두 삭제'),
      h('button', { class: 'ghost small danger', onclick: () => deleteItems(allRows, { title: `생성 기록 ${allRows.length}장을 전부 지울까요?` }) }, '🗑 전체 삭제'),
      h('span', { class: 'note' }, '카드를 Ctrl+클릭하거나 ☐를 눌러 여러 장을 고를 수 있어요.')),
    h('div', { id: 'hGrid', class: 'grid' }),
  );
  on('generated', () => { if (location.hash.startsWith('#/history')) render(); });
  on('deleted', ({ ids }) => {
    for (const id of ids) { selected.delete(id); if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } }
    if (location.hash.startsWith('#/history')) render();
  });
}

export function show() { render(); }

function delSelected() {
  const items = allRows.filter((r) => selected.has(r.id));
  if (!items.length) return toast('선택한 이미지가 없어요');
  deleteItems(items);
}

function delNonFav() {
  const items = allRows.filter((r) => !r.fav);
  if (!items.length) return toast('지울 이미지가 없어요 (모두 즐겨찾기)');
  deleteItems(items, { title: `즐겨찾기 아닌 ${items.length}장을 지울까요?` });
}

function paintSel() {
  document.querySelectorAll('#hGrid .card').forEach((c) => {
    const on = selected.has(Number(c.dataset.id));
    c.classList.toggle('selected', on);
    c.querySelector('.sel-box').textContent = on ? '☑' : '☐';
  });
  $('hDelSel').textContent = selected.size ? `🗑 선택 ${selected.size}장 삭제` : '🗑 선택 삭제';
  $('hDelSel').disabled = !selected.size;
}

function toggleSel(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  paintSel();
}

async function render() {
  allRows = await history.all();
  rows = allRows;
  $('hCount').textContent = `${allRows.length}장`;
  if (filter.fav) rows = rows.filter((r) => r.fav);
  if (filter.q) rows = rows.filter((r) => (mixLabel(r.mix) + ' ' + r.request.prompt + ' ' + (r.sceneName || '')).toLowerCase().includes(filter.q));
  const grid = $('hGrid');
  if (!rows.length) { grid.replaceChildren(h('div', { class: 'note' }, '기록이 없어요.')); paintSel(); return; }
  grid.replaceChildren(...rows.map((r) => {
    if (!urls.has(r.id)) urls.set(r.id, URL.createObjectURL(r.blob));
    const url = urls.get(r.id);
    const cost = r.cost ? [r.cost.dPercent ? `배터리 -${r.cost.dPercent}%` : null, r.cost.dAnlas > 0 ? `Anlas -${r.cost.dAnlas}` : null].filter(Boolean).join(' · ') : '';
    return h('div', { class: 'card', 'data-id': r.id },
      h('div', { class: 'thumb', onclick: (e) => {
        if (e.ctrlKey || e.metaKey || selected.size) return toggleSel(r.id);
        openLightbox(url, `${mixLabel(r.mix)} · seed ${r.request.seed}\n${r.request.prompt}`);
      } },
        h('img', { src: url, alt: '', loading: 'lazy' }),
        h('button', { class: 'sel-box', title: '선택', onclick: (e) => { e.stopPropagation(); toggleSel(r.id); } }, '☐'),
        r.sceneName ? h('span', { class: 'scene-tag' }, '🎬 ' + r.sceneName) : null),
      h('div', { class: 'meta' },
        h('div', { class: 'sub' }, new Date(r.time).toLocaleString('ko-KR'), ` · ${MODELS[r.request.model]?.label || r.request.model}`),
        h('div', { class: 'title' }, mixLabel(r.mix)),
        h('div', { class: 'sub' }, `seed ${r.request.seed} · ${r.request.steps}스텝 · CFG ${r.request.scale}${cost ? ' · ' + cost : ''}`),
        h('div', { class: 'actions' },
          h('button', { class: 'small ghost' + (r.fav ? ' fav-on' : ''), title: '즐겨찾기', onclick: async () => { r.fav = !r.fav; await history.put(r); render(); } }, r.fav ? '★' : '☆'),
          h('button', { class: 'small ghost', onclick: () => {
            state.mix = cloneMix(r.mix);
            Object.assign(state.settings, JSON.parse(JSON.stringify(r.settings)), { seed: r.request.seed });
            save.mix(); save.settings();
            toast('불러왔어요. 생성 페이지에서 확인하세요');
          } }, '불러오기'),
          h('a', { class: 'btn small ghost', href: url, download: `nai_${r.id}_${r.request.seed}.png` }, '저장'),
          h('button', { class: 'small ghost danger', title: '지우기', onclick: () => deleteItems([r]) }, '🗑'))));
  }));
  paintSel();
}
