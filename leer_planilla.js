/*
 * Relevamiento Ley Pierri — versión web
 * Ley 24.374 / Ley 8932 · Escribanía General de Gobierno de Córdoba
 * Diseño y desarrollo: Baltasar Corna Fantin, 2026.
 */
/**
 * leer_planilla.js — lee el Padrón (.xls / .xlsx) en un proceso aparte de la página (un worker), con SheetJS. Si la
 * planilla viniera armada para aprovechar una falla de la librería, no llega a la página, que es donde están las llaves
 * y el token de GitHub. Recibe los bytes del archivo y devuelve solo las filas de la primera hoja.
 */
importScripts('vendor/xlsx/xlsx.full.min.js');
onmessage = e => {
  try {
    const wb = XLSX.read(new Uint8Array(e.data), { type: 'array' });
    postMessage({ filas: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null }) });
  } catch (err) {
    postMessage({ error: String((err && err.message) || err) });
  }
};
