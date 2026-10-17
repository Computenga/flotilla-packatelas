import { CONFIG } from './config.js';
import { api, session, submit, flushQueue, queue, retryJob, NetworkError } from './api.js';
import { processPhoto, pickFile, drivePhoto, qrSupported, scanVehicleQR, pushState, enablePush, refreshPush } from './media.js';

// ═════════ Utilidades de DOM ═════════
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $app = document.getElementById('app');
/** Como replaceChildren, pero acepta arreglos anidados y omite null/false (igual que h()). */
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false).map(c => c instanceof Node ? c : document.createTextNode(String(c))));
  return el;
}
const money = n => '$' + Number(n || 0).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const num = (n, d = 1) => n == null || n === '' ? '—' : Number(n).toLocaleString('es-MX', { maximumFractionDigits: d });
const today = () => new Date().toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10);

function toast(msg, kind = 'info', ms = 3500) {
  document.querySelectorAll('.toast').forEach(old => old.remove());
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

async function busy(label, fn) {
  const ov = h('div', { class: 'overlay' }, h('div', { class: 'spinner' }), h('p', {}, label));
  document.body.append(ov);
  try { return await fn(); } finally { ov.remove(); }
}

function screen(title, body, { back, actions } = {}) {
  $app.replaceChildren(
    h('header', { class: 'topbar' },
      back ? h('button', { class: 'icon-btn', 'aria-label': 'Regresar', onclick: back }, '←') : h('span', { class: 'logo' }, '🛵'),
      h('h1', {}, title),
      actions || h('span')),
    h('main', { class: 'content' }, body),
    nav(),
  );
  window.scrollTo(0, 0);
}

// ═════════ Estado ═════════
const state = { tab: null, vehiculos: null };
const role = () => session.user?.rol;

async function vehiculos(force) {
  if (!state.vehiculos || force) {
    try {
      state.vehiculos = await api('vehiculos');
      localStorage.setItem('fl_veh', JSON.stringify(state.vehiculos));
    } catch (e) {
      state.vehiculos = JSON.parse(localStorage.getItem('fl_veh') || '[]');
      if (!(e instanceof NetworkError)) throw e;
    }
  }
  return state.vehiculos;
}

// ═════════ Navegación ═════════
const TABS = {
  repartidor: [['jornada', '🛵', 'Mi jornada'], ['historial', '📋', 'Historial'], ['cuenta', '👤', 'Cuenta']],
  mecanico: [['fallas', '🔧', 'Fallas'], ['documentos', '📄', 'Documentos'], ['dashboard', '📊', 'Métricas'], ['cuenta', '👤', 'Cuenta']],
  admin: [['dashboard', '📊', 'Métricas'], ['fallas', '🔧', 'Fallas'], ['documentos', '📄', 'Docs'], ['jornada', '🛵', 'Jornada'], ['cuenta', '👤', 'Más']],
};
function nav() {
  const tabs = TABS[role()];
  if (!tabs) return h('span');
  return h('nav', { class: 'tabbar' }, tabs.map(([id, icon, label]) =>
    h('button', { class: state.tab === id ? 'active' : '', onclick: () => go(id) }, h('span', { class: 'ti' }, icon), h('span', {}, label))));
}
function go(tab) {
  state.tab = tab;
  ({ jornada: jornada, historial: historial, cuenta: cuenta, fallas: fallas, documentos: documentos, dashboard: dashboard }[tab] || jornada)();
}

// ═════════ Login ═════════
async function login() {
  $app.replaceChildren(h('div', { class: 'login' },
    h('div', { class: 'brand' }, h('div', { class: 'logo-big' }, '🛵'), h('h1', {}, 'Flotilla Packatelas'), h('p', {}, 'Checks, fallas y reparaciones')),
    h('div', { class: 'card', id: 'login-card' }, h('div', { class: 'spinner' }))));
  let users;
  try { users = await api('usuariosLogin'); } catch (e) {
    fill(document.getElementById('login-card'), h('p', { class: 'error' }, e.message), h('button', { class: 'btn', onclick: login }, 'Reintentar'));
    return;
  }
  let pin = '';
  const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'Selecciona tu nombre'), users.map(u => h('option', { value: u.usuario_id }, u.nombre)));
  const last = localStorage.getItem('fl_last_user');
  if (last) sel.value = last;
  const dots = h('div', { class: 'pin-dots' });
  const draw = () => fill(dots, ...Array.from({ length: Math.max(4, pin.length) }, (_, i) => h('span', { class: i < pin.length ? 'on' : '' })));
  draw();
  const send = async () => {
    if (!sel.value) return toast('Selecciona tu nombre', 'warn');
    if (pin.length < 4) return toast('El PIN tiene al menos 4 dígitos', 'warn');
    try {
      const r = await busy('Entrando…', () => api('login', { usuario_id: sel.value, pin }));
      session.set(r.token, r.usuario);
      localStorage.setItem('fl_last_user', sel.value);
      if (r.cambiar_pin) return cambiarPinView(pin, true);
      start();
    } catch (e) { pin = ''; draw(); toast(e.message, 'error'); }
  };
  const key = k => () => {
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (k === '✓') return send();
    else if (pin.length < 8) pin += k;
    draw();
  };
  fill(document.getElementById('login-card'), 
    h('label', { class: 'label' }, 'Usuario'), sel,
    h('label', { class: 'label' }, 'PIN'), dots,
    h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k =>
      h('button', { class: k === '✓' ? 'key ok' : 'key', onclick: key(k) }, k))));
}

