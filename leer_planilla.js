/*
 * Relevamiento Ley Pierri — versión web
 * Ley 24.374 / Ley 8932 · Escribanía General de Gobierno de Córdoba
 * Diseño y desarrollo: Baltasar Corna Fantin, 2026.
 */
/**
 * leer_planilla.js — lee una planilla (.xls / .xlsx) en un proceso aparte de la página (un worker), con SheetJS. Si la
 * planilla viniera armada para aprovechar una falla de la librería, no llega a la página, que es donde están las llaves
 * y el token de GitHub. Recibe los bytes del archivo y devuelve { v, hoja, hojas, filas }:
 *   - los bytes solos (el Padrón): las filas de la primera hoja, cada una como objeto, con los títulos como claves;
 *   - { bytes, modo: 'matriz' } (la planilla de trámites): las filas de la hoja que tiene los títulos FECHA_INGRESO y
 *     ANTIGUEDAD en sus 20 filas de arriba (si ninguna, la primera con datos), cada una como lista de celdas crudas.
 * v es la versión de este lector: la página la controla para saber que no le llegó uno viejo guardado en el navegador.
 */
importScripts('vendor/xlsx/xlsx.full.min.js');
const VERSION = 2;
const norm = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
onmessage = e => {
  try {
    const pedido = e.data instanceof ArrayBuffer ? { bytes: e.data } : (e.data || {});
    if (pedido.modo === 'matriz') {
      const wb = XLSX.read(new Uint8Array(pedido.bytes), { type: 'array', cellText: false, cellHTML: false, cellNF: false, cellStyles: false });
      const opc = { header: 1, defval: null, raw: true, blankrows: false };
      const arriba = n => { const ws = wb.Sheets[n]; if (!ws || !ws['!ref']) return []; const r = XLSX.utils.decode_range(ws['!ref']); r.e.r = Math.min(r.e.r, r.s.r + 19); return XLSX.utils.sheet_to_json(ws, Object.assign({}, opc, { range: r })); };
      const conTitulos = n => arriba(n).some(f => { const t = (f || []).map(norm); return t.includes('ANTIGUEDAD') && t.includes('FECHA INGRESO'); });
      const hoja = wb.SheetNames.find(conTitulos) || wb.SheetNames.find(n => arriba(n).length) || null;
      // Un libro guardado con el sistema de fechas de 1904 (opción de Excel para Mac) cuenta los días desde otro origen.
      const fecha1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
      postMessage({ v: VERSION, hoja, hojas: wb.SheetNames, fecha1904, filas: hoja ? XLSX.utils.sheet_to_json(wb.Sheets[hoja], opc) : [] });
      return;
    }
    const wb = XLSX.read(new Uint8Array(pedido.bytes), { type: 'array' });
    postMessage({ v: VERSION, hoja: wb.SheetNames[0], hojas: wb.SheetNames, filas: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null }) });
  } catch (err) {
    postMessage({ v: VERSION, error: String((err && err.message) || err) });
  }
};
