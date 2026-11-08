// 프롬프트 조립. V5는 프롬프트 믹싱(|)이 안 되므로 숫자 가중치(1.2::tag::)로 작가를 섞는다.
import { QUALITY_SUFFIX } from './nai.js';

export function fmtWeight(w) {
  return Number(w).toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function artistToken(a) {
  const tag = `artist:${a.tag}`;
  const w = Number(a.weight);
  if (Math.abs(w - 1) < 1e-6) return tag;
  return `${fmtWeight(w)}::${tag}::`;
}

export function mixToText(mix) {
  return mix.filter((a) => a.enabled !== false && Number(a.weight) !== 0).map(artistToken).join(', ');
}

// s: { mix, base, extras, quality, model }
export function buildPrompt(s) {
  const parts = [];
  const artists = mixToText(s.mix);
  if (artists) parts.push(artists);
  if (s.extras) parts.push(s.extras.trim());
  if (s.base) parts.push(s.base.trim());
  let prompt = parts.filter(Boolean).join(', ');
  if (s.quality) prompt += QUALITY_SUFFIX[s.model] || '';
  return prompt;
}

export function mixLabel(mix) {
  const on = mix.filter((a) => a.enabled !== false && Number(a.weight) !== 0);
  if (!on.length) return '(작가 없음)';
  return on.map((a) => `${a.tag}${Math.abs(a.weight - 1) < 1e-6 ? '' : ' ×' + fmtWeight(a.weight)}`).join(' + ');
}

export const cloneMix = (mix) => mix.map((a) => ({ ...a }));
