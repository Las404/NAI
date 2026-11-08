// 그림체 분석 페이지: 예시 이미지 → 비슷한 작가 조합 + 화풍 태그 추천
import { $, h, toast, openLightbox, dropZone, pickFile } from '../ui.js';
import { state, save, on, addToMix, toggleMark } from '../state.js';
import { imageUrl } from '../artists.js';
import { fmtWeight, cloneMix } from '../prompt.js';
import { loadEngine, analyzeImage, hasClipData } from '../clip.js';
import { loadStyleGroups, toggleStyleTag } from '../stylepicker.js';
import { mixBar } from '../mixbar.js';

let result = null;
let imgUrl = null;
const opt = { k: 3, diversity: 0.35 };

export function mount(el) {
  el.append(
    mixBar(),
    h('div', { class: 'an-layout' },
      h('div', { class: 'an-left' },
        h('div', { id: 'anDrop', class: 'dropzone' },
          h('div', { class: 'big-emoji' }, '🖼️'),
          h('div', {}, '원하는 그림체의 예시 이미지를 끌어다 놓거나'),
          h('button', { class: 'primary', onclick: () => pickFile('image/*', run) }, '이미지 고르기'),
          h('div', { class: 'note' }, '붙여넣기(Ctrl+V)도 돼요. 이미지는 이 브라우저 안에서만 분석되고 어디에도 올라가지 않아요.')),
        h('div', { id: 'anPreview', class: 'an-preview' }),
        h('div', { class: 'panel' },
          h('h3', {}, '추천 설정'),
          h('label', {}, '추천 인원 ', h('b', { id: 'anKv' }, opt.k), '명',
            h('input', { type: 'range', min: 1, max: 6, step: 1, value: opt.k, oninput: (e) => { opt.k = Number(e.target.value); $('anKv').textContent = opt.k; renderPick(); } })),
          h('label', {}, '다양성 ', h('b', { id: 'anDv' }, opt.diversity),
            h('input', { type: 'range', min: 0, max: 0.7, step: 0.05, value: opt.diversity, oninput: (e) => { opt.diversity = Number(e.target.value); $('anDv').textContent = opt.diversity; renderPick(); } })),
          h('p', { class: 'note' }, '다양성을 올리면 서로 비슷한 작가끼리 겹치지 않게 골라요. 숨긴(🚫) 작가는 추천에서 빠져요.')),
        h('div', { class: 'panel note' },
          h('b', {}, '어떻게 찾나요? '),
          'nax.moe에서 같은 프롬프트·같은 시드로 작가만 바꿔 그린 샘플(투표 상위 작가)을 CLIP으로 미리 분석해 뒀어요. ',
          '올린 이미지와 샘플을 비교해서 비슷한 작가를 찾고, 비슷한 정도에 따라 가중치를 나눠줘요. ',
          '내용(캐릭터·구도)이 많이 다르면 정확도가 떨어질 수 있으니, 추천 조합을 생성해 보고 비교 실험으로 다듬는 걸 추천해요.')),
      h('div', { class: 'an-right', id: 'anResult' }),
    ),
  );
  dropZone($('anDrop'), run);
  window.addEventListener('paste', (e) => {
    if (!location.hash.startsWith('#/analyze')) return;
    const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
    if (f) run(f);
  });
  on('settings', renderStyles);
  on('marks', () => result && rerun());
  renderEmpty();
}

export function show() {}

let lastFile = null;
async function renderEmpty() {
  const ok = await hasClipData();
  $('anResult').replaceChildren(h('div', { class: 'panel' },
    h('h3', {}, ok ? '이미지를 올리면 여기에 결과가 나와요' : '분석 데이터 준비 중'),
    h('p', { class: 'note' }, ok
      ? '처음 분석할 때 CLIP 모델(약 90MB)을 한 번 내려받아요. 이후에는 브라우저에 캐시돼서 바로 분석돼요.'
      : '작가 샘플 분석 데이터(assets/clip)가 아직 없어요. 관리자가 tools/embed.html로 생성해야 해요.')));
}

async function run(file) {
  lastFile = file;
  if (imgUrl) URL.revokeObjectURL(imgUrl);
  imgUrl = URL.createObjectURL(file);
  $('anPreview').replaceChildren(h('img', { src: imgUrl, alt: '예시 이미지', onclick: () => openLightbox(imgUrl) }));
  const status = h('div', { class: 'an-status' }, h('div', { class: 'spinner' }), h('span', {}, '준비 중…'));
  $('anResult').replaceChildren(status);
  try {
    await loadEngine((msg) => { status.lastChild.textContent = msg; });
    status.lastChild.textContent = '이미지 분석 중…';
    await rerun();
  } catch (e) {
    $('anResult').replaceChildren(h('div', { class: 'panel bad' }, '분석 실패: ' + e.message));
  }
}

async function rerun() {
  if (!lastFile) return;
  const groups = await loadStyleGroups();
  result = await analyzeImage(lastFile, { exclude: state.hidden, groups });
  render();
}

