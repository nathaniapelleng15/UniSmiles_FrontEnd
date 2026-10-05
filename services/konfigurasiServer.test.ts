import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * "Aplikasi desktop mengambil konfigurasi dari backend" harus dibuktikan, bukan
 * diklaim. Yang bisa dibuktikan dari sini ada tiga, dan ketiganya pernah gagal
 * di proyek ini:
 *
 *   1. Aplikasi desktop memuat UI dari URL PRODUKSI, bukan dari dist lokal —
 *      kalau tidak, perbaikan di server tidak pernah sampai ke aplikasi.
 *   2. Bundle yang dimuat menembak backend, bukan localhost. Ini pernah
 *      terjadi: desktop menembak ws://localhost:3011 dan gagal koneksi.
 *   3. Kalau pengambilan gagal, yang dipakai adalah konfigurasi TERAKHIR DARI
 *      SERVER — bukan bawaan aplikasi. Dulu bawaannya '4R' margin 0, jadi label
 *      keluar tanpa kotak cetak tanpa pesan apa pun.
 *
 * Yang TIDAK bisa dibuktikan dari sini: nilai yang tersimpan di mesin kiosk
 * saat ini. Itu harus dibaca dari Local Storage di mesin itu.
 */

const PB = '/Users/nadine/Unismiles/unismiles-photobooth';
const baca = (p: string) => readFileSync(`${PB}/${p}`, 'utf8');

