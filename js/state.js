// 앱 전역 상태 + 변경 알림 (localStorage에 자동 저장)
import { local } from './store.js';
import { randSeed } from './ui.js';

export const DEFAULT_NEG =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

const defaults = {
  base: '1girl, solo, cowboy shot, looking at viewer',
  negative: DEFAULT_NEG,
  quality: true,
  styleTags: [], // [{ tag, weight }]
  characters: [], // [{ prompt, uc, x, y, enabled }]  x/y: 0.1~0.9 또는 null(자동)
  model: 'nai-diffusion-5-full',
  size: '832x1216',
  steps: 23,
  scale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  seed: randSeed(),
  randomSeed: true,
};

function migrate(s) {
  // 예전 버전: character(단일), complexity/era 선택 → 새 구조로
  if (typeof s.character === 'string') {
    if (s.character.trim() && !s.characters?.length) s.characters = [{ prompt: s.character.trim(), uc: '', x: null, y: null, enabled: true }];
    delete s.character;
  }
  for (const k of ['complexity', 'era']) {
    if (s[k]) {
      s.styleTags = s.styleTags || [];
      if (!s.styleTags.some((t) => t.tag === s[k])) s.styleTags.push({ tag: s[k], weight: 1 });
    }
    delete s[k];
  }
  return s;
}

export const state = {
  mix: local.get('mix', []),
  settings: Object.assign({}, defaults, migrate(local.get('settings', {}))),
  board: local.get('board', []),
  scenes: local.get('scenes', []), // [{ id, name, prompt, negative, size(null=기본), reserve }]
  presets: local.get('presets', {}),
  favorites: new Set(local.get('favorites', [])),
  hidden: new Set(local.get('hidden', [])),
  busy: false,
};

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, data) {
  for (const fn of listeners.get(evt) || []) fn(data);
}

export const save = {
  mix() { local.set('mix', state.mix); emit('mix'); },
  settings() { local.set('settings', state.settings); emit('settings'); },
  board() { local.set('board', state.board.map(({ id, mix, historyId }) => ({ id, mix, historyId }))); emit('board'); },
  presets() { local.set('presets', state.presets); emit('presets'); },
  scenes() { local.set('scenes', state.scenes); emit('scenes'); },
  marks() { local.set('favorites', [...state.favorites]); local.set('hidden', [...state.hidden]); emit('marks'); },
};

export function addToMix(tag, weight = 1) {
  tag = String(tag).trim().replace(/^artist:\s*/i, '').replace(/_/g, ' ');
  if (!tag) return false;
  if (state.mix.some((a) => a.tag === tag)) return false;
  state.mix.push({ tag, weight, enabled: true });
  save.mix();
  return true;
}

export function toggleMark(set, tag) {
  const s = state[set];
  if (s.has(tag)) s.delete(tag);
  else {
    s.add(tag);
    const other = set === 'favorites' ? state.hidden : state.favorites;
    other.delete(tag);
  }
  save.marks();
}
