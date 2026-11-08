// 작가 찾기 페이지
import { $, h, toast, openLightbox, debounce } from '../ui.js';
import { state, on, addToMix, toggleMark } from '../state.js';
import { GALLERIES, imageUrl, loadArtists, queryArtists } from '../artists.js';
import { mixBar } from '../mixbar.js';

const PAGE = 48;
const b = { q: '', gallery: 'loose', sort: 'score', minVotes: 0, mark: 'all', page: 0, shuffled: null };
let list = [];

export function mount(el) {
  el.append(
    mixBar(),
    h('div', { class: 'toolbar' },
      h('input', { id: 'aQ', type: 'search', placeholder: '작가 태그 검색 (예: ningen mame)', autocomplete: 'off' }),
      h('select', { id: 'aGallery' }, Object.entries(GALLERIES).map(([k, g]) => h('option', { value: k }, g.label))),
      h('select', { id: 'aSort' },
        h('option', { value: 'score' }, '추천순 (투표 신뢰도)'),
        h('option', { value: 'up' }, '좋아요 많은 순'),
        h('option', { value: 'debated' }, '호불호 갈리는 순'),
        h('option', { value: 'name' }, '이름순')),
      h('div', { class: 'seg', id: 'aMark' },
        h('button', { 'data-v': 'all', class: 'on' }, '전체'),
        h('button', { 'data-v': 'fav' }, '⭐ 즐겨찾기'),
        h('button', { 'data-v': 'hidden' }, '🚫 숨김')),
      h('label', { class: 'inline' }, '최소 투표', h('input', { id: 'aMin', type: 'number', min: 0, value: 0, style: { width: '4.5em' } })),
      h('button', { class: 'ghost', onclick: shuffle }, '🎲 랜덤')),
    h('p', { id: 'aNote', class: 'note' }),
    h('div', { id: 'aInfo', class: 'note' }),
    h('div', { id: 'aGrid', class: 'grid' }, h('div', { class: 'note' }, '작가 데이터 불러오는 중…')),
    h('div', { id: 'aPager', class: 'pager' }),
  );
  const reset = () => { b.page = 0; b.shuffled = null; render(); };
  $('aQ').addEventListener('input', debounce(() => { b.q = $('aQ').value; reset(); }, 200));
  $('aGallery').addEventListener('change', () => { b.gallery = $('aGallery').value; reset(); });
  $('aSort').addEventListener('change', () => { b.sort = $('aSort').value; reset(); });
  $('aMin').addEventListener('change', () => { b.minVotes = Number($('aMin').value) || 0; reset(); });
  $('aMark').addEventListener('click', (e) => {
    const v = e.target.dataset?.v;
    if (!v) return;
    b.mark = v;
    [...$('aMark').children].forEach((x) => x.classList.toggle('on', x.dataset.v === v));
    reset();
  });
  on('mix', markCards);
  on('marks', () => { if (b.mark !== 'all') render(); else markCards(); });
  loadArtists().then((l) => { list = l; render(); });
}

export function show() { if (list.length) markCards(); }

function query() {
  return queryArtists(list, { ...b, favorites: state.favorites, hidden: state.hidden });
}

function shuffle() {
  const l = query();
  for (let i = l.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [l[i], l[j]] = [l[j], l[i]]; }
  b.shuffled = l; b.page = 0; render();
}

function render() {
  $('aNote').textContent = `샘플 조건: ${GALLERIES[b.gallery].note}`;
  const l = b.shuffled || query();
  const pages = Math.max(1, Math.ceil(l.length / PAGE));
  b.page = Math.min(b.page, pages - 1);
  $('aInfo').textContent = `${l.length.toLocaleString()}명${b.shuffled ? ' (랜덤 순서)' : ''}${b.mark === 'all' && state.hidden.size ? ` · 숨긴 작가 ${state.hidden.size}명 제외` : ''}`;
  const grid = $('aGrid');
  grid.replaceChildren();
  if (!l.length) grid.append(h('div', { class: 'note' }, b.mark === 'fav' ? '즐겨찾기한 작가가 없어요. 카드의 ☆를 눌러 추가하세요.' : '결과가 없어요.'));
  for (const a of l.slice(b.page * PAGE, (b.page + 1) * PAGE)) grid.append(card(a));
  markCards();
  pager(pages);
}

function card(a) {
  const v = a.g[b.gallery];
  const src = imageUrl(a.tag, b.gallery);
  return h('div', { class: 'card', 'data-tag': a.tag },
    h('div', { class: 'thumb', onclick: () => openLightbox(src, `artist:${a.tag}`) },
      h('img', { src, alt: a.tag, loading: 'lazy' }),
      h('div', { class: 'thumb-marks' },
        h('button', { class: 'mark fav', title: '즐겨찾기', onclick: (e) => { e.stopPropagation(); toggleMark('favorites', a.tag); } }, '☆'),
        h('button', { class: 'mark hide', title: '숨기기 (랜덤·추천에서 제외)', onclick: (e) => { e.stopPropagation(); toggleMark('hidden', a.tag); } }, '🚫'))),
    h('div', { class: 'meta' },
      h('div', { class: 'title' }, a.tag),
      h('div', { class: 'votes' }, h('span', { class: 'u' }, `👍 ${v.up}`), ' ', h('span', { class: 'd' }, `👎 ${v.down}`)),
      h('div', { class: 'actions' },
        h('button', { class: 'small add', onclick: () => { if (addToMix(a.tag)) toast(`믹스에 추가: ${a.tag}`); else toast('이미 믹스에 있어요'); } }, '＋ 믹스'),
        h('button', { class: 'small ghost', onclick: () => { navigator.clipboard.writeText(`artist:${a.tag}`); toast('복사했어요'); } }, '복사'))));
}

function markCards() {
  const inMix = new Set(state.mix.map((a) => a.tag));
  document.querySelectorAll('#aGrid .card').forEach((c) => {
    const t = c.dataset.tag;
    c.classList.toggle('in-mix', inMix.has(t));
    c.classList.toggle('is-fav', state.favorites.has(t));
    c.classList.toggle('is-hidden', state.hidden.has(t));
    const fav = c.querySelector('.mark.fav');
    if (fav) fav.textContent = state.favorites.has(t) ? '★' : '☆';
  });
}

function pager(pages) {
  const go = (n) => { b.page = n; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  $('aPager').replaceChildren(
    h('button', { class: 'small', disabled: b.page === 0, onclick: () => go(0) }, '«'),
    h('button', { class: 'small', disabled: b.page === 0, onclick: () => go(b.page - 1) }, '‹ 이전'),
    h('span', { class: 'note' }, `${b.page + 1} / ${pages}`),
    h('button', { class: 'small', disabled: b.page >= pages - 1, onclick: () => go(b.page + 1) }, '다음 ›'),
    h('button', { class: 'small', disabled: b.page >= pages - 1, onclick: () => go(pages - 1) }, '»'));
}
