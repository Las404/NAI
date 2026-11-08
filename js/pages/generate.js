// 메인: 이미지 생성 페이지
import { $, h, toast, openLightbox, randSeed, dropZone, pickFile } from '../ui.js';
import { state, save, on, emit, addToMix, DEFAULT_NEG } from '../state.js';
import { MODELS, SAMPLERS, isOpusFree } from '../nai.js';
import { fmtWeight, mixLabel, cloneMix, buildPrompt } from '../prompt.js';
import { imageUrl } from '../artists.js';
import { history } from '../store.js';
import { runGenerate, requestFrom, NeedToken } from '../generator.js';
import { attachAutocomplete } from '../autocomplete.js';
import { parseNaiPng } from '../png.js';
import { openStylePicker } from '../stylepicker.js';
import { usage, summarize } from '../usage.js';
import { autosave, supportsFolder, chooseFolder } from '../autosave.js';
import { local } from '../store.js';
import { queue } from '../queue.js';
import { startQueue, queueBar } from '../queueui.js';
import { deleteItems } from '../remove.js';

let root;
let current = null; // 뷰어에 표시 중인 히스토리 항목
const urls = new Map();
const urlOf = (item) => { if (!urls.has(item.id)) urls.set(item.id, URL.createObjectURL(item.blob)); return urls.get(item.id); };

