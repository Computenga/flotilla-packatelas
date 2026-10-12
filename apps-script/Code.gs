/**
 * Flotilla Packatelas — API (Apps Script Web App)
 *
 * La PWA (GitHub Pages) llama a doPost con un cuerpo JSON en texto plano:
 *   { action: "nombreAccion", token: "...", ...datos }
 * Respuesta: { ok: true, data } o { ok: false, error }.
 *
 * Instalación: ver apps-script/README.md
 */

const SHEET_ID = '1T8HpYcqdHRU-ohgFGZGuNMiI3mrPWFdAZr7o37XXPmo';
const FCM_PROJECT = 'flotilla-packatelas';
const TZ = 'America/Mexico_City';
const TOKEN_DAYS = 30;

// ───────────────────────── Entrada HTTP ─────────────────────────

function doGet() {
  return json_({ ok: true, data: { service: 'flotilla-packatelas', time: now_() } });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'JSON inválido' });
  }
  try {
    const action = ACTIONS[req.action];
    if (!action) throw new Error('Acción desconocida: ' + req.action);
    const user = action.public ? null : auth_(req.token, action.roles);
    const data = action.fn(req, user);
    return json_({ ok: true, data: data });
  } catch (err) {
    console.error(req.action, err);
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ───────────────────────── Acciones ─────────────────────────

const R = 'repartidor', M = 'mecanico', A = 'admin';
const ALL = [R, M, A];

const ACTIONS = {
  // Sesión
  usuariosLogin:   { public: true, fn: usuariosLogin_ },
  login:           { public: true, fn: login_ },
  me:              { roles: ALL, fn: (req, u) => u },
  registerDevice:  { roles: ALL, fn: registerDevice_ },

  // Catálogos
  vehiculos:       { roles: ALL, fn: () => rows_('Vehiculos').filter(v => v.estatus !== 'baja').map(pickVehiculo_) },

  // Fotos
  uploadPhoto:     { roles: ALL, fn: uploadPhoto_ },
  getPhoto:        { roles: [M, A], fn: getPhoto_ },

  // Repartidor
  pendientesHoy:   { roles: ALL, fn: pendientesHoy_ },
  checkMatutino:   { roles: ALL, fn: checkMatutino_ },
  cargaCombustible:{ roles: ALL, fn: cargaCombustible_ },
  checkAntesRuta:  { roles: ALL, fn: checkAntesRuta_ },
  misCargos:       { roles: ALL, fn: misCargos_ },
  misFallas:       { roles: ALL, fn: misFallas_ },

  // Mecánico
  fallas:          { roles: [M, A], fn: listFallas_ },
  falla:           { roles: [M, A], fn: getFalla_ },
  validarFalla:    { roles: [M, A], fn: validarFalla_ },
  iniciarReparacion:{ roles: [M, A], fn: iniciarReparacion_ },
  cerrarReparacion:{ roles: [M, A], fn: cerrarReparacion_ },
  descartarFalla:  { roles: [M, A], fn: descartarFalla_ },
  documentos:      { roles: [M, A], fn: listDocumentos_ },
  guardarDocumento:{ roles: [M, A], fn: guardarDocumento_ },

  // Admin
  dashboard:       { roles: [M, A], fn: dashboard_ },
  usuarios:        { roles: [A], fn: () => rows_('Usuarios').map(u => ({ usuario_id: u.usuario_id, nombre: u.nombre, rol: u.rol, correo: u.correo, telefono: u.telefono, activo: u.activo, tiene_pin: !!u.pin_hash })) },
  setPin:          { roles: [A], fn: (req) => { setPin_(req.usuario_id, req.pin); return true; } },
};

// ───────────────────────── Sesión y seguridad ─────────────────────────

function usuariosLogin_() {
  return rows_('Usuarios')
    .filter(u => u.activo === 'SI' && u.pin_hash)
    .map(u => ({ usuario_id: u.usuario_id, nombre: u.nombre }))
    .sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
}

function login_(req) {
  const u = rows_('Usuarios').find(x => x.usuario_id === req.usuario_id && x.activo === 'SI');
  if (!u || !u.pin_hash || hashPin_(u.usuario_id, String(req.pin || '')) !== u.pin_hash) {
    Utilities.sleep(800);
    throw new Error('Usuario o PIN incorrecto');
  }
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  const payload = [u.usuario_id, u.rol, exp].join('|');
  const token = Utilities.base64EncodeWebSafe(payload) + '.' + sign_(payload);
  bitacora_(u.usuario_id, 'login', 'Usuarios', u.usuario_id, '');
  return { token: token, usuario: { usuario_id: u.usuario_id, nombre: u.nombre, rol: u.rol } };
}

function auth_(token, roles) {
  if (!token) throw new Error('Sesión requerida');
  const parts = String(token).split('.');
  const payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  if (sign_(payload) !== parts[1]) throw new Error('Sesión inválida');
  const [usuario_id, rol, exp] = payload.split('|');
  if (Date.now() > Number(exp)) throw new Error('Sesión expirada');
  const u = rows_('Usuarios').find(x => x.usuario_id === usuario_id);
  if (!u || u.activo !== 'SI') throw new Error('Usuario inactivo');
  if (roles && roles.indexOf(u.rol) < 0) throw new Error('Sin permiso para esta acción');
  return { usuario_id: u.usuario_id, nombre: u.nombre, rol: u.rol };
}

function secret_(key) {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty(key);
  if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty(key, v); }
  return v;
}

function sign_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, secret_('TOKEN_SECRET')));
}

function hashPin_(usuarioId, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, usuarioId + ':' + pin + ':' + secret_('PIN_PEPPER'));
  return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function setPin_(usuarioId, pin) {
  if (!/^\d{4,8}$/.test(String(pin))) throw new Error('El PIN debe tener de 4 a 8 dígitos');
  const u = rows_('Usuarios').find(x => x.usuario_id === usuarioId);
  if (!u) throw new Error('Usuario no encontrado: ' + usuarioId);
  update_('Usuarios', u._row, { pin_hash: hashPin_(usuarioId, String(pin)) });
}

