// 메인: 이미지 생성 페이지 (왼쪽 편집 · 가운데 결과 · 오른쪽 히스토리)
import { $, h, toast, openLightbox, randSeed, dropZone, pickFile } from '../ui.js';
import { state, save, on, emit, addToMix, DEFAULT_NEG } from '../state.js';
import { MODELS, SAMPLERS, isOpusFree } from '../nai.js';
import { fmtWeight, mixLabel, cloneMix } from '../prompt.js';
import { imageUrl } from '../artists.js';
import { history, local } from '../store.js';
import { runGenerate, requestFrom, NeedToken } from '../generator.js';
import { attachAutocomplete } from '../autocomplete.js';
import { parseNaiPng } from '../png.js';
import { openStylePicker } from '../stylepicker.js';
import { usage, summarize } from '../usage.js';
import { autosave, supportsFolder, chooseFolder } from '../autosave.js';
import { queue } from '../queue.js';
import { startQueue, queueBar } from '../queueui.js';
import { deleteItems } from '../remove.js';
import { hiliteBox } from '../hilite.js';

let root;
let current = null; // 가운데에 보이는 히스토리 항목
let rail = [];      // 오른쪽 히스토리 목록
let railLimit = 60;
let tab = local.get('genTab', 'mix');
const urls = new Map();
const urlOf = (item) => { if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.blob)); return urls.get(item.id); };
const boxes = {};

