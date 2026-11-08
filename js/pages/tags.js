// 태그 사전: 화풍·퀄리티·연도·묘사·네거티브 태그를 눌러서 생성 페이지 프롬프트에 바로 넣고 빼기
import { $, h } from '../ui.js';
import { state, on } from '../state.js';
import { tagPalette } from '../stylepicker.js';
import { promptBlock } from '../tagtext.js';

export function mount(el) {
  el.append(
    h('div', { class: 'tags-layout' },
      h('div', { class: 'panel' },
        h('h3', {}, '🏷 태그 사전'),
        h('p', { class: 'note' }, '누르면 생성 페이지 프롬프트 끝에 바로 들어가고(✓), 다시 누르면 빠져요. 🚫 묶음은 네거티브에 들어가요. 위쪽 가중치를 고르고 누르면 1.2::태그:: 처럼 들어가요.'),
        tagPalette({ mode: 'full' })),
      h('div', { class: 'tags-side' },
        h('div', { class: 'panel', id: 'tgNow' }),
        h('a', { class: 'btn primary', href: '#/' }, '🎨 생성 페이지로'))),
  );
  on('settings', paint);
  paint();
}

export function show() { paint(); }

function paint() {
  const box = $('tgNow');
  if (!box) return;
  box.replaceChildren(
    h('h3', {}, '지금 프롬프트'),
    promptBlock('메인', state.settings.base),
    promptBlock('네거티브', state.settings.negative, { cls: 'neg' }));
}
