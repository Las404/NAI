// 태그 팔레트: 누르면 생성 페이지 프롬프트(메인/네거티브) 글자에 바로 들어가고, 다시 누르면 빠져요.
// 화풍 태그(assets/style-tags.json) + 퀄리티·연도·묘사 + 부정 프롬프트 묶음
import { h } from './ui.js';
import { state, save, on, NEG_BLOCKS } from './state.js';
import { hasTag, toggleTag, splitPrompt } from './tagtext.js';
import { local } from './store.js';

let groupsPromise;
export function loadStyleGroups() {
  if (!groupsPromise) groupsPromise = fetch(new URL('../assets/style-tags.json', import.meta.url)).then((r) => r.json()).then((j) => j.groups);
  return groupsPromise;
}

const EXTRA_MAIN = [
  { id: 'quality', label: '퀄리티', desc: '그림 완성도를 끌어올리는 태그 (보통 메인 프롬프트 뒤쪽에)', tags: [
    ['masterpiece', '걸작'], ['best quality', '최고 품질'], ['very aesthetic', '아주 미적인 (NAI 품질 태그)'], ['absurdres', '초고해상도 느낌'],
    ['highres', '고해상도'], ['amazing quality', 'V4.5+ 품질 태그'], ['detailed illustration', '세밀한 일러스트'], ['intricate details', '정교한 디테일'],
    ['official art', '공식 일러스트 느낌'], ['solo artist', '한 작가 그림 (그림체 섞임 줄이기)'], ['no text', '글자 없음'],
  ] },
  { id: 'era', label: '연도', desc: '어느 시기의 그림 유행을 따를지 (최신일수록 요즘 그림체)', tags: [
    ['year 2025', '2025년 그림'], ['year 2024', '2024년 그림'], ['year 2023', '2023년 그림'], ['year 2022', '2022년 그림'],
    ['year 2021', '2021년 그림'], ['year 2020', '2020년 그림'], ['year 2018', '2018년 그림'], ['year 2015', '2015년 그림'],
    ['year 2010', '2010년 그림'], ['2000s (style)', '2000년대 스타일'], ['1990s (style)', '90년대 스타일'],
  ] },
  { id: 'detail', label: '묘사', desc: '선·피부·눈 같은 세부 렌더링', tags: [
    ['soft line', '부드러운 선'], ['thick lineart', '굵은 선'], ['thin lineart', '가는 선'], ['no lineart', '선 없음'], ['colored lineart', '색 선'],
    ['detailed hair', '머리카락 디테일'], ['detailed eyes', '눈 디테일'], ['big eyes', '큰 눈'], ['shiny skin', '광택 피부'], ['oiled skin', '번들거리는 피부'],
    ['blush', '홍조'], ['glossy lips', '촉촉한 입술'], ['sharp focus', '선명한 초점'], ['calm', '차분한 분위기'], ['rim light', '림 라이트'],
  ] },
];

const NEG_LABEL = { base: '품질·잡것', anatomy: '인체', eyes: '눈', dull: '흐린 색', mono: '흑백', real: '실사·3D', rough: '거친 그림', chibi: '치비', old: '옛날 그림' };

export async function loadPalette() {
  const style = await loadStyleGroups();
  const main = [...EXTRA_MAIN.slice(0, 1), ...style, ...EXTRA_MAIN.slice(1)].map((g) => ({ ...g, target: 'base' }));
  const neg = Object.entries(NEG_BLOCKS).map(([id, text]) => ({
    id: 'neg-' + id, label: '🚫 ' + NEG_LABEL[id], desc: '네거티브 프롬프트에 들어가요', target: 'negative',
    tags: splitPrompt(text).map((t) => [t.tag, '']),
  }));
  return [...main, ...neg];
}

// 예전 코드 호환: 메인 프롬프트에 태그 넣고 빼기
export function toggleStyleTag(tag, weight = 1) {
  state.settings.base = toggleTag(state.settings.base, tag, weight);
  save.settings();
}

const WEIGHTS = [1, 1.2, 1.5, 0.7, -1];

