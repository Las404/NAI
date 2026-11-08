// 단부루 태그 자동완성 (textarea/input에 붙임). 쉼표로 구분된 현재 토큰을 기준으로 추천.
import { h } from './ui.js';

let tagsPromise = null;
const CAT = { 0: ['일반', 'c0'], 1: ['작가', 'c1'], 3: ['작품', 'c3'], 4: ['캐릭터', 'c4'], 5: ['메타', 'c5'] };

function loadTags() {
  if (!tagsPromise) {
    tagsPromise = fetch(new URL('../assets/tags.json', import.meta.url))
      .then((r) => r.json())
      .then((j) => j.rows.map(([tag, cat, count, aliases]) => ({
        tag, cat, count, lower: tag.toLowerCase(),
        aliases: aliases ? aliases.toLowerCase().split(',') : [],
      })));
  }
  return tagsPromise;
}

let artistList = null;
export function setArtistSource(list) { artistList = list; }

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}

function currentToken(el) {
  const pos = el.selectionStart;
  const v = el.value;
  const start = v.lastIndexOf(',', pos - 1) + 1;
  let end = v.indexOf(',', pos);
  if (end < 0) end = v.length;
  const raw = v.slice(start, end);
  // 가중치 접두어(1.2::) / 괄호 제거
  const m = raw.match(/^(\s*(?:-?\d+(?:\.\d+)?::)?[\s{[]*)(.*?)([}\]\s:]*)$/);
  const lead = m ? m[1] : '';
  const word = m ? m[2] : raw.trim();
  return { start: start + lead.length, end: start + lead.length + word.length, word };
}

export function attachAutocomplete(el) {
  const box = h('div', { class: 'ac-box', role: 'listbox' });
  let items = [];
  let sel = 0;
  let open = false;
  document.body.append(box);

  const close = () => { open = false; box.style.display = 'none'; };
  const place = () => {
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left + window.scrollX}px`;
    box.style.top = `${r.bottom + window.scrollY + 2}px`;
    box.style.width = `${Math.max(280, r.width)}px`;
  };

  async function update() {
    if (document.activeElement !== el) return close();
    const { word } = currentToken(el);
    const q = word.trim().toLowerCase().replace(/_/g, ' ');
    if (q.length < 2) return close();
    let list = [];
    const isArtist = q.startsWith('artist:');
    if (isArtist && artistList) {
      const qq = q.slice(7).trim();
      list = artistList.filter((a) => a.lower.startsWith(qq)).slice(0, 12)
        .map((a) => ({ tag: 'artist:' + a.tag, cat: 1, count: (a.g.loose?.up || 0) }));
    } else {
      const tags = await loadTags();
      const pre = [], ali = [], sub = [];
      for (const t of tags) {
        if (t.lower.startsWith(q)) pre.push(t);
        else if (t.aliases.some((a) => a.startsWith(q))) ali.push(t);
        else if (q.length >= 3 && t.lower.includes(q)) sub.push(t);
        if (pre.length >= 12) break;
      }
      list = [...pre, ...ali, ...sub].slice(0, 12); // tags.json은 사용 횟수 순으로 정렬돼 있음
    }
    items = list;
    sel = 0;
    if (!items.length || document.activeElement !== el) return close();
    render();
  }

  function render() {
    box.replaceChildren(...items.map((t, i) =>
      h('div', { class: 'ac-item' + (i === sel ? ' sel' : ''), onmousedown: (e) => { e.preventDefault(); pick(i); } },
        h('span', { class: 'ac-tag ' + (CAT[t.cat]?.[1] || '') }, t.tag),
        h('span', { class: 'ac-meta' }, `${CAT[t.cat]?.[0] || ''} ${t.cat === 1 && t.tag.startsWith('artist:') ? '👍' + t.count : fmtCount(t.count)}`))));
    place();
    box.style.display = 'block';
    open = true;
  }

  function pick(i) {
    const t = items[i];
    if (!t) return;
    const { start, end } = currentToken(el);
    const v = el.value;
    // 토큰 뒤에 붙어 있던 가중치 닫는 기호(::, }, ])는 살리고, 이어지는 쉼표는 하나로 정리
    const tail = v.slice(end).match(/^([}\]:]*)\s*,?\s*/);
    const closer = tail ? tail[1] : '';
    const rest = v.slice(end + (tail ? tail[0].length : 0));
    const insert = t.tag + closer + ', ';
    el.value = v.slice(0, start) + insert + rest;
    const caret = start + insert.length;
    el.setSelectionRange(caret, caret);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    close();
  }

  el.addEventListener('input', () => update());
  el.addEventListener('focus', () => loadTags());
  el.addEventListener('blur', () => setTimeout(close, 120));
  el.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; render(); e.preventDefault(); }
    else if (e.key === 'Enter' || e.key === 'Tab') { if (!e.ctrlKey) { pick(sel); e.preventDefault(); } }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  window.addEventListener('scroll', () => open && place(), true);
  window.addEventListener('resize', close);
  window.addEventListener('hashchange', close);
}