export function mount(el) {
  root = el;
  const base = h('textarea', { id: 'gBase', placeholder: '1girl, solo, ... (태그 2글자부터 자동완성 · 1.2::태그:: 로 강조)' });
  const neg = h('textarea', { id: 'gNeg' });
  boxes.base = hiliteBox(base);
  boxes.neg = hiliteBox(neg);

  el.append(
    h('div', { class: 'gen3' },
      // ───── 왼쪽: 편집
      h('div', { class: 'gen-left' },
        h('div', { class: 'gl-top' },
          h('select', { id: 'gPreset', onchange: loadPreset }),
          h('button', { class: 'icon-btn', title: '프리셋 저장 (작가 믹스 + 화풍 태그)', onclick: savePreset }, '💾'),
          h('button', { class: 'icon-btn danger', title: '프리셋 삭제', onclick: delPreset }, '✕'),
          h('button', { class: 'icon-btn', title: 'NAI PNG 불러오기 (끌어다 놓아도 돼요)', onclick: () => pickFile('image/png', importPng) }, '📥'),
          h('button', { id: 'gAutosave', class: 'icon-btn', onclick: openAutosave })),
        section('프롬프트', h('label', { class: 'inline tiny' }, h('input', { type: 'checkbox', id: 'gQuality' }), '품질 태그'), boxes.base, 'grow'),
        section('네거티브', h('button', { class: 'link-btn', onclick: () => { state.settings.negative = DEFAULT_NEG; save.settings(); } }, '기본값'), boxes.neg, 'neg'),
        h('p', { id: 'gNegNote', class: 'note' }),
        h('div', { class: 'gl-tabs', id: 'gTabs' }),
        h('div', { class: 'gl-panel' },
          h('div', { 'data-tab': 'mix' },
            h('div', { class: 'row-gap tight end-row' },
              h('button', { class: 'ghost small', title: '추천순 상위 작가 중 무작위 3명', onclick: randomMix }, '🎲 3명'),
              h('a', { class: 'btn ghost small', href: '#/artists' }, '🔎 찾기'),
              h('a', { class: 'btn ghost small', href: '#/analyze' }, '🖼️ 분석'),
              h('button', { class: 'ghost small', onclick: () => { state.mix = []; save.mix(); } }, '비우기')),
            h('div', { id: 'gMix', class: 'mix' }),
            h('div', { class: 'row-gap' },
              h('input', { id: 'gAddArtist', placeholder: 'artist: 로 시작하면 작가 자동완성', autocomplete: 'off' }),
              h('button', { class: 'small', onclick: addTyped }, '추가'))),
          h('div', { 'data-tab': 'style' },
            h('div', { class: 'row-gap tight end-row' }, h('button', { class: 'ghost small', onclick: () => openStylePicker() }, '＋ 화풍 태그 고르기')),
            h('div', { id: 'gStyles', class: 'chips' })),
          h('div', { 'data-tab': 'chars' },
            h('div', { class: 'row-gap tight end-row' }, h('button', { class: 'ghost small', onclick: addCharacter }, '＋ 캐릭터 추가')),
            h('div', { id: 'gChars', class: 'chars' })),
          h('div', { 'data-tab': 'settings' },
            h('label', {}, '모델', h('select', { id: 'gModel' })),
            h('div', { class: 'row-gap' },
              h('label', { class: 'grow' }, '크기', h('select', { id: 'gSize' },
                h('option', { value: '832x1216' }, '832×1216 세로'),
                h('option', { value: '1216x832' }, '1216×832 가로'),
                h('option', { value: '1024x1024' }, '1024×1024 정사각'),
                h('option', { value: '640x960' }, '640×960 작은 세로'),
                h('option', { value: '960x640' }, '960×640 작은 가로'),
                h('option', { value: '1024x1536' }, '1024×1536 큰 세로 (Anlas)'),
                h('option', { value: '1536x1024' }, '1536×1024 큰 가로 (Anlas)'))),
              h('label', {}, '스텝', h('input', { id: 'gSteps', type: 'number', min: 1, max: 50, style: { width: '4.5em' } }))),
            h('div', { class: 'row-gap' },
              h('label', { class: 'grow' }, 'CFG', h('input', { id: 'gScale', type: 'number', step: 0.1, min: 0, max: 10 })),
              h('label', { class: 'grow' }, 'Rescale', h('input', { id: 'gRescale', type: 'number', step: 0.02, min: 0, max: 1 }))),
            h('label', {}, '샘플러', h('select', { id: 'gSampler' })),
            h('div', { class: 'row-gap' },
              h('label', { class: 'grow' }, '시드', h('input', { id: 'gSeed', type: 'number', min: 0, max: 4294967295 })),
              h('button', { class: 'small ghost', title: '새 시드', onclick: () => { state.settings.seed = randSeed(); save.settings(); } }, '🎲')),
            h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 'gRandom' }), '생성할 때마다 새 시드'),
            h('div', { style: { marginTop: '10px' } }, queueBar()))),
        h('div', { class: 'gl-bottom' },
          h('div', { id: 'gCost', class: 'cost-line' }),
          h('div', { class: 'gen-row' },
            h('div', { class: 'stepper', title: '한 번에 뽑을 장수 (2장 이상은 예약 생성)' },
              h('button', { onclick: () => setCount(count() - 1) }, '−'),
              h('input', { id: 'gCount', type: 'number', min: 1, max: 100, onchange: (e) => setCount(e.target.value) }),
              h('button', { onclick: () => setCount(count() + 1) }, '+')),
            h('button', { id: 'gGenerate', class: 'primary gen-btn', onclick: () => go() }, '생성')),
          h('div', { id: 'gStatus', class: 'note' }))),

      // ───── 가운데: 결과
      h('div', { class: 'gen-center', id: 'gCenter' },
        h('div', { id: 'gQueueTop', class: 'center-queue' }),
        h('div', { id: 'gViewer', class: 'viewer' }),
        h('div', { id: 'gActions', class: 'viewer-actions' }),
        h('div', { id: 'gMeta', class: 'viewer-meta' })),

      // ───── 오른쪽: 히스토리
      h('div', { class: 'gen-right' },
        h('div', { class: 'gr-head' },
          h('b', {}, '🕘 히스토리'),
          h('span', { id: 'gRailCount', class: 'note' }),
          h('a', { class: 'icon-btn', href: '#/history', title: '히스토리 페이지에서 여러 장 골라 지우기' }, '☰')),
        h('div', { id: 'gRail', class: 'rail' })),
    ),
  );

  for (const [id, m] of Object.entries(MODELS)) $('gModel').append(h('option', { value: id }, m.label));
  for (const s of SAMPLERS) $('gSampler').append(h('option', { value: s }, s));
  $('gCount').value = count();

  bindSetting('gBase', 'base');
  bindSetting('gNeg', 'negative');
  bindSetting('gModel', 'model');
  bindSetting('gSize', 'size');
  bindSetting('gSteps', 'steps', Number);
  bindSetting('gScale', 'scale', Number);
  bindSetting('gRescale', 'cfgRescale', Number);
  bindSetting('gSampler', 'sampler');
  bindSetting('gSeed', 'seed', Number);
  $('gQuality').addEventListener('change', () => { state.settings.quality = $('gQuality').checked; save.settings(); });
  $('gRandom').addEventListener('change', () => { state.settings.randomSeed = $('gRandom').checked; save.settings(); });
  attachAutocomplete(base);
  attachAutocomplete(neg);
  attachAutocomplete($('gAddArtist'));
  $('gAddArtist').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented) addTyped(); });
  $('gRail').addEventListener('scroll', () => {
    const r = $('gRail');
    if (r.scrollTop + r.clientHeight > r.scrollHeight - 300 && railLimit < rail.length) { railLimit += 60; paintRail(); }
  });

  dropZone(root, (f) => (f.type === 'image/png' ? importPng(f) : toast('PNG만 불러올 수 있어요', 'bad')));
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.page !== 'generate') return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); return; }
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    if (e.key === 'Delete' && current) deleteItems([current]);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { // 히스토리 위아래 이동
      const i = rail.findIndex((x) => x.id === current?.id);
      const n = rail[i + (e.key === 'ArrowDown' ? 1 : -1)];
      if (n) { e.preventDefault(); show1(n); }
    }
  });

  on('mix', () => { renderMix(); renderTabs(); });
  on('settings', () => { syncSettings(); updatePreview(); renderTabs(); });
  on('presets', renderPresets);
  on('busy', (b) => { updateGenButton(); if (b && !queue.running) showPending(); });
  on('queue', () => { updateGenButton(); renderQueueTop(); });
  on('generated', (item) => { current = item; rail.unshift(item); renderViewer(); paintRail(); });
  on('cost', (item) => { if (current && current.id === item.id) { current = item; renderMeta(); } });
  on('usage', updatePreview);
  on('autosave', renderAutosaveLabel);
  on('deleted', ({ ids }) => {
    for (const id of ids) { if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } }
    const idx = rail.findIndex((x) => current && x.id === current.id);
    rail = rail.filter((x) => !ids.has(x.id));
    if (current && ids.has(current.id)) { current = rail[Math.min(idx, rail.length - 1)] || null; renderViewer(); }
    paintRail();
  });

  renderAutosaveLabel();
  syncSettings();
  renderMix();
  renderPresets();
  renderTabs();
  updateGenButton();
  renderQueueTop();
  loadRail();
}

