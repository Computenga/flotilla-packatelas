// Fotos (compresión + sello de fecha), QR y notificaciones push.
import { CONFIG } from './config.js';
import { api } from './api.js';

const MAX_SIDE = 1280;
const QUALITY = 0.72;

/** Comprime una imagen y le estampa fecha/hora y un texto. Devuelve { base64, dataUrl, mime }. */
export async function processPhoto(file, stamp) {
  if (file.type === 'application/pdf') {
    const base64 = await fileToBase64(file);
    return { base64, dataUrl: null, mime: 'application/pdf', name: file.name };
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => loadImg(file));
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale), h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);

  const text = [new Date().toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' }), stamp].filter(Boolean).join(' · ');
  const size = Math.max(14, Math.round(w / 40));
  ctx.font = `600 ${size}px system-ui, sans-serif`;
  const pad = Math.round(size * 0.5);
  const tw = ctx.measureText(text).width;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(0, h - size - pad * 2, tw + pad * 2, size + pad * 2);
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, pad, h - pad - size / 2);

  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
  return { base64: dataUrl.split(',')[1], dataUrl, mime: 'image/jpeg' };
}

function loadImg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

/** Abre la cámara (o galería si el navegador no soporta capture) y devuelve el archivo elegido. */
export function pickFile({ accept = 'image/*', capture = true } = {}) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    if (capture) input.capture = 'environment';
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// ───────── Fotos de Drive (solo mecánico/admin) ─────────
const photoCache = new Map();
export async function drivePhoto(url) {
  if (!url) return null;
  if (photoCache.has(url)) return photoCache.get(url);
  const p = api('getPhoto', { url }).then(r => r.mime === 'application/pdf' ? { pdf: true, url } : { src: `data:${r.mime};base64,${r.base64}`, url });
  photoCache.set(url, p);
  p.catch(() => photoCache.delete(url));
  return p;
}

// ───────── QR ─────────
export function qrSupported() {
  return 'BarcodeDetector' in window;
}

/** Escanea un QR con la cámara. Devuelve el vehiculo_id o null si se cancela. */
export async function scanVehicleQR(container) {
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  container.replaceChildren(video);
  await video.play();
  return new Promise(resolve => {
    let done = false;
    const stop = val => {
      if (done) return;
      done = true;
      stream.getTracks().forEach(t => t.stop());
      resolve(val);
    };
    container._stop = () => stop(null);
    const tick = async () => {
      if (done) return;
      try {
        const codes = await detector.detect(video);
        const hit = codes.map(c => c.rawValue).find(v => v.startsWith(CONFIG.QR_PREFIX));
        if (hit) return stop(hit.slice(CONFIG.QR_PREFIX.length));
      } catch { /* frame no listo */ }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

// ───────── Push (Firebase Cloud Messaging) ─────────
let messagingP = null;
async function messaging() {
  if (!messagingP) {
    messagingP = (async () => {
      const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js');
      const app = initializeApp(CONFIG.firebase);
      return { m, msg: m.getMessaging(app) };
    })();
  }
  return messagingP;
}

export function pushState() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'no_soportado';
  return Notification.permission; // default | granted | denied
}

/** Pide permiso (debe llamarse desde un toque del usuario) y registra el dispositivo. */
export async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Permiso de notificaciones denegado');
  const reg = await navigator.serviceWorker.ready;
  const { m, msg } = await messaging();
  const token = await m.getToken(msg, { vapidKey: CONFIG.vapidKey, serviceWorkerRegistration: reg });
  if (!token) throw new Error('No se obtuvo token de notificaciones');
  const plataforma = /android/i.test(navigator.userAgent) ? 'android' : /iphone|ipad/i.test(navigator.userAgent) ? 'ios' : 'otro';
  await api('registerDevice', { fcm_token: token, plataforma });
  localStorage.setItem('fl_push_token', token);
  return token;
}

/** Re-registra el token al abrir la app (los tokens pueden rotar). */
export async function refreshPush(onForeground) {
  if (pushState() !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const { m, msg } = await messaging();
    const token = await m.getToken(msg, { vapidKey: CONFIG.vapidKey, serviceWorkerRegistration: reg });
    if (token && token !== localStorage.getItem('fl_push_token')) {
      await api('registerDevice', { fcm_token: token });
      localStorage.setItem('fl_push_token', token);
    }
    m.onMessage(msg, p => onForeground && onForeground(p.notification || {}));
  } catch (e) {
    console.warn('push', e);
  }
}