export function mount(el) {
  root = el;
  el.append(
    h('div', { class: 'gen-layout' },
      h('div', { class: 'gen-controls' },
        panel('작가 믹스', [
          h('button', { class: 'ghost small', title: '추천순 상위 작가 중 무작위 3명', onclick: randomMix }, '🎲 3명'),
          h('a', { class: 'btn ghost small', href: '#/artists' }, '찾기'),
          h('a', { class: 'btn ghost small', href: '#/analyze' }, '분석'),
          h('button', { class: 'ghost small', onclick: () => { state.mix = []; save.mix(); } }, '비우기'),
        ], [
          h('div', { id: 'gMix', class: 'mix' }),
          h('div', { class: 'row-gap' },
            h('input', { id: 'gAddArtist', placeholder: 'artist: 로 시작하면 자동완성…', autocomplete: 'off' }),
            h('button', { class: 'small', onclick: addTyped }, '추가')),
          h('div', { class: 'row-gap' },
            h('select', { id: 'gPreset', onchange: loadPreset }),
            h('button', { class: 'small ghost', onclick: savePreset }, '저장'),
            h('button', { class: 'small ghost danger', onclick: delPreset }, '삭제')),
        ]),
        panel('프롬프트', [
          h('label', { class: 'inline small-label' }, h('input', { type: 'checkbox', id: 'gQuality' }), '품질 태그'),
        ], [
          h('textarea', { id: 'gBase', rows: 4, placeholder: '1girl, solo, ... (태그 2글자부터 자동완성)' }),
        ]),
        panel('화풍 태그', [
          h('button', { class: 'ghost small', onclick: () => openStylePicker() }, '＋ 고르기'),
        ], [h('div', { id: 'gStyles', class: 'chips' })]),
        panel('캐릭터', [
          h('button', { class: 'ghost small', onclick: addCharacter }, '＋ 추가'),
        ], [h('div', { id: 'gChars', class: 'chars' })]),
        panel('네거티브', [
          h('button', { class: 'ghost small', onclick: () => { state.settings.negative = DEFAULT_NEG; save.settings(); syncSettings(); } }, '기본값'),
        ], [
          h('textarea', { id: 'gNeg', rows: 3 }),
          h('p', { id: 'gNegNote', class: 'note' }),
        ], true),
        panel('생성 설정', [], [
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
            h('button', { class: 'small ghost', title: '새 시드', onclick: () => { state.settings.seed = randSeed(); save.settings(); syncSettings(); } }, '🎲')),
          h('label', { class: 'inline' }, h('input', { type: 'checkbox', id: 'gRandom' }), '생성할 때마다 새 시드'),
        ], true),
      ),
      h('div', { class: 'gen-stage' },
        h('div', { class: 'stage-top' },
          h('div', { id: 'gCost', class: 'badge' }),
          h('span', { class: 'grow' }),
          h('button', { id: 'gAutosave', class: 'ghost small', onclick: openAutosave }),
          h('button', { class: 'ghost small', onclick: () => pickFile('image/png', importPng) }, '📥 NAI PNG 불러오기'),
        ),
        h('div', { id: 'gViewer', class: 'viewer' }),
        h('div', { id: 'gInfo', class: 'viewer-info' }),
        h('div', { class: 'gen-bar' },
          h('button', { id: 'gGenerate', class: 'primary big', onclick: () => doGenerate() }, '생성 ', h('kbd', {}, 'Ctrl+Enter')),
          h('div', { class: 'multi', title: '같은 설정으로 여러 장 예약 생성 (장마다 새 시드)' },
            h('input', { id: 'gCount', type: 'number', min: 2, max: 100, value: local.get('multiCount', 4), onchange: (e) => local.set('multiCount', Number(e.target.value)) }),
            h('button', { id: 'gMulti', class: 'ghost', onclick: () => {
              const n = Math.max(1, Math.min(100, Number($('gCount').value) || 1));
              startQueue(Array.from({ length: n }, () => ({ mix: state.mix, scene: null })));
            } }, '장 예약 생성')),
          h('div', { id: 'gStatus', class: 'note' })),
        queueBar(),
        h('div', { id: 'gRecent', class: 'recent' }),
        h('details', { class: 'final' },
          h('summary', {}, '최종 프롬프트 보기'),
          h('pre', { id: 'gFinal', class: 'code' }),
          h('button', { class: 'small ghost', onclick: () => { navigator.clipboard.writeText($('gFinal').textContent); toast('복사했어요'); } }, '복사')),
      ),
    ),
  );

  for (const [id, m] of Object.entries(MODELS)) $('gModel').append(h('option', { value: id }, m.label));
  for (const s of SAMPLERS) $('gSampler').append(h('option', { value: s }, s));

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
  attachAutocomplete($('gBase'));
  attachAutocomplete($('gNeg'));
  attachAutocomplete($('gAddArtist'));
  $('gAddArtist').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented) addTyped(); });

  dropZone(root, async (f) => {
    if (f.type === 'image/png') importPng(f);
    else toast('PNG만 불러올 수 있어요', 'bad');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && location.hash.replace('#', '').replace(/^\/?/, '') === '') { e.preventDefault(); doGenerate(); }
  });

  on('mix', renderMix);
  on('settings', () => { syncSettings(); updatePreview(); });
  on('presets', renderPresets);
  on('busy', (b) => { $('gGenerate').disabled = b; $('gStatus').textContent = b ? '생성 중…' : $('gStatus').textContent; if (b) showPending(); });
  on('generated', (item) => { current = item; renderViewer(); renderRecent(); });
  on('cost', (item) => { if (current && current.id === item.id) { current = item; renderInfo(); } });
  on('usage', updatePreview);
  on('autosave', renderAutosaveLabel);
  on('deleted', ({ ids }) => {
    for (const id of ids) { if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } }
    if (current && ids.has(current.id)) { current = null; renderViewer(); }
    renderRecent(true);
  });
  document.addEventListener('keydown', (e) => {
    // 생성 페이지에서 입력칸 밖이면 Delete 키로 지금 이미지 지우기
    if (e.key !== 'Delete' || !current || document.body.dataset.page !== 'generate') return;
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
    deleteItems([current]);
  });
  on('queue', () => { $('gMulti').disabled = queue.running; $('gGenerate').disabled = state.busy || queue.running; });
  renderAutosaveLabel();

  syncSettings();
  renderMix();
  renderPresets();
  renderRecent(true);
  renderViewer();
}

export function show() { updatePreview(); }

// ───────── 패널/설정 바인딩 ─────────
function panel(title, headExtra, body, collapsed = false) {
  const d = h('details', { class: 'panel', open: !collapsed },
    h('summary', { class: 'panel-head' }, h('h3', {}, title), h('div', { class: 'row-gap tight', onclick: (e) => e.stopPropagation() }, headExtra)),
    h('div', { class: 'panel-body' }, body));
  return d;
}

function bindSetting(id, key, cast = (x) => x) {
  $(id).addEventListener('input', () => { state.settings[key] = cast($(id).value); save.settings(); });
}

