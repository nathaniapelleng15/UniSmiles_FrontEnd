/**
 * Test halaman uji cetak Niimbot.
 *
 * Halaman ini adalah HTML statis yang memakai service cetak dari NiimBlueLib.
 * Yang diperiksa di sini: halaman tidak lagi memuat driver sendiri, ia memakai
 * service yang sama dengan photobooth, dan pengaturan dari Admin benar-benar
 * dibaca (bukan disetel di sini).
 *
 * Catatan lokasi: halaman berada di ROOT, bukan `public/`, karena ia adalah
 * entry build Vite — berkas di `public/` disalin apa adanya sehingga skrip
 * TypeScript-nya tidak akan pernah dikompilasi.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const PAGE = readFileSync(path.join(ROOT, 'niimbot-test.html'), 'utf8');
const ENTRY = readFileSync(path.join(ROOT, 'niimbot-print-service.ts'), 'utf8');
const VITE = readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');

test('halaman jadi entry build Vite, bukan berkas di public/', () => {
  // Kalau halaman dikembalikan ke public/, skrip TypeScript-nya akan disalin
  // mentah dan browser gagal memuatnya — kegagalan yang sudah pernah terjadi.
  assert.ok(!existsSync(path.join(ROOT, 'public', 'niimbot-test.html')),
    'halaman tidak boleh ada di public/ lagi');
  assert.match(VITE, /niimbot-test\.html/, 'halaman harus terdaftar sebagai entry build');
  assert.match(VITE, /niimbot:\s*path\.resolve\(__dirname, 'niimbot-test\.html'\)/,
    'entry niimbot harus eksplisit');
});

test('halaman memakai service NiimBlueLib, bukan driver sendiri', () => {
  // Driver protokol lama sudah dihapus: dua implementasi protokol berarti dua
  // sumber kebenaran yang bisa berbeda perilaku.
  assert.ok(!existsSync(path.join(ROOT, 'public', 'niimbot', 'niimbot.js')),
    'driver lama harus sudah dihapus');
  assert.ok(!existsSync(path.join(ROOT, 'public', 'niimbot', 'label-size.js')),
    'label-size.js lama harus sudah dihapus');
  assert.ok(!PAGE.includes('Niimbot.printImage'),
    'halaman tidak boleh memanggil API driver lama');
  assert.ok(!PAGE.includes('NiimbotLabelSize'),
    'halaman tidak boleh memakai label-size lama');
  assert.match(PAGE, /niimbot-print-service\.ts/, 'halaman harus memuat entry service baru');
});

test('entry service mengekspos API lewat global dan event siap', () => {
  // Halaman HTML biasa berjalan sebelum modul selesai dimuat. Tanpa penanda
  // "siap", tombol cetak bisa diklik sebelum service ada.
  assert.match(ENTRY, /window\.NiimbotPrint = api/, 'service harus tersedia sebagai global');
  assert.match(ENTRY, /niimbot-print-service-ready/, 'harus memberi tahu halaman saat siap');
  assert.match(ENTRY, /from '\.\/services\/niimbotPrinter'/,
    'entry harus memakai service yang sama dengan photobooth');
});

test('halaman menunggu service siap sebelum mengizinkan cetak', () => {
  assert.match(PAGE, /niimbot-print-service-ready/, 'halaman harus menunggu event siap');
  assert.match(PAGE, /if \(!printReady\)[\s\S]{0,120}Coba lagi|belum siap/,
    'klik sebelum siap harus memberi pesan jelas, bukan gagal diam-diam');
  // Cadangan bila modul selesai dimuat sebelum listener terpasang.
  assert.match(PAGE, /if \(window\.NiimbotPrint\)/, 'harus ada cadangan pemeriksaan global');
});

test('pengaturan dari Admin dibaca, tidak disetel di halaman', () => {
  // Ini inti pemindahan: halaman localhost tidak lagi jadi tempat pengaturan,
  // karena nilainya tidak terbaca oleh photobooth produksi.
  assert.match(PAGE, /function applyAdminConfig/, 'halaman harus membaca pengaturan Admin');
  assert.match(PAGE, /api\/kiosk-status/, 'dibaca lewat local bridge agent');
  assert.match(PAGE, /id="density"[^>]*readonly/, 'kepekatan tidak boleh disetel di sini');
  assert.match(PAGE, /id="offset_y"[^>]*readonly/, 'geser vertikal tidak boleh disetel di sini');
  assert.ok(!PAGE.includes('id="presetLabel"'), 'tombol setel ukuran harus hilang');
  assert.match(PAGE, /Dari Pengaturan Admin/, 'asal nilai harus ditampilkan terus terang');
});

test('agent yang mati dikatakan, bukan didiamkan', () => {
  // Kalau halaman diam saja, orang bisa menyimpulkan setelan produksi sudah
  // netral padahal agent tidak jalan sama sekali.
  assert.match(PAGE, /kiosk-agent[\s\S]{0,60}tidak jalan/,
    'halaman harus mengatakan agent tidak jalan');
  assert.match(PAGE, /Pengaturan Admin/, 'dan mengarahkan ke tempat yang benar');
});

test('penyesuaian dari Admin diteruskan ke service saat mencetak', () => {
  // Disimpan tetapi tidak dikirim = Admin terlihat berhasil tanpa efek.
  assert.match(PAGE, /function printAdjustments/, 'harus menyusun penyesuaian untuk service');
  assert.match(PAGE, /brightness[\s\S]{0,200}contrast[\s\S]{0,200}saturat/,
    'brightness/contrast/saturasi harus ikut dikirim');
  assert.match(PAGE, /density:\s*parseInt/, 'kepekatan harus ikut dikirim');
  assert.match(PAGE, /offsetYPx:\s*parseInt/, 'geser vertikal harus ikut dikirim');
  assert.match(PAGE, /fitMode/, 'mode penyesuaian foto harus ikut dikirim');
});

test('halaman tidak punya konstanta geometri sendiri', () => {
  // Geometri dihitung service, supaya halaman tidak bisa berbeda dari
  // photobooth. Satu sumber kebenaran.
  assert.match(PAGE, /printService\.labelSize\(/, 'halaman harus memakai perhitungan service');
  assert.ok(!/sizeFromMm\(/.test(PAGE), 'tidak boleh menghitung sendiri');
});

test('aset gambar uji tetap tersedia setelah halaman pindah', () => {
  // Halaman bergantung pada aset di public/; kalau ikut terhapus, gambar uji mati.
  assert.ok(existsSync(path.join(ROOT, 'public', 'assets')),
    'aset public harus tetap ada');
});

test('objek ukuran diteruskan dengan nama field yang diterima service', () => {
  // Bug nyata: currentSize() menyalin hasil service ke nama pendek (w_px/h_px),
  // lalu objek itu diteruskan ke printService.print() yang membaca widthPx.
  // Akibatnya canvas berlebar 0 dan browser hanya mengeluh
  // "The source width is 0." — pesan yang tidak menunjuk ke penyebabnya.
  assert.match(PAGE, /return printService\.labelSize\(w_mm, h_mm\);/,
    'currentSize harus mengembalikan objek service apa adanya, tanpa penamaan ulang');
  // Tidak boleh ada pembacaan nama pendek yang tersisa.
  assert.ok(!/\bg\.w_px\b|\.h_px\b|\brequested_px\b/.test(PAGE),
    'tidak boleh ada sisa pembacaan nama pendek');
  // Yang dikirim ke print() harus membawa widthPx/heightPx.
  assert.match(PAGE, /printService\.print\(currentImageUrl, g, /,
    'objek ukuran dari currentSize dikirim ke print()');
});

test('layar menampilkan ukuran yang benar, bukan undefined', () => {
  // Dulu log mencetak g.widthPx dari objek bernama pendek -> "undefined x undefined".
  assert.match(PAGE, /g\.widthPx \+ ' × ' \+ g\.heightPx/,
    'log ukuran harus memakai nama field yang benar');
});
