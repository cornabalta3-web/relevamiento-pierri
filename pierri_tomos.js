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

  return { textoDeItems,
    RE_INICIO, RE_EXP, RE_EXP_TEMPRANO, RE_FIN, RE_FIN_FUERTE, RE_RESOLUTIVA, RE_ORDEN_INSCRIPCION, RE_ORDENAR,
    puntajeResolucion, esTomo, expedienteDelNombre, cortarTomo, mejorDe, unaPorExpediente,
    unidadesDe, leerTexto, registroBase, registroPorTexto, registroIncompleto,
  };
});