/** Ejecutar desde el editor para asignar el primer PIN (por ejemplo, al admin). */
function asignarPinManual() {
  setPin_('U-001', '1234'); // ← cambia el usuario y el PIN antes de ejecutar
}

function registerDevice_(req, u) {
  if (!req.fcm_token) throw new Error('Falta token');
  return withLock_(() => {
    const existing = rows_('Dispositivos').find(d => d.fcm_token === req.fcm_token);
    if (existing) {
      update_('Dispositivos', existing._row, { usuario_id: u.usuario_id, activo: 'SI', fecha_registro: new Date() });
    } else {
      append_('Dispositivos', { usuario_id: u.usuario_id, fcm_token: req.fcm_token, plataforma: req.plataforma || 'otro', fecha_registro: new Date(), activo: 'SI' });
    }
    return true;
  });
}

// ───────────────────────── Fotos ─────────────────────────

function uploadPhoto_(req, u) {
  if (!req.base64 || !req.vehiculo_id) throw new Error('Faltan datos de la foto');
  const kind = String(req.kind || 'foto').replace(/[^a-z0-9_]/gi, '');
  const isDoc = kind === 'documento';
  const root = DriveApp.getFolderById(config_(isDoc ? 'DOCS_FOLDER_ID' : 'FOTOS_FOLDER_ID'));
  let folder = subfolder_(root, String(req.vehiculo_id));
  if (!isDoc) folder = subfolder_(folder, fmt_(new Date(), 'yyyy-MM-dd'));
  const mime = req.mime || 'image/jpeg';
  const ext = mime === 'application/pdf' ? 'pdf' : 'jpg';
  const name = [fmt_(new Date(), 'HHmmss'), kind, u.usuario_id].join('_') + '.' + ext;
  const blob = Utilities.newBlob(Utilities.base64Decode(req.base64), mime, name);
  const file = folder.createFile(blob);
  return { id: file.getId(), url: 'https://drive.google.com/file/d/' + file.getId() + '/view' };
}