// ═════════ Repartidor: jornada ═════════
async function jornada() {
  state.tab = 'jornada';
  const body = h('div', {}, h('p', { class: 'muted cap' }, today()), h('div', { class: 'spinner' }));
  screen('Hola, ' + (session.user.nombre || '').split(' ')[0], body);
  let p = { check_matutino: null, carga_combustible: null }, offline = false;
  try { p = await api('pendientesHoy'); } catch (e) { if (e instanceof NetworkError) offline = true; else return toast(e.message, 'error'); }
  const pend = await queue.all();
  const queuedCheck = pend.find(j => j.action === 'checkMatutino');
  const queuedCarga = pend.find(j => j.action === 'cargaCombustible');

  const c = p.check_matutino, g = p.carga_combustible;
  fill(body, 
    h('p', { class: 'muted cap' }, today()),
    offline && h('div', { class: 'banner warn' }, 'Sin conexión. Puedes registrar y se enviará al recuperar señal.'),
    pendingBanner(pend),
    h('div', { class: 'step ' + (c || queuedCheck ? 'done' : 'todo') },
      h('div', { class: 'step-n' }, c || queuedCheck ? '✓' : '1'),
      h('div', { class: 'step-body' },
        h('h3', {}, 'Check matutino'),
        c ? h('p', {}, `Moto ${c.vehiculo_id} · ${num(c.km, 0)} km · ${c.hora}`)
          : queuedCheck ? h('p', {}, 'Guardado, pendiente de envío')
          : h('p', { class: 'muted' }, 'Moto con la que llegaste: 4 fotos, odómetro y fallas'),
        !c && !queuedCheck && h('button', { class: 'btn primary', onclick: checkMatutino }, 'Hacer check'))),
    h('div', { class: 'step ' + (g || queuedCarga ? 'done' : (c || queuedCheck) ? 'todo' : 'locked') },
      h('div', { class: 'step-n' }, g || queuedCarga ? '✓' : '2'),
      h('div', { class: 'step-body' },
        h('h3', {}, 'Carga de gasolina'),
        g ? h('p', {}, `Registrada · ${money(g.monto)}`)
          : queuedCarga ? h('p', {}, 'Guardada, pendiente de envío')
          : h('p', { class: 'muted' }, c || queuedCheck ? 'Monto, litros y foto del ticket' : 'Disponible después del check matutino'),
        !g && !queuedCarga && (c || queuedCheck) && h('button', { class: 'btn primary', onclick: cargaGasolina }, 'Registrar carga'))),
    h('div', { class: 'step optional' },
      h('div', { class: 'step-n' }, '!'),
      h('div', { class: 'step-body' },
        h('h3', {}, 'Antes de ir a ruta'),
        h('p', { class: 'muted' }, 'Opcional: reporta un daño de la moto que te llevas y que no se reportó en la mañana.'),
        h('button', { class: 'btn', onclick: antesRuta }, 'Reportar daño'))),
    pushCard(),
  );
}

function pendingBanner(pend) {
  if (!pend.length) return null;
  const errs = pend.filter(j => j.error);
  return h('div', { class: 'banner ' + (errs.length ? 'error' : 'info') },
    h('strong', {}, pend.length + ' envío(s) pendiente(s)'),
    errs.map(j => h('div', { class: 'qerr' }, `${j.label}: ${j.error} `,
      h('button', { class: 'link', onclick: async () => { try { await busy('Reintentando…', () => retryJob(j.id)); } catch (e) { toast(e.message, 'error'); } go(state.tab); } }, 'Reintentar'),
      h('button', { class: 'link danger', onclick: async () => { await queue.del(j.id); go(state.tab); } }, 'Descartar'))),
    !errs.length && h('button', { class: 'link', onclick: async () => { const left = await busy('Enviando…', flushQueue); toast(left ? 'Aún sin señal' : 'Enviado', left ? 'warn' : 'ok'); go(state.tab); } }, 'Enviar ahora'));
}

function pushCard() {
  if (EMBED) return null; // dentro del portal, los avisos los maneja el portal
  const st = pushState();
  if (st === 'granted' || st === 'no_soportado') return null;
  return h('div', { class: 'card soft' },
    h('h3', {}, '🔔 Notificaciones'),
    h('p', { class: 'muted' }, st === 'denied' ? 'Las bloqueaste en el navegador. Actívalas en la configuración del sitio.' : 'Actívalas para recibir avisos en este teléfono.'),
    st !== 'denied' && h('button', { class: 'btn', onclick: async () => {
      try { await busy('Activando…', enablePush); toast('Notificaciones activadas', 'ok'); go(state.tab); } catch (e) { toast(e.message, 'error'); }
    } }, 'Activar notificaciones'));
}

// ───────── Selección de moto ─────────
async function chooseVehicle(title) {
  const list = await vehiculos();
  return new Promise(resolve => {
    const box = h('div', { class: 'qr-box' });
    const close = val => { box._stop && box._stop(); modal.remove(); resolve(val); };
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, 'Elegir de la lista'), list.map(v => h('option', { value: v.vehiculo_id }, `${v.vehiculo_id} · ${v.placa || ''} ${v.modelo || ''}`)));
    const modal = h('div', { class: 'modal' }, h('div', { class: 'sheet' },
      h('h2', {}, title),
      qrSupported() ? box : h('p', { class: 'muted' }, 'Tu navegador no puede escanear QR; elige la moto de la lista.'),
      sel,
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => close(null) }, 'Cancelar'),
        h('button', { class: 'btn primary', onclick: () => sel.value ? close(sel.value) : toast('Escanea o elige una moto', 'warn') }, 'Continuar'))));
    document.body.append(modal);
    if (qrSupported()) {
      scanVehicleQR(box).then(id => {
        if (!id) return;
        if (!list.some(v => v.vehiculo_id === id)) { toast('QR no reconocido: ' + id, 'error'); return; }
        navigator.vibrate && navigator.vibrate(80);
        close(id);
      }).catch(() => fill(box, h('p', { class: 'muted' }, 'No se pudo abrir la cámara; elige de la lista.')));
    }
  });
}

// ───────── Componente de foto ─────────
function photoSlot(label, stamp, opts = {}) {
  const slot = { value: null };
  const img = h('div', { class: 'ph-img' }, h('span', {}, '📷'));
  const el = h('button', { class: 'photo-slot', type: 'button', onclick: async () => {
    const file = await pickFile({ accept: opts.accept || 'image/*', capture: opts.capture !== false });
    if (!file) return;
    try {
      const p = await busy('Procesando foto…', () => processPhoto(file, stamp()));
      slot.value = { $photo: p.base64, mime: p.mime, kind: opts.kind || 'foto' };
      fill(img, p.dataUrl ? h('img', { src: p.dataUrl, alt: label }) : h('span', { class: 'pdf' }, '📄 PDF'));
      el.classList.add('filled');
      opts.onchange && opts.onchange();
    } catch (e) { toast('No se pudo leer la foto', 'error'); }
  } }, img, h('span', { class: 'ph-label' }, label));
  slot.el = el;
  return slot;
}

function photoGroup(min, max, stamp, kind) {
  const slots = [];
  const grid = h('div', { class: 'photo-grid' });
  const addBtn = h('button', { class: 'photo-add', type: 'button', onclick: () => add() }, '+ Foto');
  const add = () => {
    if (slots.length >= max) return;
    const s = photoSlot('Foto ' + (slots.length + 1), stamp, { kind });
    slots.push(s);
    grid.insertBefore(s.el, addBtn);
    if (slots.length >= max) addBtn.remove();
    s.el.click();
  };
  grid.append(addBtn);
  return { el: grid, values: () => slots.map(s => s.value).filter(Boolean), min };
}

