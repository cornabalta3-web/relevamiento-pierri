(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./pierri_core.js'), require('./pierri_texto.js'));
  else root.PierriTomos = factory(root.PierriCore, root.PierriTexto);
})(typeof self !== 'undefined' ? self : this, function (PierriCore, PierriTexto) {
  'use strict';

  const RE_INICIO = /VISTO\s*:?\s*El\s+expediente/i;
  const RE_EXP = /expediente\s*N?\s*[°ºo*“"']*\s*(\d{4})\s*-?\s*(\d{5,7})\s*\/\s*(\d{4})/i;
  const RE_EXP_TEMPRANO = /^[\s\S]{0,400}?(\d{4})\s*-?\s*(\d{5,7})\s*\/\s*(\d{4})/;
  const RE_FIN = /PROTOCOL[IÍ]CESE|PROTOCOLICESE|RESUELVE\s*:|\bORDENAR\b|\bDESESTIMAR\b/i;
  const RE_FIN_FUERTE = /PROTOCOL[IÍ]CESE|PROTOCOLICESE/i;
  const RE_RESOLUTIVA = /RESUELVE\s*:|PROTOCOL[IÍ]CESE|PROTOCOLICESE|\bORDENAR\b|\bDESESTIMAR\b|\bART[IÍ]CULO\s+1/i;
  const RE_ORDEN_INSCRIPCION = /ORDENAR[\s\S]{0,1200}?(Registro\s+Personal\s+de\s+Poseedores|inscripci[oó]n[\s\S]{0,200}?Registro)/i;
  const RE_ORDENAR = /\bORDENAR\b/i;
  function puntajeResolucion(texto) {
    if (RE_ORDEN_INSCRIPCION.test(texto)) return 3;      // ordena la inscripción: es la que buscamos
    if (RE_ORDENAR.test(texto)) return 2;                 // ordena algo, pero no la inscripción
    return 1;                                             // rectifica, desestima, archiva
  }
  function textoDeItems(items) { return items.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim(); }
  function esTomo(pags) { return pags.length > 6 || pags.filter(t => RE_INICIO.test(t)).length > 1; }
  function expedienteDelNombre(nombre) {
    const m = String(nombre || '').match(/(\d{4})-(\d{5,7})-(\d{4})/);
    return m ? `${m[1]}-${m[2]}/${m[3]}` : null;
  }
  function cortarTomo(pags, expArchivo) {
    const unidades = [], sueltas = [];
    let abierta = null;
    const cerrar = () => { if (abierta) { unidades.push(abierta); abierta = null; } };
    for (let p = 0; p < pags.length; p++) {
      const t = pags[p] || '';
      const esInicio = RE_INICIO.test(t) || (RE_EXP_TEMPRANO.test(t) && !RE_FIN.test(t));
      const esFin = RE_FIN.test(t);
      if (esInicio) {
        cerrar();
        const m = t.match(RE_EXP);
        abierta = { desde: p, hasta: p, expediente: m ? `${m[1]}-${m[2]}/${m[3]}` : null };
        if (esFin && RE_FIN_FUERTE.test(t)) cerrar();
        continue;
      }
      if (abierta) {
        abierta.hasta = p;
        if (!abierta.expediente) { const m = t.match(RE_EXP); if (m) abierta.expediente = `${m[1]}-${m[2]}/${m[3]}`; }
        if (esFin || abierta.hasta - abierta.desde >= 3) cerrar();
        continue;
      }
      if (esFin && sueltas.length && sueltas[sueltas.length - 1] === p - 1) {
        const desde = sueltas.pop();
        const m = t.match(RE_EXP) || (pags[desde] || '').match(RE_EXP);
        unidades.push({ desde, hasta: p, expediente: m ? `${m[1]}-${m[2]}/${m[3]}` : null, dudosa: true });
        continue;
      }
      sueltas.push(p);
    }
    cerrar();
    const texto = u => pags.slice(u.desde, u.hasta + 1).join(' ');
    const conParteResolutiva = unidades.filter(u => RE_RESOLUTIVA.test(texto(u)));
    const cuerpo = unidades.filter(u => !RE_RESOLUTIVA.test(texto(u)));
    if (conParteResolutiva.length) {
      const paginasCuerpo = cuerpo.reduce((a, u) => a + (u.hasta - u.desde + 1), 0);
      const elegidas = unaPorExpediente(conParteResolutiva, texto, expArchivo);
      return { unidades: elegidas, sueltas, paginasCuerpo, bloquesDescartados: cuerpo.length,
        resolucionesTramite: conParteResolutiva.length - elegidas.length };
    }
    return { unidades, sueltas, paginasCuerpo: 0, bloquesDescartados: 0 };
  }
  function mejorDe(lista, texto) {
    let mejor = lista[0], mejorPuntaje = puntajeResolucion(texto(lista[0]));
    for (const u of lista.slice(1)) {
      const p = puntajeResolucion(texto(u));
      if (p > mejorPuntaje || (p === mejorPuntaje && u.desde > mejor.desde)) { mejor = u; mejorPuntaje = p; }
    }
    mejor.descartadasDelExpediente = lista.length - 1;
    return mejor;
  }
  function unaPorExpediente(unidades, texto, expArchivo) {
    if (expArchivo) {
      const elegida = mejorDe(unidades, texto);
      if (!elegida.expediente) elegida.expediente = expArchivo;
      return [elegida];
    }
    const porExp = new Map(), sinExp = [];
    for (const u of unidades) {
      if (!u.expediente) { sinExp.push(u); continue; }
      if (!porExp.has(u.expediente)) porExp.set(u.expediente, []);
      porExp.get(u.expediente).push(u);
    }
    if (porExp.size === 1) {
      const [exp, lista] = [...porExp][0];
      const elegida = mejorDe(lista.concat(sinExp), texto);
      if (!elegida.expediente) elegida.expediente = exp;
      return [elegida];
    }
    const elegidas = [];
    for (const [, lista] of porExp) elegidas.push(lista.length === 1 ? lista[0] : mejorDe(lista, texto));
    return elegidas.concat(sinExp).sort((a, b) => a.desde - b.desde);
  }

  function unidadesDe(pags, nombre, h) {
    const unidades = [];
    let sueltas = [];
    const tipo = esTomo(pags) ? 'tomo' : 'suelta';
    let paginasCuerpo = 0, bloquesDescartados = 0, resolucionesTramite = 0;
    if (tipo === 'tomo') {
      const r = cortarTomo(pags, expedienteDelNombre(nombre));
      sueltas = r.sueltas; paginasCuerpo = r.paginasCuerpo || 0; bloquesDescartados = r.bloquesDescartados || 0;
      resolucionesTramite = r.resolucionesTramite || 0;
      r.unidades.forEach(u => unidades.push({ nombre: `${nombre}#p${u.desde + 1}-${u.hasta + 1}`, texto: pags.slice(u.desde, u.hasta + 1).join(' '), paginas: u.hasta - u.desde + 1,
        tomo: { archivo: nombre, desde: u.desde, hasta: u.hasta, expedienteVisto: u.expediente, dudosa: !!u.dudosa },
        nombreControl: u.expediente ? `documento_${u.expediente.replace('/', '-')}_tomo.pdf` : null, id: `${h}#${u.desde}` }));
    } else {
      unidades.push({ nombre, texto: pags.join(' '), paginas: pags.length, tomo: null, nombreControl: nombre, id: h });
    }
    return { unidades, tipo, sueltas, paginasCuerpo, bloquesDescartados, resolucionesTramite };
  }

  function leerTexto(u) { return PierriTexto.extraerDeTexto(u.texto, u.nombreControl); }
  function registroBase(u, h) {
    return { archivo: u.nombre, hash: u.id, hash_archivo: h, paginas: u.paginas, tomo: u.tomo, tokens: 0 };
  }
  function registroPorTexto(base, u, lect, cfg, tabla, vistos) {
    const derivado = PierriCore.procesarRegistro(lect.extraido, cfg, tabla, vistos, { nombreArchivo: u.nombreControl, textoCapaPDF: u.texto });
    return Object.assign(base, { extraido: lect.extraido, derivado, fuente: 'texto', lectura: { fuente: 'texto', cobertura: lect.cobertura, faltan: lect.faltan } });
  }
  function registroIncompleto(base, u, lect, cfg, tabla, vistos, porque, fallaModelo) {
    const derivado = PierriCore.procesarRegistro(lect.extraido, cfg, tabla, vistos, { nombreArchivo: u.nombreControl, textoCapaPDF: u.texto });
    derivado.revisar = true;
    derivado.motivos_revision = (derivado.motivos_revision || []).concat(['el texto del PDF no alcanzó: faltan ' + lect.faltan.join(', ') + (porque || '')]);
    return Object.assign(base, { extraido: lect.extraido, derivado, fuente: 'texto_incompleto', falla_modelo: fallaModelo || null,
      lectura: { fuente: 'texto_incompleto', cobertura: lect.cobertura, faltan: lect.faltan } });
  }

  const MODELO_POR_DEFECTO = 'claude-haiku-4-5-20251001';
  function cuerpoModelo(datosB64, modelo, sistema, usuario) {
    return {
      model: modelo || MODELO_POR_DEFECTO, max_tokens: 3000, temperature: 0,
      system: [{ type: 'text', text: sistema, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: datosB64 } },
        { type: 'text', text: usuario },
      ] }],
    };
  }
  function tokensDe(data) {
    const u = (data && data.usage) || {};
    return (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  }
  function respuestaModelo(data) {
    const texto = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const extraido = PierriCore.parsearJSON(texto);
    if (!extraido) return null;
    extraido._fuente = 'modelo';
    return { extraido, tokens: tokensDe(data) };
  }
  function motivoModelo(err) {
    const m = String((err && err.message) || err || '');
    const api = (m.match(/la API respondió (\d{3})/) || [])[1], pdf = (m.match(/GitHub no devolvió el PDF \(respuesta (\d{3})\)/) || [])[1];
    if (pdf) return Number(pdf) >= 500
      ? { texto: 'GitHub no está entregando los PDF guardados (falla de su lado); probá en unos minutos', grave: false }
      : { texto: 'GitHub no devolvió el PDF de esa resolución: si recién se cargó, hay que esperar unos minutos', grave: false, documento: true };
    if (/conexión con GitHub/i.test(m)) return { texto: 'no hay conexión con GitHub', grave: false };
    if (api) {
      const st = Number(api);
      if (st === 401) return { texto: 'la clave de API no es válida', grave: true };
      if (st === 402 || (st === 400 && /credit balance|billing/i.test(m))) return { texto: 'la cuenta de Anthropic no tiene crédito', grave: true };
      if (st === 403) return { texto: 'la clave no tiene permiso para usar el modelo', grave: true };
      if (st === 429) return { texto: 'demasiados pedidos seguidos; reintentar en unos minutos', grave: false };
      if (st === 529) return { texto: 'Anthropic está sobrecargado; probá en unos minutos', grave: false };
      if (st >= 500) return { texto: 'Anthropic tuvo una falla de su lado; probá en unos minutos', grave: false };
      if (st === 413) return { texto: 'el PDF de esa resolución es demasiado grande para mandarlo al modelo', grave: false, documento: true };
      if (st === 400) return { texto: 'la API rechazó el PDF de esa resolución: puede estar dañado o ser demasiado grande', grave: false, documento: true };
    }
    if (/invalid x-api-key|API key is invalid|authentication_error/i.test(m)) return { texto: 'la clave de API no es válida', grave: true };
    if (/credit balance|billing/i.test(m)) return { texto: 'la cuenta de Anthropic no tiene crédito', grave: true };
    if (/no devolvió JSON/i.test(m)) return { texto: 'el modelo contestó pero no pudo leerla', grave: false, documento: true };
    if (/fetch failed|ENOTFOUND|ECONN|network|No hay conexión|error de red/i.test(m)) return { texto: 'no hay conexión a internet', grave: false };
    return { texto: 'el modelo no respondió (' + m.slice(0, 120) + ')', grave: false };
  }
  function fusionar(deTexto, delModelo) {
    const e = JSON.parse(JSON.stringify(delModelo));
    e._fuente = 'mixto';
    if (!e.expediente && deTexto.expediente) e.expediente = deTexto.expediente;
    if (deTexto.dominio.afectados.length) {
      for (const a of e.dominio.afectados || []) {
        if (a.cuenta) continue;
        const t = deTexto.dominio.afectados.find(x => x.matricula === a.matricula && x.cuenta);
        if (t) a.cuenta = t.cuenta;
      }
      if (!(e.dominio.afectados || []).length) e.dominio.afectados = deTexto.dominio.afectados;
    }
    if (!e.posesion.antiguedad_anios && !e.posesion.fecha_inicio_declarada && (deTexto.posesion.antiguedad_anios || deTexto.posesion.fecha_inicio_declarada))
      Object.assign(e.posesion, deTexto.posesion);
    return e;
  }
  function nombreControlDe(r) { return r.tomo ? (r.tomo.expedienteVisto ? `documento_${r.tomo.expedienteVisto.replace('/', '-')}_tomo.pdf` : r.archivo) : r.archivo; }

  return { textoDeItems, MODELO_POR_DEFECTO, cuerpoModelo, respuestaModelo, tokensDe, motivoModelo, fusionar, nombreControlDe,
    RE_INICIO, RE_EXP, RE_EXP_TEMPRANO, RE_FIN, RE_FIN_FUERTE, RE_RESOLUTIVA, RE_ORDEN_INSCRIPCION, RE_ORDENAR,
    puntajeResolucion, esTomo, expedienteDelNombre, cortarTomo, mejorDe, unaPorExpediente,
    unidadesDe, leerTexto, registroBase, registroPorTexto, registroIncompleto,
  };
});
