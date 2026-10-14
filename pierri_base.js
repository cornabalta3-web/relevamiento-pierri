(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pierri_core.js'));
  else root.PierriBase = factory(root.PierriCore);
})(typeof self !== 'undefined' ? self : this, function (PierriCore) {
  'use strict';

  const esNulo = v => v === null || v === undefined;
  const coalesce = (...vs) => { for (const v of vs) if (!esNulo(v)) return v; return null; };
  function compararBinario(a, b) {
    if (a === b) return 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a.codePointAt(i), y = b.codePointAt(i);
      if (x !== y) return x < y ? -1 : 1;
      if (x > 0xffff) i++;
    }
    return a.length < b.length ? -1 : a.length > b.length ? 1 : 0;
  }
  function compararSQL(a, b) {
    const ta = esNulo(a) ? 0 : typeof a === 'number' ? 1 : 2, tb = esNulo(b) ? 0 : typeof b === 'number' ? 1 : 2;
    if (ta !== tb) return ta - tb;
    if (ta === 0) return 0;
    if (ta === 1) return a < b ? -1 : a > b ? 1 : 0;
    return compararBinario(String(a), String(b));
  }
  const maxSQL = (a, b) => esNulo(a) || esNulo(b) ? null : (compararSQL(a, b) >= 0 ? a : b);
  function sumaSQL(filas, valor) {
    let s = null;
    for (const f of filas) { const v = valor(f); if (!esNulo(v)) s = (s || 0) + Number(v); }
    return s;
  }
  function promedioSQL(valores) {
    let suma = 0, error = 0, n = 0;
    for (const v of valores) {
      if (esNulo(v)) continue;
      const r = Number(v), t = suma + r;
      if (Math.abs(suma) > Math.abs(r)) error += (suma - t) + r; else error += (r - t) + suma;
      suma = t; n++;
    }
    if (!n) return null;
    return (Number.isFinite(error) ? suma + error : suma) / n;
  }
  const empiezaConBaldio = s => typeof s === 'string' && s.slice(0, 6).replace(/[a-z]/g, c => c.toUpperCase()) === 'BALDIO';
  function comoTexto(v, n) {
    if (esNulo(v)) return null;
    if (typeof v === 'string') return v;
    if (typeof v !== 'number') throw new Error(`Provided value cannot be bound to SQLite parameter ${n}.`);
    if (Number.isNaN(v)) return null;
    if (!Number.isFinite(v)) return v > 0 ? 'Inf' : '-Inf';
    if (v === 0) return '0.0';
    const { dig, exp } = cifrasSQLite(Math.abs(v)), signo = v < 0 ? '-' : '';
    if (exp < -4 || exp > 14) return `${signo}${dig[0]}.${dig.slice(1) || '0'}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
    if (exp < 0) return `${signo}0.${'0'.repeat(-exp - 1)}${dig}`;
    return `${signo}${dig.slice(0, exp + 1).padEnd(exp + 1, '0')}.${dig.slice(exp + 1) || '0'}`;
  }
  function cifrasSQLite(r) {
    const f = new Float64Array(1), bits = new BigUint64Array(f.buffer);
    const alto = x => { f[0] = x; bits[0] &= 0xfffffffffc000000n; return f[0]; };
    const mult = (rr, y, yy) => {   // dekkerMul2
      const hx = alto(rr[0]), tx = rr[0] - hx, hy = alto(y), ty = y - hy;
      const p = hx * hy, q = hx * ty + tx * hy, c = p + q;
      const cc = rr[0] * yy + rr[1] * y + (p - c + q + tx * ty);
      rr[0] = c + cc; rr[1] = c - rr[0]; rr[1] += cc;
    };
    const rr = [r, 0];
    let e = 0;
    if (rr[0] > 9.223372036854774784e+18) {
      while (rr[0] > 9.223372036854774784e+118) { e += 100; mult(rr, 1.0e-100, -1.99918998026028836196e-117); }
      while (rr[0] > 9.223372036854774784e+28) { e += 10; mult(rr, 1.0e-10, -3.6432197315497741579e-27); }
      while (rr[0] > 9.223372036854774784e+18) { e += 1; mult(rr, 1.0e-01, -5.5511151231257827021e-18); }
    } else {
      while (rr[0] < 9.223372036854774784e-83) { e -= 100; mult(rr, 1.0e+100, -1.5902891109759918046e+83); }
      while (rr[0] < 9.223372036854774784e+07) { e -= 10; mult(rr, 1.0e+10, 0.0); }
      while (rr[0] < 9.22337203685477478e+17) { e -= 1; mult(rr, 1.0e+01, 0.0); }
    }
    const entero = x => BigInt(Math.trunc(x));
    const z = String(rr[1] < 0 ? entero(rr[0]) - entero(-rr[1]) : entero(rr[0]) + entero(rr[1])).split('').map(Number);
    let iDP = z.length + e;
    if (z.length > 15) {
      const sube = z[15] >= 5;
      z.length = 15;
      for (let j = 14; sube; j--) {
        if (++z[j] <= 9) break;
        z[j] = 0;
        if (j === 0) { z.unshift(1); iDP++; break; }
      }
    }
    return { dig: z.join('').replace(/0+$/, ''), exp: iDP - 1 };
  }
  function comoReal(v, n) {
    if (esNulo(v)) return null;
    if (typeof v === 'number') return Number.isNaN(v) ? null : v;
    if (typeof v !== 'string') throw new Error(`Provided value cannot be bound to SQLite parameter ${n}.`);
    const m = v.match(/^[ \t\n\f\r\v]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)[ \t\n\f\r\v]*$/);
    return m ? Number(m[1]) : v;
  }
  const propia = (o, k) => !!o && !esNulo(k) && Object.prototype.hasOwnProperty.call(o, k);
  const parcelaEncontrada = (parcelas, cuenta) => {
    const p = propia(parcelas, cuenta) ? parcelas[cuenta] : null;
    return p && Number(p.encontrada) === 1 ? p : null;
  };

  function aplicarRevision(r, cfg) {
    const rev = r.revision;
    if (!r.derivado) return;
    r.derivado.revision = rev || null;
    if (!rev) return;
    if (rev.tipo_documento) {
      r.derivado.tipo_documento = rev.tipo_documento;
      r.derivado.motivos_revision = (r.derivado.motivos_revision || []).filter(m => !m.startsWith('tipo_documento:'));
    }
    if (rev.posee_desde) {
      r.derivado.posee_desde = rev.posee_desde;
      r.derivado.posee_desde_precision = 'dia';
      r.derivado.posesion_criterio = 'CORREGIDA_A_MANO';
      r.derivado.elegibilidad = PierriCore.evaluarElegibilidad(PierriCore.parseFecha(rev.posee_desde), cfg);
    }
    if (rev.revisado) {
      r.derivado.revisar = false;
      r.derivado.motivos_revision = [];
    }
  }
  function marcarRepetidos(registros) {
    const porExp = new Map();
    for (const r of registros) { if (!r.derivado || !r.derivado.expediente || r.error) continue; if (!porExp.has(r.derivado.expediente)) porExp.set(r.derivado.expediente, []); porExp.get(r.derivado.expediente).push(r); }
    let n = 0;
    for (const lista of porExp.values()) {
      lista.sort((a, b) => String(b.derivado.resolucion_fecha || '').localeCompare(String(a.derivado.resolucion_fecha || '')) || String(b.cargado_en || '').localeCompare(String(a.cargado_en || '')));
      lista.forEach((r, i) => { const antes = !!r.repetido_de; r.repetido_de = i === 0 ? null : lista[0].archivo; if (antes !== !!r.repetido_de) n++; });
    }
    return n;
  }

  const claveNombre = s => PierriCore.normalizarTexto(s).split(' ').filter(Boolean).sort().join(' ');
  const ESTADO_PADRON = { DEF: 'INSCRIPTA', PRV: 'PROVISORIA', OBS: 'OBSERVADA' };
  function plausible(anioDiario, anioReso) { const a = Number(anioDiario), r = Number(anioReso); if (!a || !r) return true; return a >= r && a <= r + 3; }
  function filasPadron(filasHoja) {
    const filas = filasHoja || [];
    if (!filas.length) throw new Error('la planilla está vacía');
    const col = n => Object.keys(filas[0]).find(k => k.trim().toUpperCase() === n);
    const cNro = col('NROUNICO'), cDia = col('DIARIO'), cEst = col('ESTADO_PROCESO'), cNom = col('NOMBREPERSONA'), cTipo = col('TIPO_PARTICIPACION');
    if (!cNro || !cEst) throw new Error('no tiene las columnas del Padrón (NROUNICO, DIARIO, ESTADO_PROCESO, NOMBREPERSONA)');
    const salida = [], vistos = new Set();
    try {
      for (const f of filas) {
        const nro = String(f[cNro] || '').trim(); if (!nro) continue;
        const anio = (String(f[cDia] || '').match(/\/\s*(\d{4})/) || [])[1] || null;
        const id = f[cNom] ? `${nro}|${claveNombre(f[cNom])}` : nro;
        if (vistos.has(id)) continue;
        vistos.add(id);
        salida.push({ nro_unico: id, diario: String(f[cDia] || '').replace(/\s+/g, ' ').trim(), anio, estado: String(f[cEst] || '').trim() || null,
          nombre: comoTexto(f[cNom] || null, 5), nombre_clave: f[cNom] ? claveNombre(f[cNom]) : null, tipo: comoTexto(f[cTipo] || null, 7) });
      }
    } catch (err) {
      const e = new Error('no se pudo leer la planilla del Padrón: ' + (err.message || err));
      e.vaciado = true;
      throw e;
    }
    return salida;
  }
  function marcarInscripcion(r, insc) { r.inscripcion = insc; if (r.derivado) r.derivado.inscripcion = insc; }
  function cruzarConPadron(registros, padron, inventarioPorExp) {
    if (!padron || !padron.length) return { cruzados: 0, ambiguos: 0, no_figuran: 0, sin_nombre: 0, sin_padron: true };
    const porNombre = new Map();
    for (const p of padron) { if (!p.nombre_clave) continue; if (!porNombre.has(p.nombre_clave)) porNombre.set(p.nombre_clave, []); porNombre.get(p.nombre_clave).push(p); }
    const porNombreRes = new Map();
    for (const r of registros) { if (!r.derivado || r.repetido_de || r.error) continue; const k = claveNombre(r.derivado.rogante_principal); if (!k) continue; if (!porNombreRes.has(k)) porNombreRes.set(k, []); porNombreRes.get(k).push(r); }
    const res = { cruzados: 0, ambiguos: 0, no_figuran: 0, sin_nombre: 0, por_estado: {} };
    for (const r of registros) {
      if (!r.derivado || r.repetido_de || r.error) continue;
      let nombre = r.derivado.rogante_principal;
      if (!nombre && r.derivado.expediente && inventarioPorExp) { const inv = inventarioPorExp.get(expInventario(r.derivado.expediente)); if (inv && inv.iniciador) nombre = inv.iniciador; }
      const k = claveNombre(nombre);
      if (!k) { res.sin_nombre++; marcarInscripcion(r, { estado: 'SIN_NOMBRE_PARA_CRUZAR', origen: 'padron' }); continue; }
      const enPadron = porNombre.get(k) || [], enRes = porNombreRes.get(k) || [];
      const anotaciones = Array.from(new Map(enPadron.map(p => [p.nro_unico.split('|')[0], p])).values());
      if (!anotaciones.length) { res.no_figuran++; marcarInscripcion(r, { estado: 'NO_FIGURA_EN_PADRON', origen: 'padron', confianza: 'nombre_no_encontrado' }); }
      else if (anotaciones.length === 1 && enRes.length === 1 && plausible(anotaciones[0].anio, r.derivado.resolucion_anio)) {
        const a = anotaciones[0]; res.cruzados++; const est = ESTADO_PADRON[a.estado] || a.estado; res.por_estado[est] = (res.por_estado[est] || 0) + 1;
        marcarInscripcion(r, { estado: est, estado_codigo: a.estado, diario: a.diario, anio_diario: a.anio, nro_unico: a.nro_unico.split('|')[0], participacion: a.tipo, origen: 'padron', confianza: 'nombre_unico' });
      } else {
        res.ambiguos++;
        marcarInscripcion(r, { estado: 'AMBIGUO', origen: 'padron', confianza: anotaciones.length === 1 && enRes.length === 1 ? 'anio_incompatible' : 'nombre_repetido',
          candidatas: anotaciones.map(a => ({ nro_unico: a.nro_unico.split('|')[0], diario: a.diario, anio: a.anio, estado: ESTADO_PADRON[a.estado] || a.estado })) });
      }
    }
    return res;
  }

  const COLUMNAS_INVENTARIO = ['expediente', 'departamento', 'hojas', 'cuenta', 'cuenta_valida', 'nro_resolucion', 'estado_digitalizacion',
    'tiene_resolucion', 'en_universo', 'anio', 'origen', 'iniciador', 'dni', 'fecha_ingreso', 'fecha_resolucion', 'estado_suac'];
  const expInventario = e => String(e || '').replace(/^(\d{4})-(\d{5,7})\/(\d{4})$/, '$1-$2-$3');
  function parsearCSV(txt) {
    const lineas = txt.replace(/^\ufeff/, '').split(/\r?\n/).filter(l => l.trim());
    if (!lineas.length) return [];
    const sep = (lineas[0].match(/;/g) || []).length >= (lineas[0].match(/,/g) || []).length ? ';' : ',';
    const cab = lineas[0].split(sep).map(h => h.trim().replace(/^"|"$/g, ''));
    return lineas.slice(1).map(l => { const c = l.split(sep).map(x => x.trim().replace(/^"|"$/g, '')); const o = {}; cab.forEach((h, i) => o[h] = c[i] == null ? '' : c[i]); return o; });
  }
  function normalizarExpediente(s) {
    const t = String(s || '').replace(/[^\d-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const m = t.match(/^0*(\d{3,4})-0*(\d{5,7})-(\d{4})$/);
    if (!m) return null;
    return `${m[1].padStart(4, '0')}-${m[2].padStart(6, '0')}-${m[3]}`;
  }
  function fechaISO(s) { const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; }
  const filaInventario = valores => { const o = {}; COLUMNAS_INVENTARIO.forEach((c, i) => { o[c] = valores[i]; }); return o; };
  function filasInventario(texto, nombreArchivo) {
    const filas = parsearCSV(String(texto || ''));
    if (!filas.length) throw new Error('el CSV está vacío');
    const col = (...ns) => { for (const n of ns) { const k = Object.keys(filas[0]).find(k => PierriCore.normalizarTexto(k) === PierriCore.normalizarTexto(n)); if (k) return k; } return null; };
    const cExp = col('Expediente'), cSuac = col('Nº Exp. SUAC', 'N Exp SUAC', 'Nro Exp SUAC', 'Expediente SUAC');
    const formato = cSuac ? 'suac' : cExp ? 'digitalizados' : null;
    if (!formato) throw new Error('no reconozco las columnas: se espera el CSV de expedientes digitalizados (Expediente; Estado resol.; …) o el del SUAC (Nº Exp. SUAC; Iniciador; Nº Doc; …)');
    const cDep = col('Departamento'), cCta = col('Cuenta'), cHoj = col('Hojas'), cRes = col('Nº Resolución', 'N Resolucion', 'Nro Resolucion'), cEst = col('Estado resol.', 'Estado resol'), cUni = col('En universo');
    const cEstS = col('Estado'), cIni = col('Iniciador'), cDoc = col('Nº Doc', 'N Doc', 'DNI', 'Documento'), cFI = col('Fecha ingreso'), cFR = col('Fecha resol.', 'Fecha resol', 'Fecha resolucion');
    const origen = formato === 'suac' ? (/falt/i.test(nombreArchivo) ? 'suac_faltantes' : 'suac') : 'digitalizados';
    const salida = [];
    let descartadas = 0;
    for (const f of filas) {
      const exp = formato === 'suac' ? normalizarExpediente(f[cSuac]) : (/^\d{4}-\d{5,7}-\d{4}$/.test(String(f[cExp] || '').trim()) ? String(f[cExp]).trim() : null);
      if (!exp) { descartadas++; continue; }
      const cta = String(f[cCta] || '').replace(/\D/g, '');
      const ctaValida = cta.length === 12 && Number(cta.slice(0, 2)) >= 11 && Number(cta.slice(0, 2)) <= 36 ? 1 : 0;
      const anio = Number(exp.slice(-4)) || null;
      if (formato === 'digitalizados') {
        const est = String(f[cEst] || '').trim();
        salida.push(filaInventario([exp, String(f[cDep] || '').trim() || null, Number(f[cHoj]) || 0, ctaValida ? cta : null, ctaValida, String(f[cRes] || '').trim() || null, est || null, /resoluci/i.test(est) ? 1 : 0,
          /^s/i.test(String(f[cUni] || '')) ? 1 : 0, anio && anio > 1990 && anio < 2100 ? anio : null, origen, null, null, null, null, null]));
      } else {
        const dni = String(f[cDoc] || '').replace(/\D/g, '').replace(/^0+/, '') || null;
        const ini = String(f[cIni] || '').replace(/\s+/g, ' ').replace(/\s*C\.?P\.?\s*\d{4}.*$/i, '').trim() || null;
        const fr = fechaISO(f[cFR]);
        salida.push(filaInventario([exp, String(f[cDep] || '').trim() || null, 0, ctaValida ? cta : null, ctaValida, null, origen === 'suac_faltantes' ? 'No digitalizado' : null, fr ? 1 : 0,
          1, anio && anio > 1990 && anio < 2100 ? anio : null, origen, ini, dni && dni.length >= 6 ? dni : null, fechaISO(f[cFI]), fr, String(f[cEstS] || '').trim() || null]));
      }
    }
    return { formato, origen, filas: salida, descartadas };
  }
  function fusionarInventario(actual, nuevo) {
    const filas = (actual || []).filter(f => f.origen !== nuevo.origen).map(f => filaInventario(COLUMNAS_INVENTARIO.map(c => f[c] === undefined ? null : f[c])));
    const posicion = new Map(filas.map((f, i) => [f.expediente, i]));
    for (const x of nuevo.filas) {
      const i = posicion.get(x.expediente);
      if (i === undefined) { posicion.set(x.expediente, filas.length); filas.push(filaInventario(COLUMNAS_INVENTARIO.map(c => x[c]))); continue; }
      const v = filas[i];   // en el SET del kit, las columnas sin "excluded." son las de la fila que ya estaba
      filas[i] = {
        expediente: v.expediente,
        departamento: coalesce(x.departamento, v.departamento),
        hojas: coalesce(x.hojas === 0 ? null : x.hojas, v.hojas),   // COALESCE(NULLIF(excluded.hojas, 0), hojas)
        cuenta: coalesce(x.cuenta, v.cuenta),
        cuenta_valida: maxSQL(v.cuenta_valida, x.cuenta_valida),
        nro_resolucion: coalesce(x.nro_resolucion, v.nro_resolucion),
        estado_digitalizacion: x.origen === 'digitalizados' ? x.estado_digitalizacion : v.estado_digitalizacion,
        tiene_resolucion: maxSQL(v.tiene_resolucion, x.tiene_resolucion),
        en_universo: maxSQL(v.en_universo, x.en_universo),
        anio: coalesce(x.anio, v.anio),
        origen: esNulo(v.origen) ? x.origen : String(v.origen).includes(x.origen) ? v.origen : v.origen + '+' + x.origen,
        iniciador: coalesce(x.iniciador, v.iniciador),
        dni: coalesce(x.dni, v.dni),
        fecha_ingreso: coalesce(x.fecha_ingreso, v.fecha_ingreso),
        fecha_resolucion: coalesce(x.fecha_resolucion, v.fecha_resolucion),
        estado_suac: coalesce(x.estado_suac, v.estado_suac),
      };
    }
    return filas;
  }
  function indicePorExpediente(filas) { return new Map((filas || []).map(f => [f.expediente, f])); }
  function anexarInventario(registros, inventarioPorExp) {
    for (const r of registros) {
      if (!r.derivado || !r.derivado.expediente) continue;
      const f = inventarioPorExp ? inventarioPorExp.get(expInventario(r.derivado.expediente)) : undefined;
      if (!f) { r.inventario = null; continue; }
      const ctaLeida = (r.derivado.geo && r.derivado.geo.cuenta_normalizada || '').replace(/\D/g, '');
      r.inventario = { departamento: f.departamento, cuenta: f.cuenta, nro_resolucion: f.nro_resolucion, estado_digitalizacion: f.estado_digitalizacion, en_universo: !!f.en_universo,
        iniciador: f.iniciador || null, dni: f.dni || null, fecha_ingreso: f.fecha_ingreso || null,
        dni_coincide: f.dni && r.derivado.dni_principal ? String(f.dni).replace(/^0+/, '') === String(r.derivado.dni_principal).replace(/\D/g, '').replace(/^0+/, '') : null,
        cuenta_coincide: f.cuenta && ctaLeida ? f.cuenta === ctaLeida : null,
        resolucion_coincide: f.nro_resolucion && r.derivado.resolucion_numero ? String(f.nro_resolucion).replace(/^0+/, '') === String(r.derivado.resolucion_numero).replace(/^0+/, '') : null };
    }
  }

  function cuentasSinParcela(inventario, parcelas, maximo) {
    const cuentas = new Set();
    for (const f of inventario || []) if (f.cuenta_valida === 1 && !esNulo(f.cuenta) && !propia(parcelas, f.cuenta)) cuentas.add(f.cuenta);
    const lista = [...cuentas].sort(compararSQL), n = Number(maximo) || 500;
    return n < 0 ? lista : lista.slice(0, n);   // LIMIT negativo: sin límite
  }
  function parcelaDesdeCatastro(p, ahora) {
    if (!p) return null;
    return { encontrada: 1, nomenclatura: comoTexto(p.nomenclatura, 3), departamento: comoTexto(p.departamento, 4), pedania: comoTexto(p.pedania, 5),
      localidad: comoTexto(p.localidad, 6), tipo_parcela: comoTexto(p.tipo_parcela, 7), estado: comoTexto(p.estado, 8), designacion: comoTexto(p.designacion, 9),
      sup_tierra: comoReal(p.sup_tierra, 10), sup_mejoras: comoReal(p.sup_mejoras, 11), valuacion: comoReal(p.valuacion, 12),
      lat: comoReal(p.lat, 13), lon: comoReal(p.lon, 14), consultada_en: comoTexto(ahora, 15) };
  }

  function agrupar(filas, claves, desc = []) {
    const grupos = new Map();
    for (const f of filas) {
      const k = claves(f), id = JSON.stringify(k);
      if (!grupos.has(id)) grupos.set(id, { clave: k, filas: [] });
      grupos.get(id).filas.push(f);
    }
    return [...grupos.values()].sort((a, b) => {
      for (let i = 0; i < a.clave.length; i++) { const c = compararSQL(a.clave[i], b.clave[i]); if (c) return desc[i] ? -c : c; }
      return 0;
    });
  }
  function expedientesLeidos(registros) {
    const s = new Set();
    for (const r of registros || []) if (r.derivado && r.derivado.expediente && !r.repetido_de && !r.error) s.add(r.derivado.expediente);
    return s;
  }
  function resumenInventario(inventario, parcelas, registros, meta) {
    const inv = inventario || [];
    if (!inv.length) return { cargado: false };
    const leidos = expedientesLeidos(registros);
    const leida = e => leidos.has(e.split('-').join('/')) || leidos.has(e.slice(0, 11) + '/' + e.slice(12));
    const pendientes = new Set();
    for (const f of inv) if (f.cuenta_valida === 1 && !esNulo(f.cuenta) && !propia(parcelas, f.cuenta)) pendientes.add(f.cuenta);
    const porEstado = agrupar(inv, f => [coalesce(f.estado_digitalizacion)], [true]).map(g => ({ estado: g.clave[0], n: g.filas.length }));
    porEstado.sort((a, b) => b.n - a.n);
    return { cargado: true, archivo: (meta && meta.archivo) || null, cargado_en: (meta && meta.cargado_en) || null,
      total: inv.length, con_resolucion: sumaSQL(inv, f => f.tiene_resolucion) || 0, con_cuenta: sumaSQL(inv, f => f.cuenta_valida) || 0,
      con_resolucion_y_cuenta: inv.filter(f => f.tiene_resolucion === 1 && f.cuenta_valida === 1).length || 0, en_universo: sumaSQL(inv, f => f.en_universo) || 0,
      sin_digitalizar: inv.filter(f => f.estado_digitalizacion === 'No digitalizado').length || 0, con_dni: inv.filter(f => !esNulo(f.dni)).length || 0,
      con_iniciador: inv.filter(f => !esNulo(f.iniciador)).length || 0,
      ubicadas: inv.filter(f => parcelaEncontrada(parcelas, f.cuenta)).length, pendientes_catastro: pendientes.size,
      leidas: inv.filter(f => leida(String(f.expediente))).length, por_estado: porEstado };
  }
  function inventarioPorLocalidad(inventario, parcelas) {
    const unidas = (inventario || []).map(i => ({ i, p: parcelaEncontrada(parcelas, i.cuenta) }));   // LEFT JOIN parcelas p ON … AND p.encontrada = 1
    const grupos = agrupar(unidas, ({ i, p }) => [coalesce(p && p.localidad, '(sin ubicar)'), coalesce(p && p.departamento, i.departamento, '(sin departamento)')]);
    const salida = grupos.map(g => {
      const fs = g.filas, primera = fs[0];
      return { fila: { localidad: g.clave[0], departamento: g.clave[1], total: fs.length, con_resolucion: sumaSQL(fs, x => x.i.tiene_resolucion),
        baldias: fs.filter(x => x.p && empiezaConBaldio(x.p.estado)).length, lat: promedioSQL(fs.map(x => x.p && x.p.lat)), lon: promedioSQL(fs.map(x => x.p && x.p.lon)) },
        sinUbicar: !primera.p || esNulo(primera.p.localidad) ? 1 : 0 };
    });
    salida.sort((a, b) => a.sinUbicar - b.sinUbicar || compararSQL(b.fila.con_resolucion, a.fila.con_resolucion) || compararSQL(b.fila.total, a.fila.total));
    return salida.map(x => x.fila);
  }

  function archivosDesde(registros, archivos) {
    const porArchivo = new Map();
    for (const r of registros || []) {
      const a = porArchivo.get(r.hash_archivo) || []; a.push(r); porArchivo.set(r.hash_archivo, a);
    }
    const orden = (archivos || []).slice().sort((a, b) => compararSQL(coalesce(a.cargado_en), coalesce(b.cargado_en)) || compararSQL(coalesce(a.nombre), coalesce(b.nombre)));
    return orden.map(a => {
      const rs = porArchivo.get(a.hash) || [];
      const validas = rs.filter(r => r.derivado && !r.repetido_de && !r.error);
      const repetidas = rs.filter(r => r.derivado && r.repetido_de);
      return { nombre: a.nombre, paginas: a.paginas, resoluciones: rs.length,
        suma: validas.map(r => r.derivado.expediente || '?'),
        repetidas: repetidas.map(r => ({ expediente: r.derivado.expediente, queda: r.repetido_de })),
        errores: rs.filter(r => r.error).map(r => r.error),
        tipos: [...new Set(rs.map(r => r.derivado && r.derivado.tipo_documento).filter(Boolean))] };
    });
  }

  return {
    expInventario, claveNombre, ESTADO_PADRON, plausible, COLUMNAS_INVENTARIO,
    filasPadron, cruzarConPadron, parsearCSV, normalizarExpediente, fechaISO,
    filasInventario, fusionarInventario, indicePorExpediente, anexarInventario,
    cuentasSinParcela, parcelaDesdeCatastro, resumenInventario, inventarioPorLocalidad,
    marcarRepetidos, aplicarRevision, archivosDesde,
  };
});