// ───────── Check matutino ─────────
async function checkMatutino() {
  const vid = await chooseVehicle('¿Con qué moto llegaste?');
  if (!vid) return;
  const veh = state.vehiculos.find(v => v.vehiculo_id === vid) || {};
  const stamp = () => `${vid} · ${session.user.nombre}`;
  const sides = ['Frente', 'Trasera', 'Lado izquierdo', 'Lado derecho'].map(l => photoSlot(l, stamp, { kind: 'check' }));
  const odo = photoSlot('Odómetro', stamp, { kind: 'odometro' });
  const km = h('input', { class: 'input big', type: 'number', inputmode: 'numeric', placeholder: 'Km del odómetro' });
  const kmHint = h('p', { class: 'muted small' }, veh.km_actual ? `Último registro de esta moto: ${num(veh.km_actual, 0)} km` : '');
  km.addEventListener('input', () => {
    const v = Number(km.value);
    kmHint.className = 'small ' + (veh.km_actual && v && v < veh.km_actual ? 'error' : 'muted');
    kmHint.textContent = veh.km_actual ? (v && v < veh.km_actual ? `⚠ Menor al último registro (${num(veh.km_actual, 0)} km)` : v ? `Recorridos desde el último check: ${num(v - veh.km_actual, 0)} km` : `Último registro de esta moto: ${num(veh.km_actual, 0)} km`) : '';
  });
  const fallas = [];
  const fallasBox = h('div', {});
  const addFalla = () => {
    const desc = h('textarea', { class: 'input', rows: 2, placeholder: '¿Qué falla tiene? (ej. luz trasera fundida)' });
    const sev = h('select', { class: 'input' }, ['media', 'alta', 'baja'].map(s => h('option', { value: s }, 'Severidad ' + s)));
    const photos = photoGroup(0, 4, stamp, 'falla');
    const f = { desc, sev, photos };
    const card = h('div', { class: 'card falla-form' },
      h('div', { class: 'row between' }, h('strong', {}, 'Falla ' + (fallas.length + 1)), h('button', { class: 'link danger', type: 'button', onclick: () => { fallas.splice(fallas.indexOf(f), 1); card.remove(); } }, 'Quitar')),
      desc, sev, photos.el);
    fallas.push(f);
    fallasBox.append(card);
    desc.focus();
  };
  const send = async () => {
    const fotos = sides.map(s => s.value);
    if (fotos.some(f => !f)) return toast('Faltan fotos de la moto', 'warn');
    if (!odo.value) return toast('Falta la foto del odómetro', 'warn');
    if (!(Number(km.value) > 0)) return toast('Captura los km', 'warn');
    if (veh.km_actual && Number(km.value) < veh.km_actual) return toast('Los km no pueden ser menores al último registro', 'error');
    const lista = fallas.filter(f => f.desc.value.trim()).map(f => ({ descripcion: f.desc.value.trim(), severidad: f.sev.value, fotos: f.photos.values() }));
    const pos = await position();
    try {
      const r = await busy('Enviando check…', () => submit('checkMatutino', { vehiculo_id: vid, km: Number(km.value), fotos, foto_odometro: odo.value, fallas: lista, ...pos }, 'Check matutino ' + vid, vid));
      toast(r && r.sent ? 'Check registrado' + (lista.length ? ` con ${lista.length} falla(s)` : '') : 'Guardado sin señal; se enviará después', r && r.sent ? 'ok' : 'warn');
      jornada();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
  screen('Check matutino · ' + vid, h('div', {},
    h('h2', { class: 'section' }, '1. Fotos de la moto'),
    h('div', { class: 'photo-grid' }, sides.map(s => s.el)),
    h('h2', { class: 'section' }, '2. Odómetro'),
    h('div', { class: 'photo-grid one' }, odo.el), km, kmHint,
    h('h2', { class: 'section' }, '3. Fallas'),
    h('p', { class: 'muted' }, 'Si la moto no tiene fallas, deja esta sección vacía.'),
    fallasBox,
    h('button', { class: 'btn', type: 'button', onclick: addFalla }, '+ Agregar falla'),
    h('button', { class: 'btn primary block', onclick: send }, 'Enviar check')), { back: jornada });
}

async function cargaGasolina() {
  const p = await api('pendientesHoy').catch(() => null);
  const vid = p?.check_matutino?.vehiculo_id || 'moto';
  const stamp = () => `Gasolina ${vid} · ${session.user.nombre}`;
  const monto = h('input', { class: 'input big', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Monto $' });
  const litros = h('input', { class: 'input big', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Litros' });
  const ticket = photoSlot('Ticket', stamp, { kind: 'ticket' });
  const send = async () => {
    if (!(Number(monto.value) > 0) || !(Number(litros.value) > 0)) return toast('Captura monto y litros', 'warn');
    if (!ticket.value) return toast('Falta la foto del ticket', 'warn');
    try {
      const r = await busy('Enviando…', () => submit('cargaCombustible', { monto: Number(monto.value), litros: Number(litros.value), foto_ticket: ticket.value }, 'Carga de gasolina', vid));
      toast(r && r.sent ? 'Carga registrada' + (r.result?.km_por_litro ? ` · ${r.result.km_por_litro} km/L` : '') : 'Guardada sin señal', r && r.sent ? 'ok' : 'warn');
      jornada();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
  screen('Carga de gasolina', h('div', {},
    h('p', { class: 'muted' }, 'Se liga a tu check matutino de hoy' + (p?.check_matutino ? ` (moto ${vid}).` : '.')),
    h('label', { class: 'label' }, 'Monto pagado'), monto,
    h('label', { class: 'label' }, 'Litros'), litros,
    h('div', { class: 'photo-grid one' }, ticket.el),
    h('button', { class: 'btn primary block', onclick: send }, 'Registrar carga')), { back: jornada });
}

async function antesRuta() {
  const vid = await chooseVehicle('¿Qué moto te llevas a ruta?');
  if (!vid) return;
  const stamp = () => `Antes de ruta ${vid} · ${session.user.nombre}`;
  const desc = h('textarea', { class: 'input', rows: 3, placeholder: 'Describe el daño que encontraste' });
  const sev = h('select', { class: 'input' }, ['media', 'alta', 'baja'].map(s => h('option', { value: s }, 'Severidad ' + s)));
  const photos = photoGroup(1, 4, stamp, 'antes_ruta');
  const send = async () => {
    if (!desc.value.trim()) return toast('Describe el daño', 'warn');
    const fotos = photos.values();
    if (fotos.length < 1) return toast('Agrega al menos una foto', 'warn');
    const pos = await position();
    try {
      const r = await busy('Enviando…', () => submit('checkAntesRuta', { vehiculo_id: vid, descripcion: desc.value.trim(), severidad: sev.value, fotos, ...pos }, 'Daño antes de ruta ' + vid, vid));
      toast(r && r.sent ? 'Daño reportado al mecánico' : 'Guardado sin señal', r && r.sent ? 'ok' : 'warn');
      jornada();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
  screen('Antes de ruta · ' + vid, h('div', {},
    h('div', { class: 'banner info' }, 'Se registrará como daño no reportado y se asignará a quien entregó esta moto en el check matutino.'),
    desc, sev,
    h('h2', { class: 'section' }, 'Fotos (1 a 4)'), photos.el,
    h('button', { class: 'btn primary block', onclick: send }, 'Reportar daño')), { back: jornada });
}

function position() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(p => resolve({ lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6) }), () => resolve({}), { timeout: 5000, maximumAge: 60000 });
  });
}

// ═════════ Repartidor: historial ═════════
async function historial() {
  state.tab = 'historial';
  const body = h('div', {}, h('div', { class: 'spinner' }));
  screen('Historial', body);
  try {
    const [fallasL, cargos] = await Promise.all([api('misFallas'), api('misCargos')]);
    const total = cargos.reduce((s, c) => s + Number(c.monto_empleado || 0), 0);
    fill(body, 
      h('h2', { class: 'section' }, 'Mis cargos por reparación'),
      cargos.length ? h('div', {}, h('p', { class: 'muted' }, 'Total: ' + money(total)),
        cargos.map(c => h('div', { class: 'card row between' },
          h('div', {}, h('strong', {}, c.descripcion), h('p', { class: 'muted small' }, `${c.fecha} · Moto ${c.vehiculo_id} · ${c.causa === 'mal_uso' ? 'Mal uso' : 'Acuerdo'}`)),
          h('strong', { class: 'amount' }, money(c.monto_empleado)))))
        : h('p', { class: 'muted' }, 'Sin cargos.'),
      h('h2', { class: 'section' }, 'Fallas reportadas o asignadas'),
      fallasL.length ? fallasL.map(f => fallaCard(f, null)) : h('p', { class: 'muted' }, 'Sin fallas.'));
  } catch (e) { fill(body, h('p', { class: 'error' }, e.message)); }
}

// ═════════ Mecánico: fallas ═════════
const ESTATUS = { abierta: 'Abierta', en_reparacion: 'En reparación', cerrada: 'Cerrada', descartada: 'Descartada' };

function fallaCard(f, onclick) {
  return h(onclick ? 'button' : 'div', { class: `card falla sev-${f.severidad}`, onclick },
    h('div', { class: 'row between' },
      h('strong', {}, `${f.vehiculo_id} · ${f.falla_id}`),
      h('span', { class: `badge st-${f.estatus}` }, ESTATUS[f.estatus] || f.estatus)),
    h('p', {}, f.descripcion),
    h('p', { class: 'muted small' },
      f.tipo === 'no_reportado' ? h('span', { class: 'badge warn' }, 'No reportado en la mañana') : null, ' ',
      f.fecha_reporte, f.horas_abierta != null && (f.estatus === 'abierta' || f.estatus === 'en_reparacion') ? ` · ${num(f.horas_abierta)} h` : '',
      f.responsable_nombre ? ` · Responsable: ${f.responsable_nombre}` : ''));
}

async function fallas(filtro = 'pendientes') {
  state.tab = 'fallas';
  const body = h('div', {}, h('div', { class: 'spinner' }));
  screen('Fallas', body, { actions: h('button', { class: 'icon-btn', 'aria-label': 'Actualizar', onclick: () => fallas(filtro) }, '↻') });
  const estatus = { pendientes: ['abierta', 'en_reparacion'], cerradas: ['cerrada'], descartadas: ['descartada'] }[filtro];
  try {
    const list = await api('fallas', { estatus });
    fill(body, 
      h('div', { class: 'chips' }, [['pendientes', 'Pendientes'], ['cerradas', 'Cerradas'], ['descartadas', 'Descartadas']].map(([k, l]) =>
        h('button', { class: 'chip ' + (k === filtro ? 'on' : ''), onclick: () => fallas(k) }, l))),
      pushCard(),
      list.length ? list.map(f => fallaCard(f, () => fallaDetalle(f.falla_id, filtro))) : h('p', { class: 'muted center' }, filtro === 'pendientes' ? 'Sin fallas pendientes 🎉' : 'Sin registros.'));
  } catch (e) { fill(body, h('p', { class: 'error' }, e.message)); }
}

function gallery(urls) {
  const g = h('div', { class: 'gallery' });
  urls.forEach(u => {
    const cell = h('a', { class: 'g-cell', href: u, target: '_blank', rel: 'noopener' }, h('div', { class: 'spinner sm' }));
    g.append(cell);
    drivePhoto(u).then(p => fill(cell, p.pdf ? h('span', { class: 'pdf' }, '📄 PDF') : h('img', { src: p.src, loading: 'lazy', alt: 'Foto' })))
      .catch(() => fill(cell, h('span', { class: 'muted small' }, 'Abrir en Drive')));
  });
  return g;
}

async function fallaDetalle(id, filtro) {
  const body = h('div', {}, h('div', { class: 'spinner' }));
  screen('Falla ' + id, body, { back: () => fallas(filtro) });
  let f;
  try { f = await api('falla', { falla_id: id }); } catch (e) { return fill(body, h('p', { class: 'error' }, e.message)); }
  const act = async (label, action, data, msg) => {
    try { await busy(label, () => api(action, { falla_id: id, ...data })); toast(msg, 'ok'); fallaDetalle(id, filtro); } catch (e) { toast(e.message, 'error'); }
  };
  const rep = f.reparacion;
  fill(body, 
    fallaCard(f, null),
    h('p', { class: 'small' }, `Reportó: ${f.reportada_por_nombre} · Responsable: ${f.responsable_nombre || '—'}`),
    f.fotos.length ? gallery(f.fotos) : h('p', { class: 'muted' }, 'Sin fotos.'),

    f.check_matutino && h('div', { class: 'card soft' },
      h('h3', {}, f.tipo === 'no_reportado' ? 'Comparar con el check matutino' : 'Check matutino'),
      h('p', { class: 'muted small' }, `${f.check_matutino.check_id} · ${f.check_matutino.fecha} · ${f.check_matutino.usuario} · ${num(f.check_matutino.km, 0)} km`),
      gallery(f.check_matutino.fotos),
      f.tipo === 'no_reportado' && h('div', {},
        h('p', {}, 'Validación: ', h('strong', {}, { pendiente: 'Pendiente', confirmado: 'Se ve en el check matutino', no_visible: 'No se ve en el check matutino' }[f.validacion_mecanico] || 'Pendiente')),
        h('div', { class: 'row' },
          h('button', { class: 'btn', onclick: () => act('Guardando…', 'validarFalla', { resultado: 'confirmado' }, 'Marcado como visible en la mañana') }, 'Sí se ve'),
          h('button', { class: 'btn', onclick: () => act('Guardando…', 'validarFalla', { resultado: 'no_visible' }, 'Marcado como no visible') }, 'No se ve')))),

    rep && h('div', { class: 'card' },
      h('h3', {}, 'Reparación ' + rep.rep_id),
      h('p', { class: 'small' }, `Inicio: ${rep.fecha_inicio} · respuesta ${num(rep.horas_respuesta)} h`),
      rep.fecha_cierre && h('div', {},
        h('p', { class: 'small' }, `Cierre: ${rep.fecha_cierre} · reparación ${num(rep.horas_reparacion)} h`),
        h('p', {}, rep.descripcion),
        h('p', {}, `Total ${money(rep.costo_total)} (refacciones ${money(rep.costo_refacciones)}, mano de obra ${money(rep.costo_mano_obra)})`),
        h('p', {}, `Causa: ${rep.causa} · Empresa ${money(rep.monto_empresa)} · Empleado ${money(rep.monto_empleado)}`),
        rep.fotos.length && gallery(rep.fotos))),

    f.estatus === 'abierta' && h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => act('Iniciando…', 'iniciarReparacion', {}, 'Reparación iniciada') }, 'Iniciar reparación'),
      h('button', { class: 'btn danger-o', onclick: () => confirmInline(body, '¿Descartar esta falla?', () => act('Descartando…', 'descartarFalla', {}, 'Falla descartada')) }, 'Descartar')),
    (f.estatus === 'abierta' || f.estatus === 'en_reparacion') && h('button', { class: 'btn primary block', onclick: () => cerrarForm(f, filtro) }, 'Cerrar reparación'),
  );
}

function confirmInline(container, text, yes) {
  const bar = h('div', { class: 'banner warn row between' }, text,
    h('span', {}, h('button', { class: 'link danger', onclick: () => { bar.remove(); yes(); } }, 'Sí'), ' ', h('button', { class: 'link', onclick: () => bar.remove() }, 'No')));
  container.append(bar);
  bar.scrollIntoView({ behavior: 'smooth' });
}

function cerrarForm(f, filtro) {
  const stamp = () => `Reparación ${f.vehiculo_id} · ${f.falla_id}`;
  const desc = h('textarea', { class: 'input', rows: 3, placeholder: '¿Qué se reparó?' });
  const refac = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Refacciones $' });
  const mano = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Mano de obra $' });
  const causa = h('select', { class: 'input' },
    h('option', { value: 'desgaste' }, 'Desgaste — paga la empresa'),
    h('option', { value: 'mal_uso' }, 'Mal uso — paga el empleado'),
    h('option', { value: 'acuerdo' }, 'Acuerdo — se reparte'));
  const empleado = h('input', { class: 'input', type: 'number', inputmode: 'decimal', step: '0.01', placeholder: 'Monto que paga el empleado $' });
  const empBox = h('div', { class: 'hidden' }, h('label', { class: 'label' }, 'Parte del empleado'), empleado);
  const resumen = h('p', { class: 'summary' });
  const calc = () => {
    const total = (Number(refac.value) || 0) + (Number(mano.value) || 0);
    empBox.classList.toggle('hidden', causa.value !== 'acuerdo');
    const emp = causa.value === 'mal_uso' ? total : causa.value === 'acuerdo' ? Math.min(Number(empleado.value) || 0, total) : 0;
    resumen.textContent = `Total ${money(total)} · Empresa ${money(total - emp)} · Empleado ${money(emp)}` + (f.responsable_nombre && emp ? ` (${f.responsable_nombre})` : '');
  };
  [refac, mano, empleado].forEach(i => i.addEventListener('input', calc));
  causa.addEventListener('change', calc);
  calc();
  const photos = photoGroup(0, 4, stamp, 'reparacion');
  const send = async () => {
    if (!desc.value.trim()) return toast('Describe la reparación', 'warn');
    try {
      const r = await busy('Cerrando reparación…', () => submit('cerrarReparacion', {
        falla_id: f.falla_id, descripcion: desc.value.trim(), fotos: photos.values(),
        costo_refacciones: Number(refac.value) || 0, costo_mano_obra: Number(mano.value) || 0,
        causa: causa.value, monto_empleado: Number(empleado.value) || 0,
      }, 'Cierre ' + f.falla_id, f.vehiculo_id));
      toast(r && r.sent ? 'Reparación cerrada' : 'Guardado sin señal', r && r.sent ? 'ok' : 'warn');
      fallas(filtro);
    } catch (e) { toast(e.message, 'error', 6000); }
  };
  screen('Cerrar ' + f.falla_id, h('div', {},
    h('p', {}, h('strong', {}, f.vehiculo_id), ' · ', f.descripcion),
    desc,
    h('h2', { class: 'section' }, 'Evidencia'), photos.el,
    h('h2', { class: 'section' }, 'Costos'), refac, mano,
    h('label', { class: 'label' }, '¿Quién paga?'), causa, empBox, resumen,
    h('button', { class: 'btn primary block', onclick: send }, 'Cerrar reparación')), { back: () => fallaDetalle(f.falla_id, filtro) });
}

// ═════════ Documentos ═════════
const TIPOS_DOC = { tarjeta_circulacion: 'Tarjeta de circulación', verificacion: 'Verificación', seguro: 'Seguro', permiso: 'Permiso', tenencia: 'Tenencia', otro: 'Otro' };

async function documentos() {
  state.tab = 'documentos';
  const body = h('div', {}, h('div', { class: 'spinner' }));
  screen('Documentos', body, { actions: h('button', { class: 'icon-btn', 'aria-label': 'Agregar', onclick: () => docForm() }, '+') });
  try {
    const docs = await api('documentos');
    const label = d => d.estado === 'vencido' ? `Vencido hace ${-d.dias_restantes} d` : d.estado === 'por_vencer' ? `Vence en ${d.dias_restantes} d` : d.estado === 'vigente' ? `Vigente · ${d.dias_restantes} d` : 'Sin vigencia';
    fill(body, 
      h('button', { class: 'btn primary block', onclick: () => docForm() }, '+ Agregar documento'),
      docs.length ? docs.map(d => h('button', { class: `card doc st-${d.estado}`, onclick: () => docForm(d) },
        h('div', { class: 'row between' }, h('strong', {}, `${d.vehiculo_id} · ${TIPOS_DOC[d.tipo] || d.tipo}`), h('span', { class: `badge d-${d.estado}` }, label(d))),
        h('p', { class: 'muted small' }, `Vigencia: ${d.vigencia}${d.folio ? ' · Folio ' + d.folio : ''}`)))
        : h('p', { class: 'muted center' }, 'Aún no hay documentos registrados.'));
  } catch (e) { fill(body, h('p', { class: 'error' }, e.message)); }
}

async function docForm(doc) {
  const list = await vehiculos();
  const veh = h('select', { class: 'input' }, list.map(v => h('option', { value: v.vehiculo_id }, `${v.vehiculo_id} · ${v.placa || ''}`)));
  const tipo = h('select', { class: 'input' }, Object.entries(TIPOS_DOC).map(([k, l]) => h('option', { value: k }, l)));
  const folio = h('input', { class: 'input', placeholder: 'Folio (opcional)' });
  const emision = h('input', { class: 'input', type: 'date' });
  const vigencia = h('input', { class: 'input', type: 'date' });
  if (doc) { veh.value = doc.vehiculo_id; tipo.value = doc.tipo; folio.value = doc.folio || ''; emision.value = doc.fecha_emision || ''; vigencia.value = doc.vigencia || ''; }
  const ev = photoSlot(doc ? 'Nueva evidencia (opcional)' : 'Evidencia', () => `Documento ${veh.value}`, { kind: 'documento', accept: 'image/*,application/pdf', capture: false });
  const send = async () => {
    if (!vigencia.value) return toast('Indica la vigencia', 'warn');
    if (!doc && !ev.value) return toast('Agrega la foto o PDF del documento', 'warn');
    const data = { doc_id: doc?.doc_id, vehiculo_id: veh.value, tipo: tipo.value, folio: folio.value, fecha_emision: emision.value, vigencia: vigencia.value };
    if (ev.value) data.evidencia = ev.value;
    try {
      const r = await busy('Guardando…', () => submit('guardarDocumento', data, 'Documento ' + veh.value, veh.value));
      toast(r && r.sent ? 'Documento guardado' : 'Guardado sin señal', r && r.sent ? 'ok' : 'warn');
      documentos();
    } catch (e) { toast(e.message, 'error', 6000); }
  };
  screen(doc ? 'Renovar documento' : 'Nuevo documento', h('div', {},
    h('label', { class: 'label' }, 'Moto'), veh,
    h('label', { class: 'label' }, 'Tipo'), tipo,
    folio,
    h('label', { class: 'label' }, 'Fecha de emisión'), emision,
    h('label', { class: 'label' }, 'Vigencia (vence el)'), vigencia,
    h('div', { class: 'photo-grid one' }, ev.el),
    doc?.evidencia && h('div', {}, h('p', { class: 'muted small' }, 'Evidencia actual:'), gallery([doc.evidencia])),
    h('button', { class: 'btn primary block', onclick: send }, 'Guardar')), { back: documentos });
}

// ═════════ Dashboard ═════════
async function dashboard(range) {
  state.tab = 'dashboard';
  const now = new Date();
  range = range || { key: 'mes', desde: iso(new Date(now.getFullYear(), now.getMonth(), 1)), hasta: iso(now) };
  const presets = {
    mes: ['Este mes', iso(new Date(now.getFullYear(), now.getMonth(), 1)), iso(now)],
    pasado: ['Mes pasado', iso(new Date(now.getFullYear(), now.getMonth() - 1, 1)), iso(new Date(now.getFullYear(), now.getMonth(), 0))],
    d30: ['30 días', iso(new Date(now - 29 * 864e5)), iso(now)],
    d90: ['90 días', iso(new Date(now - 89 * 864e5)), iso(now)],
  };
  const body = h('div', {}, h('div', { class: 'spinner' }));
  screen('Métricas', body, { actions: h('button', { class: 'icon-btn', 'aria-label': 'Actualizar', onclick: () => dashboard(range) }, '↻') });
  let d;
  try { d = await api('dashboard', { desde: range.desde, hasta: range.hasta }); } catch (e) { return fill(body, h('p', { class: 'error' }, e.message)); }
  const t = d.totales, m = d.mecanico;
  const desde = h('input', { class: 'input sm', type: 'date', value: range.desde });
  const hasta = h('input', { class: 'input sm', type: 'date', value: range.hasta });
  const table = (cols, rows) => rows.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c[2] || '' }, c[1])))),
    h('tbody', {}, rows.map(r => h('tr', {}, cols.map(c => h('td', { class: c[2] || '' }, c[3] ? c[3](r[c[0]], r) : r[c[0]])))))))
    : h('p', { class: 'muted' }, 'Sin datos en el periodo.');

  fill(body, 
    h('div', { class: 'chips' }, Object.entries(presets).map(([k, [l, a, b]]) => h('button', { class: 'chip ' + (range.key === k ? 'on' : ''), onclick: () => dashboard({ key: k, desde: a, hasta: b }) }, l))),
    h('div', { class: 'row range' }, desde, hasta, h('button', { class: 'btn sm', onclick: () => dashboard({ key: 'custom', desde: desde.value, hasta: hasta.value }) }, 'Ver')),

    h('div', { class: 'kpis' },
      kpi('Reparaciones', money(t.costo_reparaciones), `Empresa ${money(t.pagado_empresa)} · Empleados ${money(t.cargado_empleados)}`),
      kpi('Combustible', money(t.gasto_combustible), `${num(t.km_recorridos, 0)} km recorridos`),
      kpi('Fallas reportadas', num(t.fallas_reportadas, 0), `${num(t.danos_no_reportados, 0)} no reportadas en la mañana`),
      kpi('Checks matutinos', num(t.checks_matutinos, 0), 'en el periodo')),

    h('h2', { class: 'section' }, 'Mecánico'),
    h('div', { class: 'kpis' },
      kpi('Abiertas', num(m.fallas_abiertas, 0), `${num(m.en_reparacion, 0)} en reparación`),
      kpi('Cerradas', num(m.reparaciones_cerradas, 0), 'en el periodo'),
      kpi('Tiempo de respuesta', m.horas_respuesta_prom == null ? '—' : num(m.horas_respuesta_prom) + ' h', 'reporte → inicio'),
      kpi('Tiempo de reparación', m.horas_reparacion_prom == null ? '—' : num(m.horas_reparacion_prom) + ' h', 'inicio → cierre')),
    m.mas_antiguas.length ? h('div', {}, h('h3', { class: 'sub' }, 'Pendientes más antiguas'),
      table([['falla_id', 'Falla'], ['vehiculo_id', 'Moto'], ['descripcion', 'Descripción'], ['horas', 'Horas', 'num', v => num(v)]], m.mas_antiguas)) : null,

    h('h2', { class: 'section' }, 'Gasto por semana'),
    weeklyChart(d.serie_semanal),

    h('h2', { class: 'section' }, 'Por moto'),
    table([['vehiculo_id', 'Moto'], ['reparaciones', 'Rep.', 'num'], ['costo_total', 'Total', 'num', money], ['empresa', 'Empresa', 'num', money], ['empleado', 'Empleado', 'num', money]], d.por_vehiculo),

    h('h2', { class: 'section' }, 'Por repartidor'),
    table([['nombre', 'Repartidor'], ['reparaciones', 'Rep.', 'num'], ['costo_total', 'Total', 'num', money], ['cargos_empleado', 'Cargos', 'num', money], ['danos_no_reportados', 'Omitidos', 'num']], d.por_repartidor),

    h('h2', { class: 'section' }, 'Combustible por moto'),
    table([['vehiculo_id', 'Moto'], ['gasto', 'Gasto', 'num', money], ['km', 'Km', 'num', v => num(v, 0)], ['km_por_litro', 'km/L', 'num', v => num(v)], ['costo_por_km', '$/km', 'num', v => v == null ? '—' : money(v)]], d.combustible),

    d.documentos_alerta.length ? h('div', {}, h('h2', { class: 'section' }, 'Documentos por vencer'),
      table([['vehiculo_id', 'Moto'], ['tipo', 'Tipo', '', v => TIPOS_DOC[v] || v], ['vigencia', 'Vigencia'], ['dias_restantes', 'Días', 'num']], d.documentos_alerta)) : null,
  );
}

