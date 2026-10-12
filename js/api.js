// Llamadas a Apps Script + cola offline en IndexedDB.
import { CONFIG } from './config.js';

// ───────── Sesión ─────────
export const session = {
  get token() { return localStorage.getItem('fl_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('fl_user')); } catch { return null; } },
  set(token, user) { localStorage.setItem('fl_token', token); localStorage.setItem('fl_user', JSON.stringify(user)); },
  clear() { localStorage.removeItem('fl_token'); localStorage.removeItem('fl_user'); },
};

export class NetworkError extends Error {}

/** Llama una acción. Lanza NetworkError si no hay conexión, Error si el servidor la rechaza. */
export async function api(action, data = {}) {
  if (CONFIG.API_URL.startsWith('PENDIENTE')) throw new Error('Falta configurar la URL de Apps Script en js/config.js');
  let res;
  try {
    res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // evita preflight CORS
      body: JSON.stringify({ action, token: session.token, ...data }),
    });
  } catch (e) {
    throw new NetworkError('Sin conexión');
  }
  if (!res.ok) throw new NetworkError('Servidor no disponible (' + res.status + ')');
  const j = await res.json();
  if (!j.ok) {
    if (/Sesión (requerida|inválida|expirada)|Usuario inactivo/.test(j.error)) {
      session.clear();
      setTimeout(() => location.reload(), 1500);
    }
    throw new Error(j.error);
  }
  return j.data;
}

// ───────── IndexedDB ─────────
const DB = 'flotilla', STORE = 'cola';
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function store(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
export const queue = {
  add: job => store('readwrite', s => s.add(job)),
  put: job => store('readwrite', s => s.put(job)),
  del: id => store('readwrite', s => s.delete(id)),
  all: () => store('readonly', s => s.getAll()),
};

/**
 * Encola un envío. `data` puede contener fotos como { $photo: base64, kind, mime }:
 * se suben a Drive primero y se reemplazan por su URL.
 */
export async function submit(action, data, label, vehiculoId) {
  const id = await queue.add({ action, data, label, vehiculo_id: vehiculoId, created: Date.now(), error: null });
  return processJob(id);
}

let running = null;
/** Intenta enviar todo lo pendiente. Devuelve cuántos quedaron. */
export async function flushQueue() {
  if (running) return running;
  running = (async () => {
    const jobs = await queue.all();
    for (const job of jobs) {
      if (job.error) continue;
      try { await processJob(job.id); } catch (e) { if (e instanceof NetworkError) break; }
    }
    running = null;
    return (await queue.all()).length;
  })();
  return running;
}

async function processJob(id) {
  const job = (await queue.all()).find(j => j.id === id);
  if (!job) return null;
  try {
    await uploadPhotos(job, job.data);
    const result = await api(job.action, job.data);
    await queue.del(job.id);
    window.dispatchEvent(new CustomEvent('queue-change'));
    return { sent: true, result };
  } catch (e) {
    if (e instanceof NetworkError) {
      window.dispatchEvent(new CustomEvent('queue-change'));
      return { sent: false, queued: true };
    }
    job.error = e.message;
    await queue.put(job);
    window.dispatchEvent(new CustomEvent('queue-change'));
    throw e;
  }
}

/** Sube cada foto pendiente, la reemplaza por su URL en el mismo objeto y guarda el avance,
 *  para que un reintento después de perder señal no vuelva a subir las que ya llegaron. */
async function uploadPhotos(job, node) {
  if (!node || typeof node !== 'object') return;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && v.$photo) {
      const r = await api('uploadPhoto', { vehiculo_id: job.vehiculo_id || 'general', kind: v.kind || 'foto', base64: v.$photo, mime: v.mime });
      node[k] = r.url;
      await queue.put(job);
    } else if (v && typeof v === 'object') {
      await uploadPhotos(job, v);
    }
  }
}

export async function retryJob(id) {
  const job = (await queue.all()).find(j => j.id === id);
  if (!job) return;
  job.error = null;
  await queue.put(job);
  return processJob(id);
}
