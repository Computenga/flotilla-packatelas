// Service worker: caché de la app para abrir sin señal + notificaciones push de Firebase.
const VERSION = 'flotilla-v1.1.0';
const SHELL = [
  './', './index.html', './css/app.css', './manifest.webmanifest',
  './js/app.js', './js/api.js', './js/media.js', './js/config.js',
  './icons/icon-192.png', './icons/icon-512.png',
];

importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyAsfJqMplaZtDDEX_rBIwNsU6eTfd2cks4',
  authDomain: 'flotilla-packatelas.firebaseapp.com',
  projectId: 'flotilla-packatelas',
  storageBucket: 'flotilla-packatelas.firebasestorage.app',
  messagingSenderId: '361944784904',
  appId: '1:361944784904:web:f7edcf16bec97f0dd8f1bd',
});
// Con payload "notification", el SDK muestra la notificación cuando la app está en segundo plano.
firebase.messaging();

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // API y CDNs van directo a la red
  // Red primero (para recibir actualizaciones), caché si no hay señal.
  e.respondWith(
    fetch(e.request)
      .then(res => { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html'))),
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.includes(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(self.registration.scope);
  }));
});