function kpi(label, value, sub) {
  return h('div', { class: 'kpi' }, h('span', { class: 'kpi-l' }, label), h('strong', { class: 'kpi-v' }, value), h('span', { class: 'kpi-s' }, sub));
}

function weeklyChart(serie) {
  if (!serie.length) return h('p', { class: 'muted' }, 'Sin datos en el periodo.');
  const W = 340, H = 180, P = { l: 44, r: 8, t: 10, b: 34 };
  const max = Math.max(1, ...serie.map(s => Math.max(s.reparaciones, s.combustible)));
  const nice = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / nice) * nice;
  const bw = (W - P.l - P.r) / serie.length;
  const y = v => P.t + (H - P.t - P.b) * (1 - v / top);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Gasto semanal en reparaciones y combustible');
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.append(e); return e; };
  [0, 0.5, 1].forEach(f => {
    add('line', { x1: P.l, x2: W - P.r, y1: y(top * f), y2: y(top * f), class: 'grid' });
    add('text', { x: P.l - 6, y: y(top * f) + 4, 'text-anchor': 'end', class: 'axis' }, '$' + Math.round(top * f / 1000 * 10) / 10 + 'k');
  });
  serie.forEach((s, i) => {
    const x = P.l + i * bw, w = Math.max(2, bw / 2 - 3);
    const bar = (bx, v, cls, label) => {
      const r = add('rect', { x: bx, y: y(v), width: w, height: H - P.b - y(v), class: 'bar ' + cls, rx: 2 });
      const tt = document.createElementNS(ns, 'title');
      tt.textContent = `Semana del ${s.semana}: ${label} ${money(v)}`;
      r.append(tt);
    };
    bar(x + 2, s.reparaciones, 'a', 'reparaciones');
    bar(x + 4 + w, s.combustible, 'b', 'combustible');
    if (serie.length <= 8 || i % Math.ceil(serie.length / 8) === 0) add('text', { x: x + bw / 2, y: H - P.b + 14, 'text-anchor': 'middle', class: 'axis' }, s.semana.slice(5));
  });
  return h('div', { class: 'card' }, svg, h('div', { class: 'legend' }, h('span', { class: 'lg a' }, 'Reparaciones'), h('span', { class: 'lg b' }, 'Combustible')));
}