export function show() { updatePreview(); boxes.base.refresh(); boxes.neg.refresh(); }

// ───────── 레이아웃 도우미 ─────────
function section(title, extra, body, cls = '') {
  const key = 'sec.' + title;
  const open = local.get(key, true);
  const sec = h('div', { class: `gl-sec ${cls}` + (open ? '' : ' closed') },
    h('div', { class: 'gl-sec-head' },
      h('button', { class: 'link-btn', onclick: () => { const c = sec.classList.toggle('closed'); local.set(key, !c); } }, title, h('span', { class: 'caret' })),
      h('span', { class: 'grow' }), extra),
    body);
  return sec;
}

const TABS = [
  ['mix', '🎨 작가', () => state.mix.filter((a) => a.enabled !== false).length],
  ['style', '🖌 화풍', () => state.settings.styleTags.length],
  ['chars', '👥 캐릭터', () => state.settings.characters.filter((c) => c.enabled !== false && c.prompt.trim()).length],
  ['settings', '⚙ 설정', () => 0],
];
function renderTabs() {
  $('gTabs').replaceChildren(...TABS.map(([id, label, n]) => {
    const c = n();
    return h('button', { class: tab === id ? 'on' : '', onclick: () => { tab = id; local.set('genTab', id); renderTabs(); } }, label, c ? h('span', { class: 'tab-count' }, c) : null);
  }));
  document.querySelectorAll('.gl-panel > [data-tab]').forEach((p) => (p.hidden = p.dataset.tab !== tab));
}