function getPhoto_(req) {
  const id = String(req.id || req.url || '').replace(/^.*\/d\/([^/]+).*$/, '$1');
  if (!id) throw new Error('Falta id de foto');
  const blob = DriveApp.getFileById(id).getBlob();
  return { mime: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

function subfolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

// ───────────────────────── Repartidor ─────────────────────────

function pendientesHoy_(req, u) {
  const hoy = fmt_(new Date(), 'yyyy-MM-dd');
  const check = rows_('Checks').filter(c => c.tipo === 'matutino' && c.usuario_id === u.usuario_id && fmt_(c.fecha_hora, 'yyyy-MM-dd') === hoy).pop();
  const carga = check ? rows_('Combustible').find(c => c.check_id === check.check_id) : null;
  return {
    check_matutino: check ? { check_id: check.check_id, vehiculo_id: check.vehiculo_id, km: check.km, hora: fmt_(check.fecha_hora, 'HH:mm') } : null,
    carga_combustible: carga ? { carga_id: carga.carga_id, monto: carga.monto } : null,
  };
}

/**
 * Check matutino: el repartidor llega con la moto que se llevó ayer.
 * req: { vehiculo_id, km, fotos:[url x4], foto_odometro, lat, lng, fallas:[{descripcion, severidad, fotos:[]}] }
 */
function checkMatutino_(req, u) {
  const veh = vehiculo_(req.vehiculo_id);
  const km = Number(req.km);
  if (!(km > 0)) throw new Error('Captura los km del odómetro');
  if (!req.fotos || req.fotos.length !== 4 || !req.foto_odometro) throw new Error('Se requieren 4 fotos y la foto del odómetro');

  return withLock_(() => {
    const hoy = fmt_(new Date(), 'yyyy-MM-dd');
    const checks = rows_('Checks').filter(c => c.tipo === 'matutino');
    if (checks.some(c => c.usuario_id === u.usuario_id && fmt_(c.fecha_hora, 'yyyy-MM-dd') === hoy)) {
      throw new Error('Ya registraste tu check matutino de hoy');
    }
    const prev = checks.filter(c => c.vehiculo_id === veh.vehiculo_id).pop();
    const kmPrev = prev ? Number(prev.km) : Number(veh.km_actual) || 0;
    if (kmPrev && km < kmPrev) throw new Error('Los km (' + km + ') son menores al último registro de esta moto (' + kmPrev + '). Revisa el odómetro.');
    const recorridos = kmPrev ? km - kmPrev : '';

    const checkId = nextId_('CH', 6);
    append_('Checks', {
      check_id: checkId, tipo: 'matutino', fecha_hora: new Date(), usuario_id: u.usuario_id, vehiculo_id: veh.vehiculo_id,
      km: km, km_recorridos: recorridos,
      foto_1: req.fotos[0], foto_2: req.fotos[1], foto_3: req.fotos[2], foto_4: req.fotos[3],
      foto_odometro: req.foto_odometro, descripcion: req.descripcion || '', lat: req.lat || '', lng: req.lng || '',
    });
    const vrow = rows_('Vehiculos').find(v => v.vehiculo_id === veh.vehiculo_id);
    update_('Vehiculos', vrow._row, { km_actual: km });

    const fallaIds = (req.fallas || []).filter(f => f.descripcion).map(f => crearFalla_({
      tipo: 'normal', check_id: checkId, reportada_por: u.usuario_id, responsable_id: u.usuario_id,
      vehiculo_id: veh.vehiculo_id, descripcion: f.descripcion, severidad: f.severidad || 'media', fotos: f.fotos || [],
    }));

    bitacora_(u.usuario_id, 'check_matutino', 'Checks', checkId, 'km ' + km);
    const alertas = [];
    const maxKm = Number(config_('KM_MAX_JORNADA', '400'));
    if (recorridos !== '' && recorridos > maxKm) {
      alertas.push('km');
      notifyRole_(A, 'Km fuera de rango', u.nombre + ' registró ' + recorridos + ' km en ' + veh.vehiculo_id + ' desde el último check.', 'anomalia_km', checkId);
    }
    if (fallaIds.length) {
      notifyRole_([M, A], 'Falla reportada · ' + veh.vehiculo_id, u.nombre + ' reportó ' + fallaIds.length + ' falla(s) en el check matutino.', 'falla_nueva', fallaIds[0]);
    }
    return { check_id: checkId, km_recorridos: recorridos, fallas: fallaIds, alertas: alertas };
  });
}

/** Carga de gasolina: ligada al check matutino de hoy del mismo repartidor. req: { monto, litros, foto_ticket } */
function cargaCombustible_(req, u) {
  const monto = Number(req.monto), litros = Number(req.litros);
  if (!(monto > 0) || !(litros > 0)) throw new Error('Captura monto y litros');
  if (!req.foto_ticket) throw new Error('Falta la foto del ticket');
  return withLock_(() => {
    const p = pendientesHoy_(req, u);
    if (!p.check_matutino) throw new Error('Primero registra tu check matutino');
    if (p.carga_combustible) throw new Error('Ya registraste la carga de hoy');
    const check = rows_('Checks').find(c => c.check_id === p.check_matutino.check_id);
    const kmRec = Number(check.km_recorridos) || 0;
    const cargaId = nextId_('CG', 6);
    const kmL = kmRec ? round_(kmRec / litros, 2) : '';
    append_('Combustible', {
      carga_id: cargaId, check_id: check.check_id, fecha_hora: new Date(), usuario_id: u.usuario_id, vehiculo_id: check.vehiculo_id,
      km_recorridos: kmRec || '', monto: monto, litros: litros, precio_litro: round_(monto / litros, 2),
      km_por_litro: kmL, costo_por_km: kmRec ? round_(monto / kmRec, 2) : '', foto_ticket: req.foto_ticket,
    });
    bitacora_(u.usuario_id, 'carga_combustible', 'Combustible', cargaId, '$' + monto);

    // Rendimiento anómalo: menos del 60% del promedio de las últimas 10 cargas de la moto
    if (kmL) {
      const hist = rows_('Combustible').filter(c => c.vehiculo_id === check.vehiculo_id && c.carga_id !== cargaId && Number(c.km_por_litro) > 0).slice(-10);
      if (hist.length >= 3) {
        const avg = hist.reduce((s, c) => s + Number(c.km_por_litro), 0) / hist.length;
        if (kmL < avg * 0.6) {
          notifyRole_(A, 'Rendimiento bajo · ' + check.vehiculo_id, u.nombre + ': ' + kmL + ' km/L (promedio ' + round_(avg, 1) + ').', 'anomalia_combustible', cargaId);
        }
      }
    }
    return { carga_id: cargaId, km_por_litro: kmL };
  });
}

/**
 * Check antes de ruta (opcional): reporta daño no registrado en el check matutino.
 * La falla se atribuye a quien hizo el último check matutino de esa moto.
 * req: { vehiculo_id, descripcion, fotos:[1..4] }
 */
function checkAntesRuta_(req, u) {
  const veh = vehiculo_(req.vehiculo_id);
  if (!req.descripcion) throw new Error('Describe el daño');
  if (!req.fotos || req.fotos.length < 1 || req.fotos.length > 4) throw new Error('Agrega de 1 a 4 fotos');
  return withLock_(() => {
    const matutino = rows_('Checks').filter(c => c.tipo === 'matutino' && c.vehiculo_id === veh.vehiculo_id).pop();
    const responsable = matutino ? matutino.usuario_id : '';
    const checkId = nextId_('CH', 6);
    const f = req.fotos;
    append_('Checks', {
      check_id: checkId, tipo: 'antes_ruta', fecha_hora: new Date(), usuario_id: u.usuario_id, vehiculo_id: veh.vehiculo_id,
      foto_1: f[0] || '', foto_2: f[1] || '', foto_3: f[2] || '', foto_4: f[3] || '', descripcion: req.descripcion,
      lat: req.lat || '', lng: req.lng || '',
    });
    const fallaId = crearFalla_({
      tipo: 'no_reportado', check_id: checkId, reportada_por: u.usuario_id, responsable_id: responsable,
      vehiculo_id: veh.vehiculo_id, descripcion: req.descripcion, severidad: req.severidad || 'media', fotos: f,
    });
    bitacora_(u.usuario_id, 'check_antes_ruta', 'Checks', checkId, 'responsable ' + responsable);
    notifyRole_([M, A], 'Daño no reportado · ' + veh.vehiculo_id, u.nombre + ' encontró un daño antes de salir a ruta. Compáralo con el check matutino.', 'falla_no_reportada', fallaId);
    return { check_id: checkId, falla_id: fallaId, responsable_id: responsable };
  });
}

function misCargos_(req, u) {
  return rows_('Reparaciones').filter(r => r.responsable_id === u.usuario_id && Number(r.monto_empleado) > 0)
    .map(r => ({ rep_id: r.rep_id, falla_id: r.falla_id, vehiculo_id: r.vehiculo_id, fecha: fmt_(r.fecha_cierre, 'yyyy-MM-dd'), descripcion: r.descripcion, causa: r.causa, monto_empleado: r.monto_empleado }))
    .reverse();
}

function misFallas_(req, u) {
  return rows_('Fallas').filter(f => f.reportada_por === u.usuario_id || f.responsable_id === u.usuario_id)
    .slice(-30).reverse().map(pickFalla_);
}

function crearFalla_(f) {
  const id = nextId_('F', 6);
  const fotos = f.fotos || [];
  append_('Fallas', {
    falla_id: id, tipo: f.tipo, check_id: f.check_id, fecha_reporte: new Date(), reportada_por: f.reportada_por,
    responsable_id: f.responsable_id, vehiculo_id: f.vehiculo_id, descripcion: f.descripcion, severidad: f.severidad,
    foto_1: fotos[0] || '', foto_2: fotos[1] || '', foto_3: fotos[2] || '', foto_4: fotos[3] || '',
    estatus: 'abierta', validacion_mecanico: f.tipo === 'no_reportado' ? 'pendiente' : '',
  });
  return id;
}

// ───────────────────────── Mecánico ─────────────────────────

function listFallas_(req) {
  const estatus = req.estatus ? [].concat(req.estatus) : ['abierta', 'en_reparacion'];
  const users = userMap_();
  return rows_('Fallas').filter(f => estatus.indexOf(f.estatus) >= 0).map(f => {
    const o = pickFalla_(f);
    o.reportada_por_nombre = users[f.reportada_por] || f.reportada_por;
    o.responsable_nombre = users[f.responsable_id] || f.responsable_id;
    o.horas_abierta = round_((Date.now() - new Date(f.fecha_reporte).getTime()) / 36e5, 1);
    return o;
  }).sort((a, b) => sevRank_(b.severidad) - sevRank_(a.severidad) || b.horas_abierta - a.horas_abierta);
}

/** Detalle con el check matutino de la moto para comparar (útil en daños no reportados). */
function getFalla_(req) {
  const f = rows_('Fallas').find(x => x.falla_id === req.falla_id);
  if (!f) throw new Error('Falla no encontrada');
  const users = userMap_();
  const out = pickFalla_(f);
  out.reportada_por_nombre = users[f.reportada_por] || f.reportada_por;
  out.responsable_nombre = users[f.responsable_id] || f.responsable_id;
  const checks = rows_('Checks');
  const origen = checks.find(c => c.check_id === f.check_id);
  let matutino = origen && origen.tipo === 'matutino' ? origen : null;
  if (!matutino) {
    const t = new Date(f.fecha_reporte).getTime();
    matutino = checks.filter(c => c.tipo === 'matutino' && c.vehiculo_id === f.vehiculo_id && new Date(c.fecha_hora).getTime() <= t).pop() || null;
  }
  out.check_matutino = matutino ? {
    check_id: matutino.check_id, fecha: fmt_(matutino.fecha_hora, 'yyyy-MM-dd HH:mm'), usuario: users[matutino.usuario_id] || matutino.usuario_id,
    km: matutino.km, fotos: [matutino.foto_1, matutino.foto_2, matutino.foto_3, matutino.foto_4, matutino.foto_odometro].filter(String),
  } : null;
  const rep = rows_('Reparaciones').filter(r => r.falla_id === f.falla_id).pop();
  out.reparacion = rep ? pickRep_(rep) : null;
  return out;
}

function validarFalla_(req, u) {
  if (['confirmado', 'no_visible'].indexOf(req.resultado) < 0) throw new Error('Resultado inválido');
  return withLock_(() => {
    const f = rows_('Fallas').find(x => x.falla_id === req.falla_id);
    if (!f) throw new Error('Falla no encontrada');
    update_('Fallas', f._row, { validacion_mecanico: req.resultado });
    bitacora_(u.usuario_id, 'validar_falla', 'Fallas', f.falla_id, req.resultado);
    return true;
  });
}

function iniciarReparacion_(req, u) {
  return withLock_(() => abrirReparacion_(req, u));
}

function abrirReparacion_(req, u) {
  {
    const f = rows_('Fallas').find(x => x.falla_id === req.falla_id);
    if (!f) throw new Error('Falla no encontrada');
    if (f.estatus !== 'abierta') throw new Error('La falla ya está ' + f.estatus);
    const repId = nextId_('R', 6);
    const inicio = new Date();
    append_('Reparaciones', {
      rep_id: repId, falla_id: f.falla_id, vehiculo_id: f.vehiculo_id, mecanico_id: u.usuario_id, fecha_inicio: inicio,
      horas_respuesta: round_((inicio - new Date(f.fecha_reporte)) / 36e5, 2), responsable_id: f.responsable_id, notificado_repartidor: 'NO',
    });
    update_('Fallas', f._row, { estatus: 'en_reparacion' });
    const v = rows_('Vehiculos').find(x => x.vehiculo_id === f.vehiculo_id);
    if (v) update_('Vehiculos', v._row, { estatus: 'en_taller' });
    bitacora_(u.usuario_id, 'iniciar_reparacion', 'Reparaciones', repId, f.falla_id);
    return { rep_id: repId };
  }
}

/**
 * req: { falla_id, descripcion, fotos:[], costo_refacciones, costo_mano_obra,
 *        causa: desgaste|mal_uso|acuerdo, monto_empleado (solo acuerdo) }
 */
function cerrarReparacion_(req, u) {
  const causas = ['desgaste', 'mal_uso', 'acuerdo'];
  if (causas.indexOf(req.causa) < 0) throw new Error('Indica la causa');
  if (!req.descripcion) throw new Error('Describe la reparación');
  const refac = Number(req.costo_refacciones) || 0, mano = Number(req.costo_mano_obra) || 0;
  const total = round_(refac + mano, 2);
  let empleado = 0;
  if (req.causa === 'mal_uso') empleado = total;
  if (req.causa === 'acuerdo') {
    empleado = Number(req.monto_empleado) || 0;
    if (empleado < 0 || empleado > total) throw new Error('El monto del empleado debe estar entre 0 y el total');
  }
  const empresa = round_(total - empleado, 2);

  return withLock_(() => {
    const f = rows_('Fallas').find(x => x.falla_id === req.falla_id);
    if (!f) throw new Error('Falla no encontrada');
    let rep = rows_('Reparaciones').filter(r => r.falla_id === f.falla_id && !r.fecha_cierre).pop();
    if (!rep) { abrirReparacion_(req, u); rep =rows_('Reparaciones').filter(r => r.falla_id === f.falla_id && !r.fecha_cierre).pop(); }
    const cierre = new Date();
    const fotos = req.fotos || [];
    const responsable = req.responsable_id || f.responsable_id;
    update_('Reparaciones', rep._row, {
      fecha_cierre: cierre, horas_reparacion: round_((cierre - new Date(rep.fecha_inicio)) / 36e5, 2), descripcion: req.descripcion,
      foto_1: fotos[0] || '', foto_2: fotos[1] || '', foto_3: fotos[2] || '', foto_4: fotos[3] || '',
      costo_refacciones: refac, costo_mano_obra: mano, costo_total: total, causa: req.causa,
      responsable_id: responsable, monto_empleado: empleado, monto_empresa: empresa,
      notificado_repartidor: empleado > 0 ? 'SI' : 'NO',
    });
    update_('Fallas', f._row, { estatus: 'cerrada' });
    const abiertas = rows_('Fallas').some(x => x.vehiculo_id === f.vehiculo_id && x.estatus === 'en_reparacion');
    const v = rows_('Vehiculos').find(x => x.vehiculo_id === f.vehiculo_id);
    if (v && !abiertas) update_('Vehiculos', v._row, { estatus: 'activo' });
    bitacora_(u.usuario_id, 'cerrar_reparacion', 'Reparaciones', rep.rep_id, '$' + total + ' ' + req.causa);

    if (empleado > 0 && responsable) {
      notifyUser_(responsable, 'Cargo por reparación', 'Se te asignó un cargo de $' + empleado + ' por ' + req.descripcion + ' (moto ' + f.vehiculo_id + ').', 'cargo_empleado', rep.rep_id, false);
    }
    notifyRole_(A, 'Reparación cerrada · ' + f.vehiculo_id, 'Total $' + total + ' — empresa $' + empresa + ', empleado $' + empleado + ' (' + req.causa + ').', 'reparacion_cerrada', rep.rep_id);
    return { rep_id: rep.rep_id, costo_total: total, monto_empleado: empleado, monto_empresa: empresa };
  });
}

function descartarFalla_(req, u) {
  return withLock_(() => {
    const f = rows_('Fallas').find(x => x.falla_id === req.falla_id);
    if (!f) throw new Error('Falla no encontrada');
    update_('Fallas', f._row, { estatus: 'descartada' });
    bitacora_(u.usuario_id, 'descartar_falla', 'Fallas', f.falla_id, req.motivo || '');
    return true;
  });
}

function listDocumentos_() {
  const hoy = startOfDay_(new Date());
  return rows_('Documentos').map(d => {
    const dias = d.vigencia ? Math.round((startOfDay_(new Date(d.vigencia)) - hoy) / 864e5) : null;
    return {
      doc_id: d.doc_id, vehiculo_id: d.vehiculo_id, tipo: d.tipo, folio: d.folio,
      fecha_emision: fmt_(d.fecha_emision, 'yyyy-MM-dd'), vigencia: fmt_(d.vigencia, 'yyyy-MM-dd'), evidencia: d.evidencia,
      dias_restantes: dias, estado: dias === null ? 'sin_vigencia' : dias < 0 ? 'vencido' : dias <= 30 ? 'por_vencer' : 'vigente',
    };
  }).sort((a, b) => (a.dias_restantes === null ? 1e9 : a.dias_restantes) - (b.dias_restantes === null ? 1e9 : b.dias_restantes));
}

/** Crea o renueva un documento. req: { doc_id?, vehiculo_id, tipo, folio, fecha_emision, vigencia, evidencia } */
function guardarDocumento_(req, u) {
  vehiculo_(req.vehiculo_id);
  if (!req.tipo || !req.vigencia) throw new Error('Indica tipo y vigencia');
  return withLock_(() => {
    const data = {
      vehiculo_id: req.vehiculo_id, tipo: req.tipo, folio: req.folio || '',
      fecha_emision: req.fecha_emision ? parseDate_(req.fecha_emision) : '', vigencia: parseDate_(req.vigencia),
      evidencia: req.evidencia || '', actualizado_por: u.usuario_id, fecha_actualizacion: new Date(), ultima_alerta_dias: '',
    };
    let id = req.doc_id;
    const existing = id ? rows_('Documentos').find(d => d.doc_id === id) : null;
    if (existing) {
      if (!req.evidencia) delete data.evidencia;
      update_('Documentos', existing._row, data);
    } else {
      id = nextId_('D', 4);
      data.doc_id = id;
      append_('Documentos', data);
    }
    bitacora_(u.usuario_id, 'guardar_documento', 'Documentos', id, req.tipo + ' ' + req.vigencia);
    return { doc_id: id };
  });
}

// ───────────────────────── Dashboard ─────────────────────────

/** req: { desde: 'yyyy-mm-dd', hasta: 'yyyy-mm-dd' } (por defecto, mes en curso) */
function dashboard_(req) {
  const now = new Date();
  const desde = req.desde ? parseDate_(req.desde) : new Date(now.getFullYear(), now.getMonth(), 1);
  const hasta = req.hasta ? new Date(parseDate_(req.hasta).getTime() + 864e5 - 1) : now;
  const inRange = d => { const t = new Date(d).getTime(); return t >= desde.getTime() && t <= hasta.getTime(); };
  const users = userMap_();

  const reps = rows_('Reparaciones').filter(r => r.fecha_cierre && inRange(r.fecha_cierre));
  const fallas = rows_('Fallas');
  const fallasPeriodo = fallas.filter(f => inRange(f.fecha_reporte));
  const cargas = rows_('Combustible').filter(c => inRange(c.fecha_hora));
  const checks = rows_('Checks').filter(c => c.tipo === 'matutino' && inRange(c.fecha_hora));

  const sum = (arr, k) => round_(arr.reduce((s, x) => s + (Number(x[k]) || 0), 0), 2);
  const avg = (arr, k) => { const v = arr.filter(x => x[k] !== '' && x[k] !== null && !isNaN(Number(x[k]))).map(x => Number(x[k])); return v.length ? round_(v.reduce((a, b) => a + b, 0) / v.length, 1) : null; };
  const groupBy = (arr, key) => arr.reduce((m, x) => { (m[x[key]] = m[x[key]] || []).push(x); return m; }, {});

  const porVehiculo = Object.entries(groupBy(reps, 'vehiculo_id')).map(([id, rs]) => ({
    vehiculo_id: id, reparaciones: rs.length, costo_total: sum(rs, 'costo_total'), empresa: sum(rs, 'monto_empresa'), empleado: sum(rs, 'monto_empleado'),
  })).sort((a, b) => b.costo_total - a.costo_total);

  const porRepartidor = Object.entries(groupBy(reps.filter(r => r.responsable_id), 'responsable_id')).map(([id, rs]) => ({
    usuario_id: id, nombre: users[id] || id, reparaciones: rs.length, costo_total: sum(rs, 'costo_total'),
    cargos_empleado: sum(rs, 'monto_empleado'), mal_uso: rs.filter(r => r.causa === 'mal_uso').length,
    danos_no_reportados: fallasPeriodo.filter(f => f.tipo === 'no_reportado' && f.responsable_id === id && f.validacion_mecanico !== 'no_visible').length,
  })).sort((a, b) => b.costo_total - a.costo_total);

  const combustible = Object.entries(groupBy(cargas, 'vehiculo_id')).map(([id, cs]) => {
    const km = sum(cs, 'km_recorridos'), litros = sum(cs, 'litros'), gasto = sum(cs, 'monto');
    return { vehiculo_id: id, cargas: cs.length, gasto: gasto, litros: litros, km: km, km_por_litro: litros ? round_(km / litros, 1) : null, costo_por_km: km ? round_(gasto / km, 2) : null };
  }).sort((a, b) => b.gasto - a.gasto);

  const abiertas = fallas.filter(f => f.estatus === 'abierta' || f.estatus === 'en_reparacion');
  const repCerradas = reps;

  // Serie por semana: costo de reparaciones y gasto de combustible
  const semana = d => fmt_(startOfWeek_(new Date(d)), 'yyyy-MM-dd');
  const serie = {};
  reps.forEach(r => { const k = semana(r.fecha_cierre); (serie[k] = serie[k] || { semana: k, reparaciones: 0, combustible: 0 }).reparaciones += Number(r.costo_total) || 0; });
  cargas.forEach(c => { const k = semana(c.fecha_hora); (serie[k] = serie[k] || { semana: k, reparaciones: 0, combustible: 0 }).combustible += Number(c.monto) || 0; });

  return {
    periodo: { desde: fmt_(desde, 'yyyy-MM-dd'), hasta: fmt_(hasta, 'yyyy-MM-dd') },
    totales: {
      costo_reparaciones: sum(reps, 'costo_total'), pagado_empresa: sum(reps, 'monto_empresa'), cargado_empleados: sum(reps, 'monto_empleado'),
      gasto_combustible: sum(cargas, 'monto'), km_recorridos: sum(checks, 'km_recorridos'),
      fallas_reportadas: fallasPeriodo.length, danos_no_reportados: fallasPeriodo.filter(f => f.tipo === 'no_reportado').length,
      checks_matutinos: checks.length,
    },
    mecanico: {
      fallas_abiertas: abiertas.filter(f => f.estatus === 'abierta').length,
      en_reparacion: abiertas.filter(f => f.estatus === 'en_reparacion').length,
      reparaciones_cerradas: repCerradas.length,
      horas_respuesta_prom: avg(repCerradas, 'horas_respuesta'),
      horas_reparacion_prom: avg(repCerradas, 'horas_reparacion'),
      mas_antiguas: abiertas.map(f => ({ falla_id: f.falla_id, vehiculo_id: f.vehiculo_id, descripcion: f.descripcion, estatus: f.estatus, horas: round_((Date.now() - new Date(f.fecha_reporte)) / 36e5, 1) }))
        .sort((a, b) => b.horas - a.horas).slice(0, 10),
    },
    por_vehiculo: porVehiculo,
    por_repartidor: porRepartidor,
    combustible: combustible,
    serie_semanal: Object.values(serie).sort((a, b) => a.semana < b.semana ? -1 : 1).map(s => ({ semana: s.semana, reparaciones: round_(s.reparaciones, 2), combustible: round_(s.combustible, 2) })),
    documentos_alerta: listDocumentos_().filter(d => d.estado === 'vencido' || d.estado === 'por_vencer'),
  };
}

// ───────────────────────── Tareas programadas ─────────────────────────

/** Ejecutar una vez desde el editor para crear los triggers. */
function instalarTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tareaDocumentos').timeBased().everyDays(1).atHour(8).inTimezone(TZ).create();
  ScriptApp.newTrigger('tareaPendientesCarga').timeBased().everyDays(1).atHour(Number(String(config_('HORA_LIMITE_CHECK', '10:00')).split(':')[0])).inTimezone(TZ).create();
  ScriptApp.newTrigger('tareaFallasSinAtender').timeBased().everyHours(2).create();
  ScriptApp.newTrigger('tareaResumenSemanal').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).inTimezone(TZ).create();
}

