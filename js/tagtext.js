// 프롬프트 글자 ↔ 태그 목록
//  - splitPrompt: "1.2::a, b::, c, {d}" → [{ tag, weight, raw, artist }]
//  - hasTag / addTag / removeTag / toggleTag: 프롬프트 글자에 태그를 넣고 빼기 (가중치 블록 안도 처리)
//  - promptChips: 프롬프트를 색 칩으로 보여주기 (읽기 전용)
import { h, toast } from './ui.js';
import { fmtWeight } from './prompt.js';

const GROUP = /(-?\d+(?:\.\d+)?)::([\s\S]*?)(?:::|$)/g;
const norm = (t) => t.trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ');

// 글자를 [{ type:'plain', text } | { type:'group', w, inner }] 조각으로
function segments(text) {
  const out = [];
  let i = 0;
  let m;
  GROUP.lastIndex = 0;
  while ((m = GROUP.exec(text))) {
    if (m.index > i) out.push({ type: 'plain', text: text.slice(i, m.index) });
    out.push({ type: 'group', w: Number(m[1]), inner: m[2] });
    i = m.index + m[0].length;
    if (!m[0].length) GROUP.lastIndex++;
  }
  if (i < text.length) out.push({ type: 'plain', text: text.slice(i) });
  return out;
}

function braceWeight(piece) {
  const t = piece.trim();
  const up = (t.match(/^\{+/) || [''])[0].length;
  const down = (t.match(/^\[+/) || [''])[0].length;
  const tag = t.replace(/^[{[]+|[}\]]+$/g, '').trim();
  return { tag, w: Math.pow(1.05, up - down) };
}

export function splitPrompt(text) {
  const out = [];
  for (const s of segments(text || '')) {
    const pieces = (s.type === 'plain' ? s.text : s.inner).split(/[,\n]/);
    for (const p of pieces) {
      if (!p.trim()) continue;
      const { tag, w } = braceWeight(p);
      if (!tag) continue;
      const weight = Math.round((s.type === 'group' ? s.w * w : w) * 100) / 100;
      out.push({ tag, weight, raw: p.trim(), artist: /^artist:/i.test(tag), group: s.type === 'group' });
    }
  }
  return out;
}

export const hasTag = (text, tag) => splitPrompt(text).some((t) => norm(t.tag) === norm(tag));

export function removeTag(text, tag) {
  const key = norm(tag);
  const keep = (p) => p.trim() && norm(braceWeight(p).tag) !== key;
  const parts = [];
  for (const s of segments(text || '')) {
    if (s.type === 'plain') {
      for (const p of s.text.split(',')) if (keep(p)) parts.push(p.trim());
    } else {
      const inner = s.inner.split(',').filter(keep).map((p) => p.trim());
      if (inner.length) parts.push(`${fmtWeight(s.w)}::${inner.join(', ')}::`);
    }
  }
  return parts.join(', ') + (parts.length ? ', ' : '');
}

export function addTag(text, tag, weight = 1) {
  const t = Math.abs(weight - 1) < 1e-6 ? tag : `${fmtWeight(weight)}::${tag}::`;
  const base = (text || '').replace(/[\s,]+$/, '');
  return (base ? base + ', ' : '') + t + ', ';
}

export function toggleTag(text, tag, weight = 1) {
  return hasTag(text, tag) ? removeTag(text, tag) : addTag(text, tag, weight);
}

const kindOf = (t) => (t.weight < 0 ? 'neg' : t.weight > 1.001 ? 'up' : t.weight < 0.999 ? 'down' : 'flat');

// 프롬프트를 칩으로 (작가 → 금색, 강조 → 빨강, 약화 → 파랑, 음수 → 보라)
export function promptChips(text, { empty = '(비어 있음)' } = {}) {
  const tags = splitPrompt(text);
  if (!tags.length) return h('div', { class: 'pchips empty note' }, empty);
  return h('div', { class: 'pchips' }, tags.map((t) =>
    h('span', { class: `pchip ${kindOf(t)}${t.artist ? ' artist' : ''}`, title: t.raw },
      Math.abs(t.weight - 1) > 1e-6 ? h('b', {}, fmtWeight(t.weight)) : null,
      t.artist ? t.tag.replace(/^artist:\s*/i, '🎨 ') : t.tag)));
}

// 칩 보기 + 원문 보기 + 복사 버튼을 한 번에
export function promptBlock(title, text, { cls = '' } = {}) {
  let raw = false;
  const body = h('div');
  const paint = () => body.replaceChildren(raw ? h('pre', { class: 'code' }, text || '') : promptChips(text));
  const btnRaw = h('button', { class: 'link-btn', onclick: () => { raw = !raw; btnRaw.textContent = raw ? '칩으로 보기' : '글자로 보기'; paint(); } }, '글자로 보기');
  paint();
  return h('div', { class: 'pblock ' + cls },
    h('div', { class: 'pblock-head' },
      h('b', {}, title),
      h('span', { class: 'note' }, `${splitPrompt(text).length}개`),
      h('span', { class: 'grow' }),
      btnRaw,
      h('button', { class: 'link-btn', onclick: () => navigator.clipboard.writeText(text || '').then(() => toast('복사했어요')) }, '복사')),
    body);
}