function bindSetting(id, key, cast = (x) => x) {
  $(id).addEventListener('input', () => { state.settings[key] = cast($(id).value); save.settings(); });
}

function syncSettings() {
  const s = state.settings;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('gBase', s.base); set('gNeg', s.negative); set('gModel', s.model); set('gSize', s.size);
  set('gSteps', s.steps); set('gScale', s.scale); set('gRescale', s.cfgRescale); set('gSampler', s.sampler); set('gSeed', s.seed);
  boxes.base.refresh(); boxes.neg.refresh();
  $('gQuality').checked = s.quality;
  $('gRandom').checked = s.randomSeed;
  const medium = !!MODELS[s.model]?.medium;
  for (const id of ['gSteps', 'gSampler', 'gNeg', 'gRescale']) $(id).disabled = medium;
  $('gNegNote').textContent = medium ? 'Medium effort는 네거티브를 못 써요. 빼고 싶은 건 프롬프트에 -2::hat:: 처럼 음수 가중치로 넣으세요.' : '';
  renderStyles();
  renderChars();
}

function updatePreview() {
  if (!root) return;
  const req = requestFrom();
  const free = isOpusFree(req);
  const sum = summarize(usage.sub);
  const v5 = MODELS[req.model]?.v5;
  const el = $('gCost');
  if (!free) { el.className = 'cost-line warn'; el.textContent = `⚠ 무료 조건 초과 (${req.width * req.height > 1048576 ? '1MP 초과 ' : ''}${req.steps > 28 ? '28스텝 초과' : ''}) → Anlas 소모`; }
  else if (v5 && sum?.v5?.negative) { el.className = 'cost-line bad'; el.textContent = '⚠ V5 배터리 소진 → 장마다 Anlas 소모'; }
  else { el.className = 'cost-line good'; el.textContent = `✓ ${MODELS[req.model]?.label} · ${req.width}×${req.height} · ${req.steps}스텝 · ${v5 ? '무료 조건 (V5 배터리 사용)' : 'Opus 무료'}`; }
}

// ───────── 생성 버튼 / 장수 ─────────
const count = () => Math.max(1, Math.min(100, Number(local.get('genCount', 1)) || 1));
function setCount(v) {
  local.set('genCount', Math.max(1, Math.min(100, Math.round(Number(v) || 1))));
  $('gCount').value = count();
  updateGenButton();
}
function updateGenButton() {
  const b = $('gGenerate');
  if (!b) return;
  const n = count();
  b.disabled = state.busy || queue.running;
  b.textContent = queue.running ? `예약 생성 중 ${queue.done}/${queue.jobs.length}` : state.busy ? '생성 중…' : n > 1 ? `${n}장 생성` : '생성';
}
function go() {
  if (state.busy || queue.running) return;
  const n = count();
  if (n > 1) startQueue(Array.from({ length: n }, () => ({ mix: state.mix, scene: null })));
  else doGenerate();
}
function renderQueueTop() {
  const box = $('gQueueTop');
  if (!box.firstChild) box.append(queueBar()); // 한 번만 만들고, 예약 중일 때만 CSS로 보임
}

async function doGenerate() {
  try {
    await runGenerate(state.mix);
    $('gStatus').textContent = `완료 (${(current.ms / 1000).toFixed(1)}초)`;
  } catch (e) {
    if (e instanceof NeedToken) { emit('needToken'); $('gStatus').textContent = 'API 토큰을 먼저 넣어주세요'; }
    else $('gStatus').textContent = '❌ ' + e.message;
    renderViewer();
  }
}