// ═════════ Cuenta / Admin ═════════
async function cuenta() {
  state.tab = 'cuenta';
  const u = session.user;
  const pend = await queue.all();
  const body = h('div', {},
    h('div', { class: 'card' }, h('h3', {}, u.nombre), h('p', { class: 'muted' }, `${u.usuario_id} · ${u.rol}`)),
    pendingBanner(pend),
    pushCard() || h('p', { class: 'muted small' }, pushState() === 'granted' ? '🔔 Notificaciones activas en este teléfono.' : ''),
    role() === 'admin' && h('div', {},
      h('h2', { class: 'section' }, 'Administración'),
      h('a', { class: 'btn block', href: 'qr.html', target: '_blank' }, '🏷️ Imprimir etiquetas QR de motos'),
      h('div', { id: 'usuarios' }, h('div', { class: 'spinner' }))),
    !session.viaPortal && h('button', { class: 'btn block', onclick: () => cambiarPinView() }, '🔑 Cambiar mi PIN'),
    !EMBED && h('button', { class: 'btn danger-o block', onclick: () => { session.clear(); location.reload(); } }, 'Cerrar sesión'),
    h('p', { class: 'muted small center' }, 'Flotilla Packatelas · v' + (window.APP_VERSION || '1')));
  screen(role() === 'admin' ? 'Más' : 'Cuenta', body);
  if (role() === 'admin') usuariosAdmin(document.getElementById('usuarios'));
}

