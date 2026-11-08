// 씬 모드: 씬마다 프롬프트·크기를 저장하고, 장수를 예약해서 한 번에 뽑기
import { $, h, toast, openLightbox, pickFile } from '../ui.js';
import { state, save, on, emit } from '../state.js';
import { local, history } from '../store.js';
import { mixLabel } from '../prompt.js';
import { runGenerate, NeedToken } from '../generator.js';
import { attachAutocomplete } from '../autocomplete.js';
import { mixBar } from '../mixbar.js';
import { queue } from '../queue.js';
import { startQueue, queueBar } from '../queueui.js';
import { deleteItems } from '../remove.js';

const SIZES = [
  ['', '기본 (생성 설정)'], ['832x1216', '832×1216 세로'], ['1216x832', '1216×832 가로'], ['1024x1024', '1024×1024 정사각'],
  ['640x960', '640×960 작은 세로'], ['960x640', '960×640 작은 가로'], ['1024x1536', '1024×1536 큰 세로 (Anlas)'], ['1536x1024', '1536×1024 큰 가로 (Anlas)'],
];
const quiet = () => local.set('scenes', state.scenes); // 다시 그리지 않고 저장만
const urls = new Map();
let gallery = new Map(); // sceneId -> [history items]

export function mount(el) {
  el.append(
    mixBar(),
    h('div', { class: 'toolbar' },
      h('button', { onclick: addScene }, '＋ 새 씬'),
      h('button', { class: 'ghost', onclick: () => bumpAll(1) }, '전체 예약 +1'),
      h('button', { class: 'ghost', onclick: () => bumpAll(0) }, '전체 예약 취소'),
      h('span', { class: 'sep' }),
      h('button', { class: 'ghost small', onclick: exportScenes }, '내보내기'),
      h('button', { class: 'ghost small', onclick: () => pickFile('application/json,.json', importScenes) }, '불러오기'),
      h('span', { class: 'grow' }),
      h('button', { id: 'sRun', class: 'primary', onclick: run }, '▶ 예약 생성')),
    queueBar(),
    h('p', { class: 'note' }, '씬 프롬프트는 생성 페이지의 ', h('b', {}, '기본 프롬프트 뒤에'), ' 붙어요. 작가 믹스·화풍 태그·캐릭터·모델 설정은 생성 페이지 것을 그대로 쓰고, 시드는 장마다 새로 뽑아요. ',
      '예약(+)을 걸고 "예약 생성"을 누르면 씬 순서대로 생성하고, 생성될 때마다 예약이 하나씩 줄어요.'),
    h('div', { id: 'sList', class: 'scene-list' }),
  );
  on('scenes', render);
  on('queue', updateRun);
  on('busy', updateRun);
  on('generated', async (item) => {
    if (!item.sceneId) return;
    const sc = state.scenes.find((s) => s.id === item.sceneId);
    if (sc && item.source === 'scene' && sc.reserve > 0) { sc.reserve--; quiet(); }
    gallery.set(item.sceneId, [item, ...(gallery.get(item.sceneId) || [])]);
    updateCard(item.sceneId);
    updateRun();
  });
  on('deleted', async ({ ids }) => {
    for (const id of ids) { if (urls.has(id)) { URL.revokeObjectURL(urls.get(id)); urls.delete(id); } }
    for (const [sid, list] of gallery) gallery.set(sid, list.filter((i) => !ids.has(i.id)));
    for (const s of state.scenes) updateCard(s.id);
  });
  render();
}

export function show() { updateRun(); }

function total() { return state.scenes.reduce((a, s) => a + (s.reserve || 0), 0); }

function updateRun() {
  const btn = $('sRun');
  if (!btn) return;
  const n = total();
  btn.textContent = queue.running ? '예약 생성 중…' : `▶ 예약 ${n}장 생성`;
  btn.disabled = queue.running || state.busy || !n;
}

function addScene() {
  state.scenes.push({ id: crypto.randomUUID(), name: `씬 ${state.scenes.length + 1}`, prompt: '', negative: '', size: '', reserve: 0 });
  save.scenes();
  setTimeout(() => document.querySelector('#sList .scene:last-child textarea')?.focus(), 50);
}

