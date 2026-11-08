// 프롬프트 조립. V5는 프롬프트 믹싱(|)이 안 되므로 숫자 가중치(1.2::tag::)로 작가를 섞는다.
import { QUALITY_SUFFIX } from './nai.js';

export function fmtWeight(w) {
  return Number(w).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function weighted(text, w) {
  w = Number(w);
  if (Math.abs(w - 1) < 1e-6) return text;
  return `${fmtWeight(w)}::${text}::`;
}

export const artistToken = (a) => weighted(`artist:${a.tag}`, a.weight);
const active = (list) => (list || []).filter((a) => a.enabled !== false && Number(a.weight) !== 0);

export function mixToText(mix) {
  return active(mix).map(artistToken).join(', ');
}

export function styleToText(tags) {
  return active(tags).map((t) => weighted(t.tag, t.weight)).join(', ');
}

// s: { mix, styleTags, base, quality, model }
export function buildPrompt(s) {
  const parts = [mixToText(s.mix), styleToText(s.styleTags), (s.base || '').trim().replace(/,\s*$/, '')];
  let prompt = parts.filter(Boolean).join(', ');
  if (s.quality) prompt += QUALITY_SUFFIX[s.model] || '';
  return prompt;
}

export function mixLabel(mix) {
  const on = active(mix);
  if (!on.length) return '(작가 없음)';
  return on.map((a) => `${a.tag}${Math.abs(a.weight - 1) < 1e-6 ? '' : ' ×' + fmtWeight(a.weight)}`).join(' + ');
}

export const cloneMix = (mix) => mix.map((a) => ({ ...a }));

// 프롬프트 문자열에서 작가 태그를 뽑아낸다 (PNG 불러오기용)
// 지원: artist:x / 1.2::artist:x:: / {artist:x} / [artist:x]
export function extractArtists(prompt) {
  const mix = [];
  let rest = prompt;
  const push = (tag, w) => {
    tag = tag.trim().replace(/_/g, ' ');
    if (tag && !mix.some((a) => a.tag === tag)) mix.push({ tag, weight: Math.round(w * 100) / 100, enabled: true });
  };
  // 숫자 가중치 블록 안의 작가들
  rest = rest.replace(/(-?\d+(?:\.\d+)?)::([^:]*?artist:[^:]*?)::/g, (m, w, body) => {
    const others = [];
    for (const piece of body.split(',')) {
      const mm = piece.trim().match(/^artist:\s*(.+)$/i);
      if (mm) push(mm[1], Number(w));
      else if (piece.trim()) others.push(piece.trim());
    }
    return others.length ? `${w}::${others.join(', ')}::` : '';
  });
  // 괄호 강조
  rest = rest.replace(/([{[]+)\s*artist:\s*([^,{}[\]]+?)\s*([}\]]+)/gi, (m, open, tag) => {
    const up = (open.match(/{/g) || []).length, down = (open.match(/\[/g) || []).length;
    push(tag, Math.pow(1.05, up - down));
    return '';
  });
  // 일반
  rest = rest.replace(/(^|,)\s*artist:\s*([^,]+)/gi, (m, lead, tag) => { push(tag, 1); return lead; });
  rest = rest.split(',').map((x) => x.trim()).filter(Boolean).join(', ');
  return { mix, rest };
}