async function usuariosAdmin(box) {
  try {
    const list = await api('usuarios');
    fill(box, h('h3', { class: 'sub' }, 'Usuarios y PIN'),
      h('p', { class: 'muted small' }, 'Los repartidores se dan de alta solos desde la lista de Personal (cada 6 h). El rol de mecánico o admin se cambia en la hoja (pestaña Usuarios).'),
      h('button', { class: 'btn block', onclick: async () => {
        try {
          const r = await busy('Sincronizando con Personal…', () => api('sincronizarPersonal'));
          toast(`Altas: ${r.altas.length} · Actualizados: ${r.actualizados} · Bajas: ${r.bajas.length}`, 'ok', 5000);
          usuariosAdmin(box);
        } catch (e) { toast(e.message, 'error'); }
      } }, '🔄 Sincronizar con Personal'),
      list.map(u => {
        const pin = h('input', { class: 'input sm', type: 'password', inputmode: 'numeric', placeholder: 'Nuevo PIN', maxlength: 8 });
        return h('div', { class: 'card row between wrap' },
          h('div', {}, h('strong', {}, u.nombre), h('p', { class: 'muted small' }, `${u.usuario_id} · ${u.rol} · ${u.activo === 'SI' ? 'activo' : 'inactivo'} · ${u.tiene_pin ? 'con PIN' : 'sin PIN'}`)),
          h('div', { class: 'row' }, pin, h('button', { class: 'btn sm', onclick: async () => {
            try { await busy('Guardando…', () => api('setPin', { usuario_id: u.usuario_id, pin: pin.value })); toast('PIN asignado a ' + u.nombre, 'ok'); pin.value = ''; usuariosAdmin(box); } catch (e) { toast(e.message, 'error'); }
          } }, 'Asignar')));
      }));
  } catch (e) { fill(box, h('p', { class: 'error' }, e.message)); }
}

