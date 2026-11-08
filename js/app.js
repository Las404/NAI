import { MODELS, SAMPLERS, generate, getSubscription, isOpusFree } from './nai.js';
import { buildPrompt, mixLabel, cloneMix, fmtWeight } from './prompt.js';
import { GALLERIES, imageUrl, loadArtists, queryArtists } from './artists.js';
import { history, local, token } from './store.js';

const $ = (id) => document.getElementById(id);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const randSeed = () => Math.floor(Math.random() * 4294967295);

// ───────── 상태 ─────────
const DEFAULT_NEG =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

const state = {
  mix: local.get('mix', []),
  settings: Object.assign(
    {
      base: '1girl, solo, cowboy shot, looking at viewer',
      character: '',
      complexity: '',
      era: '',
      quality: true,
      negative: DEFAULT_NEG,
      model: 'nai-diffusion-5-full',
      size: '832x1216',
      steps: 23,
      scale: 5,
      cfgRescale: 0,
      sampler: 'k_euler_ancestral',
      seed: randSeed(),
      randomSeed: false,
    },
    local.get('settings', {}),
  ),
  board: local.get('board', []), // [{ id, mix, historyId? }]
  presets: local.get('presets', {}),
  artists: [],
  browse: { q: '', gallery: 'loose', sort: 'score', minVotes: 0, page: 0, shuffled: null },
  busy: false,
};
const PAGE_SIZE = 48;

const saveMix = () => local.set('mix', state.mix);
const saveSettings = () => local.set('settings', state.settings);
const saveBoard = () => local.set('board', state.board.map(({ id, mix, historyId }) => ({ id, mix, historyId })));

// ───────── 탭 ─────────
document.querySelectorAll('.tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'history') renderHistory();
    if (b.dataset.tab === 'board') renderBoard();
  }),
);

// ───────── 라이트박스 ─────────
function openLightbox(src, caption = '') {
  $('lightboxImg').src = src;
  $('lightboxCaption').textContent = caption;
  $('lightbox').showModal();
}
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) $('lightbox').close(); });

// ───────── 설정 패널 ─────────
for (const [id, m] of Object.entries(MODELS)) $('model').append(h('option', { value: id }, m.label));
for (const s of SAMPLERS) $('sampler').append(h('option', { value: s }, s));

const FIELDS = ['base', 'character', 'complexity', 'era', 'negative', 'model', 'size', 'steps', 'scale', 'cfgRescale', 'sampler', 'seed'];
const NUMERIC = new Set(['steps', 'scale', 'cfgRescale', 'seed']);
function loadSettingsToUI() {
  const s = state.settings;
  for (const f of FIELDS) $(f).value = s[f];
  $('quality').checked = s.quality;
  $('randomSeed').checked = s.randomSeed;
  syncMediumLock();
}
for (const f of FIELDS) {
  $(f).addEventListener('input', () => {
    state.settings[f] = NUMERIC.has(f) ? Number($(f).value) : $(f).value;
    saveSettings();
    if (f === 'model') syncMediumLock();
    updatePreview();
  });
}
$('quality').addEventListener('change', () => { state.settings.quality = $('quality').checked; saveSettings(); updatePreview(); });
$('randomSeed').addEventListener('change', () => { state.settings.randomSeed = $('randomSeed').checked; saveSettings(); });
$('btnNewSeed').addEventListener('click', () => { state.settings.seed = randSeed(); $('seed').value = state.settings.seed; saveSettings(); });

function syncMediumLock() {
  const medium = !!MODELS[state.settings.model]?.medium;
  for (const id of ['steps', 'sampler', 'negative', 'cfgRescale']) $(id).disabled = medium;
}

function currentSettings(mix = state.mix) {
  const s = state.settings;
  const [width, height] = s.size.split('x').map(Number);
  const extras = [s.complexity, s.era].filter(Boolean).join(', ');
  return {
    model: s.model,
    prompt: buildPrompt({ mix, base: s.base, extras, quality: s.quality, model: s.model }),
    character: s.character.trim(),
    negative: s.negative,
    width, height,
    steps: s.steps, scale: s.scale, cfgRescale: s.cfgRescale, sampler: s.sampler, seed: s.seed,
  };
}

