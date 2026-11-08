// 생성 페이지 밖에서 현재 작가 믹스를 보여주는 띠
import { h } from './ui.js';
import { state, save, on } from './state.js';
import { fmtWeight } from './prompt.js';
import { imageUrl } from './artists.js';

export function mixBar() {
  const bar = h('div', { class: 'mixbar' });
  const render = () => {
    const chips = state.mix.map((a, i) => h('span', { class: 'chip' + (a.enabled === false ? ' off' : '') },
      h('img', { src: imageUrl(a.tag), alt: '' }),
      a.tag, Math.abs(a.weight - 1) > 1e-6 ? h('small', {}, ' ×' + fmtWeight(a.weight)) : null,
      h('button', { class: 'x', title: '빼기', onclick: () => { state.mix.splice(i, 1); save.mix(); } }, '✕')));
    bar.replaceChildren(
      h('span', { class: 'mixbar-label' }, `현재 믹스 ${state.mix.length}명`),
      ...(chips.length ? chips : [h('span', { class: 'note' }, '아직 비어 있어요')]),
      h('a', { class: 'btn primary small', href: '#/' }, '생성하러 가기 →'));
  };
  on('mix', render);
  render();
  return bar;
}