function bumpAll(v) {
  for (const s of state.scenes) s.reserve = v === 0 ? 0 : Math.min(99, (s.reserve || 0) + v);
  save.scenes();
}

function run() {
  const jobs = [];
  for (const s of state.scenes) for (let i = 0; i < (s.reserve || 0); i++) jobs.push({ mix: state.mix, scene: { ...s } });
  startQueue(jobs);
}

async function loadGallery() {
  const all = await history.all();
  gallery = new Map();
  for (const it of all) if (it.sceneId) { if (!gallery.has(it.sceneId)) gallery.set(it.sceneId, []); gallery.get(it.sceneId).push(it); }
}

async function render() {
  const list = $('sList');
  if (!list) return;
  if (list.contains(document.activeElement) && /TEXTAREA|INPUT/.test(document.activeElement.tagName) && document.activeElement.type !== 'button') {
    // 입력 중에는 전체를 다시 그리지 않음 (예약 숫자만 갱신)
    state.scenes.forEach((s) => { const c = list.querySelector(`[data-id="${s.id}"] .rcount`); if (c) c.textContent = s.reserve || 0; });
    updateRun();
    return;
  }
  await loadGallery();
  list.replaceChildren();
  if (!state.scenes.length) {
    list.append(h('div', { class: 'panel note' }, '아직 씬이 없어요. "＋ 새 씬"으로 장면(예: "sitting, cafe, coffee cup" / "standing, beach, sunset")을 만들고, 예약을 걸어 한 번에 뽑아보세요.'));
  }
  state.scenes.forEach((s, i) => list.append(card(s, i)));
  updateRun();
}

function card(s, i) {
  const name = h('input', { class: 'scene-name', value: s.name, oninput: (e) => { s.name = e.target.value; quiet(); } });
  const prompt = h('textarea', { rows: 3, placeholder: '씬 프롬프트 (예: sitting, cafe, holding cup, smile)', value: s.prompt, oninput: (e) => { s.prompt = e.target.value; quiet(); } });
  const neg = h('textarea', { rows: 1, placeholder: '씬 네거티브 (선택, 기본 네거티브 뒤에 붙음)', value: s.negative || '', oninput: (e) => { s.negative = e.target.value; quiet(); } });
  attachAutocomplete(prompt);
  attachAutocomplete(neg);
  const size = h('select', { onchange: (e) => { s.size = e.target.value; quiet(); } }, SIZES.map(([v, l]) => h('option', { value: v }, l)));
  size.value = s.size || '';
  const setReserve = (v) => { s.reserve = Math.max(0, Math.min(99, v)); quiet(); el.querySelector('.rcount').textContent = s.reserve; updateRun(); };
  const el = h('div', { class: 'scene panel', 'data-id': s.id },
    h('div', { class: 'scene-head' },
      h('span', { class: 'scene-no' }, i + 1),
      name,
      size,
      h('button', { class: 'ghost small', title: '위로', disabled: i === 0, onclick: () => { [state.scenes[i - 1], state.scenes[i]] = [state.scenes[i], state.scenes[i - 1]]; save.scenes(); } }, '↑'),
      h('button', { class: 'ghost small', title: '복제', onclick: () => { state.scenes.splice(i + 1, 0, { ...s, id: crypto.randomUUID(), name: s.name + ' 복사', reserve: 0 }); save.scenes(); } }, '⧉'),
      h('button', { class: 'ghost small danger', title: '씬 삭제', onclick: () => { if (confirm(`"${s.name}" 씬을 삭제할까요? (생성된 이미지는 히스토리에 남아요)`)) { state.scenes.splice(i, 1); save.scenes(); } } }, '✕')),
    prompt,
    neg,
    h('div', { class: 'scene-foot' },
      h('div', { class: 'reserve' },
        h('button', { class: 'small', onclick: () => setReserve((s.reserve || 0) - 1) }, '−'),
        h('span', { class: 'rcount', title: '예약 장수' }, s.reserve || 0),
        h('button', { class: 'small', onclick: () => setReserve((s.reserve || 0) + 1) }, '+'),
        h('span', { class: 'note' }, '장 예약')),
      h('button', { class: 'small ghost', 'data-gen': '1', onclick: () => once(s) }, '이 씬 1장 바로 생성'),
      h('span', { class: 'note scount' })),
    h('div', { class: 'scene-gallery' }));
  fillGallery(el, s.id);
  return el;
}