// ───────── 작가 믹스 ─────────
function renderMix() {
  const box = $('gMix');
  box.replaceChildren();
  if (!state.mix.length) box.append(h('div', { class: 'mix-empty' }, '작가 찾기·그림체 분석에서 추가하거나 아래에 직접 입력하세요'));
  state.mix.forEach((a, i) => {
    const num = h('input', { type: 'number', step: '0.05', min: '-2', max: '3', value: fmtWeight(a.weight) });
    const range = h('input', { type: 'range', step: '0.05', min: '-1', max: '2', value: a.weight });
    const set = (v) => { a.weight = Math.round(Number(v) * 100) / 100; num.value = fmtWeight(a.weight); range.value = a.weight; save.mix(); };
    num.addEventListener('change', () => set(num.value));
    range.addEventListener('input', () => { num.value = fmtWeight(range.value); });
    range.addEventListener('change', () => set(range.value));
    box.append(h('div', { class: 'mix-row' + (a.enabled === false ? ' off' : '') },
      h('input', { type: 'checkbox', checked: a.enabled !== false, title: '켜기/끄기', onchange: (e) => { a.enabled = e.target.checked; save.mix(); } }),
      h('img', { src: imageUrl(a.tag), alt: '', loading: 'lazy', onerror: (e) => (e.target.style.visibility = 'hidden'), onclick: () => openLightbox(imageUrl(a.tag), a.tag) }),
      h('div', { class: 'mid' }, h('div', { class: 'name', title: a.tag }, a.tag), range),
      num,
      h('button', { class: 'x', title: '빼기', onclick: () => { state.mix.splice(i, 1); save.mix(); } }, '✕')));
  });
  updatePreview();
}
function addTyped() {
  const v = $('gAddArtist').value.replace(/,\s*$/, '');
  for (const t of v.split(',')) if (t.trim()) addToMix(t);
  $('gAddArtist').value = '';
}
async function randomMix() {
  const { loadArtists, queryArtists } = await import('../artists.js');
  const pool = queryArtists(await loadArtists(), { gallery: 'loose', sort: 'score', hidden: state.hidden }).slice(0, 1500);
  state.mix = [];
  while (state.mix.length < 3 && pool.length) {
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    state.mix.push({ tag: a.tag, weight: 1, enabled: true });
  }
  save.mix();
}

// 프리셋
function renderPresets() {
  const sel = $('gPreset');
  sel.replaceChildren(h('option', { value: '' }, '프리셋 (작가 믹스 + 화풍)…'), ...Object.keys(state.presets).sort().map((n) => h('option', { value: n }, n)));
}
function loadPreset() {
  const p = state.presets[$('gPreset').value];
  if (!p) return;
  state.mix = cloneMix(p.mix);
  if (p.styleTags) { state.settings.styleTags = p.styleTags.map((t) => ({ ...t })); save.settings(); }
  save.mix();
  toast(`프리셋 "${$('gPreset').value}" 불러옴`);
}
function savePreset() {
  if (!state.mix.length) return toast('작가 믹스가 비어 있어요');
  const name = prompt('프리셋 이름', $('gPreset').value || mixLabel(state.mix).slice(0, 40));
  if (!name) return;
  state.presets[name] = { mix: cloneMix(state.mix), styleTags: state.settings.styleTags.map((t) => ({ ...t })), time: Date.now() };
  save.presets();
  $('gPreset').value = name;
  toast('프리셋을 저장했어요', 'good');
}
function delPreset() {
  const name = $('gPreset').value;
  if (!name) return toast('삭제할 프리셋을 먼저 고르세요');
  if (!confirm(`프리셋 "${name}"을 삭제할까요?`)) return;
  delete state.presets[name];
  save.presets();
}

