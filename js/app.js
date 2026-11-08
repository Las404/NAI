// 앱 시작: 페이지 라우팅(#/...), 상단 사용량 표시, 토큰 창
import { $, h } from './ui.js';
import { on, emit } from './state.js';
import { token } from './store.js';
import { usage, summarize, refreshUsage } from './usage.js';
import { loadArtists } from './artists.js';
import { setArtistSource } from './autocomplete.js';
import * as generate from './pages/generate.js';
import * as artists from './pages/artists.js';
import * as scenes from './pages/scenes.js';
import * as analyze from './pages/analyze.js';
import * as lab from './pages/lab.js';
import * as historyPage from './pages/history.js';
import * as usagePage from './pages/usage.js';

const PAGES = {
  '': { mod: generate, label: '🎨 생성' },
  scenes: { mod: scenes, label: '🎬 씬 모드' },
  artists: { mod: artists, label: '🔎 작가 찾기' },
  analyze: { mod: analyze, label: '🖼️ 그림체 분석' },
  lab: { mod: lab, label: '🧪 비교 실험' },
  history: { mod: historyPage, label: '🕘 히스토리' },
  usage: { mod: usagePage, label: '🔋 사용량' },
};
const mounted = new Set();

function route() {
  const key = location.hash.replace(/^#\/?/, '').split('?')[0];
  const name = PAGES[key] ? key : '';
  for (const [k] of Object.entries(PAGES)) {
    $('page-' + (k || 'generate')).hidden = k !== name;
  }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === name));
  const page = PAGES[name];
  const el = $('page-' + (name || 'generate'));
  if (!mounted.has(name)) { page.mod.mount(el); mounted.add(name); }
  page.mod.show?.();
  document.body.dataset.page = name || 'generate';
}

function buildNav() {
  $('nav').replaceChildren(...Object.entries(PAGES).map(([k, p]) => h('a', { href: '#/' + k, 'data-page': k }, p.label)));
}

// 상단: Anlas / V5 배터리 따로 표시
function renderPills() {
  const box = $('pills');
  if (!token.get()) {
    box.replaceChildren(h('button', { class: 'pill muted', onclick: openToken }, '토큰을 넣어주세요'));
    return;
  }
  if (usage.error && !usage.sub) {
    box.replaceChildren(h('a', { class: 'pill bad', href: '#/usage', title: usage.error.message }, usage.error.status === 401 ? '토큰 오류' : '사용량 확인 실패'));
    return;
  }
  const s = summarize(usage.sub);
  if (!s) { box.replaceChildren(h('span', { class: 'pill muted' }, '불러오는 중…')); return; }
  const v5 = s.v5;
  box.replaceChildren(
    h('a', { class: 'pill', href: '#/usage', title: `구독 ${s.anlas.fixed.toLocaleString()} + 구매 ${s.anlas.purchased.toLocaleString()}` },
      '💎 ', h('b', {}, s.anlas.total.toLocaleString()), h('small', {}, ' Anlas')),
    v5
      ? h('a', { class: 'pill battery ' + (v5.negative ? 'bad' : v5.percent < 15 ? 'warn' : 'good'), href: '#/usage', title: 'V5 사용량 배터리' },
          h('span', { class: 'mini-meter' }, h('span', { style: { width: `${Math.max(0, Math.min(100, v5.percent))}%` } })),
          h('b', {}, `${v5.percent}%`), h('small', {}, ' V5'))
      : h('span', { class: 'pill muted', title: 'V5 배터리는 Opus 전용' }, `${s.tier}`),
  );
}

// 토큰 창
function openToken() {
  $('tokenInput').value = token.get();
  $('tokenRemember').checked = token.remembered();
  $('tokenDialog').showModal();
}
function setupToken() {
  $('btnToken').addEventListener('click', openToken);
  $('tokenDialog').addEventListener('close', () => {
    const v = $('tokenDialog').returnValue;
    if (v === 'save') token.set($('tokenInput').value.trim(), $('tokenRemember').checked);
    if (v === 'clear') token.set('', false);
    $('tokenInput').value = '';
    refreshUsage();
  });
  on('needToken', openToken);
}

buildNav();
setupToken();
on('usage', renderPills);
window.addEventListener('hashchange', route);
route();
renderPills();
refreshUsage();
setInterval(() => { if (document.visibilityState === 'visible' && token.get()) refreshUsage(); }, 5 * 60 * 1000);
loadArtists().then(setArtistSource);