function fillGallery(el, id) {
  const items = gallery.get(id) || [];
  const s = state.scenes.find((x) => x.id === id);
  el.querySelector('.scount').replaceChildren(...(items.length ? [
    `생성 ${items.length}장`,
    h('button', { class: 'small ghost', title: '즐겨찾기(★)한 이미지는 남기고 지우기', onclick: () => {
      const del = items.filter((i) => !i.fav);
      if (!del.length) return toast('지울 이미지가 없어요 (모두 즐겨찾기)');
      deleteItems(del, { title: `"${s?.name}" 씬에서 즐겨찾기 아닌 ${del.length}장을 지울까요?` });
    } }, '🗑 즐겨찾기 빼고'),
    h('button', { class: 'small ghost danger', onclick: () => deleteItems(items, { title: `"${s?.name}" 씬 이미지 ${items.length}장을 모두 지울까요?` }) }, '🗑 전부'),
  ] : []));
  el.querySelector('.scene-gallery').replaceChildren(...items.slice(0, 30).map((it) => {
    if (!urls.has(it.id)) urls.set(it.id, URL.createObjectURL(it.blob));
    const u = urls.get(it.id);
    return h('div', { class: 'sg-item' + (it.fav ? ' fav' : '') },
      h('img', { src: u, title: `seed ${it.request.seed}`, onclick: () => openLightbox(u, `${it.sceneName} · ${mixLabel(it.mix)} · seed ${it.request.seed}`) }),
      h('button', { class: 'sg-fav', title: '즐겨찾기', onclick: async () => { it.fav = !it.fav; await history.put(it); fillGallery(el, id); } }, it.fav ? '★' : '☆'),
      h('button', { class: 'sg-del', title: '지우기', onclick: () => deleteItems([it]) }, '✕'));
  }));
}

function updateCard(id) {
  const el = document.querySelector(`#sList [data-id="${id}"]`);
  if (!el) return;
  const s = state.scenes.find((x) => x.id === id);
  if (s) el.querySelector('.rcount').textContent = s.reserve || 0;
  fillGallery(el, id);
}

async function once(s) {
  if (state.busy || queue.running || state.lock) return toast('생성 중이에요');
  try {
    await runGenerate(state.mix, { forceRandom: true, source: 'scene-once', scene: { ...s } });
  } catch (e) {
    if (e instanceof NeedToken) emit('needToken');
    else toast(e.message, 'bad');
  }
}

function exportScenes() {
  const data = { type: 'geukkak-scenes', version: 1, scenes: state.scenes.map(({ id, name, prompt, negative, size }) => ({ id, name, prompt, negative, size })) };
  const a = h('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), download: `scenes_${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a); a.click(); a.remove();
}

async function importScenes(file) {
  try {
    const j = JSON.parse(await file.text());
    const list = Array.isArray(j) ? j : j.scenes;
    if (!Array.isArray(list)) throw new Error('씬 목록을 찾지 못했어요');
    const add = list.map((x, i) => ({
      id: crypto.randomUUID(),
      name: String(x.name || x.title || `가져온 씬 ${i + 1}`),
      prompt: String(x.prompt || x.scenePrompt || ''),
      negative: String(x.negative || x.uc || ''),
      size: typeof x.size === 'string' ? x.size : (x.width && x.height ? `${x.width}x${x.height}` : ''),
      reserve: 0,
    }));
    state.scenes.push(...add);
    save.scenes();
    toast(`씬 ${add.length}개를 가져왔어요`, 'good');
  } catch (e) {
    toast('불러오기 실패: ' + e.message, 'bad');
  }
}