// ───────── 화풍 태그 ─────────
function renderStyles() {
  const box = $('gStyles');
  const list = state.settings.styleTags;
  box.replaceChildren();
  if (!list.length) box.append(h('div', { class: 'note' }, '매체·색감·효과 같은 화풍 태그를 골라 넣어요. 그림체 분석에서 추천받을 수도 있어요.'));
  list.forEach((t, i) => {
    const num = h('input', { type: 'number', step: '0.1', value: fmtWeight(t.weight), title: '가중치', onchange: () => { t.weight = Number(num.value) || 1; save.settings(); } });
    box.append(h('span', { class: 'chip on' }, t.tag, num, h('button', { class: 'x', onclick: () => { list.splice(i, 1); save.settings(); } }, '✕')));
  });
}

// ───────── 캐릭터 ─────────
function addCharacter() {
  const max = MODELS[state.settings.model]?.v5 ? 22 : 6;
  if (state.settings.characters.length >= max) return toast(`이 모델은 캐릭터 ${max}명까지예요`);
  state.settings.characters.push({ prompt: '', uc: '', x: null, y: null, enabled: true });
  save.settings();
}
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];
function renderChars() {
  const box = $('gChars');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return;
  const chars = state.settings.characters;
  box.replaceChildren();
  if (!chars.length) box.append(h('div', { class: 'note' }, '캐릭터별 프롬프트를 따로 넣으면 여러 명이 섞이지 않게 그릴 수 있어요. 위치를 찍으면 그 자리에 배치돼요.'));
  chars.forEach((c, i) => {
    const ta = h('textarea', { rows: 2, placeholder: `캐릭터 ${i + 1}: girl, red hair, ...`, value: c.prompt });
    ta.addEventListener('input', () => { c.prompt = ta.value; save.settings(); });
    attachAutocomplete(ta);
    const uc = h('textarea', { rows: 1, placeholder: '이 캐릭터의 네거티브 (선택)', value: c.uc || '' });
    uc.addEventListener('input', () => { c.uc = uc.value; save.settings(); });
    const grid = h('div', { class: 'pos-grid', title: '위치 (같은 칸 다시 누르면 자동)' },
      GRID.flatMap((y) => GRID.map((x) => h('button', {
        class: 'pos' + (c.x === x && c.y === y ? ' on' : ''),
        title: `x ${x}, y ${y}`,
        onclick: () => { if (c.x === x && c.y === y) { c.x = null; c.y = null; } else { c.x = x; c.y = y; } save.settings(); },
      }))));
    box.append(h('div', { class: 'char' + (c.enabled === false ? ' off' : '') },
      h('div', { class: 'char-head' },
        h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: c.enabled !== false, onchange: (e) => { c.enabled = e.target.checked; save.settings(); } }), `캐릭터 ${i + 1}`),
        h('span', { class: 'note' }, c.x == null ? '위치: 자동' : `위치: ${c.x}, ${c.y}`),
        h('button', { class: 'x', onclick: () => { chars.splice(i, 1); save.settings(); } }, '✕')),
      h('div', { class: 'char-body' }, h('div', { class: 'grow' }, ta, uc), grid)));
  });
}

// ───────── 가운데 결과 ─────────
function showPending() {
  $('gViewer').replaceChildren(h('div', { class: 'viewer-empty' }, h('div', { class: 'spinner' }), h('div', {}, '생성 중…')));
}
function show1(item) { current = item; renderViewer(); paintRailSel(); }

function renderViewer() {
  const v = $('gViewer');
  if (!current) {
    v.replaceChildren(h('div', { class: 'viewer-empty' },
      h('div', { class: 'big-emoji' }, '🪚'),
      h('div', {}, '왼쪽에서 프롬프트와 작가를 정하고 ', h('b', {}, '생성'), '을 누르세요 ', h('kbd', {}, 'Ctrl+Enter')),
      h('div', { class: 'note' }, 'NAI로 만든 PNG를 여기에 끌어다 놓으면 설정을 그대로 불러와요')));
    $('gActions').replaceChildren();
    $('gMeta').replaceChildren();
    return;
  }
  const url = urlOf(current);
  v.replaceChildren(h('img', { src: url, alt: '생성 결과', onclick: () => openLightbox(url, `${mixLabel(current.mix)} · seed ${current.request.seed}`) }));
  renderMeta();
}