function tareaDocumentos() {
  const buckets = String(config_('DIAS_ALERTA_DOCS', '30,15,7')).split(',').map(Number).sort((a, b) => b - a);
  const docs = rows_('Documentos');
  const hoy = startOfDay_(new Date());
  const avisos = [];
  docs.forEach(d => {
    if (!d.vigencia) return;
    const dias = Math.round((startOfDay_(new Date(d.vigencia)) - hoy) / 864e5);
    let bucket = null;
    if (dias < 0) bucket = 'vencido';
    else buckets.forEach(b => { if (dias <= b) bucket = String(b); });
    if (bucket && String(d.ultima_alerta_dias) !== bucket) {
      avisos.push(d.vehiculo_id + ' · ' + d.tipo + (dias < 0 ? ' VENCIDO hace ' + (-dias) + ' días' : ' vence en ' + dias + ' días') + ' (' + fmt_(d.vigencia, 'yyyy-MM-dd') + ')');
      update_('Documentos', d._row, { ultima_alerta_dias: bucket });
    }
  });
  if (!avisos.length) return;
  notifyRole_([M, A], 'Documentos por vencer', avisos.length + ' documento(s) requieren atención', 'documentos', '');
  sendMail_([config_('CORREO_MECANICO', '')].concat(adminEmails_()), 'Flotilla · Documentos por vencer', avisos.join('\n'));
}