function updatePreview() {
  const cs = currentSettings();
  $('finalPrompt').textContent = cs.prompt + (cs.character ? `\n\n[캐릭터 1] ${cs.character}` : '');
  const medium = !!MODELS[cs.model]?.medium;
  const steps = medium ? 14 : cs.steps;
  const free = isOpusFree({ width: cs.width, height: cs.height, steps });
  const badge = $('costBadge');
  if (free) {
    badge.className = 'badge good';
    badge.textContent = MODELS[cs.model].v5
      ? '✓ Opus 무료 조건 충족 (V5는 사용량 배터리 소모)'
      : '✓ Opus 무료 조건 충족';
  } else {
    badge.className = 'badge warn';
    badge.textContent = `⚠ 무료 조건 초과: ${cs.width * cs.height > 1048576 ? '1MP 초과 ' : ''}${steps > 28 ? '28스텝 초과' : ''} → Anlas 소모`;
  }
}
$('btnCopyPrompt').addEventListener('click', () => navigator.clipboard.writeText($('finalPrompt').textContent));

// ───────── 작가 믹스 ─────────
function addToMix(tag, weight = 1) {
  tag = tag.trim().replace(/^artist:\s*/i, '').replace(/_/g, ' ');
  if (!tag) return;
  if (state.mix.some((a) => a.tag === tag)) return toast(`이미 믹스에 있어요: ${tag}`);
  state.mix.push({ tag, weight, enabled: true });
  saveMix(); renderMix(); refreshInMixMarks();
}
function renderMix() {
  const box = $('mixList');
  box.replaceChildren();
  if (!state.mix.length) {
    box.append(h('div', { class: 'mix-empty' }, '작가 탐색에서 ＋를 눌러 추가하세요'));
  }
  state.mix.forEach((a, i) => {
    const num = h('input', { type: 'number', step: '0.05', min: '-2', max: '3', value: fmtWeight(a.weight) });
    const range = h('input', { type: 'range', step: '0.05', min: '-1', max: '2', value: a.weight });
    const set = (v) => {
      a.weight = Math.round(Number(v) * 100) / 100;
      num.value = fmtWeight(a.weight); range.value = a.weight;
      saveMix(); updatePreview();
    };
    num.addEventListener('change', () => set(num.value));
    range.addEventListener('input', () => set(range.value));
    const row = h('div', { class: 'mix-row' + (a.enabled === false ? ' off' : '') },
      h('input', { type: 'checkbox', checked: a.enabled !== false, title: '켜기/끄기',
        onchange: (e) => { a.enabled = e.target.checked; saveMix(); renderMix(); } }),
      h('img', { src: imageUrl(a.tag), alt: '', loading: 'lazy', onerror: (e) => (e.target.style.visibility = 'hidden'),
        onclick: () => openLightbox(imageUrl(a.tag), a.tag) }),
      h('div', { class: 'mid' }, h('div', { class: 'name', title: a.tag }, a.tag), range),
      num,
      h('button', { class: 'x', title: '빼기', onclick: () => { state.mix.splice(i, 1); saveMix(); renderMix(); refreshInMixMarks(); } }, '✕'),
    );
    box.append(row);
  });
  updatePreview();
  renderSweepSelect();
}
$('btnClearMix').addEventListener('click', () => { state.mix = []; saveMix(); renderMix(); refreshInMixMarks(); });
$('btnAddArtist').addEventListener('click', () => { addToMix($('addArtist').value); $('addArtist').value = ''; });
$('addArtist').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnAddArtist').click(); });
$('addArtist').addEventListener('input', () => {
  const q = $('addArtist').value;
  const dl = $('artistOptions');
  dl.replaceChildren();
  if (q.trim().length < 2) return;
  for (const a of queryArtists(state.artists, { q, gallery: 'loose', sort: 'score' }).slice(0, 20)) dl.append(h('option', { value: a.tag }));
});
$('btnRandomMix').addEventListener('click', () => {
  const pool = queryArtists(state.artists, { gallery: 'loose', sort: 'score' }).slice(0, 1500);
  state.mix = [];
  while (state.mix.length < 3 && pool.length) {
    const a = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    state.mix.push({ tag: a.tag, weight: 1, enabled: true });
  }
  saveMix(); renderMix(); refreshInMixMarks();
});