// 팔레트 화면. mode: 'compact'(생성 페이지 탭) | 'full'(태그 페이지·창)
export function tagPalette({ mode = 'compact' } = {}) {
  const root = h('div', { class: 'palette ' + mode });
  let groups = [];
  let active = local.get('palGroup', 'quality');
  let weight = 1;
  let q = '';
  const search = h('input', { type: 'search', placeholder: '태그 검색 (영어·한글 설명)', oninput: (e) => { q = e.target.value.trim().toLowerCase(); paint(); } });

  function chip(g, [tag, desc]) {
    const text = state.settings[g.target] || '';
    const on = hasTag(text, tag);
    const click = () => {
      state.settings[g.target] = toggleTag(state.settings[g.target], tag, g.target === 'negative' ? 1 : weight);
      save.settings();
    };
    if (mode === 'full') {
      return h('button', { class: 'style-item' + (on ? ' on' : '') + (g.target === 'negative' ? ' neg' : ''), onclick: click, title: on ? '누르면 빠져요' : '누르면 들어가요' },
        h('span', { class: 'st-tag' }, (on ? '✓ ' : '') + tag), desc ? h('span', { class: 'st-desc' }, desc) : null);
    }
    return h('button', { class: 'chip pal' + (on ? ' on' : '') + (g.target === 'negative' ? ' neg' : ''), title: desc || tag, onclick: click }, (on ? '✓ ' : '') + tag);
  }

  function paint() {
    if (!groups.length) return;
    const g = groups.find((x) => x.id === active) || groups[0];
    const tabs = h('div', { class: 'pal-tabs' }, groups.map((x) => {
      const n = x.tags.filter(([t]) => hasTag(state.settings[x.target] || '', t)).length;
      return h('button', { class: (x.id === g.id && !q ? 'on' : '') + (x.target === 'negative' ? ' neg' : ''), onclick: () => { active = x.id; local.set('palGroup', x.id); q = ''; search.value = ''; paint(); } },
        x.label, n ? h('span', { class: 'tab-count' }, n) : null);
    }));
    let list;
    if (q) {
      list = groups.map((x) => {
        const hit = x.tags.filter(([t, d]) => t.toLowerCase().includes(q) || (d || '').toLowerCase().includes(q));
        return hit.length ? h('div', { class: 'pal-sec' }, h('div', { class: 'note' }, x.label), h('div', { class: mode === 'full' ? 'style-grid' : 'chips' }, hit.map((t) => chip(x, t)))) : null;
      }).filter(Boolean);
      if (!list.length) list = [h('div', { class: 'note' }, '찾는 태그가 없어요. 프롬프트 칸에 직접 쓰면 자동완성돼요.')];
    } else {
      list = [
        h('p', { class: 'note' }, g.desc, g.target === 'negative' ? '' : ' · 누르면 메인 프롬프트 끝에 들어가요'),
        h('div', { class: mode === 'full' ? 'style-grid' : 'chips' }, g.tags.map((t) => chip(g, t))),
      ];
    }
    wsel.replaceChildren(h('span', { class: 'note', style: { padding: '4px 6px' } }, '가중치'),
      ...WEIGHTS.map((w) => h('button', { class: w === weight ? 'on' : '', onclick: () => { weight = w; paint(); } }, String(w))));
    tabsBox.replaceChildren(tabs);
    listBox.replaceChildren(...list);
  }

  const wsel = h('div', { class: 'seg', title: '새로 넣을 때 가중치 (메인 프롬프트)' });
  const tabsBox = h('div');
  const listBox = h('div', { class: 'pal-list' });
  root.append(h('div', { class: 'pal-top' }, search, wsel), tabsBox, listBox);
  loadPalette().then((g) => { groups = g; paint(); });
  on('settings', () => { if (root.isConnected) paint(); });
  return root;
}

export function openStylePicker() {
  document.getElementById('styleDialog')?.remove();
  const dlg = h('dialog', { id: 'styleDialog', class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, '🏷 태그 넣기'), h('form', { method: 'dialog' }, h('button', { class: 'ghost small' }, '닫기'))),
    tagPalette({ mode: 'full' }));
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => setTimeout(() => dlg.remove(), 0));
  document.body.append(dlg);
  dlg.showModal();
}