test('aplikasi desktop memuat UI produksi atau UI ter-bundel yang cocok', () => {
  const main = baca('electron/main.cjs');
  assert.match(main, /const URL_UI = process\.env\.PHOTOBOOTH_URL \|\| 'https:\/\/photobooth\.uniinside\.net'/,
    'UI harus dimuat dari produksi, supaya perbaikan di server langsung berlaku di aplikasi desktop');
  // Desain sekarang: UI hasil build DIBUNDEL ke installer dan dimuat lewat
  // skema app-photobooth://, dengan hosting sebagai fallback. Yang penting:
  // jendela memuat hasil urlUiEfektif(), bukan alamat yang dikeras.
  assert.match(main, /function urlUiEfektif\(/,
    'sumber UI harus lewat urlUiEfektif() (bundel dulu, hosting cadangan)');
  assert.match(main, /jendela\.loadURL\(tujuanUi\)/,
    'jendela harus benar-benar memuat UI efektif itu');
  // UI ter-bundel memang IKUT dipaketkan sekarang; konsistensi shell+UI jadi
  // tugas installer, bukan tugas hosting.
  const builder = baca('electron-builder.config.cjs');
  assert.match(builder, /'dist\/\*\*'/,
    'dist HARUS ikut dibundel: satu installer = shell + UI yang cocok');
});

test('build produksi menembak backend, bukan localhost', () => {
  const env = baca('.env.production');
  assert.match(env, /^VITE_API_BASE_URL=https:\/\/api\.uniinside\.net\/api\/v1\s*$/m,
    'build produksi harus menembak backend produksi');
  // Bridge lokal harus MATI: kalau hidup, photobooth membaca kalibrasi dari
  // agent di mesin kiosk, dan pengaturan Admin bisa tidak berpengaruh.
  assert.match(env, /^VITE_ENABLE_LOCAL_KIOSK_BRIDGE=false\s*$/m,
    'bridge lokal harus mati supaya konfigurasi dari server yang dipakai');
});

test('alamat backend yang dipakai berasal dari env, localhost hanya cadangan', () => {
  const api = baca('services/apiService.ts');
  // Urutan prioritas: env build DULU, baru setelan tersimpan.
  assert.match(api, /import\.meta\.env\.VITE_API_BASE_URL \|\| parsed\.backendUrl/,
    'env build harus menang atas setelan tersimpan, supaya aplikasi tidak bisa diarahkan ke backend lain lewat Local Storage');
  // Cadangan hanya untuk pengembangan.
  assert.match(api, /const getDefaultApiBaseUrl = \(\): string => 'http:\/\/localhost:8000'/,
    'cadangan localhost hanya untuk dev');
  // Dan alamat yang jelas salah harus jatuh ke cadangan, bukan diterima.
  assert.match(api, /example\\\.com|:5001|placeholder/i,
    'alamat contoh harus ditolak, bukan dipakai');
});

test('pengambilan gagal memakai salinan TERAKHIR DARI SERVER, bukan bawaan aplikasi', () => {
  const api = baca('services/apiService.ts');
  // Ada penyimpanan khusus untuk konfigurasi yang berasal dari server.
  assert.match(api, /pb_printing_config_server/, 'harus ada simpanan konfigurasi dari server');
  assert.match(api, /const salinan = bacaKonfigurasiServerTerakhir\(\);[\s\S]{0,80}return salinan \?/,
    'saat gagal mengambil, yang dikembalikan harus salinan server — bukan null yang membuat pemanggil kembali ke bawaan');
  // Salinan harus DITANDAI berasal dari server, supaya tidak ada yang mengira
  // itu setelan lokal yang bisa menimpa server.
  assert.match(api, /_sumber: 'server'/, 'salinan harus ditandai berasal dari server');
  // Dan tidak ada pembacaan config dari berkas yang bisa diedit tangan.
  assert.ok(!/readFileSync|fs\.readFile/.test(api.split('fetchPrintingConfig')[0]),
    'konfigurasi cetak tidak boleh dibaca dari berkas lokal');
});

test('setiap pengambilan berhasil menimpa salinan, dan tidak ada jalur yang melewatinya', () => {
  const booth = baca('components/PhotoBooth.tsx');
  // Disimpan tepat setelah berhasil dibaca.
  const iAmbil = booth.indexOf('const cfg = await fetchPrintingConfig();');
  const iSimpan = booth.indexOf('simpanKonfigurasiServer(cfg');
  assert.ok(iAmbil > 0 && iSimpan > iAmbil,
    'konfigurasi yang berhasil dibaca harus langsung disimpan sebagai salinan server');
  // Kalau tidak ada sama sekali, itu harus TERLIHAT (peringatan), bukan diam.
  assert.match(booth, /belum pernah terbaca/,
    'kiosk yang belum pernah membaca konfigurasi server harus memberi peringatan, bukan mencetak diam-diam dengan bawaan');
});

test('nilai dari salinan server tetap diterapkan, termasuk margin dan ketajaman', () => {
  const booth = baca('components/PhotoBooth.tsx');
  // Bidang yang menentukan hasil di kertas harus benar-benar dipakai dari cfg.
  for (const field of [
    'paper_size', 'print_margin_top_px', 'print_margin_right_px',
    'print_margin_left_px', 'print_margin_bottom_px', 'print_sharpen',
    'grayscale_algorithm', 'photo_fit_mode', 'thermal_density',
  ]) {
    assert.ok(booth.includes(`cfg.${field}`),
      `${field} dari server harus dipakai; kalau tidak, nilai Admin tersimpan tanpa efek di kertas`);
  }
});

test('base URL tidak bisa diarahkan ke backend lain lewat setelan tersimpan sendirian', () => {
  const api = baca('services/apiService.ts');
  const getConfig = api.slice(api.indexOf('export const getApiConfig'), api.indexOf('readBooleanEnv'));
  // apiKey dan kioskId boleh punya cadangan dari setelan tersimpan, TAPI base
  // URL tidak: kalau ia bisa, satu nilai di Local Storage cukup untuk
  // mengarahkan kiosk ke server lain tanpa menyentuh build.
  assert.ok(!/baseUrl:\s*parsed\.backendUrl/.test(getConfig),
    'base URL tidak boleh diambil langsung dari setelan tersimpan tanpa env build lebih dulu');
  assert.match(getConfig, /normalizeApiBaseUrl\(import\.meta\.env\.VITE_API_BASE_URL/,
    'base URL harus lewat env build lebih dulu');
});