function tareaPendientesCarga() {
  const hoy = fmt_(new Date(), 'yyyy-MM-dd');
  const cargas = rows_('Combustible');
  const users = userMap_();
  const faltan = rows_('Checks').filter(c => c.tipo === 'matutino' && fmt_(c.fecha_hora, 'yyyy-MM-dd') === hoy && !cargas.some(g => g.check_id === c.check_id));
  if (!faltan.length) return;
  notifyRole_(A, 'Cargas de gasolina pendientes', faltan.map(c => (users[c.usuario_id] || c.usuario_id) + ' (' + c.vehiculo_id + ')').join(', '), 'carga_pendiente', hoy);
}

function tareaFallasSinAtender() {
  const horas = Number(config_('HORAS_FALLA_SIN_ATENDER', '24'));
  const hoy = fmt_(new Date(), 'yyyy-MM-dd');
  const yaAvisadas = rows_('Notificaciones').filter(n => n.tipo === 'recordatorio_falla' && fmt_(n.fecha_hora, 'yyyy-MM-dd') === hoy).map(n => n.referencia_id);
  const pendientes = rows_('Fallas').filter(f => f.estatus === 'abierta' && (Date.now() - new Date(f.fecha_reporte)) / 36e5 > horas && yaAvisadas.indexOf(f.falla_id) < 0);
  pendientes.forEach(f => notifyRole_(M, 'Falla sin atender · ' + f.vehiculo_id, f.descripcion, 'recordatorio_falla', f.falla_id));
  if (pendientes.length) sendMail_(adminEmails_(), 'Flotilla · Fallas sin atender', pendientes.map(f => f.falla_id + ' ' + f.vehiculo_id + ': ' + f.descripcion).join('\n'));
}