function renderMeta() {
  const it = current;
  if (!it) return;
  const c = it.cost;
  const costText = c ? [c.dPercent != null ? `배터리 -${c.dPercent}%` : null, c.dAnlas > 0 ? `Anlas -${c.dAnlas}` : null].filter(Boolean).join(' · ') || '소모 없음' : '';
  $('gMeta').replaceChildren(...[
    h('div', {}, `${it.request.width}×${it.request.height}`),
    h('div', { class: 'seed-line', title: '클릭하면 이 시드로 고정', onclick: () => { state.settings.seed = it.request.seed; state.settings.randomSeed = false; save.settings(); toast('시드를 고정했어요'); } }, '🔒 ', it.request.seed),
    h('div', { class: 'meta-mix', title: it.request.prompt }, (it.sceneName ? `🎬 ${it.sceneName} · ` : '') + mixLabel(it.mix)),
    costText ? h('div', {}, costText) : null,
    it.savedAs ? h('div', { title: it.savedAs }, '💾 저장됨') : null,
    it.saveError ? h('div', { class: 'bad' }, '💾 저장 실패') : null].filter(Boolean));
  $('gActions').replaceChildren(
    h('a', { class: 'icon-btn', href: urlOf(it), download: `nai_${it.id}_${it.request.seed}.png`, title: '내려받기' }, '⬇'),
    h('button', { class: 'icon-btn' + (it.fav ? ' fav-on' : ''), title: '즐겨찾기', onclick: async () => { it.fav = !it.fav; await history.put(it); renderMeta(); paintRail(); } }, it.fav ? '★' : '☆'),
    h('button', { class: 'icon-btn', title: '이 설정 다시 불러오기', onclick: () => restore(it) }, '↩'),
    h('button', { class: 'icon-btn', title: '비교 실험 보드에 추가', onclick: () => { state.board.push({ id: crypto.randomUUID(), mix: cloneMix(it.mix), historyId: it.id }); save.board(); toast('비교 실험 보드에 추가했어요'); } }, '🧪'),
    h('button', { class: 'icon-btn danger', title: '지우기 (Delete)', onclick: () => deleteItems([it]) }, '🗑'));
}

function restore(it) {
  state.mix = cloneMix(it.mix);
  Object.assign(state.settings, JSON.parse(JSON.stringify(it.settings)), { seed: it.request.seed });
  save.mix(); save.settings();
  toast('이 이미지의 설정을 불러왔어요');
}

// ───────── 오른쪽 히스토리 ─────────
async function loadRail() {
  rail = await history.all();
  if (!current && rail.length) current = rail[0];
  renderViewer();
  paintRail();
}
function paintRail() {
  $('gRailCount').textContent = rail.length.toLocaleString();
  $('gRail').replaceChildren(...rail.slice(0, railLimit).map((it) =>
    h('div', { class: 'rail-item' + (current && current.id === it.id ? ' on' : '') + (it.fav ? ' fav' : ''), 'data-id': it.id },
      h('img', { src: urlOf(it), loading: 'lazy', alt: '', onclick: () => show1(it) }),
      it.sceneName ? h('span', { class: 'rail-tag' }, '🎬') : null,
      h('button', { class: 'rail-fav', title: '즐겨찾기', onclick: async () => { it.fav = !it.fav; await history.put(it); paintRail(); if (current === it) renderMeta(); } }, it.fav ? '★' : '☆'),
      h('button', { class: 'rail-del', title: '지우기', onclick: () => deleteItems([it]) }, '✕'))));
  if (!rail.length) $('gRail').append(h('div', { class: 'note', style: { padding: '10px' } }, '아직 생성한 이미지가 없어요'));
}
function paintRailSel() {
  document.querySelectorAll('#gRail .rail-item').forEach((el) => el.classList.toggle('on', current && Number(el.dataset.id) === current.id));
  document.querySelector('#gRail .rail-item.on')?.scrollIntoView({ block: 'nearest' });
}