function syncSettings() {
  const s = state.settings;
  const set = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };
  set('gBase', s.base); set('gNeg', s.negative); set('gModel', s.model); set('gSize', s.size);
  set('gSteps', s.steps); set('gScale', s.scale); set('gRescale', s.cfgRescale); set('gSampler', s.sampler); set('gSeed', s.seed);
  $('gQuality').checked = s.quality;
  $('gRandom').checked = s.randomSeed;
  const medium = !!MODELS[s.model]?.medium;
  for (const id of ['gSteps', 'gSampler', 'gNeg', 'gRescale']) $(id).disabled = medium;
  $('gNegNote').textContent = medium ? 'Medium effort는 네거티브를 쓸 수 없어요. 빼고 싶은 건 프롬프트에 -2::hat:: 처럼 음수 가중치로 넣으세요.' : '';
  renderStyles();
  renderChars();
}

function updatePreview() {
  if (!root) return;
  const req = requestFrom();
  $('gFinal').textContent = req.prompt + req.characters.map((c, i) => `\n\n[캐릭터 ${i + 1}${c.x != null ? ` @${c.x},${c.y}` : ''}] ${c.prompt}${c.uc ? `\n  (네거티브) ${c.uc}` : ''}`).join('');
  const free = isOpusFree(req);
  const badge = $('gCost');
  const sum = summarize(usage.sub);
  const v5 = MODELS[req.model]?.v5;
  if (!free) {
    badge.className = 'badge warn';
    badge.textContent = `⚠ 무료 조건 초과 (${req.width * req.height > 1048576 ? '1MP 초과 ' : ''}${req.steps > 28 ? '28스텝 초과' : ''}) → Anlas 소모`;
  } else if (v5 && sum?.v5?.negative) {
    badge.className = 'badge bad';
    badge.textContent = '⚠ V5 배터리 소진 → 장마다 Anlas 소모';
  } else {
    badge.className = 'badge good';
    badge.textContent = v5 ? '✓ 무료 조건 · V5 배터리 사용' : '✓ Opus 무료 조건';
  }
}

