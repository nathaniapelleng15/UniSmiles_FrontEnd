/**
 * Entry point untuk halaman uji cetak Niimbot.
 *
 * Kenapa berkas ini ada dan bukan `public/`:
 *   Vite menyalin isi `public/` APA ADANYA — berkas TypeScript di sana tidak
 *   akan pernah dikompilasi, dan browser tidak bisa memuat `.ts`. Entry point
 *   karena itu berada di luar `public/`, dan Vite mengompilasinya menjadi
 *   bundle yang bisa dimuat halaman HTML statis.
 *
 * Halaman uji menerima service ini lewat `window.NiimbotPrint` dan event
 * `niimbot-print-service-ready`. Event dipakai supaya halaman tahu kapan
 * service benar-benar siap — skrip HTML biasa berjalan sebelum modul selesai
 * dimuat, dan tombol yang bisa diklik sebelum service ada hanya menghasilkan
 * pesan gagal yang membingungkan.
 */

import {
  NiimbotPrinter,
  labelSize,
  B1_PRO_PRINTHEAD_PX,
  LABEL_DPI,
  DEFAULT_ADJUSTMENTS,
  type PrintAdjustments,
  type LabelSize,
} from './services/niimbotPrinter';

const api = {
  NiimbotPrinter,
  labelSize,
  B1_PRO_PRINTHEAD_PX,
  LABEL_DPI,
  DEFAULT_ADJUSTMENTS,
  /** Satu instance per halaman: printer hanya bisa dipegang satu klien. */
  printer: new NiimbotPrinter(),

  isSupported: () => NiimbotPrinter.isSupported(),
  connect: () => api.printer.connect(),
  disconnect: () => api.printer.disconnect(),
  print: (
    image: string,
    size: LabelSize,
    copies: number,
    adjustments: PrintAdjustments,
    onProgress?: (page: number, total: number) => void,
  ) => api.printer.print(image, size, copies, adjustments, onProgress),
};

declare global {
  interface Window {
    NiimbotPrint: typeof api;
  }
}

window.NiimbotPrint = api;
window.dispatchEvent(new CustomEvent('niimbot-print-service-ready', { detail: api }));
