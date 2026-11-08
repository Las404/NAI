// 공통 UI 도우미
export const $ = (id) => document.getElementById(id);

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'disabled') el.disabled = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

let toastBox;
export function toast(msg, kind = '') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts' }); document.body.append(toastBox); }
  const el = h('div', { class: 'toast ' + kind }, msg);
  toastBox.append(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

export function openLightbox(src, caption = '') {
  let dlg = $('lightbox');
  if (!dlg) {
    dlg = h('dialog', { id: 'lightbox', class: 'lightbox' },
      h('form', { method: 'dialog' }, h('button', { class: 'close' }, '✕')),
      h('img', { id: 'lightboxImg', alt: '' }),
      h('div', { id: 'lightboxCaption', class: 'note' }));
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  $('lightboxImg').src = src;
  $('lightboxCaption').textContent = caption;
  dlg.showModal();
}

export const randSeed = () => Math.floor(Math.random() * 4294967295);

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '-';
  sec = Math.max(0, Math.round(sec));
  const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}일 ${hh}시간`;
  if (hh) return `${hh}시간 ${m}분`;
  return `${m}분`;
}

// 파일 드래그앤드롭 영역
export function dropZone(el, onFile, accept = /^image\//) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag');
    const f = [...(e.dataTransfer?.files || [])].find((x) => accept.test(x.type));
    if (f) onFile(f);
  });
}

export function pickFile(accept, onFile) {
  const input = h('input', { type: 'file', accept, style: { display: 'none' } });
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.remove(); });
  document.body.append(input);
  input.click();
}
