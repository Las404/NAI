// 앱 전역 상태 + 변경 알림 (localStorage에 자동 저장)
import { local } from './store.js';
import { randSeed } from './ui.js';
import { clampSteps } from './nai.js';

export const DEFAULT_NEG =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page';

// 튜너·기본값용 넉넉한 부정 프롬프트 (블록별로 나눠서 튜너가 켜고 끌 수 있게)
export const NEG_BLOCKS = {
  base: 'nsfw, lowres, worst quality, bad quality, jpeg artifacts, scan artifacts, blurry, artistic error, film grain, dithering, halftone, screentone, watermark, logo, signature, username, text, multiple views, negative space, variant set, 4koma, 2koma, turnaround, dated, upscaled, unfinished, amateur, bad illustration, bad portrait',
  anatomy: 'mutation, deformed, distorted, disfigured, distorted anatomy, asymmetrical face, bad anatomy, bad proportions, bad hands, extra digits, fewer digits, extra limbs',
  eyes: 'bad eyes, bad pupils, deformed pupils, extra pupils, asymmetrical eyes, mismatched eyes, dull eyes',
  dull: '1.2::muted colors, desaturated, pale colors, washed out, low contrast, faded, dull colors::',
  mono: 'monochrome, greyscale, sepia',
  real: '3d, realistic',
  rough: 'sketch, jaggy lines, oekaki, soft focus, motion blur',
  chibi: 'chibi, toon (style)',
  old: 'old, 1990s (style)',
};
export const FULL_NEG = Object.values(NEG_BLOCKS).join(', ');

const defaults = {
  base: '1girl, solo, cowboy shot, looking at viewer',
  negative: FULL_NEG,
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
  absorbStyleTags(s);
  if (s.model) s.steps = clampSteps(s.model, s.steps ?? 23);
  return s;
}

// 화풍 태그는 이제 메인 프롬프트 글자에 바로 들어감 → 예전 목록(styleTags)은 프롬프트 앞에 합침
export function absorbStyleTags(s) {
  if (s.styleTags?.length) {
    const txt = s.styleTags.map((t) => (Math.abs(t.weight - 1) < 1e-6 ? t.tag : `${t.weight}::${t.tag}::`)).join(', ');
    s.base = [txt, (s.base || '').trim()].filter(Boolean).join(', ');
  }
  s.styleTags = [];
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
