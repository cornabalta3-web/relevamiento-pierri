/*
 * Relevamiento Ley Pierri — versión web
 * Ley 24.374 / Ley 8932 · Escribanía General de Gobierno de Córdoba
 * Diseño y desarrollo: Baltasar Corna Fantin, 2026.
 */
/**
 * leer_planilla.js — lee una planilla (.xls / .xlsx) en un proceso aparte de la página (un worker), con SheetJS. Si la
 * planilla viniera armada para aprovechar una falla de la librería, no llega a la página, que es donde están las llaves
 * y el token de GitHub. Recibe los bytes del archivo y devuelve solo las filas de la primera hoja:
 *   - los bytes solos (el Padrón): cada fila como objeto, con los títulos de columna como claves;
 *   - { bytes, modo: 'matriz' } (la planilla de trámites): cada fila como lista de celdas, con su valor crudo. Así no se
 *     pierden las columnas de título repetido o vacío, y se arma sin el texto con formato de cada celda (menos memoria).
 */
importScripts('vendor/xlsx/xlsx.full.min.js');
onmessage = e => {
  try {
    const pedido = e.data instanceof ArrayBuffer ? { bytes: e.data } : (e.data || {});
    if (pedido.modo === 'matriz') {
      const wb = XLSX.read(new Uint8Array(pedido.bytes), { type: 'array', cellText: false, cellHTML: false, cellNF: false, cellStyles: false });
      postMessage({ filas: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null, raw: true, blankrows: false }) });
      return;
    }
    const wb = XLSX.read(new Uint8Array(pedido.bytes), { type: 'array' });
    postMessage({ filas: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null }) });
  } catch (err) {
    postMessage({ error: String((err && err.message) || err) });
  }
};
