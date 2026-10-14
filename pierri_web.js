/*
 * Relevamiento Ley Pierri — versión web
 * Ley 24.374 / Ley 8932 · Escribanía General de Gobierno de Córdoba
 * Diseño y desarrollo: Baltasar Corna Fantin, 2026.
 */
/**
 * pierri_web.js — hace en el navegador lo que en el kit hace pierri.js, para que el Tablero ande desde un link
 * (GitHub Pages) sin programa instalado. El Tablero le pide todo con api(ruta) como si fuera el servidor.
 *
 * Los datos viven en el mismo repositorio público, cifrados. Tres llaves:
 *   - la llave de los datos (DEK, AES-256-GCM) cifra el relevamiento;
 *   - cada usuario tiene un par de llaves (ECDH P-256). La privada va cifrada con una llave que sale de su usuario y su
 *     contraseña (PBKDF2-SHA256, 600.000 vueltas, con una sal del sitio). La DEK se le entrega cifrada con su pública;
 *   - la bóveda del administrador (AK) guarda la lista de usuarios y el registro de cambios. No guarda contraseñas,
 *     ni llaves que abran datos, ni el token de GitHub.
 *
 * Archivos (todos en datos/):
 *   usuarios.json      { v, iteraciones, sal, usuarios: [ { priv, dek } ] } — una entrada por usuario activo, mezcladas,
 *                      sin nombres ni identificadores: al ingresar se prueba con cuál abre la contraseña.
 *   relevamiento.enc   el JSON que exporta el kit ("Guardar JSON"), comprimido y cifrado con la DEK.
 *   admin.enc          la bóveda, cifrada con AK; AK va cifrada con la pública del administrador.
 *
 * Reglas:
 *   - Hay un solo administrador y es el único que escribe, con un token de GitHub que queda solo en su computadora.
 *     Adivinar su contraseña da lectura, no escritura.
 *   - Cada escritura se arma leyendo el estado último del repositorio (no lo que tiene la pestaña) y va en un único
 *     commit sobre ese estado; si alguien escribió en el medio, se vuelve a armar.
 *   - Desactivar a alguien, cambiarle la contraseña o cambiar la del administrador cambia la DEK y vuelve a cifrar
 *     todo: las contraseñas viejas no abren nada de lo que se guarde después. Lo anterior queda en el historial.
 *
 * La sesión vive solo en la memoria de la página: no se guarda en el navegador. Al recargar o cerrar, hay que volver a
 * ingresar. La llave privada se importa como no extraíble. El token de GitHub se guarda en esta computadora pero
 * cifrado con una llave que sale de la contraseña del administrador: los demás sitios de la cuenta en github.io (que
 * comparten el almacenamiento del navegador) no pueden usarlo.
 */