// 프리셋
function renderPresets() {
  const sel = $('presetSelect');
  sel.replaceChildren(h('option', { value: '' }, '프리셋 불러오기…'));
  for (const name of Object.keys(state.presets).sort()) sel.append(h('option', { value: name }, name));
}
$('presetSelect').addEventListener('change', () => {
  const p = state.presets[$('presetSelect').value];
  if (!p) return;
  state.mix = cloneMix(p.mix);
  saveMix(); renderMix(); refreshInMixMarks();
});
$('btnSavePreset').addEventListener('click', () => {
  if (!state.mix.length) return toast('믹스가 비어 있어요');
  const name = prompt('프리셋 이름', mixLabel(state.mix).slice(0, 40));
  if (!name) return;
  state.presets[name] = { mix: cloneMix(state.mix), time: Date.now() };
  local.set('presets', state.presets); renderPresets(); $('presetSelect').value = name;
});
$('btnDelPreset').addEventListener('click', () => {
  const name = $('presetSelect').value;
  if (!name || !confirm(`프리셋 "${name}"을 삭제할까요?`)) return;
  delete state.presets[name];
  local.set('presets', state.presets); renderPresets();
});

// ───────── 작가 탐색 ─────────
for (const [k, g] of Object.entries(GALLERIES)) $('gallery').append(h('option', { value: k }, g.label));
const b = state.browse;
$('q').addEventListener('input', debounce(() => { b.q = $('q').value; b.page = 0; b.shuffled = null; renderBrowse(); }, 200));
$('gallery').addEventListener('change', () => { b.gallery = $('gallery').value; b.page = 0; b.shuffled = null; renderBrowse(); });
$('sort').addEventListener('change', () => { b.sort = $('sort').value; b.page = 0; b.shuffled = null; renderBrowse(); });
$('minVotes').addEventListener('change', () => { b.minVotes = Number($('minVotes').value) || 0; b.page = 0; b.shuffled = null; renderBrowse(); });
$('btnShuffle').addEventListener('click', () => {
  const list = queryArtists(state.artists, b);
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  b.shuffled = list; b.page = 0; renderBrowse();
});

function renderBrowse() {
  const g = GALLERIES[b.gallery];
  $('galleryNote').textContent = `샘플 조건: ${g.note}`;
  const list = b.shuffled || queryArtists(state.artists, b);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  b.page = Math.min(b.page, pages - 1);
  $('browseInfo').textContent = `${list.length.toLocaleString()}명${b.shuffled ? ' (랜덤 순서)' : ''}`;
  const grid = $('artistGrid');
  grid.replaceChildren();
  const inMix = new Set(state.mix.map((a) => a.tag));
  for (const a of list.slice(b.page * PAGE_SIZE, (b.page + 1) * PAGE_SIZE)) {
    const v = a.g[b.gallery];
    const src = imageUrl(a.tag, b.gallery);
    grid.append(
      h('div', { class: 'card' + (inMix.has(a.tag) ? ' in-mix' : ''), 'data-tag': a.tag },
        h('div', { class: 'thumb', onclick: () => openLightbox(src, `artist:${a.tag}`) },
          h('img', { src, alt: a.tag, loading: 'lazy' })),
        h('div', { class: 'meta' },
          h('div', { class: 'title' }, a.tag),
          h('div', { class: 'votes' }, h('span', { class: 'u' }, `👍 ${v.up}`), ' ', h('span', { class: 'd' }, `👎 ${v.down}`)),
          h('div', { class: 'actions' },
            h('button', { class: 'small', onclick: () => addToMix(a.tag) }, '＋ 믹스'),
            h('button', { class: 'small ghost', title: '태그 복사', onclick: () => { navigator.clipboard.writeText(`artist:${a.tag}`); toast('복사했어요'); } }, '복사'),
          ),
        ),
      ),
    );
  }
  renderPager(pages);
}
function renderPager(pages) {
  const p = $('pager');
  p.replaceChildren();
  const go = (n) => { b.page = n; renderBrowse(); $('tab-browse').scrollIntoView({ behavior: 'smooth' }); };
  p.append(
    h('button', { class: 'small', disabled: b.page === 0, onclick: () => go(0) }, '«'),
    h('button', { class: 'small', disabled: b.page === 0, onclick: () => go(b.page - 1) }, '‹ 이전'),
    h('span', { class: 'note' }, `${b.page + 1} / ${pages}`),
    h('button', { class: 'small', disabled: b.page >= pages - 1, onclick: () => go(b.page + 1) }, '다음 ›'),
    h('button', { class: 'small', disabled: b.page >= pages - 1, onclick: () => go(pages - 1) }, '»'),
  );
}
function refreshInMixMarks() {
  const inMix = new Set(state.mix.map((a) => a.tag));
  document.querySelectorAll('#artistGrid .card').forEach((c) => c.classList.toggle('in-mix', inMix.has(c.dataset.tag)));
}

