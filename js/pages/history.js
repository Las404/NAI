// 히스토리 페이지
import { $, h, toast, openLightbox } from '../ui.js';
import { state, save, on } from '../state.js';
import { MODELS } from '../nai.js';
import { mixLabel, cloneMix } from '../prompt.js';
import { history } from '../store.js';

const urls = new Map();
let filter = { fav: false, q: '' };

export function mount(el) {
  el.append(
    h('div', { class: 'toolbar' },
      h('input', { type: 'search', placeholder: '작가·프롬프트로 찾기', oninput: (e) => { filter.q = e.target.value.toLowerCase(); render(); } }),
      h('label', { class: 'inline' }, h('input', { type: 'checkbox', onchange: (e) => { filter.fav = e.target.checked; render(); } }), '즐겨찾기만'),
      h('span', { id: 'hCount', class: 'note' }),
      h('span', { class: 'sep' }),
      h('button', { class: 'ghost danger', onclick: clearAll }, '기록 전체 삭제')),
    h('div', { id: 'hGrid', class: 'grid' }),
  );
  on('generated', () => { if (location.hash.startsWith('#/history')) render(); });
}

export function show() { render(); }

async function clearAll() {
  if (!confirm('생성 기록을 전부 삭제할까요? 되돌릴 수 없어요. (즐겨찾기 포함)')) return;
  await history.clear();
  state.board.forEach((c) => delete c.historyId);
  save.board();
  render();
}

async function render() {
  let rows = await history.all();
  $('hCount').textContent = `${rows.length}장`;
  if (filter.fav) rows = rows.filter((r) => r.fav);
  if (filter.q) rows = rows.filter((r) => (mixLabel(r.mix) + ' ' + r.request.prompt).toLowerCase().includes(filter.q));
  const grid = $('hGrid');
  if (!rows.length) return grid.replaceChildren(h('div', { class: 'note' }, '기록이 없어요.'));
  grid.replaceChildren(...rows.map((r) => {
    if (!urls.has(r.id)) urls.set(r.id, URL.createObjectURL(r.blob));
    const url = urls.get(r.id);
    const cost = r.cost ? [r.cost.dPercent ? `배터리 -${r.cost.dPercent}%` : null, r.cost.dAnlas > 0 ? `Anlas -${r.cost.dAnlas}` : null].filter(Boolean).join(' · ') : '';
    return h('div', { class: 'card' },
      h('div', { class: 'thumb', onclick: () => openLightbox(url, `${mixLabel(r.mix)} · seed ${r.request.seed}\n${r.request.prompt}`) }, h('img', { src: url, alt: '', loading: 'lazy' })),
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
          h('button', { class: 'small ghost danger', onclick: async () => { await history.remove(r.id); URL.revokeObjectURL(url); urls.delete(r.id); render(); } }, '삭제'))));
  }));
}
