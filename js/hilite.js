// 프롬프트 입력칸에 가중치 색 표시 (투명 textarea 뒤에 같은 글자를 색칠해서 깔아두는 방식)
//  1.2::tag::  → 강조(빨강)   0.5::tag:: → 약화(파랑)   -1::tag:: → 음수(보라)   {tag} / [tag] 도 표시
import { h } from './ui.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function classFor(w) {
  if (w < 0) return 'hl-neg';
  if (w < 1) return 'hl-down';
  if (w > 1) return 'hl-up';
  return 'hl-flat';
}

export function highlight(text) {
  let out = '';
  let i = 0;
  // 숫자 가중치 블록, 중괄호/대괄호 블록, 작가 태그
  const re = /(-?\d+(?:\.\d+)?)::([\s\S]*?)(::|$)|(\{+)([^{}]*?)(\}+)|(\[+)([^[\]]*?)(\]+)|(artist:[^,\n:]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > i) out += esc(text.slice(i, m.index));
    if (m[1] !== undefined) {
      out += `<span class="${classFor(Number(m[1]))}">${esc(m[0])}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="hl-up">${esc(m[0])}</span>`;
    } else if (m[7] !== undefined) {
      out += `<span class="hl-down">${esc(m[0])}</span>`;
    } else if (m[10] !== undefined) {
      out += `<span class="hl-artist">${esc(m[0])}</span>`;
    }
    i = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += esc(text.slice(i));
  return out + '\n';
}

// textarea를 색 표시 입력칸으로 감싸서 반환 (textarea 자체는 그대로 쓰면 됨)
export function hiliteBox(textarea) {
  textarea.classList.add('hl-front');
  const back = h('div', { class: 'hl-back', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'hl-wrap' }, back, textarea);
  const sync = () => { back.innerHTML = highlight(textarea.value); back.scrollTop = textarea.scrollTop; };
  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', () => { back.scrollTop = textarea.scrollTop; });
  new ResizeObserver(() => { back.style.height = textarea.offsetHeight + 'px'; sync(); }).observe(textarea);
  wrap.refresh = sync;
  sync();
  return wrap;
}