(function () {
  'use strict';
  const ITER = 600000;
  const CLAVE_MINIMA = 12;
  const LARGO_CARGA = 512;   // todas las entregas de la DEK miden lo mismo: no se distingue al administrador
  const ROLES = { admin: 'Administración', editor: 'Revisión', veedor: 'Consulta' };
  // En la web solo el administrador escribe. Los perfiles de los demás quedan guardados para cuando haya más funciones.
  const PERMISOS = { ver: ['veedor', 'editor', 'admin'], revisar: [], cargar: ['admin'], administrar: ['admin'] };
  const RUTAS = { usuarios: 'datos/usuarios.json', datos: 'datos/relevamiento.enc', admin: 'datos/admin.enc' };
  const CLAVE_TOKEN = 'pierri_web_token';
  const REPO = window.PIERRI_WEB_REPO || repoDesdeDireccion();
  const AVISO_DEMORA = 'Si te acaban de crear el usuario o cambiar la contraseña, esperá unos minutos: GitHub tarda en publicar los cambios.';
  const FECHA_CORTE = '2006-01-01';

  function repoDesdeDireccion() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    return { owner: m ? m[1] : '', repo: location.pathname.split('/').filter(Boolean)[0] || '', rama: 'main' };
  }

  // ───────────── Cifrado ─────────────
  const te = new TextEncoder(), td = new TextDecoder();
  const S = crypto.subtle;
  const EC = { name: 'ECDH', namedCurve: 'P-256' };
  const azar = n => crypto.getRandomValues(new Uint8Array(n));
  function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function desb64(s) { const t = atob(s), u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; }
  async function derivar(usuario, clave, sal) {
    const base = await S.importKey('raw', te.encode(usuario + '\u0000' + String(clave).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await S.deriveBits({ name: 'PBKDF2', salt: sal, iterations: ITER, hash: 'SHA-256' }, base, 256));
  }
  const llaveAES = raw => S.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function cifrar(raw, bytes, llave) {
    const iv = azar(12);
    return { iv: b64(iv), datos: b64(new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, llave || await llaveAES(raw), bytes))) };
  }
  async function descifrar(raw, sobre, llave) {
    return new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: desb64(sobre.iv) }, llave || await llaveAES(raw), desb64(sobre.datos)));
  }
  async function parNuevo() {
    const k = await S.generateKey(EC, true, ['deriveBits']);
    return { priv: new Uint8Array(await S.exportKey('pkcs8', k.privateKey)), pub: new Uint8Array(await S.exportKey('raw', k.publicKey)) };
  }
  async function llaveCompartida(privada, publica) {
    const bits = new Uint8Array(await S.deriveBits({ name: 'ECDH', public: publica }, privada, 256));
    const base = await S.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await S.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('relevamiento-pierri') }, base, 256));
  }
  /** Cifra para el dueño de una llave pública (ECDH con una llave efímera + HKDF + AES-GCM). */
  async function sellarPara(pubRaw, bytes) {
    const eph = await S.generateKey(EC, true, ['deriveBits']);
    const k = await llaveCompartida(eph.privateKey, await S.importKey('raw', pubRaw, EC, false, []));
    return Object.assign({ e: b64(new Uint8Array(await S.exportKey('raw', eph.publicKey))) }, await cifrar(k, bytes));
  }
  /** Abre lo sellado para una llave privada (CryptoKey no extraíble). */
  async function abrirCon(priv, sobre) {
    return descifrar(await llaveCompartida(priv, await S.importKey('raw', desb64(sobre.e), EC, false, [])), sobre);
  }
  const importarPriv = bytes => S.importKey('pkcs8', bytes, EC, false, ['deriveBits']);
  /** Llave para guardar el token en esta computadora: sale de la llave de la contraseña del administrador. */
  async function llaveToken(kek) {
    const base = await S.importKey('raw', kek, 'HKDF', false, ['deriveKey']);
    return S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('relevamiento-pierri:token') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function rellenar(texto, n) {
    const b = te.encode(texto);
    if (b.length > n) throw new Error('El nombre es demasiado largo.');
    const u = new Uint8Array(n).fill(32); u.set(b); return u;
  }
  const flujo = (bytes, t) => new Response(new Blob([bytes]).stream().pipeThrough(t));
  const comprimir = async texto => new Uint8Array(await flujo(te.encode(texto), new CompressionStream('gzip')).arrayBuffer());
  const descomprimir = bytes => flujo(bytes, new DecompressionStream('gzip')).text();
  /** Ningún texto de los datos puede formar etiquetas HTML: < y > se cambian por ‹ ›. Es una red de seguridad además del escape del Tablero. */
  function limpiar(v) {
    if (typeof v === 'string') return /[<>]/.test(v) ? v.replace(/</g, '‹').replace(/>/g, '›') : v;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = limpiar(v[i]); return v; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = limpiar(v[k]); return v; }
    return v;
  }
  function mezclar(a) { for (let i = a.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const normUsuario = u => String(u || '').trim().toLowerCase();
  function validarUsuario(u) { if (!/^[a-z0-9._-]{3,40}$/.test(u)) throw new Error('El usuario va en minúsculas, sin espacios, de 3 a 40 caracteres (letras, números, punto, guion).'); }
  function validarClave(c) {
    const n = [...String(c || '')].length;
    if (n < CLAVE_MINIMA) throw new Error(`La contraseña debe tener al menos ${CLAVE_MINIMA} caracteres.`);
    if (n > 128) throw new Error('La contraseña no puede superar los 128 caracteres.');
  }

  // ───────────── Repositorio ─────────────
  function errorGitHub(status) {
    if (status === 401) return 'GitHub no acepta el token: está vencido, revocado o mal copiado. Cargá uno nuevo en Configuración.';
    if (status === 403) return 'El token no tiene permiso de escritura sobre este repositorio (Contents: Read and write).';
    if (status === 404) return 'GitHub no encuentra el repositorio con ese token: revisá que el token incluya este repositorio.';
    return 'GitHub respondió ' + status + '.';
  }
  async function red(url, opciones) {
    try { return await fetch(url, opciones); }
    catch (e) { const x = new Error('No hay conexión con GitHub. Revisá internet y volvé a intentar.'); x.red = true; throw x; }
  }
  async function gh(token, metodo, ruta, cuerpo) {
    const r = await red(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${ruta}`, {
      method: metodo, cache: 'no-store',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(errorGitHub(r.status)); e.status = r.status; throw e; }
    return j;
  }
  /** Lee un archivo en un commit dado por la API (lo último de verdad). Devuelve null si no existe. */
  async function leerEn(token, ruta, ref) {
    const r = await red(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${ruta}?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(errorGitHub(r.status));
    return r.text();
  }
  /** Lee un archivo de la página publicada. Lo nuevo puede tardar unos minutos en aparecer. */
  async function leerPublicado(ruta) {
    const r = await red(ruta + '?v=' + Date.now(), { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('No se pudo leer ' + ruta + ' (respuesta ' + r.status + ').');
    return r.text();
  }
  /**
   * Una escritura: lee el estado del último commit, arma los archivos con construir(estado) y los guarda en un único
   * commit hijo de ese. Si en el medio alguien escribió, GitHub rechaza el avance de la rama y se vuelve a armar todo.
   */
  async function transaccion(construir, mensaje) {
    const token = tokenGuardado();
    if (!token) throw new Error('Falta el permiso de GitHub para guardar: cargalo en Configuración.');
    for (let intento = 0; intento < 3; intento++) {
      const head = await punta(token);
      const base = await gh(token, 'GET', `/git/commits/${head}`);
      const estado = { token, head, leer: ruta => leerEn(token, ruta, head) };
      const archivos = await construir(estado);
      const arbol = [];
      for (const [ruta, texto] of Object.entries(archivos)) {
        const blob = await gh(token, 'POST', '/git/blobs', { content: texto, encoding: 'utf-8' });
        arbol.push({ path: ruta, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const t = await gh(token, 'POST', '/git/trees', { base_tree: base.tree.sha, tree: arbol });
      const c = await gh(token, 'POST', '/git/commits', { message: mensaje, tree: t.sha, parents: [head] });
      try { await gh(token, 'PATCH', `/git/refs/heads/${encodeURIComponent(REPO.rama)}`, { sha: c.sha, force: false }); return estado; }
      catch (e) {
        if (e.red) throw new Error('Se cortó la conexión justo al guardar: no se sabe si quedó guardado. Volvé a ingresar y fijate antes de repetirlo.');
        if (e.status === 422 || e.status === 409) continue;
        throw e;
      }
    }
    throw new Error('GitHub no aceptó el cambio: o el sistema cambió varias veces mientras guardabas, o la rama tiene reglas de protección. Volvé a ingresar y probá de nuevo.');
  }
  /** El último commit de la rama. */
  async function punta(token) {
    try { return (await gh(token, 'GET', `/git/ref/heads/${encodeURIComponent(REPO.rama)}`)).object.sha; }
    catch (e) { if (e.status === 404) throw new Error(`No encuentro la rama "${REPO.rama}" en el repositorio (o el token no incluye este repositorio).`); throw e; }
  }

  // ───────────── Token y sesión (solo en memoria) ─────────────
  let SESION = null;
  const sesion = () => SESION;
  function guardarSesion(s) { SESION = s; }
  const tokenGuardado = () => (SESION && SESION.token) || '';
  /** Guarda el token cifrado en esta computadora (y lo deja en la sesión). Con '' lo borra. */
  async function guardarToken(s, t) {
    s.token = t || '';
    try {
      if (!t) { localStorage.removeItem(CLAVE_TOKEN); return; }
      localStorage.setItem(CLAVE_TOKEN, JSON.stringify(await cifrar(null, te.encode(t), s.llaveToken)));
    } catch (e) { /* sin almacenamiento: queda solo en la sesión */ }
  }
  async function leerToken(llave) {
    try { const t = localStorage.getItem(CLAVE_TOKEN); return t ? td.decode(await descifrar(null, JSON.parse(t), llave)) : ''; }
    catch (e) { return ''; }   // de otra contraseña u otro usuario: no sirve
  }
  const puede = (s, p) => !!s && (PERMISOS[p] || []).includes(s.rol);
  function exigir(p) {
    const s = sesion();
    if (!s) throw new Error('Tenés que ingresar.');
    if (!puede(s, p)) throw new Error(`Tu perfil (${ROLES[s.rol] || s.rol}) no puede hacer esta operación en la versión web.`);
    return s;
  }
  function cortarSesion(texto) {
    guardarSesion(null); CACHE = null;
    setTimeout(() => location.reload(), 2500);
    return new Error(texto);
  }

  // ───────────── Estado guardado ─────────────
  /** Del estado de un commit: la lista pública, la DEK vigente y la bóveda, abiertas con la llave del administrador. */
  async function abrirEstado(estado, s) {
    const txtU = await estado.leer(RUTAS.usuarios), txtA = await estado.leer(RUTAS.admin);
    if (!txtU || !txtA) throw new Error('El repositorio no tiene el sistema armado.');
    const lista = JSON.parse(txtU), adm = JSON.parse(txtA), priv = s.priv;
    let carga = null;
    for (const e of lista.usuarios) {
      try { const c = JSON.parse(td.decode(await abrirCon(priv, e.dek)).trim()); if (c.u === s.usuario) { carga = c; break; } } catch (err) { /* no es la suya */ }
    }
    if (!carga) throw cortarSesion('Tu contraseña cambió en otra sesión. Volvé a ingresar.');
    const ak = await abrirCon(priv, adm.ak);
    const boveda = JSON.parse(td.decode(await descifrar(ak, adm)));
    return { lista, dek: desb64(carga.k), ak, boveda };
  }
  /** El estado del último commit, leído por la API (lo usa el administrador para no depender de la demora de Pages). */
  async function estadoFresco(token) { const head = await punta(token); return { leer: r => leerEn(token, r, head) }; }
  async function cargaPara(info, u, dek) {
    return sellarPara(desb64(info.pub), rellenar(JSON.stringify({ k: b64(dek), u, n: info.nombre, r: info.rol }), LARGO_CARGA));
  }
  /** usuarios.json entero desde la bóveda: una entrada por usuario activo, en orden al azar. */
  async function armarLista(boveda, sal, dek) {
    const usuarios = [];
    for (const [u, info] of Object.entries(boveda.usuarios)) if (info.activo && info.priv) usuarios.push({ priv: info.priv, dek: await cargaPara(info, u, dek) });
    return JSON.stringify({ v: 2, iteraciones: ITER, sal, usuarios: mezclar(usuarios) }, null, 1);
  }
  async function sellarBoveda(boveda, ak, pubAdmin) {
    return JSON.stringify(Object.assign({ v: 2, ak: await sellarPara(pubAdmin, ak) }, await cifrar(ak, te.encode(JSON.stringify(boveda)))));
  }
  async function sellarDatos(dek, contenido) { return JSON.stringify(Object.assign({ v: 2 }, await cifrar(dek, await comprimir(JSON.stringify(contenido))))); }
  async function abrirDatosTexto(dek, texto) {
    if (!texto) return { resultados: [], resumen: {}, config: {} };
    return JSON.parse(await descomprimir(await descifrar(dek, JSON.parse(texto))));
  }
  function anotar(boveda, s, accion, detalle) {
    boveda.cambios = boveda.cambios || [];
    boveda.cambios.push({ fecha: new Date().toISOString(), usuario: s.usuario, accion, detalle: detalle || null });
    if (boveda.cambios.length > 2000) boveda.cambios = boveda.cambios.slice(-2000);
  }
  function listaUsuarios(boveda) {
    return Object.entries(boveda.usuarios).sort(([a], [b]) => a.localeCompare(b)).map(([u, i]) => ({
      usuario: u, nombre: i.nombre, rol: i.rol, activo: i.activo ? 1 : 0, debe_cambiar: 0, creado_en: i.creado || null, ultimo_acceso: null, bloqueado_hasta: null,
    }));
  }
  /** Llaves nuevas para un usuario a partir de la contraseña que le pone el administrador. */
  async function llavesPara(u, clave, sal) {
    const par = await parNuevo(), kek = await derivar(u, clave, sal);
    const r = { pub: b64(par.pub), priv: await cifrar(kek, par.priv), privKey: await importarPriv(par.priv), kek };
    par.priv.fill(0);
    return r;
  }

  /**
   * Arma los archivos de un cambio sobre usuarios. cambio(boveda, abiertos) modifica la bóveda y devuelve
   * { rotar, rotarAdmin, detalle }. Con rotar se cambia la DEK y se vuelve a cifrar el relevamiento; con rotarAdmin,
   * además, la AK (cuando cambian las llaves del administrador).
   */
  async function cambiarUsuarios(s, cambio, mensaje) {
    let nuevaSesion = null;
    await transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const r = await cambio(ab.boveda, ab);
      let dek = ab.dek, ak = ab.ak;
      const archivos = {};
      if (r.rotar || r.rotarAdmin) {
        const contenido = await abrirDatosTexto(ab.dek, await estado.leer(RUTAS.datos));
        dek = azar(32);
        archivos[RUTAS.datos] = await sellarDatos(dek, contenido);
      }
      if (r.rotarAdmin) ak = azar(32);
      const yo = ab.boveda.usuarios[s.usuario];
      archivos[RUTAS.usuarios] = await armarLista(ab.boveda, ab.lista.sal, dek);
      archivos[RUTAS.admin] = await sellarBoveda(ab.boveda, ak, desb64(yo.pub));
      nuevaSesion = Object.assign({}, s, { dek: b64(dek) }, r.sesion || {});
      return archivos;
    }, mensaje);
    if (nuevaSesion.kekNueva) {   // cambió la contraseña del administrador: el token se vuelve a cifrar con la llave nueva
      nuevaSesion.llaveToken = await llaveToken(nuevaSesion.kekNueva); delete nuevaSesion.kekNueva;
      await guardarToken(nuevaSesion, s.token);
    }
    guardarSesion(nuevaSesion); CACHE = null;
  }

  // ───────────── Operaciones ─────────────
  async function inicial(c) {
    const u = normUsuario(c.usuario); validarUsuario(u); validarClave(c.clave);
    const token = String(c.token || '').trim();
    if (!token) throw new Error('Falta el token de GitHub.');
    const repo = await gh(token, 'GET', '');
    if (repo.permissions && repo.permissions.push === false) throw new Error('Con ese token no se puede escribir en este repositorio.');
    let sesionNueva, kekAdmin;
    guardarSesion({ token });   // provisoria: solo para que la transacción tenga el token
    try {
      await transaccion(async estado => {
        if (await estado.leer(RUTAS.usuarios)) throw new Error('El sistema ya tiene administrador. Si lo acabás de crear, esperá unos minutos a que GitHub lo publique e ingresá con tu usuario.');
        const sal = azar(16), dek = azar(32), ak = azar(32), ahora = new Date().toISOString();
        const ll = await llavesPara(u, c.clave, sal);
        const boveda = { v: 2, usuarios: { [u]: { nombre: String(c.nombre || u).trim(), rol: 'admin', pub: ll.pub, priv: ll.priv, activo: true, creado: ahora } }, cambios: [] };
        sesionNueva = { usuario: u, nombre: boveda.usuarios[u].nombre, rol: 'admin', dek: b64(dek), priv: ll.privKey, token }; kekAdmin = ll.kek;
        anotar(boveda, sesionNueva, 'inicio', 'se creó el administrador');
        return {
          [RUTAS.usuarios]: await armarLista(boveda, b64(sal), dek),
          [RUTAS.admin]: await sellarBoveda(boveda, ak, desb64(ll.pub)),
          [RUTAS.datos]: await sellarDatos(dek, { fecha: ahora, origen: null, resumen: {}, config: {}, resultados: [] }),
        };
      }, 'Puesta en marcha');
    } catch (e) { guardarSesion(null); throw e; }
    sesionNueva.llaveToken = await llaveToken(kekAdmin);
    await guardarToken(sesionNueva, token);
    guardarSesion(sesionNueva);
    return { ok: true };
  }

  async function login(c) {
    const txt = await leerPublicado(RUTAS.usuarios);
    if (!txt) throw new Error('El sistema todavía no tiene usuarios. Si lo acabás de crear, esperá unos minutos a que GitHub lo publique.');
    const lista = JSON.parse(txt), u = normUsuario(c.usuario);
    const kek = await derivar(u, c.clave || '', desb64(lista.sal));
    let priv = null, privKey = null, carga = null;
    for (const e of lista.usuarios) {
      try { priv = await descifrar(kek, e.priv); } catch (err) { continue; }
      privKey = await importarPriv(priv);
      try { carga = JSON.parse(td.decode(await abrirCon(privKey, e.dek)).trim()); } catch (err) { carga = null; }
      break;
    }
    if (!carga || carga.u !== u) throw new Error('Usuario o contraseña incorrectos. ' + AVISO_DEMORA);
    const s = { usuario: u, nombre: carga.n, rol: carga.r, dek: carga.k };
    if (carga.r === 'admin') {
      s.priv = privKey;
      s.llaveToken = await llaveToken(kek);
      s.token = await leerToken(s.llaveToken);
      if (s.token) {   // lo último de verdad, aunque Pages todavía no haya publicado el último cambio
        try { s.dek = b64((await abrirEstado(await estadoFresco(s.token), s)).dek); } catch (e) { if (/cambió en otra sesión/.test(e.message)) throw new Error('Usuario o contraseña incorrectos. ' + AVISO_DEMORA); }
      }
    }
    if (priv) priv.fill(0);
    guardarSesion(s); CACHE = null;
    return { ok: true };
  }

  async function cambiarClavePropia(c) {
    const s = exigir('administrar');   // en la web solo el administrador escribe; a los demás se la cambia él
    validarClave(c.nueva);
    await cambiarUsuarios(s, async (boveda, ab) => {
      const yo = boveda.usuarios[s.usuario];
      try { await descifrar(await derivar(s.usuario, c.actual || '', desb64(ab.lista.sal)), yo.priv); }
      catch (e) { throw new Error('La contraseña actual no es correcta.'); }
      const ll = await llavesPara(s.usuario, c.nueva, desb64(ab.lista.sal));
      Object.assign(yo, { pub: ll.pub, priv: ll.priv, actualizado: new Date().toISOString() });
      anotar(boveda, s, 'cambio_clave', s.usuario);
      return { rotar: true, rotarAdmin: true, sesion: { priv: ll.privKey, kekNueva: ll.kek } };
    }, 'Actualización de usuarios');
    return { ok: true };
  }

  async function verUsuarios(s) {
    const token = tokenGuardado();
    let estado;
    if (token) estado = await estadoFresco(token);
    else estado = { leer: leerPublicado };
    return (await abrirEstado(estado, s)).boveda;
  }

  async function usuarios(metodo, c) {
    const s = exigir('administrar');
    if (metodo === 'GET') return { roles: ROLES, usuarios: listaUsuarios(await verUsuarios(s)) };
    const u = normUsuario(c.usuario);
    let lista = null;
    await cambiarUsuarios(s, async (boveda, ab) => {
      const ahora = new Date().toISOString(), sal = desb64(ab.lista.sal);
      let r = {};
      if (c.accion === 'crear') {
        validarUsuario(u); validarClave(c.clave);
        if (boveda.usuarios[u]) throw new Error('Ese usuario ya existe.');
        if (!ROLES[c.rol]) throw new Error('Perfil desconocido.');
        if (c.rol === 'admin') throw new Error('En la versión web hay un solo administrador.');
        const ll = await llavesPara(u, c.clave, sal);
        boveda.usuarios[u] = { nombre: String(c.nombre || u).trim(), rol: c.rol, pub: ll.pub, priv: ll.priv, activo: true, creado: ahora };
        anotar(boveda, s, 'usuario_alta', `${u} (${c.rol})`);
      } else {
        const info = boveda.usuarios[u];
        if (!info) throw new Error('Ese usuario no existe.');
        if (c.accion === 'rol') {
          if (!ROLES[c.rol]) throw new Error('Perfil desconocido.');
          if (u === s.usuario || c.rol === 'admin') throw new Error('En la versión web hay un solo administrador: ese perfil no se cambia.');
          info.rol = c.rol; info.actualizado = ahora;
          anotar(boveda, s, 'usuario_perfil', `${u} → ${c.rol}`);
        } else if (c.accion === 'activo') {
          if (u === s.usuario) throw new Error('No podés desactivar tu propia cuenta.');
          if (c.activo) {
            if (info.activo) throw new Error('Ese usuario ya está activo. Para cambiarle la contraseña usá "nueva contraseña".');
            // Volver a activar pide contraseña nueva: la vieja no vuelve a servir.
            validarClave(c.clave);
            const ll = await llavesPara(u, c.clave, sal);
            Object.assign(info, { activo: true, pub: ll.pub, priv: ll.priv, actualizado: ahora });
            anotar(boveda, s, 'usuario_activado', u);
          } else {
            Object.assign(info, { activo: false, priv: null, actualizado: ahora });
            anotar(boveda, s, 'usuario_desactivado', u);
            r = { rotar: true };
          }
        } else if (c.accion === 'reiniciar_clave') {
          if (!info.activo) throw new Error('Ese usuario está desactivado: para habilitarlo usá "activar", que pide la contraseña nueva.');
          validarClave(c.clave);
          const ll = await llavesPara(u, c.clave, sal);
          Object.assign(info, { pub: ll.pub, priv: ll.priv, actualizado: ahora });
          anotar(boveda, s, 'usuario_clave_reiniciada', u);
          // La contraseña vieja pudo filtrarse: se cambia la llave de los datos (y la de la bóveda, si es la del administrador).
          r = u === s.usuario ? { rotar: true, rotarAdmin: true, sesion: { priv: ll.privKey, kekNueva: ll.kek } } : { rotar: true };
        } else throw new Error('Acción desconocida.');
      }
      lista = listaUsuarios(boveda);
      return r;
    }, 'Actualización de usuarios');
    return { ok: true, usuarios: lista };
  }

  async function importar(cuerpo, nombre) {
    const s = exigir('cargar');
    const texto = typeof cuerpo === 'string' ? cuerpo : await cuerpo.text();
    let d;
    try { d = JSON.parse(texto.replace(/^﻿/, '')); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
    if (!d || !Array.isArray(d.resultados)) throw new Error('Ese JSON no es el que baja "Guardar JSON" del kit: no tiene "resultados".');
    const validas = d.resultados.filter(r => r && r.derivado && !r.repetido_de).length;
    const contenido = limpiar({ fecha: new Date().toISOString(), origen: nombre || 'relevamiento', fecha_kit: d.fecha || null, resumen: d.resumen || {}, config: d.config || {}, resultados: d.resultados });
    let dekUsada = null;
    await transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const sellado = await sellarDatos(ab.dek, contenido);
      if (sellado.length > 95 * 1024 * 1024) throw new Error('El relevamiento cifrado supera lo que GitHub acepta por archivo (100 MB).');
      anotar(ab.boveda, s, 'carga_relevamiento', `${nombre || 'JSON'}: ${validas} resoluciones`);
      dekUsada = ab.dek;
      return { [RUTAS.datos]: sellado, [RUTAS.admin]: await sellarBoveda(ab.boveda, ab.ak, desb64(ab.boveda.usuarios[s.usuario].pub)) };
    }, 'Actualización del relevamiento');
    guardarSesion(Object.assign({}, s, { dek: b64(dekUsada) }));
    CACHE = { dek: b64(dekUsada), contenido };
    return { ok: true, resoluciones: validas };
  }

  let CACHE = null;   // el relevamiento descifrado de esta pestaña
  async function datos() {
    const s = exigir('ver');
    if (!CACHE || CACHE.dek !== s.dek) {
      const token = s.rol === 'admin' ? tokenGuardado() : '';
      let texto;
      if (token) {
        const estado = await estadoFresco(token);
        s.dek = b64((await abrirEstado(estado, s)).dek);
        // Si la lectura directa del archivo grande falla (red, o GitHub la desvía), se usa lo publicado.
        try { texto = await estado.leer(RUTAS.datos); } catch (e) { if (!e.red) throw e; texto = await leerPublicado(RUTAS.datos); }
      } else texto = await leerPublicado(RUTAS.datos);
      let contenido;
      try { contenido = await abrirDatosTexto(desb64(s.dek), texto); }
      catch (e) {
        if (e.name !== 'OperationError') throw e;
        // El administrador cambió la llave de los datos: hay que volver a ingresar para recibir la nueva.
        throw cortarSesion('Los datos se volvieron a cifrar. Volvé a ingresar con tu usuario.');
      }
      CACHE = { dek: s.dek, contenido: limpiar(contenido) };
    }
    const c = CACHE.contenido;
    const cfg = Object.assign({ regla: 'CORTE_FIJO', fechaCorte: FECHA_CORTE, margenBordeMeses: 12 }, c.config || {}, s.config || {});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cfg.fechaCorte)) || isNaN(Date.parse(cfg.fechaCorte))) cfg.fechaCorte = FECHA_CORTE;
    cfg.margenBordeMeses = Math.max(0, Number(cfg.margenBordeMeses) || 0);
    const P = window.PierriCore;
    const registros = (c.resultados || []).filter(r => r && r.derivado);
    for (const r of registros) {   // mismo cálculo que el Tablero en modo archivo: el corte se puede cambiar en pantalla
      const d = r.derivado, pd = d.posee_desde ? P.parseFecha(d.posee_desde) : null;
      d.elegibilidad = P.evaluarElegibilidad(pd, cfg);
      d.motivos_revision = (d.motivos_revision || []).filter(m => !m.startsWith('caso borde'));
      if (d.elegibilidad.borde) d.motivos_revision.push(`caso borde (posee desde ${d.posee_desde}, límite ${d.elegibilidad.fechaLimite})`);
      d.revisar = d.motivos_revision.length > 0;
    }
    const resumen = Object.assign({}, c.resumen || {});
    resumen.resoluciones = registros.filter(r => !r.repetido_de && !r.error).length;
    resumen.cargado_web = c.fecha || null;
    return { config: Object.assign({ key: '', modelo: '' }, cfg), resumen, registros };
  }

  async function auditoria() {
    const s = exigir('administrar');
    const boveda = await verUsuarios(s);
    return { registros: (boveda.cambios || []).slice().reverse().map((c, i) => ({ id: i, fecha: c.fecha, usuario: c.usuario, rol: 'admin', accion: c.accion, detalle: c.detalle, ip: 'web' })) };
  }

  async function token(metodo, c) {
    const s = exigir('administrar');
    if (metodo === 'DELETE') { await guardarToken(s, ''); return { ok: true, token: false }; }
    const t = String(c.token || '').trim();
    if (!t) throw new Error('Pegá el token.');
    const repo = await gh(t, 'GET', '');
    if (repo.permissions && repo.permissions.push === false) throw new Error('Con ese token no se puede escribir en este repositorio.');
    await guardarToken(s, t);
    CACHE = null;
    return { ok: true, token: true };
  }

  // ───────────── Rutas que pide el Tablero ─────────────
  async function api(ruta, opciones) {
    const o = opciones || {}, metodo = (o.method || 'GET').toUpperCase();
    const url = new URL(ruta, location.href), p = url.pathname.replace(/^.*\/api\//, '/api/');
    const cuerpoJSON = () => { try { return JSON.parse(typeof o.body === 'string' ? o.body : '{}'); } catch (e) { return {}; } };
    switch (p) {
      case '/api/yo': {
        const s = sesion();
        if (!s) {
          if (!(await leerPublicado(RUTAS.usuarios))) return { sin_usuarios: true };
          throw new Error('Tenés que ingresar.');
        }
        return { usuario: s.usuario, nombre: s.nombre, rol: s.rol, rol_nombre: ROLES[s.rol] || s.rol, debe_cambiar: false,
          web_token: s.rol === 'admin' ? !!tokenGuardado() : undefined,
          permisos: Object.fromEntries(Object.keys(PERMISOS).map(k => [k, puede(s, k)])) };
      }
      case '/api/login': return login(cuerpoJSON());
      case '/api/logout': guardarSesion(null); CACHE = null; return { ok: true };
      case '/api/clave': return cambiarClavePropia(cuerpoJSON());
      case '/api/usuarios': return usuarios(metodo, cuerpoJSON());
      case '/api/datos': return datos();
      case '/api/config': {
        const s = exigir('ver'), c = cuerpoJSON();
        s.config = { regla: c.regla === 'PLAZO_MOVIL' ? 'PLAZO_MOVIL' : 'CORTE_FIJO', fechaCorte: c.fechaCorte, margenBordeMeses: Number(c.margenBordeMeses) || 0 };
        return { ok: true };
      }
      case '/api/auditoria': return auditoria();
      case '/api/inventario/localidades': { const d = await datos(); return { localidades: [], inventario: d.resumen.inventario || { cargado: false } }; }
      case '/api/web/inicial': return inicial(cuerpoJSON());
      case '/api/web/importar': return importar(o.body, url.searchParams.get('nombre'));
      case '/api/web/token': return token(metodo, cuerpoJSON());
      default:
        throw new Error('Esto todavía se hace en el kit: cargalo ahí y subí el JSON con "Guardar JSON".');
    }
  }

  window.PIERRI_WEB = { api, repo: REPO, version: 2 };
})();