// ═════════ Cambio de PIN ═════════
function cambiarPinView(actualConocido, obligatorio) {
  const actual = h('input', { class: 'input big', type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'PIN actual' });
  const nuevo = h('input', { class: 'input big', type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'PIN nuevo (4 a 8 dígitos)' });
  const otra = h('input', { class: 'input big', type: 'password', inputmode: 'numeric', maxlength: 8, placeholder: 'Repite el PIN nuevo' });
  if (actualConocido) actual.value = actualConocido;
  const send = async () => {
    if (nuevo.value !== otra.value) return toast('Los PIN nuevos no coinciden', 'warn');
    try {
      await busy('Guardando…', () => api('cambiarPin', { actual: actual.value, nuevo: nuevo.value }));
      toast('PIN actualizado', 'ok');
      start();
    } catch (e) { toast(e.message, 'error', 5000); }
  };
  const body = h('div', {},
    obligatorio && h('div', { class: 'banner info' }, 'Estás usando el PIN temporal. Crea uno propio para continuar; no lo compartas con nadie.'),
    !actualConocido && [h('label', { class: 'label' }, 'PIN actual'), actual],
    h('label', { class: 'label' }, 'PIN nuevo'), nuevo, otra,
    h('button', { class: 'btn primary block', onclick: send }, 'Guardar PIN'),
    obligatorio && h('button', { class: 'btn block', onclick: () => { session.clear(); location.reload(); } }, 'Salir'));
  screen(obligatorio ? 'Crea tu PIN' : 'Cambiar PIN', body, obligatorio ? {} : { back: cuenta });
  if (obligatorio) document.querySelector('.tabbar')?.remove();
}