function tareaResumenSemanal() {
  const hasta = new Date(Date.now() - 864e5);
  const desde = new Date(hasta.getTime() - 6 * 864e5);
  const d = dashboard_({ desde: fmt_(desde, 'yyyy-MM-dd'), hasta: fmt_(hasta, 'yyyy-MM-dd') });
  const t = d.totales, m = d.mecanico;
  const body = [
    'Semana ' + d.periodo.desde + ' a ' + d.periodo.hasta, '',
    'Reparaciones: $' + t.costo_reparaciones + ' (empresa $' + t.pagado_empresa + ', empleados $' + t.cargado_empleados + ')',
    'Combustible: $' + t.gasto_combustible + ' · ' + t.km_recorridos + ' km',
    'Fallas reportadas: ' + t.fallas_reportadas + ' (no reportadas en la mañana: ' + t.danos_no_reportados + ')',
    'Mecánico: ' + m.reparaciones_cerradas + ' cerradas, ' + m.fallas_abiertas + ' abiertas, respuesta prom. ' + m.horas_respuesta_prom + ' h, reparación prom. ' + m.horas_reparacion_prom + ' h',
  ].join('\n');
  sendMail_(adminEmails_(), 'Flotilla · Resumen semanal', body);
}

// ───────────────────────── Notificaciones ─────────────────────────