function render() {
  $('anResult').replaceChildren(
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, '추천 작가 조합'), h('span', { class: 'note' }, '가중치는 비슷한 정도에 비례')),
      h('div', { id: 'anPick', class: 'pick' }),
      h('div', { class: 'row-gap' },
        h('button', { class: 'primary', onclick: () => applyPick(true) }, '이 조합으로 믹스 바꾸기'),
        h('button', { class: 'ghost', onclick: () => applyPick(false) }, '지금 믹스에 더하기'),
        h('button', { class: 'ghost', onclick: toBoard }, '🧪 비교 실험에 보내기'))),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, '추천 화풍 태그'), h('span', { class: 'note' }, '누르면 생성 프롬프트에 넣고 빼요')),
      h('div', { id: 'anStyles' })),
    h('div', { class: 'panel' },
      h('h3', {}, '비슷한 작가 후보'),
      h('div', { id: 'anCands', class: 'grid small' })),
  );
  renderPick();
  renderStyles();
  renderCands();
}

function currentPick() { return result ? result.pick(opt.k, opt.diversity) : []; }

function renderPick() {
  if (!result || !$('anPick')) return;
  const top = result.artists[0]?.sim || 1;
  $('anPick').replaceChildren(...currentPick().map((p) =>
    h('div', { class: 'pick-item' },
      h('img', { src: imageUrl(p.tag), alt: '', onclick: () => openLightbox(imageUrl(p.tag), p.tag) }),
      h('div', {},
        h('div', { class: 'title' }, p.tag),
        h('div', { class: 'note' }, `가중치 ${fmtWeight(p.weight)} · 유사도 ${Math.round((p.sim / top) * 100)}`)))));
}

function applyPick(replace) {
  const pick = currentPick();
  if (replace) state.mix = pick.map((p) => ({ tag: p.tag, weight: p.weight, enabled: true }));
  else for (const p of pick) if (!state.mix.some((a) => a.tag === p.tag)) state.mix.push({ tag: p.tag, weight: p.weight, enabled: true });
  save.mix();
  toast(replace ? '믹스를 추천 조합으로 바꿨어요' : '믹스에 더했어요', 'good');
}

function toBoard() {
  const pick = currentPick().map((p) => ({ tag: p.tag, weight: p.weight, enabled: true }));
  state.board.push({ id: crypto.randomUUID(), mix: cloneMix(pick) });
  if (pick.length >= 2) for (const p of pick) state.board.push({ id: crypto.randomUUID(), mix: pick.map((x) => ({ ...x, enabled: x.tag !== p.tag })) });
  save.board();
  toast(`비교 실험 보드에 ${pick.length >= 2 ? pick.length + 1 : 1}칸 추가 (조합 + 한 명씩 빼기)`, 'good');
}

async function renderStyles() {
  const box = $('anStyles');
  if (!box || !result) return;
  const groups = await loadStyleGroups();
  const selected = new Set(state.settings.styleTags.map((t) => t.tag));
  const rows = groups.filter((g) => result.styles[g.id]).map((g) => {
    const top = result.styles[g.id].filter((s) => s.score > 1.0).slice(0, 3);
    return h('div', { class: 'style-row' },
      h('span', { class: 'style-row-label' }, g.label),
      top.length
        ? top.map((s) => h('button', { class: 'chip' + (selected.has(s.tag) ? ' on' : ''), title: s.desc, onclick: () => toggleStyleTag(s.tag) },
            s.tag, h('small', {}, ` ${s.score.toFixed(1)}`)))
        : h('span', { class: 'note' }, '두드러진 특징 없음'));
  });
  box.replaceChildren(...rows, h('p', { class: 'note' }, '숫자는 같은 분류 안에서 얼마나 두드러지는지예요 (높을수록 강함). CLIP 추정이라 참고용이에요.'));
}

function renderCands() {
  const top = result.artists[0]?.sim || 1;
  const inMix = new Set(state.mix.map((a) => a.tag));
  $('anCands').replaceChildren(...result.artists.slice(0, 40).map((c) =>
    h('div', { class: 'card' + (inMix.has(c.tag) ? ' in-mix' : '') },
      h('div', { class: 'thumb', onclick: () => openLightbox(imageUrl(c.tag), c.tag) }, h('img', { src: imageUrl(c.tag), loading: 'lazy', alt: c.tag }),
        h('span', { class: 'sim' }, Math.round((c.sim / top) * 100))),
      h('div', { class: 'meta' },
        h('div', { class: 'title' }, c.tag),
        h('div', { class: 'actions' },
          h('button', { class: 'small', onclick: () => { addToMix(c.tag) ? toast(`믹스에 추가: ${c.tag}`) : toast('이미 믹스에 있어요'); } }, '＋ 믹스'),
          h('button', { class: 'small ghost', title: '즐겨찾기', onclick: () => { toggleMark('favorites', c.tag); toast(state.favorites.has(c.tag) ? '즐겨찾기에 추가' : '즐겨찾기 해제'); } }, '☆'),
          h('button', { class: 'small ghost', title: '숨기기', onclick: () => toggleMark('hidden', c.tag) }, '🚫'))))));
}
