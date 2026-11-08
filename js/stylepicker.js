// 화풍 태그 고르기 창 (assets/style-tags.json)
import { h } from './ui.js';
import { state, save } from './state.js';

let groupsPromise;
export function loadStyleGroups() {
  if (!groupsPromise) groupsPromise = fetch(new URL('../assets/style-tags.json', import.meta.url)).then((r) => r.json()).then((j) => j.groups);
  return groupsPromise;
}

export function toggleStyleTag(tag, weight = 1) {
  const list = state.settings.styleTags;
  const i = list.findIndex((t) => t.tag === tag);
  if (i >= 0) list.splice(i, 1);
  else list.push({ tag, weight });
  save.settings();
}

export async function openStylePicker() {
  const groups = await loadStyleGroups();
  let dlg = document.getElementById('styleDialog');
  if (dlg) dlg.remove();
  let active = groups[0].id;
  const body = h('div', { class: 'style-body' });
  const tabs = h('div', { class: 'seg' });
  const render = () => {
    tabs.replaceChildren(...groups.map((g) => h('button', { class: g.id === active ? 'on' : '', onclick: () => { active = g.id; render(); } }, g.label)));
    const g = groups.find((x) => x.id === active);
    const selected = new Set(state.settings.styleTags.map((t) => t.tag));
    body.replaceChildren(
      h('p', { class: 'note' }, g.desc),
      h('div', { class: 'style-grid' }, g.tags.map(([tag, desc]) =>
        h('button', { class: 'style-item' + (selected.has(tag) ? ' on' : ''), onclick: () => { toggleStyleTag(tag); render(); } },
          h('span', { class: 'st-tag' }, tag), h('span', { class: 'st-desc' }, desc)))),
    );
  };
  dlg = h('dialog', { id: 'styleDialog', class: 'wide' },
    h('div', { class: 'dlg-head' }, h('h3', {}, '화풍 태그'), h('form', { method: 'dialog' }, h('button', { class: 'ghost small' }, '닫기'))),
    tabs, body);
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  document.body.append(dlg);
  render();
  dlg.showModal();
}