// ───────── 생성 ─────────
async function runGenerate(mix, { fixedSeed = false } = {}) {
  const tk = token.get();
  if (!tk) { $('tokenDialog').showModal(); throw new Error('토큰이 필요해요'); }
  if (state.busy) throw new Error('이미 생성 중이에요');
  if (!fixedSeed && state.settings.randomSeed) {
    state.settings.seed = randSeed(); $('seed').value = state.settings.seed; saveSettings();
  }
  const cs = currentSettings(mix);
  setBusy(true, '생성 중…');
  try {
    const t0 = performance.now();
    const { blob } = await generate(tk, cs);
    const item = {
      time: Date.now(), blob, mix: cloneMix(mix), settings: { ...state.settings }, request: cs, fav: false,
    };
    item.id = await history.add(item);
    setBusy(false, `완료 (${((performance.now() - t0) / 1000).toFixed(1)}초)`);
    refreshUsage();
    return item;
  } catch (e) {
    setBusy(false, `❌ ${e.message}`);
    throw e;
  }
}
function setBusy(busy, msg) {
  state.busy = busy;
  $('status').textContent = msg || '';
  for (const id of ['btnGenerate', 'btnBoardNext']) $(id).disabled = busy;
  document.querySelectorAll('[data-gen]').forEach((x) => (x.disabled = busy));
}
$('btnGenerate').addEventListener('click', async () => {
  try {
    const item = await runGenerate(state.mix);
    const url = URL.createObjectURL(item.blob);
    $('lastResult').replaceChildren(
      h('img', { src: url, alt: '생성 결과', onclick: () => openLightbox(url, mixLabel(item.mix) + ` · seed ${item.request.seed}`) }),
      h('div', { class: 'note' }, `${mixLabel(item.mix)} · seed ${item.request.seed}`),
    );
  } catch {}
});