// ───────── 자동저장 ─────────
function renderAutosaveLabel() {
  const m = autosave.mode;
  const btn = $('gAutosave');
  btn.textContent = m === 'off' ? '📁' : '📂';
  btn.title = m === 'folder' ? `자동저장: ${autosave.folderName} 폴더` : m === 'download' ? '자동저장: 다운로드 폴더' : '자동저장 꺼짐 (눌러서 설정)';
  btn.classList.toggle('on-accent', m !== 'off');
}

function openAutosave() {
  document.getElementById('autosaveDialog')?.remove();
  const body = h('div');
  const render = () => {
    const m = autosave.mode;
    const opt = (value, title, desc, disabled) => h('label', { class: 'radio-card' + (m === value ? ' on' : '') + (disabled ? ' disabled' : '') },
      h('input', { type: 'radio', name: 'asMode', value, checked: m === value, disabled, onchange: async () => {
        if (value === 'folder' && !autosave.folderName) {
          try { await chooseFolder(); toast('저장 폴더를 정했어요', 'good'); } catch { /* 취소 */ }
        } else autosave.mode = value;
        render();
      } }),
      h('div', {}, h('b', {}, title), h('div', { class: 'note' }, desc)));
    body.replaceChildren(...[
      opt('folder', '폴더에 바로 저장 (추천)', supportsFolder ? '고른 폴더에 생성할 때마다 PNG를 저장해요. 사이트에서 지우면 컴퓨터의 파일도 같이 지워져요.' : '이 브라우저는 지원하지 않아요 (Chrome·Edge에서 가능).', !supportsFolder),
      m === 'folder' ? h('div', { class: 'row-gap indent' },
        h('span', { class: 'note' }, `📁 ${autosave.folderName || '(없음)'}`),
        h('button', { class: 'small', onclick: async () => { try { await chooseFolder(); render(); } catch {} } }, '폴더 바꾸기'),
        h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: autosave.byDate, onchange: (e) => { autosave.byDate = e.target.checked; } }), '날짜별 하위 폴더')) : null,
      opt('download', '다운로드 폴더로 자동 다운로드', '모든 브라우저에서 돼요. 대신 사이트에서 지워도 다운로드된 파일은 남아요.'),
      opt('off', '끄기', '히스토리(브라우저 안)에만 저장돼요.'),
      h('p', { class: 'note' }, '파일 이름: 날짜_시간_시드_작가.png · NAI 메타데이터가 그대로 들어 있어서 나중에 PNG 불러오기로 설정을 되살릴 수 있어요.'),
    ].filter(Boolean));
  };
  const dlg = h('dialog', { id: 'autosaveDialog' },
    h('div', { class: 'dlg-head' }, h('h3', {}, '💾 이미지 자동저장'), h('form', { method: 'dialog' }, h('button', { class: 'ghost small' }, '닫기'))),
    body);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  render();
  dlg.showModal();
}

// ───────── PNG 불러오기 ─────────
async function importPng(file) {
  try {
    const { mix, settings } = await parseNaiPng(file);
    const summary = `작가 ${mix.length}명${settings.characters?.length ? `, 캐릭터 ${settings.characters.length}명` : ''}, 시드 ${settings.seed ?? '-'}`;
    if (!confirm(`이 PNG의 설정을 불러올까요?\n(${summary})\n지금 작가 믹스와 프롬프트는 바뀌어요.`)) return;
    state.mix = mix;
    Object.assign(state.settings, settings, { randomSeed: false });
    save.mix(); save.settings();
    toast('PNG 설정을 불러왔어요', 'good');
  } catch (e) {
    toast(e.message, 'bad');
  }
}
