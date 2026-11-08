// 비교 실험 페이지 (시드 고정, 작가 믹스만 바꿔 비교)
import { $, h, toast, openLightbox } from '../ui.js';
import { state, save, on, emit } from '../state.js';
import { mixLabel, cloneMix } from '../prompt.js';
import { history } from '../store.js';
import { runGenerate, NeedToken } from '../generator.js';
import { mixBar } from '../mixbar.js';
import { queue } from '../queue.js';

const urls = new Map();

export function mount(el) {
  el.append(
    mixBar(),
    h('div', { class: 'toolbar' },
      h('button', { onclick: () => add(state.mix) }, '＋ 현재 믹스 추가'),
      h('span', { class: 'sep' }),
      h('select', { id: 'lSweepArtist', title: '가중치를 바꿔볼 작가' }),
      h('input', { id: 'lSweepValues', value: '0.6, 0.8, 1, 1.2, 1.4', style: { width: '12em' } }),
      h('button', { onclick: sweep }, '가중치 스윕'),
      h('button', { onclick: ablate, title: '믹스에서 작가를 한 명씩 빼서 비교' }, '한 명씩 빼보기'),
      h('span', { class: 'sep' }),
      h('button', { id: 'lNext', class: 'primary', onclick: next }, '▶ 다음 빈 칸 생성'),
      h('button', { class: 'ghost danger', onclick: clear }, '보드 비우기')),
    h('p', { class: 'note' }, '모든 칸은 생성 페이지의 프롬프트·설정과 ', h('b', {}, '같은 시드'), '를 쓰고 작가 믹스만 달라요. 버튼 한 번에 한 장씩 생성돼요. ',
      h('span', { id: 'lSeed' })),
    h('div', { id: 'lStatus', class: 'note' }),
    h('div', { id: 'lGrid', class: 'grid board' }),
  );
  on('board', render);
  on('mix', renderSweep);
  on('settings', () => { $('lSeed').textContent = `(현재 시드 ${state.settings.seed})`; });
  on('busy', (b) => { $('lNext').disabled = b; document.querySelectorAll('#lGrid [data-gen]').forEach((x) => (x.disabled = b)); });
  $('lSeed').textContent = `(현재 시드 ${state.settings.seed})`;
  renderSweep();
  render();
}

export function show() { render(); }

function add(mix) { state.board.push({ id: crypto.randomUUID(), mix: cloneMix(mix) }); save.board(); }

function renderSweep() {
  const sel = $('lSweepArtist');
  const prev = sel.value;
  sel.replaceChildren(h('option', { value: '' }, '스윕할 작가…'), ...state.mix.map((a) => h('option', { value: a.tag }, a.tag)));
  sel.value = state.mix.some((a) => a.tag === prev) ? prev : '';
}

function sweep() {
  const tag = $('lSweepArtist').value;
  if (!tag) return toast('스윕할 작가를 고르세요');
  const values = $('lSweepValues').value.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
  if (!values.length) return toast('가중치 목록을 확인하세요');
  for (const w of values) state.board.push({ id: crypto.randomUUID(), mix: state.mix.map((a) => (a.tag === tag ? { ...a, weight: w, enabled: true } : { ...a })) });
  save.board();
}

function ablate() {
  const onList = state.mix.filter((a) => a.enabled !== false);
  if (onList.length < 2) return toast('작가가 2명 이상일 때 쓸 수 있어요');
  state.board.push({ id: crypto.randomUUID(), mix: cloneMix(state.mix) });
  for (const a of onList) state.board.push({ id: crypto.randomUUID(), mix: state.mix.map((x) => (x.tag === a.tag ? { ...x, enabled: false } : { ...x })) });
  save.board();
}

function clear() {
  if (state.board.length && !confirm('보드를 비울까요? (생성된 이미지는 히스토리에 남아요)')) return;
  state.board = [];
  save.board();
}

function next() {
  const cell = state.board.find((c) => !c.historyId);
  if (!cell) return toast('빈 칸이 없어요');
  gen(cell);
}

async function gen(cell) {
  if (queue.running || state.lock) return toast('예약 생성이나 자동 튜너가 돌아가는 중이에요');
  $('lStatus').textContent = '생성 중…';
  try {
    const item = await runGenerate(cell.mix, { fixedSeed: true, source: 'lab' });
    cell.historyId = item.id;
    urls.set(item.id, URL.createObjectURL(item.blob));
    save.board();
    $('lStatus').textContent = `완료 (${(item.ms / 1000).toFixed(1)}초)`;
  } catch (e) {
    if (e instanceof NeedToken) emit('needToken');
    $('lStatus').textContent = '❌ ' + e.message;
  }
}

async function render() {
  const grid = $('lGrid');
  if (!grid) return;
  if (!state.board.length) {
    grid.replaceChildren(h('div', { class: 'note' }, '비어 있어요. "＋ 현재 믹스 추가", "가중치 스윕", "한 명씩 빼보기"로 칸을 만들거나, 그림체 분석에서 보내보세요.'));
    return;
  }
  const need = state.board.filter((c) => c.historyId && !urls.has(c.historyId));
  if (need.length) {
    const all = await history.all();
    for (const c of need) {
      const it = all.find((x) => x.id === c.historyId);
      if (it) urls.set(it.id, URL.createObjectURL(it.blob));
      else delete c.historyId;
    }
  }
  grid.replaceChildren(...state.board.map((cell, i) => {
    const url = cell.historyId && urls.get(cell.historyId);
    return h('div', { class: 'card' },
      h('div', { class: 'thumb', onclick: () => url && openLightbox(url, mixLabel(cell.mix)) },
        url ? h('img', { src: url, alt: '' }) : h('div', { class: 'ph' }, '아직 생성 안 됨')),
      h('div', { class: 'meta' },
        h('div', { class: 'title' }, `#${i + 1}`),
        h('div', { class: 'sub' }, mixLabel(cell.mix)),
        h('div', { class: 'actions' },
          h('button', { class: 'small', 'data-gen': '1', disabled: state.busy, onclick: () => gen(cell) }, url ? '다시 생성' : '생성'),
          h('button', { class: 'small ghost', onclick: () => { state.mix = cloneMix(cell.mix); save.mix(); toast('믹스로 불러왔어요'); } }, '믹스로'),
          h('button', { class: 'small ghost danger', onclick: () => { state.board.splice(i, 1); save.board(); } }, '삭제'))));
  }));
}