// ═════════ Arranque ═════════
// Integración con el portal: ambas apps viven en computenga.github.io y comparten el almacenamiento
// del navegador. Si hay sesión del portal, se usa para entrar a la flotilla sin pedir PIN.
const EMBED = new URLSearchParams(location.search).has('embed');
if (EMBED) document.documentElement.classList.add('embed');

function sesionPortal() {
  try {
    const token = localStorage.getItem('pp_token');
    const user = JSON.parse(localStorage.getItem('pp_user') || 'null');
    return token && user && user.no_empleado ? { token, id: 'U-' + user.no_empleado } : null;
  } catch { return null; }
}

async function entrarConPortal(p) {
  const box = h('div', { class: 'boot' }, h('div', {}, h('div', { class: 'spinner' }), h('p', { class: 'muted center' }, 'Entrando con tu sesión del portal…')));
  $app.replaceChildren(box);
  try {
    const r = await api('ssoPortal', { portal_token: p.token });
    session.set(r.token, r.usuario);
    localStorage.setItem('fl_via_portal', '1');
    return true;
  } catch (e) {
    if (EMBED) {
      fill(box, h('div', { class: 'card', style: 'max-width:420px;margin:40px auto' }, h('h3', {}, '🛵 Flotilla'), h('p', {}, e.message)));
      return null;
    }
    toast(e.message, 'warn', 5000);
    return false;
  }
}

/** Accesos directos desde el portal: #check, #carga, #ruta, #fallas, #documentos, #dashboard, #historial, #cuenta */
function abrirDestino(hash) {
  const d = String(hash || '').replace('#', '');
  if (!d) return false;
  history.replaceState(null, '', location.pathname + location.search);
  const acciones = { check: checkMatutino, carga: cargaGasolina, ruta: antesRuta };
  if (acciones[d]) { jornada().then(() => acciones[d]()); return true; }
  if (['fallas', 'documentos', 'dashboard', 'historial', 'cuenta', 'jornada'].includes(d)) { go(d); return true; }
  return false;
}

async function start() {
  const portal = sesionPortal();
  // Si el portal tiene a otra persona, la sesión de flotilla guardada ya no corresponde.
  if (portal && session.user && session.user.usuario_id !== portal.id && localStorage.getItem('fl_via_portal')) session.clear();
  if ((!session.token || !session.user) && portal) {
    const ok = await entrarConPortal(portal);
    if (ok === null) return;
  }
  if (!session.token || !session.user) return login();
  state.tab = TABS[role()]?.[0]?.[0] || 'jornada';
  if (!abrirDestino(location.hash)) go(state.tab);
  flushQueue().then(left => { if (left === 0) window.dispatchEvent(new CustomEvent('queue-change')); });
  // Dentro del portal, los avisos los recibe el portal (mismo Firebase); no se registra otro token aquí.
  if (!EMBED) refreshPush(n => toast(`🔔 ${n.title || ''}${n.body ? ' — ' + n.body : ''}`, 'info', 6000));
}
window.addEventListener('hashchange', () => { if (session.token) abrirDestino(location.hash); });

window.addEventListener('online', () => flushQueue().then(left => { toast(left ? 'Reconectado, enviando…' : 'Envíos pendientes completados', 'ok'); if (['jornada', 'cuenta'].includes(state.tab)) go(state.tab); }));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' });
start();
