// 생성 기록은 IndexedDB(이미지 포함), 설정·믹스·프리셋은 localStorage
const DB = 'geukkak';
const STORE = 'history';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const os = req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      os.createIndex('time', 'time');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const os = t.objectStore(STORE);
    const result = fn(os);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const history = {
  add: (item) => tx('readwrite', (os) => os.add(item)),
  put: (item) => tx('readwrite', (os) => os.put(item)),
  remove: (id) => tx('readwrite', (os) => os.delete(id)),
  all: () => tx('readonly', (os) => os.getAll()).then((rows) => rows.sort((a, b) => b.time - a.time)),
  clear: () => tx('readwrite', (os) => os.clear()),
};

export const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('gk.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem('gk.' + key, JSON.stringify(value));
  },
  del(key) {
    localStorage.removeItem('gk.' + key);
  },
};

// 토큰: "이 기기에 저장"을 체크하면 localStorage, 아니면 sessionStorage(탭 닫으면 사라짐)
export const token = {
  get: () => localStorage.getItem('gk.token') || sessionStorage.getItem('gk.token') || '',
  set(value, remember) {
    localStorage.removeItem('gk.token');
    sessionStorage.removeItem('gk.token');
    if (!value) return;
    (remember ? localStorage : sessionStorage).setItem('gk.token', value);
  },
  remembered: () => !!localStorage.getItem('gk.token'),
};
