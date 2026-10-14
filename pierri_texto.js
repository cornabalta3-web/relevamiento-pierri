(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PierriTexto = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CRITICOS = ['expediente', 'antiguedad', 'cuenta', 'rogantes_multiples'];

  const RE = {
    expediente: /expediente\s*N?\s*[°ºo*“"']*\s*(\d{4})\s*-?\s*(\d{5,7})\s*\/\s*(\d{4})/i,
    cuil: /(\d{2}\s*-\s*\d{8}\s*-\s*\d)/g,
    dni: /D\.?\s?N\.?\s?I\.?\s*:?\s*N?\s*[°º]?\s*([\d][\d.\s]{6,12}\d)/gi,
    matricula: /(?:MATRICULA|Matr[ií]cula|MATRÍCULA|MFR)\s*:?\s*N?\s*[°º]?\s*(\d{5,7})/g,
    cuenta: /\b(\d{2}\s*-?\s*\d{2}\s*-?\s*\d{7}\s*\/\s*\d)\b/g,
    superficie: /[Ss]uperficie\s+(?:[Tt]otal|de)?\s*:?\s*(?:de\s*)?([\d.]+,\d{2}|[\d.]+)\s*(?:m2|mts\.?2|m²)/g,
    fechaSello: /C[OÓ]RDOBA\s*,?\s*(\d{1,2})\s*([A-ZÁÉÍÓÚ]{3,10})\.?\s*(\d{4})/i,
    resolucion: /RESOLUCI[OÓ]N\s*(?:Nro\.?|N[°º])?\s*:?\s*(\d{1,4})\b(?!\s*\/)/i,
    verbo: /\b(ORDENAR|DESESTIMAR|RECHAZAR|ARCHIVAR|RECTIFICAR|AMPLIAR|CANCELAR|DEJAR SIN EFECTO)\b/i,
    titular: /[Tt]itular\s+Re[qg]istral\s*:?\s*([A-ZÁÉÍÓÚÑ][^.;]{2,60}?)(?:\s*\(|\.|;|$)/,
    departamento: /(?:Departamento|Dpto\.?)\s*:?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,28}?)\s*(?:,|;|\.|-|\s+Pedan|\s+Provincia|\s+de\s+esta)/i,
    pedania: /Pedan[ií]a\s*:?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,28}?)(?:,|\s+Localidad|\s+Municipalidad|\.|;)/i,
    localidad: /(?:Localidad|Municipalidad)\s*:?\s*(?:de\s+)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,32}?)\s*(?:,|;|\.|\s+Provincia|\s+Pedan|\s+Dpto|\s+Departamento)/i,
    barrio: /\bBarrio\s*:?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,30}?)\s*(?:,|;|\.|\s+Localidad|\s+de\s+la)/i,
    cedula: /C[EÉ]DULA\s+DE\s+NOTIFICACI[OÓ]N/i,
    expedienteRuidoso: /Exp(?:ediente|te)\.?\s*N?[°ºo*“"'”:.\s]*([0-9^?*]{3,4})\s*-\s*0*(\d{5,7})\s*\/\s*(\d{4})/i,
    manzana: /(?:Manzana|MZA?\.?)\s*:?\s*N?[°º]?\s*(\d{1,4})/i,
    lote: /Lote\s*:?\s*N?[°º]?\s*(\d{1,4}[A-Z]?)/i,
    afectacion: /afecta\s+(?:en\s+forma\s+)?(parcial(?:mente)?|total(?:mente)?)/i,
    cesion: /[Cc]esi[óo]n\s+de\s+[Dd]erechos/,
    rogante: /(?:posesi[óo]n que (?:el|la)|a favor de\s*(?:l|la)?)\s*(?:Sr(?:a|es)?\.?\s*)?([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'’,. ]{4,60}?)\s*,?\s*D\.?\s?N\.?\s?I/,
  };

  const MESES = { ENE:1, FEB:2, MAR:3, ABR:4, MAY:5, JUN:6, JUL:7, AGO:8, SEP:9, SET:9, OCT:10, NOV:11, DIC:12 };
  const PALABRAS = { CERO:0, UN:1, UNO:1, UNA:1, DOS:2, TRES:3, CUATRO:4, CINCO:5, SEIS:6, SIETE:7, OCHO:8, NUEVE:9, DIEZ:10,
    ONCE:11, DOCE:12, TRECE:13, CATORCE:14, QUINCE:15, DIECISEIS:16, DIECISIETE:17, DIECIOCHO:18, DIECINUEVE:19, VEINTE:20,
    VEINTIUNO:21, VEINTIDOS:22, VEINTITRES:23, VEINTICUATRO:24, VEINTICINCO:25, VEINTISEIS:26, VEINTISIETE:27, VEINTIOCHO:28,
    VEINTINUEVE:29, TREINTA:30, CUARENTA:40, CINCUENTA:50, SESENTA:60, SETENTA:70, OCHENTA:80, NOVENTA:90, CIEN:100 };

  function limpiar(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function aNumero(s) {
    if (s == null) return null;
    const t = limpiar(s);
    if (/^\d+$/.test(t)) return Number(t);
    let total = 0;
    for (const p of t.split(' ')) { if (p === 'Y' || !p) continue; if (!(p in PALABRAS)) return null; total += PALABRAS[p]; }
    return total || null;
  }
  function iso(d, m, a) {
    const dd = Number(d), mm = Number(m), aa = Number(a);
    if (!dd || !mm || !aa || mm > 12 || dd > 31) return null;
    return `${aa}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }
  function fechaBarra(s) { const m = String(s).match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/); return m ? iso(m[1], m[2], m[3]) : null; }

  function todas(texto, re) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(texto)) !== null) { out.push(m[1].replace(/\s/g, '')); if (!re.global) break; }
    return out;
  }

  const NUM_RE = '(\\d{1,3}|[A-Za-zÁÉÍÓÚÑáéíóúñ]+(?:\\s+y\\s+[A-Za-zÁÉÍÓÚÑáéíóúñ]+)?)';
  const FE_RE = '(\\d{1,2}\\s*[\\/\\-.]\\s*\\d{1,2}\\s*[\\/\\-.]\\s*\\d{4})';
  const RE_ANIOS = new RegExp('antig[üuúù]edad[\\s\\S]{0,220}?es\\s*(?:de\\s*)?(?:m[aá]s\\s+de\\s*)?' + NUM_RE + '\\s*a[nñ]os?(?:\\s*y\\s*' + NUM_RE + '\\s*mes(?:es)?)?[\\s,;.]*al\\s*' + FE_RE, 'gi');
  const RE_DATA = new RegExp('antig[üuúù]edad[\\s\\S]{0,160}?data del\\s*' + FE_RE, 'gi');
  const RE_ANIOS_INV = new RegExp('antig[üuúù]edad[\\s\\S]{0,160}?al\\s*' + FE_RE + '\\s*,?\\s*es\\s*(?:de\\s*)?' + NUM_RE + '\\s*a[nñ]os?(?:\\s*y\\s*' + NUM_RE + '\\s*mes(?:es)?)?', 'gi');
  const RE_DESDE_FECHA = new RegExp('antig[üuúù]edad[\\s\\S]{0,160}?desde el\\s*' + FE_RE, 'gi');
  const RE_DESDE_ANIO = new RegExp('antig[üuúù]edad[\\s\\S]{0,160}?(?:desde el|data del)\\s+a[nñ]o\\s*(\\d\\.?\\d{3})', 'gi');
  function scan(re, t, f) {
    const out = []; re.lastIndex = 0; let m;
    while ((m = re.exec(t)) !== null) { const r = f(m); if (r) out.push(Object.assign({ _pos: m.index }, r)); if (m.index === re.lastIndex) re.lastIndex++; }
    return out;
  }
  const MESES_N = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };
  const numMes = x => MESES_N[String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')];
  const dos = n => String(n).padStart(2, '0');
  function fechasEnPalabras(t) {
    return String(t)
      .replace(/\b(\d{1,2})\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(?:del?\s+)?(?:a[nñ]o\s+)?(\d{4})\b/g, (m, d, mes, a) => numMes(mes) ? `${dos(d)}/${dos(numMes(mes))}/${a}` : m)
      .replace(/\bmes\s+de\s+([A-Za-zÁÉÍÓÚáéíóú]+)\s+(?:del?\s+)?(?:a[nñ]o\s+)?(\d{4})\b/g, (m, mes, a) => numMes(mes) ? `01/${dos(numMes(mes))}/${a}` : m)
      .replace(/\bal\s+(\d{1,2})\s*\/\s*(\d{4})\b/g, (m, mm, a) => `al 01/${dos(mm)}/${a}`);
  }
  function antiguedadTodas(t) {
    t = fechasEnPalabras(t);
    const a = scan(RE_ANIOS, t, m => aNumero(m[1]) == null ? null : { antiguedad_anios: aNumero(m[1]), antiguedad_meses: m[2] ? (aNumero(m[2]) || 0) : 0,
      fecha_referencia: fechaBarra(m[3]), fecha_inicio_declarada: null, criterio: criterio(m[0]), texto_original: m[0].replace(/\s+/g, ' ') });
    const a2 = scan(RE_ANIOS_INV, t, m => aNumero(m[2]) == null ? null : { antiguedad_anios: aNumero(m[2]), antiguedad_meses: m[3] ? (aNumero(m[3]) || 0) : 0,
      fecha_referencia: fechaBarra(m[1]), fecha_inicio_declarada: null, criterio: criterio(m[0]), texto_original: m[0].replace(/\s+/g, ' ') });
    const b = scan(RE_DATA, t, m => ({ antiguedad_anios: null, antiguedad_meses: null, fecha_referencia: null, fecha_inicio_declarada: fechaBarra(m[1]),
      criterio: criterio(m[0]) || 'SURGE_EXPEDIENTE', texto_original: m[0].replace(/\s+/g, ' ') }));
    const c = scan(RE_DESDE_FECHA, t, m => ({ antiguedad_anios: null, antiguedad_meses: null, fecha_referencia: null, fecha_inicio_declarada: fechaBarra(m[1]),
      criterio: criterio(m[0]), texto_original: m[0].replace(/\s+/g, ' ') }));
    const d = scan(RE_DESDE_ANIO, t, m => ({ antiguedad_anios: null, antiguedad_meses: null, fecha_referencia: null, fecha_inicio_declarada: `${m[1].replace('.', '')}-01-01`,
      criterio: criterio(m[0]), texto_original: m[0].replace(/\s+/g, ' ') }));
    return a.concat(a2, b, c, d).sort((x, y) => x._pos - y._pos).map(x => { delete x._pos; return x; });
  }
  function antiguedad(t) {
    const todas = antiguedadTodas(t);
    if (!todas.length) return null;
    let m = todas[todas.length - 1];
    if (m.antiguedad_anios != null && !m.antiguedad_meses) {
      const conMeses = todas.filter(x => x.antiguedad_meses && x.fecha_referencia === m.fecha_referencia && x.antiguedad_anios === m.antiguedad_anios);
      if (conMeses.length) m = conMeses[conMeses.length - 1];
    }
    return m;
  }
  function criterio(frase) {
    const f = frase.toLowerCase();
    if (f.includes('documental')) return 'SURGE_DOCUMENTAL';
    if (f.includes('del expediente')) return 'SURGE_EXPEDIENTE';
    if (/declarad[ao] por (el|la) rogante/.test(f)) return 'DECLARADA_ROGANTE';
    return null;
  }

  const LETRAS = '[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ .]{2,32}?';
  const FIN = '\\s*(?:,|;|\\.|\\s+Provincia|\\s+provincia|\\s+Pedan|\\s+Dpto|\\s+Departamento|\\s+DEPARTAMENTO)';
  const RE_LOC = [
    new RegExp('(?:Localidad|LOCALIDAD)\\s*:?\\s*(?:de\\s+)?(' + LETRAS + ')' + FIN),
    new RegExp('(?:Pueblo|Ciudad\\s+de|Comuna\\s+de|Municipalidad\\s+de|Municipio\\s+de\\s+la\\s+Ciudad\\s+de)\\s+(' + LETRAS + ')' + FIN),
    new RegExp('(?:Lugar|Paraje)(?:\\s+denominado)?\\s*:?\\s+(' + LETRAS + ')' + FIN),
  ];
  function localidadDelInmueble(t) {
    const ini = t.search(/inmueble[\s,]*ubicado\s+en|ubicad[oa]\s+en/i);
    if (ini >= 0) {
      const zona = t.slice(ini, ini + 320);
      for (const re of [RE_LOC_ZONA].concat(RE_LOC.slice(1))) { const m = zona.match(re); if (m) return m[1].trim(); }
    }
    const m = t.match(RE_LOC[0]);
    return m ? m[1].trim() : null;
  }
  const RE_CTA = /(?:cuenta|cta\.?|Cuenta\s+DGR|N[°º]\s*de\s*cta\.?)\s*(?:de\s+Rentas)?\s*(?:N[°º]?\s*[:.]?)?\s*[:.]?\s*([0-9](?:[0-9 .\-\/]{9,20})[0-9])/gi;
  const RE_CTA_SUELTA = /\b(\d{2}\s*-?\s*\d{2}\s*-?\s*\d{7}\s*[\/-]\s*\d)\b/g;
  const MARCA_INMUEBLE = /afecta|empad\w*|cuenta\s+de\s+Rentas|designaci[oó]n\s+oficial|consulta\s+catastral|resto\s+de\s+parcela/gi;
  const MARCA_LINDERO = /lind(?:a|an|ando|ero|eros)\b/gi;
  function apariciones(t) {
    const out = [];
    for (const re of [RE_CTA, RE_CTA_SUELTA]) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(t)) !== null) {
        const dig = m[1].replace(/\D/g, '');
        if (dig.length !== 12) continue;
        const antes = t.slice(Math.max(0, m.index - 170), m.index);
        const ultima = rx => { let k = -1, x; rx.lastIndex = 0; while ((x = rx.exec(antes)) !== null) k = x.index; return k; };
        const pi = ultima(MARCA_INMUEBLE), pl = ultima(MARCA_LINDERO);
        out.push({ dig, pos: m.index, lado: pl > pi ? 'lindero' : pi >= 0 ? 'inmueble' : 'neutra' });
      }
    }
    return out;
  }
  function cuentasDelInmueble(t) {
    const ap = apariciones(t);
    const inm = ap.filter(a => a.lado === 'inmueble').map(a => a.dig);
    const lin = new Set(ap.filter(a => a.lado === 'lindero').map(a => a.dig));
    const neu = ap.filter(a => a.lado === 'neutra' && !lin.has(a.dig)).map(a => a.dig);
    return Array.from(new Set(inm.concat(neu)));
  }
  function cuentasDeLinderos(t) { return apariciones(t).filter(a => a.lado === 'lindero').map(a => a.dig); }

  const RE_LOC_ZONA = new RegExp('(?:[Ll]ocalidad|LOCALIDAD)\\s*:?\\s*(?:de\\s+)?(' + LETRAS + ')' + FIN);
  function tipoDocumento(t) {
    if (/ORDENAR[\s\S]{0,400}?(Registro\s+Personal\s+de\s+Poseedores|inscripci[oó]n[\s\S]{0,160}?Registro)/i.test(t)) return 'RESOLUCION_INSCRIPCION';
    if (RE.cedula.test(t)) return 'CEDULA_NOTIFICACION';
    if (/\b(APROBAR\s+formalmente|EMPL[AÁ]CESE|SUSP[EÉ]NDASE|INT[IÍ]MESE|REQU[IÍ][EÉ]RASE)\b/i.test(t)) return 'RESOLUCION_TRAMITE';
    const m = t.match(RE.verbo);
    if (!m) return null;
    const v = limpiar(m[1]);
    if (v === 'ORDENAR') return 'RESOLUCION_INSCRIPCION';
    if (v === 'RECTIFICAR' || v === 'AMPLIAR') return 'RESOLUCION_RECTIFICA';
    if (v === 'CANCELAR' || v.startsWith('DEJAR')) return 'RESOLUCION_CANCELA';
    return 'RESOLUCION_DESESTIMA';
  }

  function extraerDeTexto(texto, nombreArchivo) {
    const t = String(texto || '').replace(/\s+/g, ' ');
    const e = {
      tipo_documento: tipoDocumento(t), resolucion: { numero: null, fecha: null }, expediente: null,
      rogantes: [], inmueble: { departamento: null, pedania: null, localidad: null, calle: null, numero: null, manzana: null,
        lote: null, barrio: null, superficie_m2: null, superficie_texto: null, tipo: null },
      plano: { existe: /Plano de Mensura/i.test(t) || null, profesional: null, matricula_profesional: null, fecha_visado: null },
      dominio: { afectados: [], nomenclatura: null },
      posesion: { antiguedad_anios: null, antiguedad_meses: null, fecha_referencia: null, fecha_inicio_declarada: null,
        criterio: null, origen_mencionado: RE.cesion.test(t) ? 'CESION' : null, folio: null, texto_original: null },
      declaracion_jurada: { fecha: null, folio_unico: null, juzgado_paz: null, testigos: [] },
      documental: [],
      calidad: { legibilidad: null, campos_dudosos: [], observaciones: 'extraído de la capa de texto del PDF' },
      _fuente: 'texto',
    };

    let m = t.match(RE.expediente);
    if (m) e.expediente = `${m[1]}-${m[2]}/${m[3]}`;
    else {
      m = t.match(RE.expedienteRuidoso);
      if (m) {
        const pref = /^\d{4}$/.test(m[1]) ? m[1] : (/^0?53/.test(m[1]) ? '0535' : null);
        if (pref) e.expediente = `${pref}-${m[2].padStart(6, '0')}/${m[3]}`;
      }
    }
    m = t.match(RE.fechaSello);
    if (m) { const mes = MESES[limpiar(m[2]).slice(0, 3)]; if (mes) e.resolucion.fecha = iso(m[1], mes, m[3]); }
    m = t.match(RE.resolucion);
    if (m) e.resolucion.numero = m[1];

    const cuils = todas(t, RE.cuil);
    const visto = t.slice(0, 900);
    const cuilRogante = todas(visto, RE.cuil)[0] || (cuils.length === 1 ? cuils[0] : null) ||
      (cuils.length && cuils.every(c => c === cuils[0]) ? cuils[0] : null);
    const art1 = (t.match(/ORDENAR[\s\S]{0,700}?Registro Personal/i) || [''])[0];
    const cuilsArt1 = Array.from(new Set(todas(art1, RE.cuil)));
    if (cuilsArt1.length > 1) e.calidad.observaciones = `${cuilsArt1.length} rogantes en el art. 1° (${cuilsArt1.join(', ')}); el texto solo estructura el primero`;
    let nombre = null;
    const mn = t.match(RE.rogante);
    if (mn) {
      nombre = mn[1].replace(/\s+/g, ' ').replace(/[.,]\s*$/, '').trim();
      if (limpiar(nombre).split(' ').length > 8 || /\d/.test(nombre)) nombre = null;
      else nombre = nombre.toUpperCase();
    }
    if (cuilRogante) {
      const d = cuilRogante.replace(/\D/g, '');
      e.rogantes.push({ apellido_nombre: nombre, dni: d.slice(2, 10).replace(/^0+/, ''), cuil: `${d.slice(0,2)}-${d.slice(2,10)}-${d.slice(10)}`,
        estado_civil: null, domicilio: { calle: null, numero: null, barrio: null, cp: null, localidad: null, departamento: null } });
    }

    m = t.match(RE.departamento); if (m) e.inmueble.departamento = m[1].trim();
    m = t.match(RE.pedania); if (m) e.inmueble.pedania = m[1].trim();
    e.inmueble.localidad = localidadDelInmueble(t);
    { const ini = t.search(/inmueble\s+ubicado\s+en|ubicad[oa]\s+en/i);
      if (ini >= 0) { m = t.slice(ini, ini + 260).match(RE.barrio); if (m) e.inmueble.barrio = m[1].trim(); } }
    m = t.match(RE.manzana); if (m) e.inmueble.manzana = m[1];
    m = t.match(RE.lote); if (m) e.inmueble.lote = m[1];
    const sups = todas(t, RE.superficie).map(s => Number(s.replace(/\./g, '').replace(',', '.'))).filter(n => n > 0);
    if (sups.length) { e.inmueble.superficie_m2 = sups[0]; e.inmueble.superficie_texto = String(sups[0]); }
    e.inmueble.tipo = e.inmueble.manzana ? 'urbano' : null;

    const matriculas = Array.from(new Set(todas(t, RE.matricula)));
    const cuentas = cuentasDelInmueble(t);
    const deLinderos = new Set(cuentasDeLinderos(t));
    const pares = {};
    const reParejas = /(?:MATRICULA|Matr[ií]cula|MFR)\s*:?\s*[-]?\s*(\d{5,7})[^.;]{0,40}?cta\.?\s*:?\s*(\d{2}\s*-?\s*\d{2}\s*-?\s*\d{7}\s*\/\s*\d)/gi;
    let p;
    while ((p = reParejas.exec(t)) !== null) pares[p[1]] = p[2].replace(/\D/g, '');
    const afect = t.match(RE.afectacion);
    const afectacion = afect ? (limpiar(afect[1]).startsWith('PARCIAL') ? 'parcial' : 'total') : null;
    const afectadas = [];
    const reOracionAfecta = /afecta[^.]{0,400}/gi;
    let oa;
    while ((oa = reOracionAfecta.exec(t)) !== null) {
      const reM = /(?:MATRICULA|Matr[ií]cula|MATRÍCULA|MFR)\s*:?\s*N?\s*[°º]?\s*(\d{5,7})/g;
      let mm2; while ((mm2 = reM.exec(oa[0])) !== null) if (!afectadas.includes(mm2[1])) afectadas.push(mm2[1]);
    }
    const listaMat = afectadas.length ? afectadas : matriculas;
    for (const mat of listaMat) e.dominio.afectados.push({ matricula: mat, cuenta: pares[mat] || null, titular_registral: null, afectacion });
    if (!e.dominio.afectados.length && cuentas.length) e.dominio.afectados.push({ matricula: null, cuenta: cuentas[0], titular_registral: null, afectacion });
    if (e.dominio.afectados.length && !e.dominio.afectados[0].cuenta && cuentas.length === 1) e.dominio.afectados[0].cuenta = cuentas[0];
    m = t.match(RE.titular); if (m && e.dominio.afectados.length) e.dominio.afectados[0].titular_registral = m[1].trim();

    const ants = antiguedadTodas(t);
    let antConflicto = false;
    if (ants.length) {
      const claves = new Set(ants.map(a => a.fecha_inicio_declarada || `${a.antiguedad_anios}|${a.fecha_referencia}`));
      antConflicto = claves.size > 1;
      Object.assign(e.posesion, ants[ants.length - 1]);
      if (antConflicto) e.calidad.observaciones = 'las frases de antigüedad de las dos páginas no coinciden: ' + ants.map(a => a.texto_original).join(' || ');
    }

    const faltan = [];
    if (!e.expediente) faltan.push('expediente');
    else if (nombreArchivo) {
      const m2 = String(nombreArchivo).match(/(\d{4})[-_](\d{5,7})[-_\/](\d{4})/);
      if (m2 && `${m2[1]}-${m2[2]}/${m2[3]}` !== e.expediente) faltan.push('expediente_distinto_al_archivo');
    }
    if (antConflicto) faltan.push('antiguedad_inconsistente');
    if (e.posesion.fecha_referencia) {
      const anio = Number(e.posesion.fecha_referencia.slice(0, 4));
      if (anio < 2003 || anio > new Date().getFullYear()) faltan.push('fecha_referencia_fuera_de_rango');
    }
    if (e.posesion.antiguedad_anios != null && (e.posesion.antiguedad_anios < 1 || e.posesion.antiguedad_anios > 100)) faltan.push('antiguedad_fuera_de_rango');
    if (e.dominio.afectados.some(a => a.cuenta)) {
      const dep = Number(String(e.dominio.afectados.find(a => a.cuenta).cuenta).slice(0, 2));
      if (dep < 11 || dep > 36) faltan.push('cuenta_con_departamento_invalido');
    }
    if (!e.posesion.antiguedad_anios && !e.posesion.fecha_inicio_declarada) faltan.push('antiguedad');
    if (!e.dominio.afectados.some(a => a.cuenta)) faltan.push('cuenta');
    if (!e.tipo_documento) faltan.push('tipo_documento');
    if (!e.rogantes.length) faltan.push('rogante');
    if (e.rogantes.length && !e.rogantes[0].apellido_nombre) faltan.push('nombre_rogante');
    if (cuilsArt1.length > 1) faltan.push('rogantes_multiples');
    if (!e.dominio.afectados.some(a => a.matricula)) faltan.push('matricula');

    const INCONSISTENCIAS = ['expediente_distinto_al_archivo', 'antiguedad_inconsistente', 'fecha_referencia_fuera_de_rango', 'antiguedad_fuera_de_rango', 'cuenta_con_departamento_invalido'];
    const noEvaluable = ['RESOLUCION_DESESTIMA', 'RESOLUCION_CANCELA', 'CEDULA_NOTIFICACION', 'RESOLUCION_TRAMITE'].includes(e.tipo_documento);
    const criticosFaltantes = faltan.filter(f => noEvaluable ? (f === 'expediente' || f === 'expediente_distinto_al_archivo') : (CRITICOS.includes(f) || f === 'tipo_documento' || INCONSISTENCIAS.includes(f)));
    e.calidad.legibilidad = criticosFaltantes.length ? 'mala' : (faltan.length ? 'regular' : 'buena');
    e.calidad.campos_dudosos = faltan;
    const totales = ['expediente', 'antiguedad', 'cuenta', 'tipo_documento', 'rogante', 'matricula'];
    return { extraido: e, faltan, suficiente: criticosFaltantes.length === 0, cobertura: (totales.length - faltan.length) / totales.length };
  }

  return { extraerDeTexto, antiguedad, antiguedadTodas, aNumero, CRITICOS };
});