function notifyRole_(roles, title, body, tipo, ref) {
  roles = [].concat(roles);
  rows_('Usuarios').filter(u => u.activo === 'SI' && roles.indexOf(u.rol) >= 0)
    .forEach(u => notifyUser_(u.usuario_id, title, body, tipo, ref, true));
}

function notifyUser_(usuarioId, title, body, tipo, ref, emailFallback) {
  const devices = rows_('Dispositivos').filter(d => d.usuario_id === usuarioId && d.activo === 'SI');
  let sent = false;
  devices.forEach(d => {
    const res = sendPush_(d.fcm_token, title, body, { tipo: tipo, ref: String(ref || '') });
    log_(usuarioId, 'push', tipo, ref, title + ' — ' + body, res.ok ? 'enviado' : 'fallido');
    if (res.ok) sent = true;
    if (res.unregistered) update_('Dispositivos', d._row, { activo: 'NO' });
  });
  if (!sent && emailFallback) {
    const u = rows_('Usuarios').find(x => x.usuario_id === usuarioId);
    if (u && u.correo) {
      const ok = sendMail_([u.correo], 'Flotilla · ' + title, body);
      log_(usuarioId, 'correo', tipo, ref, title + ' — ' + body, ok ? 'enviado' : 'fallido');
    }
  }
}

/** FCM HTTP v1 con el token OAuth del propio script (el proyecto de Apps Script debe estar ligado al proyecto de GCP de Firebase). */
function sendPush_(token, title, body, data) {
  try {
    const res = UrlFetchApp.fetch('https://fcm.googleapis.com/v1/projects/' + FCM_PROJECT + '/messages:send', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload: JSON.stringify({ message: {
        token: token,
        notification: { title: title, body: body },
        data: data || {},
        webpush: { fcm_options: { link: config_('APP_URL', 'https://computenga.github.io/flotilla-packatelas/') } },
      } }),
    });
    const code = res.getResponseCode();
    if (code === 200) return { ok: true };
    const txt = res.getContentText();
    console.warn('FCM', code, txt);
    return { ok: false, unregistered: code === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(txt) };
  } catch (err) {
    console.error('FCM error', err);
    return { ok: false };
  }
}

function sendMail_(to, subject, body) {
  const list = to.filter(String).join(',');
  if (!list) return false;
  try { MailApp.sendEmail(list, subject, body); return true; } catch (err) { console.error('Mail', err); return false; }
}

