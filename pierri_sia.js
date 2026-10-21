(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pierri_core.js'));
  else root.PierriSIA = factory(root.PierriCore);
})(typeof self !== 'undefined' ? self : this, function (PierriCore) {
  'use strict';
  const P = PierriCore;
  const TIPO = 'PLANILLA_UEST';

  const CAMPOS = {
    expediente: ['NRO EXP SUAC', 'NRO EXPEDIENTE', 'EXPEDIENTE'],
    fecha_ingreso: ['FECHA INGRESO'],
    antiguedad: ['ANTIGUEDAD'],
    resolucion_fecha: ['FECHA RESOLUC', 'FECHA RESOLUCION'],
    resolucion_numero: ['NUMERO RESOLUCION', 'NRO RESOLUCION'],
    iniciador_resolucion: ['IINICIADOR EN RESOLUCION', 'INICIADOR EN RESOLUCION'],
    iniciador: ['INICIADOR'],
    dni: ['NRO DOC INICIADOR'],
    cuenta: ['CUENTA', 'NUMERO CUENTA'],
    localidad: ['LOCALIDAD PARCELA'],
    domicilio: ['DOMICILIO PARCELA'],
    pedania: ['PEDANIA'],
    tipo_lugar: ['TIPO LUGAR'],
    superficie: ['SUPERFICIE'],
    estado: ['ESTADO TRAMITE'],
    etapa: ['TRIBUNAL'],
  };
  const OBLIGATORIOS = ['expediente', 'fecha_ingreso', 'antiguedad'];

  function canonExpediente(e) {
    const s = String(e == null ? '' : e);
    const m = s.match(/(\d{3,4})\s*-*\s*(\d{4,7})\s*[-/*]+\s*(\d{4})(?!\d)/);
    if (m) return `${m[1].padStart(4, '0')}-${m[2].padStart(6, '0')}/${m[3]}`;
    const d = s.toUpperCase().match(/\b([A-Z]{2,5}\d{2}-\d{9}-\d{3})\b/);
    return d ? d[1] : null;
  }
  const SIN_DATO = /^(S\/?D|N\/?D|NO DECLARA|SIN DATOS?|-+|0)$/i;
  function texto(v, largo) {
    if (v == null) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return !s || SIN_DATO.test(s) ? null : s.slice(0, largo || 160);
  }
  function fechaCelda(v) {
    if (v == null || v === '') return null;
    let d = null;
    if (typeof v === 'number') { if (v > 20000 && v < 80000) d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000); }
    else d = P.parseFecha(String(v).trim().replace(/\s+\d{1,2}:\d{2}.*$/, '').replace(/\.+$/, ''));
    if (!d) return null;
    const a = d.getUTCFullYear();
    return a >= 1950 && a <= new Date().getUTCFullYear() + 1 ? P.fmtFecha(d) : null;
  }
  function numero(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  function cuentaDe(v) {
    const c = String(v == null ? '' : v).replace(/\D/g, '');
    return c.length === 12 && Number(c.slice(0, 2)) >= 11 && Number(c.slice(0, 2)) <= 36 ? c : null;
  }
  function dniDe(v) {
    const m = String(v == null ? '' : v).replace(/\./g, '').match(/\d{6,9}/);
    return m ? m[0].replace(/^0+/, '') : null;
  }
  const LECTOR = { expediente: canonExpediente, fecha_ingreso: fechaCelda, resolucion_fecha: fechaCelda, antiguedad: numero, cuenta: cuentaDe, dni: dniDe,
    resolucion_numero: v => { const s = texto(v, 20); return s && /\d/.test(s) ? s.replace(/^0+(?=\d)/, '') : null; } };

  function filasSIA(matriz, opciones) {
    const filas = matriz || [];
    const corrida = (opciones && opciones.fecha1904) ? v => fechaCelda(typeof v === 'number' ? v + 1462 : v) : fechaCelda;
    const lector = Object.assign({}, LECTOR, { fecha_ingreso: corrida, resolucion_fecha: corrida });
    const norm = v => P.normalizarTexto(v == null ? '' : v);
    let cab = -1;
    for (let i = 0; i < Math.min(filas.length, 20) && cab < 0; i++) {
      const t = (filas[i] || []).map(norm);
      if (OBLIGATORIOS.every(k => CAMPOS[k].some(n => t.includes(n)))) cab = i;
    }
    if (cab < 0) {
      const arriba = filas.slice(0, 20).flatMap(f => (f || []).filter(v => v != null && String(v).trim()));
      const nombre = { expediente: 'número de expediente (NRO_EXP_SUAC)', fecha_ingreso: 'fecha de ingreso (FECHA_INGRESO)', antiguedad: 'antigüedad (ANTIGUEDAD)' };
      const faltan = OBLIGATORIOS.filter(k => !arriba.some(v => CAMPOS[k].includes(norm(v)))).map(k => nombre[k]);
      const parecidos = [...new Set(arriba.map(v => String(v).trim().slice(0, 40)).filter(v => /EXP|INGRESO|ANTIG/.test(norm(v))))].slice(0, 8);
      throw new Error('en las primeras 20 filas no hay una fila con los títulos de número de expediente (NRO_EXP_SUAC), fecha de ingreso (FECHA_INGRESO) y antigüedad (ANTIGUEDAD), como en la planilla de trámites del SIA de la UEST'
        + (arriba.length ? `. No encontré: ${faltan.join(', ') || 'los tres en una misma fila'}` + (parecidos.length ? `. Títulos parecidos: ${parecidos.map(v => '«' + v + '»').join(', ')}` : '') : '. Las primeras 20 filas están vacías'));
    }
    const titulos = filas[cab].map(norm);
    const cols = {};
    for (const [campo, nombres] of Object.entries(CAMPOS)) cols[campo] = nombres.flatMap(n => titulos.flatMap((t, j) => t === n ? [j] : []));
    const porExp = new Map();
    let descartadas = 0, total = 0;
    for (const f of filas.slice(cab + 1)) {
      if (!f || !f.some(v => v != null && String(v).trim() !== '')) continue;
      total++;
      const fila = {};
      for (const [campo, js] of Object.entries(cols)) {
        const leer = lector[campo] || texto;
        let valor = null;
        for (const j of js) { valor = leer(f[j]); if (valor != null) break; }
        fila[campo] = valor;
      }
      if (!fila.expediente) { descartadas++; continue; }
      const previa = porExp.get(fila.expediente);
      if (previa) { for (const [k, v] of Object.entries(fila)) if (v != null) previa[k] = v; }
      else porExp.set(fila.expediente, fila);
    }
    return { filas: [...porExp.values()], descartadas, total };
  }

  const antiguedadUsable = a => Number.isFinite(a) && a >= 1 && a <= 100;
  function estimacion(f, cfg) {
    const a = numero(f.antiguedad), usable = antiguedadUsable(a);
    const pos = usable && f.fecha_ingreso
      ? P.calcularPoseeDesde({ fecha_referencia: f.fecha_ingreso, antiguedad_anios: Math.floor(a), antiguedad_meses: Math.round((a % 1) * 12) })
      : { fecha: null, precision: null };
    const motivo = !f.fecha_ingreso ? 'la planilla no trae la fecha de ingreso del trámite'
      : !usable ? `la planilla no trae una antigüedad que se pueda usar (${a == null ? 'vacía' : a + ' años'})` : null;
    return { fecha: pos.fecha, precision: pos.precision, motivo, elegibilidad: P.evaluarElegibilidad(pos.fecha, cfg) };
  }
  const tipoInmueble = t => { const s = P.normalizarTexto(t); return /^RUR/.test(s) ? 'rural' : /^U/.test(s) ? 'urbano' : null; };

  function registroDePlanilla(f, cfg, tabla, meta) {
    const m = meta || {}, est = estimacion(f, cfg);
    const fRes = P.parseFecha(f.resolucion_fecha);
    const dec = P.decodificarCuenta(f.cuenta, tabla);
    const nombre = f.iniciador_resolucion || f.iniciador || null;
    const derivado = {
      expediente: f.expediente, tipo_documento: TIPO,
      resolucion_numero: f.resolucion_numero || null, resolucion_fecha: P.fmtFecha(fRes), resolucion_anio: fRes ? fRes.getUTCFullYear() : null,
      cantidad_rogantes: nombre ? 1 : 0, rogante_principal: nombre, rogantes_todos: nombre ? `${nombre} (DNI ${f.dni || '?'})` : null, dni_principal: f.dni || null,
      matriculas: [], titulares_registrales: null,
      posee_desde: P.fmtFecha(est.fecha), posee_desde_precision: est.precision, posee_desde_origen: 'planilla_uest', posesion_criterio: TIPO,
      elegibilidad: est.elegibilidad,
      geo: { cuenta_normalizada: dec.normalizada, dep_codigo: dec.dep_codigo, dep_nombre: dec.dep_nombre, ped_codigo: dec.ped_codigo,
        ped_nombre: dec.ped_nombre || (f.pedania ? String(f.pedania).toUpperCase() : null), origen_ubicacion: dec.valida ? 'cuenta' : f.localidad ? 'texto' : null,
        localidad: f.localidad || null, calle: f.domicilio || null, tipo_inmueble: tipoInmueble(f.tipo_lugar) },
      senales: [], validaciones: [], revisar: false, motivos_revision: [], sin_estimar: est.motivo,
    };
    return { hash: 'sia:' + f.expediente, archivo: m.archivo || null, cargado_en: m.cargado_en || null, fuente: 'planilla', extraido: null, derivado,
      planilla: { fecha_ingreso: f.fecha_ingreso, antiguedad: numero(f.antiguedad), estado: f.estado || null, etapa: f.etapa || null,
        superficie: f.superficie || null, tipo_lugar: f.tipo_lugar || null, con_resolucion: !!(fRes || f.resolucion_numero) } };
  }

  const MUESTRA_CADA = 200;
  function enMuestra(expediente) {
    const e = canonExpediente(expediente); if (!e) return false;
    let h = 0x811c9dc5;   // FNV-1a: por cada carácter, h = (h xor carácter) × el primo de FNV (2^24 + 2^8 + 0x93)
    for (let i = 0; i < e.length; i++) { h ^= e.charCodeAt(i); h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0; }
    return h % MUESTRA_CADA === 0;
  }

  function compararConLeidas(registros, porExp, cfg, tabla) {
    const out = { comparadas: 0, coinciden: 0, sin_comparar: 0, diferencia_mediana_anios: null, hasta_un_anio: 0,
      muestra: { expedientes: 0, leidas: 0, comparadas: 0, coinciden: 0 } };
    const difs = [], M = out.muestra;
    for (const e of porExp.keys()) if (enMuestra(e)) M.expedientes++;
    for (const r of registros || []) {
      if (!r.derivado || r.repetido_de || r.error || r.fuente === 'planilla' || !r.derivado.tipo_documento) continue;
      const c1 = P.clasificar(r.derivado); if (c1 === 'NO_APLICA') continue;
      const f = porExp.get(canonExpediente(r.derivado.expediente)); if (!f) continue;
      const e = registroDePlanilla(f, cfg, tabla).derivado, c2 = P.clasificar(e);
      const evaluables = !/^(SIN_DATO|REVISAR)$/.test(c1) && c2 !== 'SIN_DATO';
      const coincide = evaluables ? c1.startsWith('ELEGIBLE') === c2.startsWith('ELEGIBLE') : null;
      const m = enMuestra(f.expediente);
      r.planilla_estimaba = { posee_desde: e.posee_desde, clasificacion: c2, coincide, fecha_ingreso: f.fecha_ingreso, antiguedad: numero(f.antiguedad), en_muestra: m };
      if (m) M.leidas++;
      if (!evaluables) { out.sin_comparar++; continue; }
      out.comparadas++; if (coincide) out.coinciden++;
      if (m) { M.comparadas++; if (coincide) M.coinciden++; }
      const d = Math.abs(Number(String(r.derivado.posee_desde).slice(0, 4)) - Number(String(e.posee_desde).slice(0, 4)));
      if (Number.isFinite(d)) { difs.push(d); if (d <= 1) out.hasta_un_anio++; }
    }
    if (difs.length) { difs.sort((a, b) => a - b); out.diferencia_mediana_anios = difs[Math.floor(difs.length / 2)]; }
    return out;
  }

  function controlarCruce(registros) {
    for (const r of registros || []) {
      const d = r.derivado, i = d && d.inscripcion, ingreso = r.planilla && r.planilla.fecha_ingreso;
      if (!i || !i.anio_diario || !ingreso || d.resolucion_anio) continue;
      if (Number(i.anio_diario) >= Number(String(ingreso).slice(0, 4))) continue;
      const amb = { estado: 'AMBIGUO', origen: 'padron', confianza: 'anio_incompatible',
        candidatas: [{ nro_unico: i.nro_unico, diario: i.diario, anio: i.anio_diario, estado: i.estado }] };
      r.inscripcion = amb; d.inscripcion = amb;
    }
  }

  return { TIPO, canonExpediente, CAMPOS, filasSIA, registroDePlanilla, compararConLeidas, controlarCruce, enMuestra, MUESTRA_CADA };
});