// ───────── 비교 보드 ─────────
const boardUrls = new Map(); // historyId -> objectURL
function addBoard(mix) {
  state.board.push({ id: crypto.randomUUID(), mix: cloneMix(mix) });
  saveBoard(); renderBoard();
}
$('btnBoardAdd').addEventListener('click', () => addBoard(state.mix));
$('btnToBoard').addEventListener('click', () => { addBoard(state.mix); toast('비교 보드에 추가했어요'); });
$('btnBoardClear').addEventListener('click', () => {
  if (state.board.length && !confirm('보드를 비울까요? (생성된 이미지는 히스토리에 남아요)')) return;
  state.board = []; saveBoard(); renderBoard();
});
function renderSweepSelect() {
  const sel = $('sweepArtist');
  const prev = sel.value;
  sel.replaceChildren(h('option', { value: '' }, '스윕할 작가…'));
  for (const a of state.mix) sel.append(h('option', { value: a.tag }, a.tag));
  sel.value = state.mix.some((a) => a.tag === prev) ? prev : '';
}
$('btnSweep').addEventListener('click', () => {
  const tag = $('sweepArtist').value;
  if (!tag) return toast('스윕할 작가를 고르세요');
  const values = $('sweepValues').value.split(',').map((x) => Number(x.trim())).filter((x) => !Number.isNaN(x));
  if (!values.length) return toast('가중치 목록을 확인하세요');
  for (const w of values) addBoard(state.mix.map((a) => (a.tag === tag ? { ...a, weight: w, enabled: true } : { ...a })));
});
$('btnAblate').addEventListener('click', () => {
  const on = state.mix.filter((a) => a.enabled !== false);
  if (on.length < 2) return toast('작가가 2명 이상일 때 쓸 수 있어요');
  addBoard(state.mix);
  for (const a of on) addBoard(state.mix.map((x) => (x.tag === a.tag ? { ...x, enabled: false } : { ...x })));
});
$('btnBoardNext').addEventListener('click', () => {
  const cell = state.board.find((c) => !c.historyId);
  if (!cell) return toast('빈 칸이 없어요');
  generateCell(cell);
});
async function generateCell(cell) {
  try {
    const item = await runGenerate(cell.mix, { fixedSeed: true });
    cell.historyId = item.id;
    boardUrls.set(item.id, URL.createObjectURL(item.blob));
    saveBoard();
  } catch {}
  renderBoard();
}
async function renderBoard() {
  const grid = $('boardGrid');
  grid.replaceChildren();
  if (!state.board.length) {
    grid.append(h('div', { class: 'note' }, '아직 비어 있어요. 오른쪽에서 믹스를 만든 뒤 "＋ 현재 믹스 추가"나 "가중치 스윕"을 눌러보세요.'));
    return;
  }
  const need = state.board.filter((c) => c.historyId && !boardUrls.has(c.historyId));
  if (need.length) {
    const all = await history.all();
    for (const c of need) {
      const it = all.find((x) => x.id === c.historyId);
      if (it) boardUrls.set(it.id, URL.createObjectURL(it.blob));
      else delete c.historyId;
    }
  }
  state.board.forEach((cell, i) => {
    const url = cell.historyId && boardUrls.get(cell.historyId);
    grid.append(
      h('div', { class: 'card' },
        h('div', { class: 'thumb', onclick: () => url && openLightbox(url, mixLabel(cell.mix)) },
          url ? h('img', { src: url, alt: '' }) : h('div', { class: 'ph' }, state.busy ? '대기 중' : '아직 생성 안 됨')),
        h('div', { class: 'meta' },
          h('div', { class: 'title' }, `#${i + 1}`),
          h('div', { class: 'sub' }, mixLabel(cell.mix)),
          h('div', { class: 'actions' },
            h('button', { class: 'small', 'data-gen': true, disabled: state.busy, onclick: () => generateCell(cell) }, url ? '다시 생성' : '생성'),
            h('button', { class: 'small ghost', onclick: () => { state.mix = cloneMix(cell.mix); saveMix(); renderMix(); refreshInMixMarks(); toast('믹스로 불러왔어요'); } }, '믹스로'),
            h('button', { class: 'small ghost danger', onclick: () => { state.board.splice(i, 1); saveBoard(); renderBoard(); } }, '삭제'),
          ),
        ),
      ),
    );
  });
}