function adminEmails_() {
  return String(config_('CORREOS_ADMIN', '')).split(',').map(s => s.trim()).filter(String);
}

function log_(usuarioId, canal, tipo, ref, mensaje, estado) {
  append_('Notificaciones', { notif_id: nextId_('N', 6), fecha_hora: new Date(), usuario_id: usuarioId, canal: canal, tipo: tipo, referencia_id: ref || '', mensaje: mensaje, estado: estado });
}

/** Prueba manual desde el editor: manda un push a todos los dispositivos de un usuario. */
function probarPush() {
  notifyUser_('U-001', 'Prueba', 'Push de prueba de la flotilla', 'prueba', '', false); // ← cambia el usuario
}

// ───────────────────────── Acceso a hojas ─────────────────────────

let _ss = null;
const _cache = {};

function ss_() { return _ss || (_ss = SpreadsheetApp.openById(SHEET_ID)); }

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('No existe la pestaña ' + name);
  return sh;
}

function headers_(name) {
  if (!_cache['h:' + name]) _cache['h:' + name] = sheet_(name).getRange(1, 1, 1, sheet_(name).getLastColumn()).getValues()[0];
  return _cache['h:' + name];
}

function rows_(name) {
  if (_cache['r:' + name]) return _cache['r:' + name];
  const sh = sheet_(name);
  const last = sh.getLastRow();
  const h = headers_(name);
  const values = last > 1 ? sh.getRange(2, 1, last - 1, h.length).getValues() : [];
  const out = [];
  values.forEach((r, i) => {
    if (r.every(c => c === '')) return;
    const o = { _row: i + 2 };
    h.forEach((k, j) => o[k] = r[j]);
    out.push(o);
  });
  return (_cache['r:' + name] = out);
}

function append_(name, obj) {
  const h = headers_(name);
  sheet_(name).appendRow(h.map(k => obj[k] === undefined ? '' : obj[k]));
  delete _cache['r:' + name];
}

function update_(name, row, obj) {
  const h = headers_(name);
  const sh = sheet_(name);
  Object.keys(obj).forEach(k => {
    const col = h.indexOf(k);
    if (col >= 0) sh.getRange(row, col + 1).setValue(obj[k]);
  });
  delete _cache['r:' + name];
}

function config_(key, def) {
  const row = rows_('Config').find(r => r.clave === key);
  const v = row ? row.valor : '';
  return v === '' || v === undefined ? (def === undefined ? '' : def) : v;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('Servidor ocupado, intenta de nuevo');
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

function nextId_(prefix, width) {
  const p = PropertiesService.getScriptProperties();
  const key = 'SEQ_' + prefix;
  const n = Number(p.getProperty(key) || 0) + 1;
  p.setProperty(key, String(n));
  return prefix + '-' + ('000000000' + n).slice(-width);
}

function bitacora_(usuarioId, accion, entidad, id, detalle) {
  append_('Bitacora', { fecha_hora: new Date(), usuario_id: usuarioId, accion: accion, entidad: entidad, entidad_id: id, detalle: detalle });
}

// ───────────────────────── Utilidades ─────────────────────────

function vehiculo_(id) {
  const v = rows_('Vehiculos').find(x => x.vehiculo_id === id);
  if (!v) throw new Error('Moto no encontrada: ' + id);
  if (v.estatus === 'baja') throw new Error('La moto ' + id + ' está dada de baja');
  return v;
}

function userMap_() {
  return rows_('Usuarios').reduce((m, u) => { m[u.usuario_id] = u.nombre; return m; }, {});
}

function pickVehiculo_(v) {
  return { vehiculo_id: v.vehiculo_id, placa: v.placa, marca: v.marca, modelo: v.modelo, color: v.color, km_actual: v.km_actual, estatus: v.estatus };
}

function pickFalla_(f) {
  return {
    falla_id: f.falla_id, tipo: f.tipo, check_id: f.check_id, fecha_reporte: fmt_(f.fecha_reporte, 'yyyy-MM-dd HH:mm'),
    reportada_por: f.reportada_por, responsable_id: f.responsable_id, vehiculo_id: f.vehiculo_id, descripcion: f.descripcion,
    severidad: f.severidad, fotos: [f.foto_1, f.foto_2, f.foto_3, f.foto_4].filter(String), estatus: f.estatus, validacion_mecanico: f.validacion_mecanico,
  };
}

function pickRep_(r) {
  return {
    rep_id: r.rep_id, fecha_inicio: fmt_(r.fecha_inicio, 'yyyy-MM-dd HH:mm'), fecha_cierre: fmt_(r.fecha_cierre, 'yyyy-MM-dd HH:mm'),
    horas_respuesta: r.horas_respuesta, horas_reparacion: r.horas_reparacion, descripcion: r.descripcion,
    fotos: [r.foto_1, r.foto_2, r.foto_3, r.foto_4].filter(String), costo_refacciones: r.costo_refacciones, costo_mano_obra: r.costo_mano_obra,
    costo_total: r.costo_total, causa: r.causa, responsable_id: r.responsable_id, monto_empleado: r.monto_empleado, monto_empresa: r.monto_empresa,
  };
}

function sevRank_(s) { return { alta: 3, media: 2, baja: 1 }[s] || 0; }
function round_(n, d) { const f = Math.pow(10, d); return Math.round(Number(n) * f) / f; }
function now_() { return fmt_(new Date(), 'yyyy-MM-dd HH:mm:ss'); }

function fmt_(d, pattern) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  return isNaN(date) ? String(d) : Utilities.formatDate(date, TZ, pattern);
}

function parseDate_(s) {
  if (s instanceof Date) return s;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) throw new Error('Fecha inválida: ' + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function startOfDay_(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function startOfWeek_(d) { const x = startOfDay_(d); const day = (x.getDay() + 6) % 7; x.setDate(x.getDate() - day); return x; }