// ───────── 작가 믹스 ─────────
function renderMix() {
  const box = $('gMix');
  box.replaceChildren();
  if (!state.mix.length) box.append(h('div', { class: 'mix-empty' }, '작가 찾기·그림체 분석에서 추가하거나, 아래에 직접 입력하세요'));
  state.mix.forEach((a, i) => {
    const num = h('input', { type: 'number', step: '0.05', min: '-2', max: '3', value: fmtWeight(a.weight) });
    const range = h('input', { type: 'range', step: '0.05', min: '-1', max: '2', value: a.weight });
    const set = (v) => { a.weight = Math.round(Number(v) * 100) / 100; num.value = fmtWeight(a.weight); range.value = a.weight; save.mix(); };
    num.addEventListener('change', () => set(num.value));
    range.addEventListener('input', () => { a.weight = Number(range.value); num.value = fmtWeight(a.weight); });
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
  const pool = queryArtists(await loadArtists(), { gallery: 'loose', sort: 'score' }).filter((a) => !state.hidden.has(a.tag)).slice(0, 1500);
  state.mix = [];
  while (state.mix.length < 3 && pool.length) {
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    state.mix.push({ tag: a.tag, weight: 1, enabled: true });
  }
  save.mix();
}

function renderPresets() {
  const sel = $('gPreset');
  sel.replaceChildren(h('option', { value: '' }, '프리셋 불러오기…'), ...Object.keys(state.presets).sort().map((n) => h('option', { value: n }, n)));
}
function loadPreset() {
  const p = state.presets[$('gPreset').value];
  if (!p) return;
  state.mix = cloneMix(p.mix);
  if (p.styleTags) { state.settings.styleTags = p.styleTags.map((t) => ({ ...t })); save.settings(); }
  save.mix();
}
function savePreset() {
  if (!state.mix.length) return toast('믹스가 비어 있어요');
  const name = prompt('프리셋 이름', mixLabel(state.mix).slice(0, 40));
  if (!name) return;
  state.presets[name] = { mix: cloneMix(state.mix), styleTags: state.settings.styleTags.map((t) => ({ ...t })), time: Date.now() };
  save.presets();
  $('gPreset').value = name;
}
function delPreset() {
  const name = $('gPreset').value;
  if (!name || !confirm(`프리셋 "${name}"을 삭제할까요?`)) return;
  delete state.presets[name];
  save.presets();
}

// ───────── 화풍 태그 ─────────
function renderStyles() {
  const box = $('gStyles');
  const list = state.settings.styleTags;
  box.replaceChildren();
  if (!list.length) box.append(h('div', { class: 'note' }, '매체·색감·효과 같은 화풍 태그를 골라 넣을 수 있어요.'));
  list.forEach((t, i) => {
    const num = h('input', { type: 'number', step: '0.1', value: fmtWeight(t.weight), title: '가중치', onchange: () => { t.weight = Number(num.value) || 1; save.settings(); } });
    box.append(h('span', { class: 'chip on' }, t.tag, num,
      h('button', { class: 'x', onclick: () => { list.splice(i, 1); save.settings(); } }, '✕')));
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
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'TEXTAREA') return; // 입력 중엔 다시 그리지 않음
  const chars = state.settings.characters;
  box.replaceChildren();
  if (!chars.length) box.append(h('div', { class: 'note' }, '캐릭터별 프롬프트를 따로 넣으면 여러 명을 섞이지 않게 그릴 수 있어요. 위치를 정하면 그 자리에 배치돼요.'));
  chars.forEach((c, i) => {
    const ta = h('textarea', { rows: 2, placeholder: `캐릭터 ${i + 1}: girl, red hair, ...`, value: c.prompt });
    ta.addEventListener('input', () => { c.prompt = ta.value; save.settings(); });
    attachAutocomplete(ta);
    const uc = h('textarea', { rows: 1, placeholder: '이 캐릭터의 네거티브 (선택)', value: c.uc || '' });
    uc.addEventListener('input', () => { c.uc = uc.value; save.settings(); });
    const grid = h('div', { class: 'pos-grid', title: '위치 (가운데 버튼 = 자동)' },
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

// ───────── 생성 & 뷰어 ─────────
async function doGenerate() {
  if (state.busy) return;
  if (queue.running) return toast('예약 생성 중이에요. 끝나거나 정지한 뒤에 눌러주세요');
  try {
    await runGenerate(state.mix);
    $('gStatus').textContent = `완료 (${(current.ms / 1000).toFixed(1)}초)`;
  } catch (e) {
    if (e instanceof NeedToken) { emit('needToken'); $('gStatus').textContent = 'API 토큰을 먼저 넣어주세요'; }
    else $('gStatus').textContent = '❌ ' + e.message;
    renderViewer();
  }
}

function showPending() {
  $('gViewer').replaceChildren(h('div', { class: 'viewer-empty' }, h('div', { class: 'spinner' }), h('div', {}, '생성 중…')));
}

function renderViewer() {
  const v = $('gViewer');
  if (!current) {
    v.replaceChildren(h('div', { class: 'viewer-empty' },
      h('div', { class: 'big-emoji' }, '🪚'),
      h('div', {}, '왼쪽에서 작가와 프롬프트를 정하고 ', h('b', {}, '생성'), '을 누르세요'),
      h('div', { class: 'note' }, 'NAI로 만든 PNG를 여기에 끌어다 놓으면 설정을 그대로 불러와요')));
    $('gInfo').replaceChildren();
    return;
  }
  const url = urlOf(current);
  v.replaceChildren(h('img', { src: url, alt: '생성 결과', onclick: () => openLightbox(url, `${mixLabel(current.mix)} · seed ${current.request.seed}`) }));
  renderInfo();
}

function renderInfo() {
  const it = current;
  const cost = it.cost;
  const costText = cost ? [cost.dPercent != null ? `배터리 -${cost.dPercent}%` : null, cost.dAnlas > 0 ? `Anlas -${cost.dAnlas}` : null].filter(Boolean).join(' · ') || '소모 없음' : '';
  $('gInfo').replaceChildren(
    h('div', { class: 'info-main' },
      h('b', {}, mixLabel(it.mix)),
      h('span', { class: 'note' }, ` · seed ${it.request.seed} · ${it.request.width}×${it.request.height} · ${it.request.steps}스텝 · ${MODELS[it.request.model]?.label || it.request.model}${costText ? ' · ' + costText : ''}`),
      it.savedAs ? h('div', { class: 'note' }, `💾 ${it.savedAs}`) : null,
      it.saveError ? h('div', { class: 'note bad' }, `💾 자동저장 실패: ${it.saveError}`) : null),
    h('div', { class: 'actions' },
      h('a', { class: 'btn small ghost', href: urlOf(it), download: `nai_${it.id}_${it.request.seed}.png` }, '💾 저장'),
      h('button', { class: 'small ghost' + (it.fav ? ' fav-on' : ''), onclick: async () => { it.fav = !it.fav; await history.put(it); renderInfo(); } }, it.fav ? '★ 즐겨찾기' : '☆ 즐겨찾기'),
      h('button', { class: 'small ghost', title: '이 시드로 고정', onclick: () => { state.settings.seed = it.request.seed; state.settings.randomSeed = false; save.settings(); toast('시드를 고정했어요'); } }, '🔒 이 시드 고정'),
      h('button', { class: 'small ghost', onclick: () => { state.board.push({ id: crypto.randomUUID(), mix: cloneMix(it.mix), historyId: it.id }); save.board(); toast('비교 실험 보드에 추가했어요'); } }, '🧪 보드에 추가'),
      h('button', { class: 'small ghost', onclick: () => restore(it) }, '↩ 이 설정 불러오기'),
      h('button', { class: 'small ghost danger', title: '이 이미지 지우기 (Delete 키)', onclick: () => deleteItems([it]) }, '🗑 삭제')));
}

function restore(it) {
  state.mix = cloneMix(it.mix);
  state.settings = Object.assign(state.settings, JSON.parse(JSON.stringify(it.settings)), { seed: it.request.seed });
  save.mix(); save.settings();
  toast('설정을 불러왔어요');
}

async function renderRecent(first = false) {
  const rows = (await history.all()).slice(0, 24);
  if (first && rows.length && !current) { current = rows[0]; renderViewer(); }
  $('gRecent').replaceChildren(...rows.map((r) =>
    h('img', { src: urlOf(r), class: current && current.id === r.id ? 'on' : '', title: mixLabel(r.mix), onclick: () => { current = r; renderViewer(); renderRecent(); } })));
}

// ───────── 자동저장 ─────────
function renderAutosaveLabel() {
  const m = autosave.mode;
  const btn = $('gAutosave');
  btn.textContent = m === 'folder' ? `💾 자동저장: ${autosave.folderName || '폴더'}` : m === 'download' ? '💾 자동저장: 다운로드' : '💾 자동저장 꺼짐';
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
      opt('off', '끄기', '히스토리(브라우저 안)에만 저장돼요.'),
      opt('folder', '폴더에 바로 저장', supportsFolder ? '고른 폴더에 생성할 때마다 PNG를 저장해요. 처음 생성할 때 한 번 권한을 물어볼 수 있어요.' : '이 브라우저는 지원하지 않아요 (Chrome·Edge에서 가능).', !supportsFolder),
      m === 'folder' ? h('div', { class: 'row-gap indent' },
        h('span', { class: 'note' }, `📁 ${autosave.folderName || '(없음)'}`),
        h('button', { class: 'small', onclick: async () => { try { await chooseFolder(); render(); } catch {} } }, '폴더 바꾸기'),
        h('label', { class: 'inline' }, h('input', { type: 'checkbox', checked: autosave.byDate, onchange: (e) => { autosave.byDate = e.target.checked; } }), '날짜별 하위 폴더')) : null,
      opt('download', '다운로드 폴더로 자동 다운로드', '브라우저 기본 다운로드 폴더에 저장돼요. 처음에 "여러 파일 다운로드 허용"을 물어보면 허용해 주세요.'),
      h('p', { class: 'note' }, '파일 이름: 날짜_시간_시드_작가.png · NAI 메타데이터가 그대로 들어 있어서 나중에 "PNG 불러오기"로 설정을 되살릴 수 있어요.'),
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