// ───────── 히스토리 ─────────
$('favOnly').addEventListener('change', renderHistory);
$('btnHistoryClear').addEventListener('click', async () => {
  if (!confirm('생성 기록을 전부 삭제할까요? 되돌릴 수 없어요. (즐겨찾기 포함)')) return;
  await history.clear();
  state.board.forEach((c) => delete c.historyId); saveBoard();
  renderHistory();
});
const historyUrls = new Map();
async function renderHistory() {
  let rows = await history.all();
  $('historyCount').textContent = `${rows.length}장`;
  if ($('favOnly').checked) rows = rows.filter((r) => r.fav);
  const grid = $('historyGrid');
  grid.replaceChildren();
  if (!rows.length) grid.append(h('div', { class: 'note' }, '기록이 없어요.'));
  for (const r of rows) {
    if (!historyUrls.has(r.id)) historyUrls.set(r.id, URL.createObjectURL(r.blob));
    const url = historyUrls.get(r.id);
    const cap = `${mixLabel(r.mix)} · seed ${r.request.seed}`;
    grid.append(
      h('div', { class: 'card' },
        h('div', { class: 'thumb', onclick: () => openLightbox(url, cap + '\n' + r.request.prompt) }, h('img', { src: url, alt: '' })),
        h('div', { class: 'meta' },
          h('div', { class: 'sub' }, new Date(r.time).toLocaleString('ko-KR'), ` · ${MODELS[r.request.model]?.label || r.request.model}`),
          h('div', { class: 'title' }, mixLabel(r.mix)),
          h('div', { class: 'sub' }, `seed ${r.request.seed} · ${r.request.steps}스텝 · CFG ${r.request.scale}`),
          h('div', { class: 'actions' },
            h('button', { class: 'small ghost' + (r.fav ? ' fav-on' : ''), title: '즐겨찾기',
              onclick: async () => { r.fav = !r.fav; await history.put(r); renderHistory(); } }, r.fav ? '★' : '☆'),
            h('button', { class: 'small ghost', title: '믹스·설정 불러오기',
              onclick: () => {
                state.mix = cloneMix(r.mix); state.settings = { ...state.settings, ...r.settings, seed: r.request.seed };
                saveMix(); saveSettings(); loadSettingsToUI(); renderMix(); refreshInMixMarks(); toast('불러왔어요');
              } }, '불러오기'),
            h('a', { class: 'small', href: url, download: `geukkak_${r.id}_${r.request.seed}.png` }, h('button', { class: 'small ghost' }, '저장')),
            h('button', { class: 'small ghost danger',
              onclick: async () => { await history.remove(r.id); URL.revokeObjectURL(url); historyUrls.delete(r.id); renderHistory(); } }, '삭제'),
          ),
        ),
      ),
    );
  }
}

// ───────── 토큰·사용량 ─────────
$('btnToken').addEventListener('click', () => {
  $('tokenInput').value = token.get();
  $('tokenRemember').checked = token.remembered();
  $('tokenDialog').showModal();
});
$('tokenDialog').addEventListener('close', () => {
  const v = $('tokenDialog').returnValue;
  if (v === 'save') token.set($('tokenInput').value.trim(), $('tokenRemember').checked);
  if (v === 'clear') token.set('', false);
  $('tokenInput').value = '';
  refreshUsage();
});
async function refreshUsage() {
  const badge = $('usage');
  const tk = token.get();
  if (!tk) { badge.className = 'badge muted'; badge.textContent = '토큰 없음'; return; }
  try {
    const sub = await getSubscription(tk);
    const tiers = ['무료', 'Tablet', 'Scroll', 'Opus'];
    const ts = sub.trainingStepsLeft || {};
    const anlas = (ts.fixedTrainingStepsLeft || 0) + (ts.purchasedTrainingSteps || 0);
    const usage = sub.usage;
    let txt = `${tiers[sub.tier] ?? 'tier ' + sub.tier} · Anlas ${anlas.toLocaleString()}`;
    let cls = 'badge good';
    if (usage && typeof usage.percent === 'number') {
      txt += ` · V5 배터리 ${usage.percent}%`;
      if (usage.isNegative || usage.percent <= 0) cls = 'badge bad';
      else if (usage.percent < 15) cls = 'badge warn';
    }
    badge.className = cls; badge.textContent = txt;
    badge.title = JSON.stringify({ tier: sub.tier, usage, trainingStepsLeft: ts }, null, 1);
  } catch (e) {
    badge.className = 'badge bad';
    badge.textContent = e.status === 401 ? '토큰 오류' : '사용량 확인 실패';
    badge.title = e.message;
  }
}

// ───────── 유틸 ─────────
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastTimer;
function toast(msg) {
  $('status').textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (!state.busy && $('status').textContent === msg) $('status').textContent = ''; }, 2500);
}

// ───────── 시작 ─────────
loadSettingsToUI();
renderMix();
renderPresets();
refreshUsage();
$('artistGrid').append(h('div', { class: 'note' }, '작가 데이터 불러오는 중…'));
loadArtists().then((list) => { state.artists = list; renderBrowse(); });
