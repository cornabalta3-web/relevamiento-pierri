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
 * Archivos de la rama principal (la que publica la página), todos en datos/:
 *   usuarios.json      { v, iteraciones, sal, usuarios: [ { priv, dek } ] } — una entrada por usuario activo, mezcladas,
 *                      sin nombres ni identificadores: al ingresar se prueba con cuál abre la contraseña.
 *   admin.enc          la bóveda, cifrada con AK; AK va cifrada con la pública del administrador.
 *   relevamiento.enc   el JSON que exporta el kit ("Guardar JSON"), comprimido y cifrado con la DEK.
 *   indice.json        la lista de las lecturas hechas en la web (sin datos: solo nombres de archivo).
 *   lecturas/NNNN.enc  lo leído en la web: { registros, archivos } — las resoluciones y, por cada PDF, dónde quedó
 *                      guardado y con qué llave se abre.
 *   revisiones.enc     las correcciones hechas en la web: { id de la resolución: revisión }. Van aparte para que subir
 *                      de nuevo el JSON del kit no las pise: se aplican encima, y si el kit tiene una más nueva, manda esa.
 *   padron.enc, inventario.enc, catastro.enc   el Padrón del Registro, el inventario de la UEST y las parcelas ya
 *                      consultadas en Catastro. Todo lo que sale de cruzarlos se calcula al mirar, no se guarda.
 *   Todos los .enc van comprimidos y cifrados con la DEK.
 *
 * Rama "pdf" (no se publica en la página): los PDF originales, cifrados uno por uno con una llave propia y
 * agrupados en paquetes p/<azar>.bin. La llave y la posición de cada PDF están en las lecturas, que van cifradas con
 * la DEK: sin entrar al sistema, un paquete es ruido. Al cambiar la DEK no hace falta volver a cifrar los paquetes
 * (pesan gigas): alcanza con volver a cifrar las lecturas. Quien tuvo acceso antes pudo ver esos PDF, igual que antes.
 *
 * Reglas:
 *   - Hay un solo administrador y es el único que escribe, con un token de GitHub que queda solo en su computadora.
 *     Adivinar su contraseña da lectura, no escritura.
 *   - Cada escritura se arma leyendo el estado último del repositorio (no lo que tiene la pestaña) y va en un único
 *     commit sobre ese estado; si alguien escribió en el medio, se vuelve a armar.
 *   - Desactivar a alguien, cambiarle la contraseña o cambiar la del administrador cambia la DEK y vuelve a cifrar
 *     todo lo cifrado con ella: las contraseñas viejas no abren nada de lo que se guarde después. Lo anterior queda en
 *     el historial.
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
  // En la web solo el administrador escribe (es el único con permiso de GitHub). Los perfiles de los demás quedan
  // guardados para cuando haya más funciones.
  const PERMISOS = { ver: ['veedor', 'editor', 'admin'], revisar: ['admin'], cargar: ['admin'], administrar: ['admin'] };
  const RUTAS = { usuarios: 'datos/usuarios.json', datos: 'datos/relevamiento.enc', admin: 'datos/admin.enc', indice: 'datos/indice.json',
    revisiones: 'datos/revisiones.enc', padron: 'datos/padron.enc', inventario: 'datos/inventario.enc', catastro: 'datos/catastro.enc',
    instrucciones: 'datos/modelo.enc', completadas: 'datos/completadas.enc' };
  const CLAVE_TOKEN = 'pierri_web_token';
  // La clave de API de Anthropic, como el token: solo en esta computadora y cifrada con la contraseña del administrador.
  const CLAVE_API = 'pierri_web_clave_api', CLAVE_MODELO = 'pierri_web_modelo';
  const MODELOS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'];
  const LOTE_MODELO = 15;   // resoluciones por cada guardado al completar con el modelo
  const REPO = window.PIERRI_WEB_REPO || repoDesdeDireccion();
  const RAMA_PDF = REPO.ramaPdf || 'pdf';
  const AVISO_DEMORA = 'Si te acaban de crear el usuario o cambiar la contraseña, esperá unos minutos: GitHub tarda en publicar los cambios.';
  const FECHA_CORTE = '2006-01-01';
  const PDF_MAXIMO = 60 * 1024 * 1024;       // un PDF cifrado tiene que entrar en un solo envío a GitHub (100 MB en base64)
  const PAQUETE = 30 * 1024 * 1024;          // los PDF se suben en paquetes de hasta 30 MB (40 MB en base64)
  // Se guarda en GitHub cada 60 MB de PDF leídos o cada 250 archivos, lo que llegue primero: lo leído no espera al final.
  // Cada tanda son 12 o 13 escrituras (2 o 3 paquetes); 7.000 PDF son unas 35 tandas, unas 450 de las 500 escrituras por
  // hora que permite GitHub si la carga entera dura menos de una hora. Si se pasa, GitHub pide una pausa y se espera.
  const TANDA_BYTES = 60 * 1024 * 1024;
  const TANDA_ARCHIVOS = 250;
  const LECTURA_MAXIMA = 1500 * 1024;        // una lectura cifrada que pasa este tamaño se cierra y se empieza otra
  const TIPOS = ['RESOLUCION_INSCRIPCION', 'RESOLUCION_RECTIFICA', 'RESOLUCION_DESESTIMA', 'RESOLUCION_CANCELA', 'RESOLUCION_TRAMITE', 'CEDULA_NOTIFICACION'];

  function repoDesdeDireccion() {
    const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
    return { owner: m ? m[1] : '', repo: location.pathname.split('/').filter(Boolean)[0] || '', rama: 'main' };
  }
  const ahora = () => new Date().toISOString();
  const dormir = ms => new Promise(r => setTimeout(r, ms));
  const mb = n => (n / 1024 / 1024).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + ' MB';
  /** Avisa al Tablero cómo va una tarea larga (leer, subir, esperar a GitHub). */
  function progreso(texto) { try { window.dispatchEvent(new CustomEvent('pierri-web-progreso', { detail: texto })); } catch (e) { /* sin pantalla */ } }
  let OCUPADO = 0;
  async function ocupado(fn) { OCUPADO++; try { return await fn(); } finally { OCUPADO--; } }

  // ───────────── Cifrado ─────────────
  const te = new TextEncoder(), td = new TextDecoder();
  const S = crypto.subtle;
  const EC = { name: 'ECDH', namedCurve: 'P-256' };
  const azar = n => crypto.getRandomValues(new Uint8Array(n));
  const hex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
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
  /** Llaves para guardar el token y la clave de API en esta computadora: salen de la llave de la contraseña del administrador. */
  async function llaveLocal(kek, uso) {
    const base = await S.importKey('raw', kek, 'HKDF', false, ['deriveKey']);
    return S.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('relevamiento-pierri:' + uso) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  const llaveToken = kek => llaveLocal(kek, 'token');
  const llaveApi = kek => llaveLocal(kek, 'api');
  function rellenar(texto, n) {
    const b = te.encode(texto);
    if (b.length > n) throw new Error('El nombre es demasiado largo.');
    const u = new Uint8Array(n).fill(32); u.set(b); return u;
  }
  /** La huella de un PDF: la misma que usa el kit (SHA-1, 16 caracteres), para reconocer el mismo archivo en los dos. */
  async function huella(bytes) { return hex(new Uint8Array(await S.digest('SHA-1', bytes))).slice(0, 16); }
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
  function errorGitHub(status, j) {
    if (/rate limit/i.test(String((j && j.message) || ''))) return 'GitHub frenó los pedidos por un rato (límite de uso). Esperá unos minutos y volvé a intentar: lo ya guardado no se pierde.';
    if (status === 401) return 'GitHub no acepta el token: está vencido, revocado o mal copiado. Cargá uno nuevo en Configuración.';
    if (status === 403) return 'El token no tiene permiso de escritura sobre este repositorio (Contents: Read and write).';
    if (status === 404) return 'GitHub no encuentra el repositorio con ese token: revisá que el token incluya este repositorio.';
    return 'GitHub respondió ' + status + '.';
  }
  async function red(url, opciones) {
    try { return await fetch(url, opciones); }
    catch (e) { const x = new Error('No hay conexión con GitHub. Revisá internet y volvé a intentar.'); x.red = true; throw x; }
  }
  /**
   * Cuánto esperar si GitHub pidió una pausa (límite de pedidos). null si no es eso, o si la espera es tan larga que
   * conviene avisar y cortar. GitHub pide no más de 80 escrituras por minuto y 500 por hora.
   */
  function esperaPedida(r, j) {
    const limite = r.status === 429 || (r.status === 403 && (r.headers.get('retry-after') || /rate limit/i.test(String((j && j.message) || ''))));
    if (!limite) return null;
    const ra = Number(r.headers.get('retry-after'));
    if (ra > 0) return ra > 900 ? null : ra * 1000;
    const reset = Number(r.headers.get('x-ratelimit-reset'));
    if (r.headers.get('x-ratelimit-remaining') === '0' && reset) { const ms = reset * 1000 - Date.now() + 1000; return ms > 15 * 60 * 1000 ? null : Math.max(ms, 1000); }
    return 60000;
  }
  // En las cargas grandes, GitHub pide dejar al menos un segundo entre escrituras.
  const RITMO = { ultimo: 0, minimo: 0 };
  async function gh(token, metodo, ruta, cuerpo) {
    for (let intento = 0; ; intento++) {
      if (metodo !== 'GET' && RITMO.minimo) { const falta = RITMO.ultimo + RITMO.minimo - Date.now(); if (falta > 0) await dormir(falta); RITMO.ultimo = Date.now(); }
      const r = await red(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}${ruta}`, {
        method: metodo, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) return j;
      const espera = esperaPedida(r, j);
      if (espera != null && intento < 6) {
        progreso(`GitHub pidió una pausa: sigo solo en ${Math.ceil(espera / 1000)} segundos…`);
        await dormir(espera); continue;
      }
      const e = new Error(errorGitHub(r.status, j)); e.status = r.status; throw e;
    }
  }
  /** Lee un archivo en un commit dado por la API (lo último de verdad). Devuelve null si no existe. */
  async function leerEn(token, ruta, ref) {
    const r = await red(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/contents/${ruta}?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' }, cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(errorGitHub(r.status, await r.json().catch(() => ({}))));
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
  /** El último commit de una rama (la principal si no se dice otra). */
  async function punta(token, rama) {
    const r = rama || REPO.rama;
    try { return (await gh(token, 'GET', `/git/ref/heads/${encodeURIComponent(r)}`)).object.sha; }
    catch (e) {
      if (e.status !== 404) throw e;
      if (r !== REPO.rama) { e.sinRama = true; throw e; }
      throw new Error(`No encuentro la rama "${r}" en el repositorio (o el token no incluye este repositorio).`);
    }
  }
  /**
   * Sube paquetes de PDF cifrados a la rama de los PDF, que no se publica en la página. La crea la primera vez.
   * Los paquetes se suben una sola vez; si otro guardado se cruza, solo se rearma el commit. Devuelve el commit.
   */
  async function subirPaquetes(token, paquetes) {
    const arbol = [];
    for (let i = 0; i < paquetes.length; i++) {
      const p = paquetes[i];
      progreso(`Subiendo los PDF cifrados a GitHub: paquete ${i + 1} de ${paquetes.length} (${p.n} archivo${p.n === 1 ? '' : 's'}, ${mb(p.bytes.length)})…`);
      const blob = await gh(token, 'POST', '/git/blobs', { content: b64(p.bytes), encoding: 'base64' });
      arbol.push({ path: p.ruta, mode: '100644', type: 'blob', sha: blob.sha });
    }
    for (let intento = 0; intento < 4; intento++) {
      let head = null, arbolBase = null;
      try { head = await punta(token, RAMA_PDF); arbolBase = (await gh(token, 'GET', `/git/commits/${head}`)).tree.sha; }
      catch (e) { if (!e.sinRama) throw e; }
      const t = await gh(token, 'POST', '/git/trees', arbolBase ? { base_tree: arbolBase, tree: arbol } : { tree: arbol });
      const c = await gh(token, 'POST', '/git/commits', { message: 'PDF cifrados', tree: t.sha, parents: head ? [head] : [] });
      try {
        if (head) await gh(token, 'PATCH', `/git/refs/heads/${encodeURIComponent(RAMA_PDF)}`, { sha: c.sha, force: false });
        else await gh(token, 'POST', '/git/refs', { ref: `refs/heads/${RAMA_PDF}`, sha: c.sha });
        return c.sha;
      } catch (e) {
        if (e.red) throw new Error('Se cortó la conexión justo al guardar los PDF. Volvé a intentar: lo que ya estaba guardado no se pierde.');
        if (e.status === 422 || e.status === 409) continue;
        throw e;
      }
    }
    throw new Error('GitHub no aceptó los PDF: otra carga se cruzó varias veces. Volvé a intentar.');
  }
  /** Trae un PDF guardado: solo su tramo del paquete (pedido por rango), y lo descifra. */
  async function traerPDF(a) {
    const p = a.pdf;
    const url = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.repo}/${p.commit}/${p.pack}`, rango = { Range: `bytes=${p.off}-${p.off + p.len - 1}` };
    // El paquete no cambia nunca (va por commit): se aprovecha lo guardado en el navegador. Pero si lo guardado es un
    // error (pedido antes de que GitHub lo tuviera), se vuelve a pedir sin usarlo.
    let r = await red(url, { headers: rango, cache: 'force-cache' });
    if (!r.ok) r = await red(url, { headers: rango, cache: 'reload' });
    if (!r.ok) throw new Error(`GitHub no devolvió el PDF (respuesta ${r.status}). Si recién lo cargaste, esperá unos cinco minutos y volvé a probar.`);
    let u = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200 && u.length !== p.len) u = u.subarray(p.off, p.off + p.len);   // el servidor mandó el paquete entero
    return new Uint8Array(await S.decrypt({ name: 'AES-GCM', iv: desb64(p.iv) }, await llaveAES(desb64(p.k)), u));
  }

  // ───────────── Token y sesión (solo en memoria) ─────────────
  let SESION = null;
  const sesion = () => SESION;
  function guardarSesion(s) { SESION = s; }
  const tokenGuardado = () => (SESION && SESION.token) || '';
  /** Guarda el token cifrado en esta computadora (y lo deja en la sesión). Con '' lo borra. */
  async function guardarToken(s, t) { s.token = t || ''; await guardarSecreto(CLAVE_TOKEN, s.token, s.llaveToken); }
  async function leerToken(llave) { return leerSecreto(CLAVE_TOKEN, llave); }
  async function guardarClaveApi(s, k) { s.claveApi = k || ''; await guardarSecreto(CLAVE_API, s.claveApi, s.llaveApi); }
  async function guardarSecreto(nombre, valor, llave) {
    try {
      if (!valor) { localStorage.removeItem(nombre); return; }
      localStorage.setItem(nombre, JSON.stringify(await cifrar(null, te.encode(valor), llave)));
    } catch (e) { /* sin almacenamiento: queda solo en la sesión */ }
  }
  async function leerSecreto(nombre, llave) {
    try { const t = localStorage.getItem(nombre); return t ? td.decode(await descifrar(null, JSON.parse(t), llave)) : ''; }
    catch (e) { return ''; }   // de otra contraseña u otro usuario: no sirve
  }
  const puede = (s, p) => !!s && (PERMISOS[p] || []).includes(s.rol);
  function exigir(p) {
    const s = sesion();
    if (!s) throw new Error('Tenés que ingresar.');
    if (!puede(s, p)) throw new Error(`Tu perfil (${ROLES[s.rol] || s.rol}) no puede hacer esta operación en la versión web.`);
    return s;
  }
  function exigirToken() { if (!tokenGuardado()) throw new Error('Falta el permiso de GitHub para guardar: cargalo en Configuración.'); }
  function cortarSesion(texto) {
    guardarSesion(null); CACHE = null; perderPendiente();
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
    const plano = await descifrar(ak, adm);   // desde la v3 va comprimida, como los demás
    const boveda = JSON.parse(adm.v >= 3 ? await descomprimir(plano) : td.decode(plano));
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
    // Comprimida: se reescribe con cada cambio y cada versión queda en el historial, que así crece mucho menos.
    return JSON.stringify(Object.assign({ v: 3, ak: await sellarPara(pubAdmin, ak) }, await cifrar(ak, await comprimir(JSON.stringify(boveda)))));
  }
  const sellarBovedaDe = (ab, s) => sellarBoveda(ab.boveda, ab.ak, desb64(ab.boveda.usuarios[s.usuario].pub));
  async function sellarDatos(dek, contenido) { return JSON.stringify(Object.assign({ v: 2 }, await cifrar(dek, await comprimir(JSON.stringify(contenido))))); }
  /** Abre un archivo cifrado con la DEK. Sin archivo, devuelve null. */
  async function abrirJSON(dek, texto) { return texto ? JSON.parse(await descomprimir(await descifrar(dek, JSON.parse(texto)))) : null; }
  async function abrirDatosTexto(dek, texto) { return (await abrirJSON(dek, texto)) || { resultados: [], resumen: {}, config: {} }; }
  /** Cambia la DEK de un archivo sin abrir su contenido. */
  async function recifrar(vieja, nueva, texto) {
    const sobre = JSON.parse(texto);
    return JSON.stringify(Object.assign({ v: sobre.v || 2 }, await cifrar(nueva, await descifrar(vieja, sobre))));
  }
  /** El índice de las lecturas de la web. Solo acepta nombres con la forma esperada. */
  function leerIndice(texto) {
    let i = null;
    try { i = texto ? JSON.parse(texto) : null; } catch (e) { i = null; }
    const lecturas = (i && Array.isArray(i.lecturas) ? i.lecturas : []).filter(r => typeof r === 'string' && /^datos\/lecturas\/\d{4,6}\.enc$/.test(r));
    return { v: 1, lecturas };
  }
  /** Todo lo que está cifrado con la DEK en un commit: lo que hay que volver a cifrar al cambiarla. */
  async function rutasCifradas(estado) {
    return [RUTAS.datos, RUTAS.revisiones, RUTAS.padron, RUTAS.inventario, RUTAS.catastro, RUTAS.instrucciones, RUTAS.completadas]
      .concat(leerIndice(await estado.leer(RUTAS.indice)).lecturas);
  }
  function anotar(boveda, s, accion, detalle) {
    boveda.cambios = boveda.cambios || [];
    boveda.cambios.push({ fecha: ahora(), usuario: s.usuario, accion, detalle: detalle || null });
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
   * { rotar, rotarAdmin, detalle }. Con rotar se cambia la DEK y se vuelve a cifrar todo lo cifrado con ella; con
   * rotarAdmin, además, la AK (cuando cambian las llaves del administrador).
   */
  async function cambiarUsuarios(s, cambio, mensaje) {
    let nuevaSesion = null;
    await transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const r = await cambio(ab.boveda, ab);
      let dek = ab.dek, ak = ab.ak;
      const archivos = {};
      if (r.rotar || r.rotarAdmin) {
        dek = azar(32);
        for (const ruta of await rutasCifradas(estado)) { const t = await estado.leer(ruta); if (t) archivos[ruta] = await recifrar(ab.dek, dek, t); }
      }
      if (r.rotarAdmin) ak = azar(32);
      const yo = ab.boveda.usuarios[s.usuario];
      archivos[RUTAS.usuarios] = await armarLista(ab.boveda, ab.lista.sal, dek);
      archivos[RUTAS.admin] = await sellarBoveda(ab.boveda, ak, desb64(yo.pub));
      nuevaSesion = Object.assign({}, s, { dek: b64(dek) }, r.sesion || {});
      return archivos;
    }, mensaje);
    if (nuevaSesion.kekNueva) {   // cambió la contraseña del administrador: el token se vuelve a cifrar con la llave nueva
      nuevaSesion.llaveToken = await llaveToken(nuevaSesion.kekNueva); nuevaSesion.llaveApi = await llaveApi(nuevaSesion.kekNueva); delete nuevaSesion.kekNueva;
      await guardarToken(nuevaSesion, s.token);
      await guardarClaveApi(nuevaSesion, s.claveApi);
    }
    guardarSesion(nuevaSesion); CACHE = null;
  }

  // ───────────── Usuarios ─────────────
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
        const sal = azar(16), dek = azar(32), ak = azar(32), t = ahora();
        const ll = await llavesPara(u, c.clave, sal);
        const boveda = { v: 2, usuarios: { [u]: { nombre: String(c.nombre || u).trim(), rol: 'admin', pub: ll.pub, priv: ll.priv, activo: true, creado: t } }, cambios: [] };
        sesionNueva = { usuario: u, nombre: boveda.usuarios[u].nombre, rol: 'admin', dek: b64(dek), priv: ll.privKey, token }; kekAdmin = ll.kek;
        anotar(boveda, sesionNueva, 'inicio', 'se creó el administrador');
        return {
          [RUTAS.usuarios]: await armarLista(boveda, b64(sal), dek),
          [RUTAS.admin]: await sellarBoveda(boveda, ak, desb64(ll.pub)),
          [RUTAS.datos]: await sellarDatos(dek, { fecha: t, origen: null, resumen: {}, config: {}, resultados: [] }),
        };
      }, 'Puesta en marcha');
    } catch (e) { guardarSesion(null); throw e; }
    sesionNueva.llaveToken = await llaveToken(kekAdmin); sesionNueva.llaveApi = await llaveApi(kekAdmin);
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
      s.llaveToken = await llaveToken(kek); s.llaveApi = await llaveApi(kek);
      s.claveApi = await leerSecreto(CLAVE_API, s.llaveApi);
      s.token = await leerToken(s.llaveToken);
      if (s.token) {   // lo último de verdad, aunque Pages todavía no haya publicado el último cambio
        try { s.dek = b64((await abrirEstado(await estadoFresco(s.token), s)).dek); } catch (e) { if (/cambió en otra sesión/.test(e.message)) throw new Error('Usuario o contraseña incorrectos. ' + AVISO_DEMORA); }
      }
    }
    if (priv) priv.fill(0);
    guardarSesion(s); CACHE = null; perderPendiente();
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
      Object.assign(yo, { pub: ll.pub, priv: ll.priv, actualizado: ahora() });
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
      const t = ahora(), sal = desb64(ab.lista.sal);
      let r = {};
      if (c.accion === 'crear') {
        validarUsuario(u); validarClave(c.clave);
        if (boveda.usuarios[u]) throw new Error('Ese usuario ya existe.');
        if (!ROLES[c.rol]) throw new Error('Perfil desconocido.');
        if (c.rol === 'admin') throw new Error('En la versión web hay un solo administrador.');
        const ll = await llavesPara(u, c.clave, sal);
        boveda.usuarios[u] = { nombre: String(c.nombre || u).trim(), rol: c.rol, pub: ll.pub, priv: ll.priv, activo: true, creado: t };
        anotar(boveda, s, 'usuario_alta', `${u} (${c.rol})`);
      } else {
        const info = boveda.usuarios[u];
        if (!info) throw new Error('Ese usuario no existe.');
        if (c.accion === 'rol') {
          if (!ROLES[c.rol]) throw new Error('Perfil desconocido.');
          if (u === s.usuario || c.rol === 'admin') throw new Error('En la versión web hay un solo administrador: ese perfil no se cambia.');
          info.rol = c.rol; info.actualizado = t;
          anotar(boveda, s, 'usuario_perfil', `${u} → ${c.rol}`);
        } else if (c.accion === 'activo') {
          if (u === s.usuario) throw new Error('No podés desactivar tu propia cuenta.');
          if (c.activo) {
            if (info.activo) throw new Error('Ese usuario ya está activo. Para cambiarle la contraseña usá "nueva contraseña".');
            // Volver a activar pide contraseña nueva: la vieja no vuelve a servir.
            validarClave(c.clave);
            const ll = await llavesPara(u, c.clave, sal);
            Object.assign(info, { activo: true, pub: ll.pub, priv: ll.priv, actualizado: t });
            anotar(boveda, s, 'usuario_activado', u);
          } else {
            Object.assign(info, { activo: false, priv: null, actualizado: t });
            anotar(boveda, s, 'usuario_desactivado', u);
            r = { rotar: true };
          }
        } else if (c.accion === 'reiniciar_clave') {
          if (!info.activo) throw new Error('Ese usuario está desactivado: para habilitarlo usá "activar", que pide la contraseña nueva.');
          validarClave(c.clave);
          const ll = await llavesPara(u, c.clave, sal);
          Object.assign(info, { pub: ll.pub, priv: ll.priv, actualizado: t });
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

  // ───────────── Lo guardado, en memoria ─────────────
  let CACHE = null;   // lo descifrado de esta pestaña: { dek, kit, indice, lecturas, revisiones, padron, inventario, catastro }
  /** Lee y descifra todo lo guardado. El administrador lo lee por la API (lo último); los demás, de la página publicada. */
  async function cargarTodo(s) {
    const token = s.rol === 'admin' ? tokenGuardado() : '';
    let leer = leerPublicado;
    if (token) {
      const estado = await estadoFresco(token);
      s.dek = b64((await abrirEstado(estado, s)).dek);
      // Si la lectura directa falla por la red (o GitHub la desvía), se usa lo publicado.
      leer = async ruta => { try { return await estado.leer(ruta); } catch (e) { if (!e.red) throw e; return leerPublicado(ruta); } };
    }
    const dek = desb64(s.dek);
    try {
      const [txtKit, txtIndice, ...extras] = await Promise.all([RUTAS.datos, RUTAS.indice, RUTAS.revisiones, RUTAS.padron, RUTAS.inventario, RUTAS.catastro,
        RUTAS.instrucciones, RUTAS.completadas].map(leer));
      const indice = leerIndice(txtIndice);
      const textos = await Promise.all(indice.lecturas.map(leer));
      const lecturas = {};
      for (let i = 0; i < textos.length; i++) if (textos[i]) lecturas[indice.lecturas[i]] = limpiar(await abrirJSON(dek, textos[i]));
      const [revisiones, padron, inventario, catastro, instrucciones, completadas] = await Promise.all(extras.map(t => abrirJSON(dek, t)));
      // Las instrucciones del modelo van al modelo tal cual (no se muestran): no se les cambia nada.
      return { dek: s.dek, kit: limpiar(await abrirDatosTexto(dek, txtKit)), indice, lecturas, revisiones: limpiar(revisiones), padron: limpiar(padron),
        inventario: limpiar(inventario), catastro: limpiar(catastro), instrucciones, completadas: limpiar(completadas) };
    } catch (e) {
      if (e.name !== 'OperationError') throw e;
      // El administrador cambió la llave de los datos: hay que volver a ingresar para recibir la nueva.
      throw cortarSesion('Los datos se volvieron a cifrar. Volvé a ingresar con tu usuario.');
    }
  }
  async function cacheDatos(s) {
    if (!CACHE || CACHE.dek !== s.dek) CACHE = await cargarTodo(s);
    return CACHE;
  }
  /**
   * Después de guardar: la sesión queda con la DEK con que se guardó y lo que se escribió pasa a la memoria sin volver
   * a bajar todo. Si mientras tanto cambió algo más (otra DEK, otra lectura que esta pestaña no tiene), se vuelve a leer.
   */
  function alGuardar(s, dek, cambios) {
    const d = b64(dek);
    if (SESION === s || (SESION && SESION.usuario === s.usuario)) SESION.dek = d;
    if (!CACHE || CACHE.dek !== d) { CACHE = null; return; }
    delete CACHE._ix;
    if (cambios.indice) {
      if (cambios.indice.lecturas.some(r => r !== cambios.ruta && !CACHE.lecturas[r])) { CACHE = null; return; }
      CACHE.indice = cambios.indice; CACHE.lecturas[cambios.ruta] = cambios.contenido;
    }
    for (const k of ['kit', 'revisiones', 'padron', 'inventario', 'catastro', 'instrucciones', 'completadas']) if (k in cambios) CACHE[k] = cambios[k];
  }
  /** Lo leído en la web: los archivos (con dónde está cada PDF) y los registros, sin repetir. */
  function lecturasWeb(c) {
    const archivos = {}, registros = [], vistos = new Set();
    for (const ruta of c.indice.lecturas) {
      const l = c.lecturas[ruta]; if (!l) continue;
      Object.assign(archivos, l.archivos || {});
      for (const r of l.registros || []) if (r && !vistos.has(r.hash)) { vistos.add(r.hash); registros.push(r); }
    }
    return { archivos, registros };
  }
  /** Para reconocer rápido un PDF que ya está: los archivos guardados en la web y los que leyó el kit. Se rehace al cambiar la memoria. */
  function indices(c) {
    if (!c._ix) {
      const kit = new Map();
      for (const r of c.kit.resultados || []) {
        if (!r) continue;
        // La huella del PDF está en hash_archivo y al principio del id; en un lote importado sin los PDF, solo en el id.
        for (const h of [r.hash_archivo, String(r.hash || '').split('#')[0]]) if (h && !kit.has(h)) kit.set(h, r);
      }
      c._ix = { archivos: lecturasWeb(c).archivos, kit };
    }
    return c._ix;
  }
  /**
   * Las parcelas consultadas para el inventario, con la forma de la tabla del kit. Como en el kit, las que se consultaron
   * para ubicar resoluciones no cuentan para el inventario (allá van a otra tabla); para ubicar resoluciones sirven todas.
   */
  function parcelasDe(cat) {
    const out = {};
    for (const [cta, v] of Object.entries(cat || {})) if (v.inv) out[cta] = window.PierriBase.parcelaDesdeCatastro(v.p || null, v.en || null);
    return out;
  }
  /** Suma consultas nuevas a las guardadas sin perder la marca de las que ya cuentan para el inventario. */
  function sumarParcelas(actual, nuevas) {
    const out = Object.assign({}, actual || {});
    for (const [cta, v] of Object.entries(nuevas)) out[cta] = (out[cta] && out[cta].inv && !v.inv) ? Object.assign({}, v, { inv: true }) : v;
    return out;
  }
  let LOCALIDADES;   // undefined: sin pedir; null: no está
  async function localidades() {
    if (LOCALIDADES === undefined) {
      try { const r = await fetch('localidades_cordoba.json', { cache: 'force-cache' }); LOCALIDADES = r.ok ? (await r.json()).localidades || null : null; }
      catch (e) { LOCALIDADES = null; }
    }
    return LOCALIDADES;
  }
  const tabla = () => window.TABLA_CODIGOS || null;
  function cfgDe(c, s) {
    const cfg = Object.assign({ regla: 'CORTE_FIJO', fechaCorte: FECHA_CORTE, margenBordeMeses: 12 }, (c && c.kit && c.kit.config) || {}, s.config || {});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cfg.fechaCorte)) || isNaN(Date.parse(cfg.fechaCorte))) cfg.fechaCorte = FECHA_CORTE;
    cfg.margenBordeMeses = Math.max(0, Number(cfg.margenBordeMeses) || 0);
    return cfg;
  }

  let VISTA = null;   // lo último que se calculó: todos los registros, los archivos y el resultado del cruce con el Padrón
  /**
   * Lo que ve el Tablero, calculado en el momento sobre una copia: lo del kit más lo leído en la web (si un PDF está en
   * los dos, manda la lectura del kit), las correcciones (la más nueva), Catastro, la localidad, los repetidos, el
   * inventario, el Padrón y los grupos por domicilio o matrícula. El mismo orden que el kit.
   */
  function vista(c, s, loc) {
    const P = window.PierriCore, B = window.PierriBase, T = tabla();
    const cfg = cfgDe(c, s);
    const deKit = (c.kit.resultados || []).filter(Boolean);
    const enKit = new Set(deKit.map(r => r.hash));
    const web = lecturasWeb(c);
    // Lo completado después con el modelo reemplaza a la lectura por texto de esa misma resolución.
    const comp = c.completadas || {};
    const todos = structuredClone(deKit.concat(web.registros.filter(r => !enKit.has(r.hash))).map(r => comp[r.hash] || r));
    const revs = c.revisiones || {}, cat = c.catastro || {};
    for (const r of todos) {
      if (!r.derivado) continue;
      const d = r.derivado, pd = d.posee_desde ? P.parseFecha(d.posee_desde) : null;
      d.elegibilidad = P.evaluarElegibilidad(pd, cfg);
      d.motivos_revision = (d.motivos_revision || []).filter(m => !m.startsWith('caso borde'));
      if (d.elegibilidad.borde) d.motivos_revision.push(`caso borde (posee desde ${d.posee_desde}, límite ${d.elegibilidad.fechaLimite})`);
      d.revisar = d.motivos_revision.length > 0;
      const rw = revs[r.hash];
      if (rw && (!r.revision || String(rw.en || '') >= String(r.revision.en || ''))) r.revision = rw;
      B.aplicarRevision(r, cfg);
      const g = d.geo, cta = g && g.cuenta_normalizada ? g.cuenta_normalizada.replace(/\D/g, '') : '';
      // Ubicada por la parcela: deja de ser la ubicación aproximada por localidad que pudo traer del kit.
      if (cta && !(g.catastro && g.catastro.encontrada) && cat[cta] && P.enriquecerConCatastro(d, cat[cta].p || null, T)) delete g.ubicacion_aproximada;
      if (loc) P.ubicarPorLocalidad(d, loc);
      // Dónde está su PDF (la clave para pedirlo), si se guardó en la web.
      const clave = [r.hash_archivo, String(r.hash || '').split('#')[0]].find(h => h && web.archivos[h] && web.archivos[h].pdf);
      r.pdf_web = clave || null;
    }
    B.marcarRepetidos(todos);
    // El cruce con el Padrón y el inventario se hace acá, con lo cargado en la web. Lo que traía el JSON del kit se saca:
    // mezclado con lo leído en la web daría resoluciones sin cruzar y conteos que no cierran.
    if (!c.padron) for (const r of todos) { delete r.inscripcion; if (r.derivado) delete r.derivado.inscripcion; }
    if (!c.inventario) for (const r of todos) delete r.inventario;
    let indiceInv = null;
    if (c.inventario) { indiceInv = B.indicePorExpediente(c.inventario.filas || []); B.anexarInventario(todos, indiceInv); }
    const cruce = c.padron ? B.cruzarConPadron(todos, c.padron.filas || [], indiceInv || new Map()) : null;
    P.detectarClusters(todos.filter(r => r.derivado && !r.repetido_de && !r.error).map(r => r.derivado));

    const validos = todos.filter(r => r.derivado && !r.repetido_de && !r.error);
    const kr = c.kit.resumen || {};
    const archivosKit = new Set(deKit.map(r => r.hash_archivo).filter(Boolean));
    const leidosWeb = Object.keys(web.archivos).filter(h => web.archivos[h].tipo !== 'kit' && !archivosKit.has(h)).length;
    // El JSON del kit trae solo las resoluciones válidas: sus repetidas y sus errores se suman de su resumen.
    const resumen = Object.assign({}, kr, {
      archivos: (Number(kr.archivos) || archivosKit.size) + leidosWeb,
      resoluciones: validos.length,
      repetidas: (Number(kr.repetidas) || 0) + todos.filter(r => r.repetido_de).length,
      errores: (Number(kr.errores) || 0) + todos.filter(r => r.error).length,
      incompletas: validos.filter(r => r.fuente === 'texto_incompleto').length,
      // Los tokens del kit (de su resumen) más los gastados en la web al completar con el modelo.
      tokens: (Number(kr.tokens) || deKit.reduce((a, r) => a + (Number(r.tokens) || 0), 0)) + Object.values(comp).reduce((a, r) => a + (Number(r.tokens) || 0), 0),
      instrucciones_modelo: !!(c.instrucciones && c.instrucciones.prompt_sistema),
      cargado_web: c.kit.fecha || null,
      pdf_guardados: Object.values(web.archivos).filter(a => a.pdf).length,
    });
    resumen.padron = c.padron ? { archivo: c.padron.archivo || null, cargado_en: c.padron.cargado_en || null, filas: (c.padron.filas || []).length } : {};
    resumen.inventario = { cargado: false };
    if (c.inventario) resumen.inventario = B.resumenInventario(c.inventario.filas || [], parcelasDe(cat), todos, { archivo: c.inventario.archivo || null, cargado_en: c.inventario.cargado_en || null });
    VISTA = { todos, archivos: web.archivos, cruce };
    const clave = s.claveApi || '';
    return { config: Object.assign({}, cfg, { key: clave ? '••••' + clave.slice(-4) : '', modelo: modeloElegido() }), resumen, registros: todos.filter(r => r.derivado) };
  }
  async function datos() {
    const s = exigir('ver');
    const c = await cacheDatos(s);
    return vista(c, s, await localidades());
  }

  // ───────────── El JSON del kit ─────────────
  async function importar(cuerpo, nombre) {
    const s = exigir('cargar');
    const texto = typeof cuerpo === 'string' ? cuerpo : await cuerpo.text();
    let d;
    try { d = JSON.parse(texto.replace(/^﻿/, '')); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
    if (!d || !Array.isArray(d.resultados)) throw new Error('Ese JSON no es el que baja "Guardar JSON" del kit: no tiene "resultados".');
    const validas = d.resultados.filter(r => r && r.derivado && !r.repetido_de).length;
    const contenido = limpiar({ fecha: ahora(), origen: nombre || 'relevamiento', fecha_kit: d.fecha || null, resumen: d.resumen || {}, config: d.config || {}, resultados: d.resultados });
    let dekUsada = null;
    await ocupado(() => transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const sellado = await sellarDatos(ab.dek, contenido);
      if (sellado.length > 95 * 1024 * 1024) throw new Error('El relevamiento cifrado supera lo que GitHub acepta por archivo (100 MB).');
      anotar(ab.boveda, s, 'carga_relevamiento', `${nombre || 'JSON'}: ${validas} resoluciones`);
      dekUsada = ab.dek;
      return { [RUTAS.datos]: sellado, [RUTAS.admin]: await sellarBovedaDe(ab, s) };
    }, 'Actualización del relevamiento'));
    alGuardar(s, dekUsada, { kit: contenido });
    return { ok: true, resoluciones: validas };
  }

  // ───────────── Leer PDF en el navegador ─────────────
  let PDFJS = null;
  /** pdf.js, servido desde el propio sitio. Se carga recién cuando hace falta. */
  async function pdfjs() {
    if (!PDFJS) {
      const lib = await import(new URL('vendor/pdfjs/pdf.min.js', location.href).href);
      lib.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.js', location.href).href;
      PDFJS = lib;
    }
    return PDFJS;
  }
  /** La capa de texto de cada página, igual que el kit. pdf.js se queda con el buffer: se le pasa una copia. */
  async function textoPorPagina(bytes) {
    const lib = await pdfjs();
    const doc = await lib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
    const paginas = [];
    try {
      for (let i = 1; i <= doc.numPages; i++) {
        const tc = await (await doc.getPage(i)).getTextContent();
        paginas.push(window.PierriTomos.textoDeItems(tc.items));
      }
    } finally { await doc.destroy(); }
    return paginas;
  }

  /** Lo leído y todavía no guardado en GitHub. Se guarda solo cada tanto y al terminar la carga. */
  function pendienteNuevo() { return { registros: [], archivos: {}, pdfs: [], bytes: 0, resoluciones: 0, fallo: null }; }
  let PEND = pendienteNuevo();
  const hayPendiente = () => PEND.pdfs.length > 0 || Object.keys(PEND.archivos).length > 0;
  const cuantosPendientes = () => Object.keys(PEND.archivos).length;
  /** Lo que estaba esperando, delante de lo que llegó después (si un guardado falló y hay que reintentar). */
  function juntarPendientes(a, b) {
    return { registros: a.registros.concat(b.registros), archivos: Object.assign({}, a.archivos, b.archivos), pdfs: a.pdfs.concat(b.pdfs),
      bytes: a.bytes + b.bytes, resoluciones: a.resoluciones + b.resoluciones, fallo: b.fallo || a.fallo };
  }
  /**
   * Si la sesión se corta con lectura sin guardar, se pierde (los PDF siguen en la computadora). Queda anotado cuántos
   * eran, para avisarlo al volver a ingresar.
   */
  function perderPendiente() {
    const n = cuantosPendientes();
    if (n) { try { sessionStorage.setItem('pierri_pendientes', String(n)); } catch (e) { /* sin almacenamiento */ } }
    PEND = pendienteNuevo();
  }
  let CATASTRO_CAIDO = false;
  // Una sola cosa por vez con lo leído sin guardar, como la cola `procesando` del kit: leer un PDF, guardar una tanda.
  let COLA = Promise.resolve();
  function enCola(fn) { const p = COLA.then(fn, fn); COLA = p.then(() => {}, () => {}); return p; }

  /** Un PDF que llega desde el Tablero: se lee por texto (como el kit sin clave) y queda esperando para guardarse. */
  function recibirPDF(cuerpo, nombreCrudo) {
    const s = exigir('cargar'); exigirToken();
    return enCola(() => ocupado(() => recibirPDFAhora(s, cuerpo, nombreCrudo)));
  }
  async function recibirPDFAhora(s, cuerpo, nombreCrudo) {
    const nombre = limpiar(String(nombreCrudo || 'archivo.pdf')).slice(0, 200);
    // Si un guardado falló, no se sigue juntando en memoria sin límite: primero hay que guardar lo pendiente.
    if (PEND.fallo && PEND.bytes >= TANDA_BYTES) return { estado: 'error', error: 'Hay PDF leídos que todavía no se guardaron en GitHub. Tocá "Guardar lo pendiente" y después seguí.', sin_guardar: PEND.fallo };
    const bytes = new Uint8Array(await cuerpo.arrayBuffer());
    if (!bytes.length) return { estado: 'error', error: 'archivo vacío' };
    if (bytes.length > PDF_MAXIMO) return { estado: 'error', error: `El archivo pesa ${mb(bytes.length)}: en la web entran PDF de hasta ${mb(PDF_MAXIMO)}.` };
    if (td.decode(bytes.subarray(0, 5)) !== '%PDF-') return { estado: 'error', error: 'El archivo no es un PDF.' };
    const h = await huella(bytes);
    const c = await cacheDatos(s), ix = indices(c);
    const previo = (ix.archivos[h] && ix.archivos[h].pdf) ? ix.archivos[h] : PEND.archivos[h];
    if (previo) return { estado: 'ya_cargado', hash: h, nombre_previo: previo.nombre };
    const t = ahora();
    // Leído antes por el kit: no se vuelve a leer (manda la lectura del kit); solo se guarda el PDF para poder verlo.
    const delKit = ix.kit.get(h);
    if (delKit) {
      PEND.archivos[h] = { nombre, tipo: 'kit', paginas: null, unidades: null, cargado_en: t };
      PEND.pdfs.push({ h, bytes }); PEND.bytes += bytes.length;
      return Object.assign({ estado: 'ya_cargado', hash: h, nombre_previo: (delKit.tomo && delKit.tomo.archivo) || delKit.archivo || nombre, pdf_guardado: true }, await guardarSiHaceFalta());
    }
    progreso(`Leyendo ${nombre}…`);
    const T = window.PierriTomos, X = window.PierriTexto, P = window.PierriCore;
    let pags;
    try { pags = await textoPorPagina(bytes); }
    catch (e) { return { estado: 'error', error: 'No se pudo abrir el PDF: ' + (e.message || e) }; }
    const a = T.unidadesDe(pags, nombre, h);
    const cfg = cfgDe(c, s), vistos = new Set(), registros = [];
    for (const u of a.unidades) {
      const base = T.registroBase(u, h);
      try {
        const lect = X.extraerDeTexto(u.texto, u.nombreControl);
        registros.push(lect.suficiente ? T.registroPorTexto(base, u, lect, cfg, tabla(), vistos)
          : T.registroIncompleto(base, u, lect, cfg, tabla(), vistos, ' (en la web se lee solo por texto: falta leerla con el modelo)', null));
      } catch (err) { registros.push(Object.assign(base, { error: String(err.message || err) })); }
    }
    // La ubicación (Catastro y, si no hay parcela, la localidad) se calcula al mirar, en el mismo orden que el kit.
    for (const r of registros) { r.cargado_en = t; r.origen = 'web'; }
    limpiar(registros);
    PEND.registros.push(...registros);
    PEND.archivos[h] = { nombre, tipo: a.tipo, paginas: pags.length, unidades: registros.length, sueltas: a.sueltas.map(p => p + 1), cargado_en: t };
    PEND.pdfs.push({ h, bytes }); PEND.bytes += bytes.length; PEND.resoluciones += registros.filter(r => r.derivado).length;
    const resp = { estado: 'procesado', hash: h, tipo: a.tipo, paginas: pags.length, unidades: registros.length, sueltas: a.sueltas.map(p => p + 1),
      paginas_cuerpo: a.paginasCuerpo || 0, bloques_descartados: a.bloquesDescartados || 0, resoluciones_tramite: a.resolucionesTramite || 0,
      por_texto: registros.filter(r => r.fuente === 'texto').length, por_modelo: 0,
      incompletas: registros.filter(r => r.fuente === 'texto_incompleto').length, errores: registros.filter(r => r.error).length,
      errores_detalle: registros.filter(r => r.error).map(r => r.error).slice(0, 2), falla_modelo: null, tokens: 0,
      expedientes: registros.filter(r => r.derivado).map(r => ({ expediente: r.derivado.expediente, clasificacion: P.clasificar(r.derivado), rogante: r.derivado.rogante_principal })) };
    return Object.assign(resp, await guardarSiHaceFalta());
  }
  /**
   * Guarda la tanda si ya llegó al tope. El archivo ya se leyó: si el guardado falla, no se informa como error del
   * archivo sino como "sin guardar", y no se reintenta solo con cada archivo (hasta que se toque "Guardar lo pendiente").
   */
  async function guardarSiHaceFalta() {
    if (PEND.fallo || (PEND.bytes < TANDA_BYTES && cuantosPendientes() < TANDA_ARCHIVOS)) return {};
    try { await guardarAhora(); return {}; }
    catch (e) { return { sin_guardar: e.message }; }
  }
  /** Cifra cada PDF con su propia llave y los junta en paquetes. Devuelve los paquetes y dónde quedó cada PDF. */
  async function armarPaquetes(pdfs) {
    const paquetes = [], ubic = new Map(); let actual = null;
    for (const p of pdfs) {
      const k = azar(32), iv = azar(12);
      const ct = new Uint8Array(await S.encrypt({ name: 'AES-GCM', iv }, await llaveAES(k), p.bytes));
      if (!actual || (actual.largo + ct.length > PAQUETE && actual.partes.length)) { actual = { ruta: `p/${hex(azar(12))}.bin`, partes: [], largo: 0, n: 0 }; paquetes.push(actual); }
      ubic.set(p.h, { pack: actual.ruta, off: actual.largo, len: ct.length, iv: b64(iv), k: b64(k) });
      actual.partes.push(ct); actual.largo += ct.length; actual.n++;
    }
    for (const q of paquetes) { const u = new Uint8Array(q.largo); let o = 0; for (const c of q.partes) { u.set(c, o); o += c.length; } q.bytes = u; delete q.partes; }
    return { paquetes, ubic };
  }
  /** "Guardar lo pendiente" y el final de una carga: en la cola, después de lo que se esté leyendo. */
  function guardarPendiente() {
    exigir('cargar'); exigirToken();
    return enCola(() => { PEND.fallo = null; return guardarAhora(); });
  }
  /**
   * Guarda en GitHub lo leído: primero los PDF cifrados (en su rama), después las resoluciones y dónde quedó cada PDF
   * (en la principal), en un solo commit. Trabaja sobre la tanda que había al empezar; si se corta en el medio, la tanda
   * vuelve a quedar esperando (con los PDF que ya subió anotados) y se reintenta.
   */
  async function guardarAhora() {
    const s = exigir('cargar'); exigirToken();
    if (!hayPendiente()) return { ok: true, archivos: 0, resoluciones: 0 };
    const lote = PEND; PEND = pendienteNuevo();
    return ocupado(async () => {
      RITMO.minimo = 1000;
      try {
        if (lote.pdfs.length) {
          const { paquetes, ubic } = await armarPaquetes(lote.pdfs);
          const commit = await subirPaquetes(tokenGuardado(), paquetes);
          for (const p of lote.pdfs) lote.archivos[p.h].pdf = Object.assign({ commit }, ubic.get(p.h));
          lote.pdfs = []; lote.bytes = 0;   // ya están en GitHub: se libera la memoria
        }
        // Catastro de lo nuevo, si responde. Si no, queda para el botón "Catastro".
        let parcelas = null;
        const cuentas = [...new Set(lote.registros.map(r => r.derivado && r.derivado.geo && r.derivado.geo.cuenta_normalizada).filter(Boolean).map(x => x.replace(/\D/g, '')))]
          .filter(x => x.length === 12 && !(CACHE && CACHE.catastro && CACHE.catastro[x]));
        // Si Catastro no respondió una vez en esta carga, no se lo vuelve a esperar en cada tanda: queda para el botón.
        if (cuentas.length && !CATASTRO_CAIDO) {
          try { progreso('Consultando Catastro…'); parcelas = await consultarParcelas(cuentas); } catch (e) { parcelas = null; CATASTRO_CAIDO = true; }
        }
        progreso('Guardando las resoluciones leídas…');
        const n = Object.keys(lote.archivos).length, m = lote.resoluciones;
        let escrito = null;
        await transaccion(async estado => {
          const ab = await abrirEstado(estado, s);
          const indice = leerIndice(await estado.leer(RUTAS.indice));
          let ruta = null, previo = null;
          const ultima = indice.lecturas[indice.lecturas.length - 1];
          if (ultima) { const t = await estado.leer(ultima); if (t && t.length < LECTURA_MAXIMA) { previo = await abrirJSON(ab.dek, t); ruta = ultima; } }
          if (!ruta) {
            let k = indice.lecturas.length + 1;
            do { ruta = `datos/lecturas/${String(k++).padStart(4, '0')}.enc`; } while (indice.lecturas.includes(ruta));
            indice.lecturas = indice.lecturas.concat([ruta]);
          }
          const antes = previo ? previo.registros || [] : [], ya = new Set(antes.map(r => r.hash));
          const contenido = { v: 1, registros: antes.concat(lote.registros.filter(r => !ya.has(r.hash))), archivos: Object.assign({}, previo ? previo.archivos : {}, lote.archivos) };
          const archivos = { [ruta]: await sellarDatos(ab.dek, contenido), [RUTAS.indice]: JSON.stringify(indice, null, 1) };
          escrito = { dek: ab.dek, ruta, contenido, indice };
          if (parcelas && Object.keys(parcelas).length) {
            const cat = sumarParcelas(await abrirJSON(ab.dek, await estado.leer(RUTAS.catastro)), parcelas);
            archivos[RUTAS.catastro] = await sellarDatos(ab.dek, cat);
            escrito.catastro = cat;
          }
          anotar(ab.boveda, s, 'carga_pdf', `${n} archivo(s), ${m} resolución(es)`);
          archivos[RUTAS.admin] = await sellarBovedaDe(ab, s);
          return archivos;
        }, 'Actualización del relevamiento');
        const cambios = { indice: escrito.indice, ruta: escrito.ruta, contenido: limpiar(escrito.contenido) };
        if (escrito.catastro) cambios.catastro = escrito.catastro;
        alGuardar(s, escrito.dek, cambios);
        return { ok: true, archivos: n, resoluciones: m };
      } catch (e) {
        // Si la sesión se cortó en el medio (otra contraseña), lo leído se da por perdido; si no, vuelve a esperar.
        if (SESION) { PEND = juntarPendientes(lote, PEND); PEND.fallo = e.message; }
        else { PEND = lote; perderPendiente(); }
        throw e;
      } finally { RITMO.minimo = 0; progreso(''); }
    });
  }

  // ───────────── Lectura con el modelo (solo con el botón) ─────────────
  // La web nunca llama al modelo sola: solo cuando el administrador toca "Completar incompletas con el modelo".
  // Lee nada más las resoluciones que el texto no resolvió y que tienen su PDF guardado.
  const ENCABEZADOS_API = k => ({ 'x-api-key': k, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' });
  function modeloElegido() {
    let m = null; try { m = localStorage.getItem(CLAVE_MODELO); } catch (e) { m = null; }
    return MODELOS.includes(m) ? m : window.PierriTomos.MODELO_POR_DEFECTO;
  }
  /** Comprueba la clave con un pedido que no cuesta nada (la lista de modelos). No dice si la cuenta tiene crédito. */
  async function verificarClave(k) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/models', { headers: ENCABEZADOS_API(k), cache: 'no-store' });
      return r.ok ? { ok: true, texto: 'La clave es válida.' } : { ok: false, texto: window.PierriTomos.motivoModelo(new Error('la API respondió ' + r.status)).texto };
    } catch (e) { return { ok: false, texto: 'no se pudo verificar la clave: no hay conexión a internet' }; }
  }
  async function configModelo(c) {
    const s = exigir('administrar');
    let verificacion = null;
    if (typeof c.key === 'string' && !c.key.startsWith('••••')) {
      const k = c.key.trim();
      if (k) verificacion = await verificarClave(k);
      await guardarClaveApi(s, k);
    }
    if (c.modelo && MODELOS.includes(c.modelo)) { try { localStorage.setItem(CLAVE_MODELO, c.modelo); } catch (e) { /* queda el de siempre */ } }
    return { ok: true, verificacion };
  }
  /**
   * Las instrucciones del modelo citan resoluciones reales como ejemplo: no pueden ir en el código publicado. Se cargan
   * una vez desde un archivo y quedan cifradas con la DEK, como los datos.
   */
  async function cargarInstrucciones(cuerpo) {
    const s = exigir('administrar'); exigirToken();
    let d;
    try { d = JSON.parse((typeof cuerpo === 'string' ? cuerpo : await cuerpo.text()).replace(/^\ufeff/, '')); } catch (e) { throw new Error('El archivo no es un JSON válido.'); }
    if (!d || typeof d.prompt_sistema !== 'string' || d.prompt_sistema.length < 500 || typeof d.prompt_usuario !== 'string' || !d.prompt_usuario)
      throw new Error('Ese archivo no son las instrucciones del modelo (instrucciones_modelo.json).');
    const inst = { prompt_sistema: d.prompt_sistema, prompt_usuario: d.prompt_usuario, version: String(d.version || ''), cargado_en: ahora() };
    let escrito = null;
    await ocupado(() => transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      anotar(ab.boveda, s, 'carga_instrucciones', 'instrucciones del modelo' + (inst.version ? ' ' + inst.version : ''));
      escrito = ab.dek;
      return { [RUTAS.instrucciones]: await sellarDatos(ab.dek, inst), [RUTAS.admin]: await sellarBovedaDe(ab, s) };
    }, 'Actualización del relevamiento'));
    alGuardar(s, escrito, { instrucciones: inst });
    return { ok: true };
  }
  let PDFLIB = null;
  function cargarScript(src) {
    return new Promise((ok, mal) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => mal(new Error('No se pudo cargar ' + src + '.')); document.head.appendChild(e); });
  }
  /** Las páginas de una resolución dentro de un tomo, como hace el kit antes de mandarla al modelo (pdf-lib). */
  async function recortarPaginas(bytes, desde, hasta) {
    if (!PDFLIB) { if (!window.PDFLib) await cargarScript('vendor/pdflib/pdf-lib.min.js'); PDFLIB = window.PDFLib; }
    const src = await PDFLIB.PDFDocument.load(bytes, { ignoreEncryption: true });
    const out = await PDFLIB.PDFDocument.create();
    const idx = []; for (let p = desde; p <= hasta; p++) idx.push(p);
    (await out.copyPages(src, idx)).forEach(pg => out.addPage(pg));
    return new Uint8Array(await out.save());
  }
  /** El mismo pedido y los mismos reintentos que el kit (pierri_lector.js), desde el navegador. */
  async function leerConModelo(bytes, k, modelo, inst) {
    const cuerpo = window.PierriTomos.cuerpoModelo(b64(bytes), modelo, inst.prompt_sistema, inst.prompt_usuario);
    let ultimo = 'sin respuesta';
    for (let intento = 0; intento < 5; intento++) {
      let resp;
      try {
        resp = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
          headers: Object.assign({ 'content-type': 'application/json' }, ENCABEZADOS_API(k)), body: JSON.stringify(cuerpo) });
      } catch (err) { ultimo = 'error de red: ' + err.message; await dormir(1500 * 2 ** intento); continue; }
      if (resp.status === 429 || resp.status >= 500) { ultimo = 'la API respondió ' + resp.status; await dormir(1500 * 2 ** intento); continue; }
      if (!resp.ok) throw new Error('la API respondió ' + resp.status + ': ' + (await resp.text()).slice(0, 300));
      const leido = window.PierriTomos.respuestaModelo(await resp.json());
      if (!leido) { ultimo = 'el modelo no devolvió JSON válido'; continue; }
      return leido;
    }
    throw new Error(ultimo);
  }
  /** "Completar incompletas con el modelo": hasta LOTE_MODELO por vez, en la cola con las cargas. */
  function completar() {
    const s = exigir('cargar'); exigirToken();
    return enCola(() => ocupado(() => completarAhora(s)));
  }
  async function completarAhora(s) {
    if (!s.claveApi) return { completadas: 0, pendientes: 0, motivo: 'sin clave' };
    await datos();
    const c = CACHE, T = window.PierriTomos, P = window.PierriCore;
    if (!c.instrucciones || !c.instrucciones.prompt_sistema) throw new Error('Faltan las instrucciones del modelo: cargalas una vez en Configuración.');
    const incompletas = VISTA.todos.filter(r => r.derivado && r.fuente === 'texto_incompleto' && !r.error);
    const conPdf = incompletas.filter(r => r.pdf_web);
    const lote = conPdf.slice(0, LOTE_MODELO), ix = indices(c), modelo = modeloElegido(), cfg = cfgDe(c, s);
    // El registro tal como se guardó (sin lo que se calcula al mirar), del kit o de lo leído en la web.
    const original = new Map();
    for (const r of (c.kit.resultados || []).concat(lecturasWeb(c).registros)) if (r && !original.has(r.hash)) original.set(r.hash, r);
    const nuevas = {}, fallas = [];
    let n = 0, tokens = 0;
    for (let i = 0; i < lote.length; i++) {
      const r = lote[i];
      progreso(`Leyendo con el modelo ${i + 1} de ${lote.length}: ${(r.derivado && r.derivado.expediente) || r.archivo}…`);
      try {
        let bytes = await traerPDF(ix.archivos[r.pdf_web]);
        if (r.tomo) bytes = await recortarPaginas(bytes, r.tomo.desde, r.tomo.hasta);
        const leido = await leerConModelo(bytes, s.claveApi, modelo, c.instrucciones);
        const reg = structuredClone(original.get(r.hash) || r);
        const fusion = T.fusionar(reg.extraido, leido.extraido);
        reg.extraido = fusion; reg.derivado = P.procesarRegistro(fusion, cfg, tabla(), new Set(), { nombreArchivo: T.nombreControlDe(reg) });
        reg.fuente = 'modelo'; reg.tokens = leido.tokens; reg.lectura = { fuente: 'modelo', completada_despues: true, modelo, en: ahora() };
        delete reg.falla_modelo; delete reg.error_modelo;
        nuevas[r.hash] = limpiar(reg); n++; tokens += leido.tokens;
      } catch (err) {
        const m = T.motivoModelo(err); fallas.push(m.texto);
        if (m.grave) break;   // clave mala o sin crédito: no tiene sentido seguir
      }
    }
    if (n) {
      let parcelas = null;
      const cuentas = [...new Set(Object.values(nuevas).map(r => r.derivado.geo && r.derivado.geo.cuenta_normalizada).filter(Boolean).map(x => x.replace(/\D/g, '')))]
        .filter(x => x.length === 12 && !(c.catastro && c.catastro[x]));
      if (cuentas.length && !CATASTRO_CAIDO) { try { parcelas = await consultarParcelas(cuentas); } catch (e) { CATASTRO_CAIDO = true; } }
      progreso('Guardando lo leído con el modelo…');
      let escrito = null;
      await transaccion(async estado => {
        const ab = await abrirEstado(estado, s);
        const comp = Object.assign((await abrirJSON(ab.dek, await estado.leer(RUTAS.completadas))) || {}, nuevas);
        const archivos = { [RUTAS.completadas]: await sellarDatos(ab.dek, comp) };
        escrito = { dek: ab.dek, completadas: comp };
        if (parcelas && Object.keys(parcelas).length) {
          const cat = sumarParcelas(await abrirJSON(ab.dek, await estado.leer(RUTAS.catastro)), parcelas);
          archivos[RUTAS.catastro] = await sellarDatos(ab.dek, cat); escrito.catastro = cat;
        }
        anotar(ab.boveda, s, 'completar_con_modelo', `${n} resolución(es), ${tokens} tokens (${modelo})`);
        archivos[RUTAS.admin] = await sellarBovedaDe(ab, s);
        return archivos;
      }, 'Actualización del relevamiento');
      const cambios = { completadas: escrito.completadas };
      if (escrito.catastro) cambios.catastro = escrito.catastro;
      alGuardar(s, escrito.dek, cambios);
    }
    progreso('');
    return { completadas: n, pendientes: conPdf.length - n, sin_pdf: incompletas.length - conPdf.length, tokens, fallas: fallas.slice(0, 3) };
  }

  // ───────────── Ver un PDF guardado ─────────────
  async function verPDF(h) {
    const s = exigir('ver');
    const c = await cacheDatos(s);
    const a = indices(c).archivos[String(h || '')];
    if (!a || !a.pdf) throw new Error('Este PDF todavía no está guardado en la web. Subilo en "Cargar": si ya estaba leído, se guarda sin volver a leerlo.');
    return { nombre: a.nombre, bytes: await traerPDF(a) };
  }

  // ───────────── Correcciones ─────────────
  async function revisar(c) {
    const s = exigir('revisar'); exigirToken();
    const id = String(c.id || '');
    const fecha = String(c.posee_desde || '').trim();
    if (fecha && (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(Date.parse(fecha)))) throw new Error('La fecha corregida debe ser una fecha válida (día, mes y año).');
    const tipo = TIPOS.includes(String(c.tipo_documento)) ? String(c.tipo_documento) : null;
    const rev = limpiar({ revisado: !!c.revisado, revisor: String(c.revisor || '').trim().slice(0, 80) || null, nota: String(c.nota || '').trim().slice(0, 500) || null,
      posee_desde: fecha || null, tipo_documento: tipo, en: ahora() });
    const d0 = await datos();
    const reg = d0.registros.find(r => r.hash === id);
    if (!reg) throw new Error('No encuentro esa resolución.');
    let escrito = null;
    await ocupado(() => transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const revs = (await abrirJSON(ab.dek, await estado.leer(RUTAS.revisiones))) || {};
      revs[id] = rev;
      anotar(ab.boveda, s, 'revision', [reg.derivado.expediente || reg.archivo, rev.revisado ? 'revisada' : 'sin tilde', rev.posee_desde ? 'fecha ' + rev.posee_desde : '', rev.tipo_documento || ''].filter(Boolean).join(' · '));
      escrito = { dek: ab.dek, revisiones: limpiar(revs) };
      return { [RUTAS.revisiones]: await sellarDatos(ab.dek, revs), [RUTAS.admin]: await sellarBovedaDe(ab, s) };
    }, 'Actualización del relevamiento'));
    alGuardar(s, escrito.dek, { revisiones: escrito.revisiones });
    const r1 = (await datos()).registros.find(r => r.hash === id);
    return { ok: true, revision: rev, clasificacion: r1 ? window.PierriCore.clasificar(r1.derivado) : null };
  }

  // ───────────── Padrón, inventario y Catastro ─────────────
  /**
   * Lee la planilla del Padrón en un proceso aparte (leer_planilla.js, con SheetJS): si el archivo viniera armado para
   * atacar la librería, no alcanza la página, que es donde están las llaves y el token. Vuelven solo las filas.
   */
  function leerPlanilla(bytes) {
    return new Promise((ok, mal) => {
      const w = new Worker('leer_planilla.js');
      const fin = (f, x) => { clearTimeout(t); w.terminate(); f(x); };
      const t = setTimeout(() => fin(mal, new Error('la planilla tardó demasiado en leerse')), 120000);
      w.onmessage = e => (e.data && e.data.error) ? fin(mal, new Error(e.data.error)) : fin(ok, (e.data && e.data.filas) || []);
      w.onerror = e => { e.preventDefault(); fin(mal, new Error(e.message || 'no se pudo leer')); };
      w.postMessage(bytes.buffer, [bytes.buffer]);
    });
  }
  /** Guarda un archivo cifrado con la DEK, leyendo el último estado. cambiar(actual) devuelve el contenido nuevo. */
  async function guardarUno(s, clave, cambiar, accion, detalle) {
    let escrito = null;
    await ocupado(() => transaccion(async estado => {
      const ab = await abrirEstado(estado, s);
      const nuevo = await cambiar(await abrirJSON(ab.dek, await estado.leer(RUTAS[clave])));
      escrito = { dek: ab.dek, valor: limpiar(nuevo) };
      const archivos = { [RUTAS[clave]]: await sellarDatos(ab.dek, nuevo) };
      if (accion) { anotar(ab.boveda, s, accion, detalle); archivos[RUTAS.admin] = await sellarBovedaDe(ab, s); }
      return archivos;
    }, 'Actualización del relevamiento'));
    alGuardar(s, escrito.dek, { [clave]: escrito.valor });
    return escrito.valor;
  }
  async function cargarPadron(cuerpo, nombreCrudo) {
    const s = exigir('cargar'); exigirToken();
    const nombre = limpiar(String(nombreCrudo || 'padron.xls')).slice(0, 200);
    let filasHoja;
    try { filasHoja = await leerPlanilla(new Uint8Array(await cuerpo.arrayBuffer())); }
    catch (e) { throw new Error('no se pudo leer la planilla del Padrón: ' + (e.message || e)); }
    if (!filasHoja.length) throw new Error('la planilla está vacía');
    const filas = window.PierriBase.filasPadron(filasHoja);
    await guardarUno(s, 'padron', () => ({ archivo: nombre, cargado_en: ahora(), filas }), 'carga_padron', `${nombre}: ${filas.length} filas`);
    await datos();
    return { filas: filas.length, cruce: VISTA.cruce || { cruzados: 0, ambiguos: 0, no_figuran: 0, sin_nombre: 0 } };
  }
  async function cargarInventario(cuerpo, nombreCrudo) {
    const s = exigir('cargar'); exigirToken();
    const nombre = limpiar(String(nombreCrudo || 'inventario.csv')).slice(0, 200);
    const nuevo = window.PierriBase.filasInventario(await cuerpo.text(), nombre);
    await guardarUno(s, 'inventario', actual => {
      const a = actual || { archivo: '', filas: [] }, previo = a.archivo || '';
      return { archivo: previo && !previo.includes(nombre) ? previo + ' + ' + nombre : nombre, cargado_en: ahora(), filas: window.PierriBase.fusionarInventario(a.filas || [], nuevo) };
    }, 'carga_inventario', `${nombre}: ${nuevo.filas.length} expedientes (${nuevo.formato})`);
    const d = await datos();
    return { formato: nuevo.formato, origen: nuevo.origen, filas: nuevo.filas.length, descartadas: nuevo.descartadas, inventario: d.resumen.inventario };
  }
  /** Consulta cuentas en Catastro. Devuelve lo que hay que guardar: { cuenta: { p: parcela o null, en } }. */
  async function consultarParcelas(cuentas) {
    let enc;
    // Cada pedido tiene 20 segundos: si Catastro acepta la conexión y no contesta, no puede trabar una carga.
    try { enc = await window.PierriCore.consultarCatastro(cuentas, u => fetch(u, { signal: AbortSignal.timeout(20000) })); }
    catch (e) {
      // fetch falla sin respuesta si no hay internet, si Catastro no acepta consultas desde otra página (CORS) o si tardó.
      if (e instanceof TypeError || (e && (e.name === 'TimeoutError' || e.name === 'AbortError'))) throw new Error('Catastro no respondió desde el navegador (sin conexión, tardó demasiado, o el servidor de Catastro no acepta consultas desde esta página). Mientras tanto, lo que no tiene parcela se ubica por localidad.');
      throw e;
    }
    const t = ahora(), out = {};
    for (const c of cuentas) out[c] = { p: enc[c] || null, en: t };
    return limpiar(out);
  }
  async function ubicarInventario(maximo) {
    const s = exigir('cargar'); exigirToken();
    const c = await cacheDatos(s);
    const cuentas = window.PierriBase.cuentasSinParcela(c.inventario ? c.inventario.filas || [] : [], parcelasDe(c.catastro), Math.min(Number(maximo) || 500, 500));
    if (!cuentas.length) { const d = await datos(); return { consultadas: 0, encontradas: 0, pendientes: 0, inventario: d.resumen.inventario }; }
    const nuevas = await consultarParcelas(cuentas);
    for (const v of Object.values(nuevas)) v.inv = true;
    await guardarUno(s, 'catastro', actual => sumarParcelas(actual, nuevas));
    const d = await datos(), inv = d.resumen.inventario || {};
    return { consultadas: cuentas.length, encontradas: Object.values(nuevas).filter(v => v.p).length, pendientes: inv.pendientes_catastro || 0, inventario: inv };
  }
  async function catastro() {
    const s = exigir('cargar'); exigirToken();
    const d = await datos();
    const cuentas = [...new Set(d.registros.map(r => r.derivado.geo).filter(g => g && g.cuenta_normalizada && !(g.catastro && g.catastro.encontrada))
      .map(g => g.cuenta_normalizada.replace(/\D/g, '')).filter(x => x.length === 12))];
    if (!cuentas.length) return { ubicadas: 0 };
    const nuevas = await consultarParcelas(cuentas);
    await guardarUno(s, 'catastro', actual => sumarParcelas(actual, nuevas));
    return { ubicadas: Object.values(nuevas).filter(v => v.p).length };
  }
  async function inventarioLocalidades() {
    const d = await datos(), c = CACHE;
    if (!c || !c.inventario) return { localidades: [], inventario: d.resumen.inventario || { cargado: false } };
    return { localidades: window.PierriBase.inventarioPorLocalidad(c.inventario.filas || [], parcelasDe(c.catastro)), inventario: d.resumen.inventario };
  }
  async function archivos() {
    await datos();
    const lista = new Map();
    for (const r of VISTA.todos) if (r.hash_archivo && !lista.has(r.hash_archivo)) lista.set(r.hash_archivo, { hash: r.hash_archivo, nombre: (r.tomo && r.tomo.archivo) || r.archivo, tipo: r.tomo ? 'tomo' : 'suelta', paginas: null, unidades: null, cargado_en: r.cargado_en || null });
    for (const [h, a] of Object.entries(VISTA.archivos)) if (a.tipo !== 'kit') lista.set(h, { hash: h, nombre: a.nombre, tipo: a.tipo, paginas: a.paginas, unidades: a.unidades, cargado_en: a.cargado_en });
    const orden = [...lista.values()].sort((a, b) => String(a.cargado_en || '').localeCompare(String(b.cargado_en || '')) || String(a.nombre).localeCompare(String(b.nombre)));
    return { archivos: window.PierriBase.archivosDesde(VISTA.todos, orden) };
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

  // Cerrar la pestaña con PDF leídos sin guardar, o mientras se lee o se sube una tanda: el navegador pregunta antes.
  window.addEventListener('beforeunload', e => { if (SESION && (hayPendiente() || OCUPADO > 0)) { e.preventDefault(); e.returnValue = ''; } });

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
      case '/api/logout': guardarSesion(null); CACHE = null; perderPendiente(); return { ok: true };
      case '/api/clave': return cambiarClavePropia(cuerpoJSON());
      case '/api/usuarios': return usuarios(metodo, cuerpoJSON());
      case '/api/datos': return datos();
      case '/api/config': {
        const s = exigir('ver'), c = cuerpoJSON();
        if ('key' in c || 'modelo' in c) return configModelo(c);
        s.config = { regla: c.regla === 'PLAZO_MOVIL' ? 'PLAZO_MOVIL' : 'CORTE_FIJO', fechaCorte: c.fechaCorte, margenBordeMeses: Number(c.margenBordeMeses) || 0 };
        return { ok: true };
      }
      case '/api/auditoria': return auditoria();
      case '/api/pdf': return recibirPDF(o.body, url.searchParams.get('nombre'));
      case '/api/revision': return revisar(cuerpoJSON());
      case '/api/padron': return cargarPadron(o.body, url.searchParams.get('nombre'));
      case '/api/inventario': return cargarInventario(o.body, url.searchParams.get('nombre'));
      case '/api/inventario/ubicar': return ubicarInventario(url.searchParams.get('maximo'));
      case '/api/inventario/localidades': return inventarioLocalidades();
      case '/api/catastro': return catastro();
      case '/api/archivos': return archivos();
      case '/api/web/inicial': return inicial(cuerpoJSON());
      case '/api/web/importar': return importar(o.body, url.searchParams.get('nombre'));
      case '/api/web/guardar': return guardarPendiente();
      case '/api/web/pdf': return verPDF(url.searchParams.get('h'));
      case '/api/web/instrucciones': return cargarInstrucciones(o.body);
      case '/api/completar': return completar();
      case '/api/web/token': return token(metodo, cuerpoJSON());
      default:
        throw new Error('Esto todavía no está en la versión web.');
    }
  }

  window.PIERRI_WEB = { api, repo: REPO, version: 3, pdfjs, ocupado: () => OCUPADO > 0, pendientes: hayPendiente, cuantosPendientes };
})();
