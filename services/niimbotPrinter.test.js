/**
 * Test service cetak Niimbot.
 *
 * Yang diuji di sini adalah bagian yang TIDAK butuh printer fisik: geometri
 * label, pengaturan tampilan dari Admin, dan alur print task. Bagian yang butuh
 * hardware (Bluetooth, kertas) tidak bisa diuji otomatis dan memang tidak
 * diklaim lolos di sini.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = readFileSync(path.join(here, '..', 'services', 'niimbotPrinter.ts'), 'utf8');
// Konstanta geometri dipisah ke labelGeometry.ts supaya bisa benar-benar
// dieksekusi di test tanpa dependensi library printer.
const GEOMETRY = readFileSync(path.join(here, '..', 'services', 'labelGeometry.ts'), 'utf8');

// Nilai-nilai ini juga dipakai test dari sisi lain (backend, halaman uji).
const PRINTHEAD_PX = 576;
const DPI = 300;
const px = (mm) => Math.round((mm / 25.4) * DPI);

test('lebar dikunci ke kepala cetak, memakai angka hasil pengukuran di kertas', () => {
  // NiimBlueLib menulis 567 untuk B1_PRO; pengukuran di unit yang dipakai
  // menunjukkan 576. Kalau seseorang "merapikan" angka ini agar cocok dengan
  // tabel library, tepi label akan terpotong ~0,76 mm tanpa error.
  assert.match(GEOMETRY, /export const B1_PRO_PRINTHEAD_PX = 576;/,
    'lebar kepala cetak harus 576 px (hasil pengukuran di kertas)');
  assert.ok(!/PRINTHEAD_PX = 567/.test(GEOMETRY + SERVICE),
    'jangan pakai 567 dari tabel library — itu bukan unit yang dipakai');
  // Service harus memakai konstanta itu, bukan menyalin angkanya.
  assert.match(SERVICE, /from '\.\/labelGeometry\.ts'/,
    'service harus mengimpor geometri, bukan mendefinisikan ulang');
});

test('geometri label dihitung oleh modul terpisah, bukan disalin di sini', () => {
  // Perhitungan lebar adalah penentu utama hasil cetak, jadi ia diuji dengan
  // MENJALANKAN kodenya di labelGeometry.test.ts — bukan dengan mencocokkan
  // teks di berkas ini.
  assert.match(SERVICE, /labelSize/, 'service harus memakai labelSize');
  assert.ok(!/Math\.min\(requested, printheadPx\)/.test(SERVICE),
    'perhitungan lebar tidak boleh diduplikasi di service');
});

test('pengaturan tampilan Admin dipakai, bukan diabaikan', () => {
  // Kalau nilai dari Admin hanya disimpan tanpa masuk ke filter canvas,
  // panel Admin akan terlihat berhasil tanpa mengubah hasil cetak.
  assert.match(SERVICE, /ctx\.filter = `brightness\(\$\{adj\.brightness\}%\) contrast\(\$\{adj\.contrast\}%\) saturate\(\$\{adj\.saturation\}%\)`/,
    'brightness/contrast/saturasi harus masuk ke filter canvas');
});

test('latar putih diisi TANPA filter aktif', () => {
  // Kalau filter aktif saat mengisi latar, brightness 100% pun mengubah putih
  // menjadi abu — dan pada printer 1-bit abu = hitam, jadi label jadi bertitik.
  const fillIdx = SERVICE.indexOf("ctx.fillStyle = '#ffffff'");
  const filterIdx = SERVICE.indexOf('ctx.filter =');
  assert.ok(fillIdx > 0 && filterIdx > fillIdx,
    'latar putih harus diisi lebih dulu, baru filter dipasang');
  assert.match(SERVICE, /ctx\.fillRect\(0, 0, canvas\.width, canvas\.height\);\n\n\s+\/\/ Baru gambar fotonya/,
    'pengisian latar harus selesai sebelum foto digambar');
});

test('perhitungan gambar ada di drawRect, bukan di dalam prepareCanvas', () => {
  // Perhitungannya SENGAJA dipindah ke labelGeometry.drawRect supaya bisa
  // dieksekusi di test nyata (labelGeometry.test.ts), bukan hanya dicocokkan
  // teksnya. Di sini yang diperiksa hanya bahwa prepareCanvas benar-benar
  // memakai hasilnya — bukan menghitung sendiri.
  // Kedua offset (vertikal DAN mendatar) harus diteruskan; kalau salah satu
  // hilang, kalibrasi posisi diam-diam tidak bekerja untuk sumbu itu.
  // Kedua offset, margin empat sisi, dan batas kepala cetak harus diteruskan.
  // Pola dibiarkan longgar terhadap spasi/komentar: yang penting argumennya ADA,
  // supaya menghapus salah satunya ketahuan di sini, bukan di kertas.
  const call = SERVICE.slice(SERVICE.indexOf('const r = drawRect('));
  const args = call.slice(0, call.indexOf(');'));
  for (const wajib of ['adj.offsetYPx', 'adj.offsetXPx', 'adj.marginTopPx', 'adj.marginRightPx',
    'adj.marginLeftPx', 'adj.marginBottomPx', 'B1_PRO_PRINTHEAD_PX']) {
    assert.ok(args.includes(wajib), 'drawRect harus menerima ' + wajib);
  }
  // Margin hanya bekerja kalau digambar dengan kliping; tanpa ini foto menutupi
  // seluruh kanvas dan margin tidak akan pernah terlihat.
  assert.match(SERVICE, /ctx\.rect\(r\.clipX, r\.clipY, r\.clipW, r\.clipH\)/,
    'margin harus diterapkan lewat kliping');
  assert.match(SERVICE, /ctx\.clip\(\)/, 'kliping harus dipanggil');
  assert.match(SERVICE, /ctx\.drawImage\(img, r\.dx, r\.dy, r\.dw, r\.dh\)/,
    'menggambar memakai hasil drawRect');
  // Offset vertikal tidak boleh dihitung ulang di sini; itu tugas drawRect.
  assert.ok(!/let dy = Math\.round/.test(SERVICE),
    'perhitungan offset harus ada di drawRect saja, supaya tidak ada dua versi');
  // Default-nya harus fit: stretch bisa membuat foto gepeng tanpa disadari.
  assert.match(SERVICE, /fitMode: 'fit',/, 'bawaan harus fit');
});

test('tiga mode penyesuaian didukung', () => {
  assert.match(SERVICE, /fitMode: 'fit' \| 'cover' \| 'stretch'/, 'tipe harus mencakup cover');
  const geo = readFileSync(new URL('./labelGeometry.ts', import.meta.url), 'utf8');
  // cover = tanpa bingkai; fit = ada bingkai. Keduanya menjaga rasio.
  assert.match(geo, /mode === 'cover'[\s\S]{0,80}Math\.max\(/, 'cover memakai skala terbesar');
  assert.match(geo, /Math\.min\(/, 'fit memakai skala terkecil');
});

test('alur cetak mengikuti contoh resmi NiimBlueLib', () => {
  // Urutan ini dari contoh resmi library (example/main.js). Salah urutan
  // membuat printer tidak mengeluarkan label atau menggantung.
  const order = ['printInit', 'printPage', 'waitForPageFinished', 'waitForFinished'];
  let last = -1;
  for (const step of order) {
    const idx = SERVICE.indexOf(`task.${step}`);
    assert.ok(idx > last, `${step} harus dipanggil setelah langkah sebelumnya`);
    last = idx;
  }
  assert.match(SERVICE, /await task\.printEnd\(\)/, 'printEnd wajib: itu yang mengeluarkan kertas');
  assert.match(SERVICE, /finally \{[\s\S]{0,200}printEnd/,
    'printEnd harus di finally, supaya kertas tetap keluar walau ada error');
});

test('memakai API library, bukan protokol sendiri', () => {
  // Inti permintaan: jangan menerapkan ulang protokol NIIMBOT.
  assert.match(SERVICE, /from '@mmote\/niimbluelib'/, 'harus memakai NiimBlueLib');
  assert.match(SERVICE, /instantiateClient/, 'koneksi lewat factory library');
  assert.match(SERVICE, /ImageEncoder\.encodeCanvas/, 'encoding gambar lewat library');
  assert.match(SERVICE, /newPrintTask/, 'print task dari library');
  assert.match(SERVICE, /getPrintTaskType\(\)/, 'versi task dideteksi library, bukan ditulis tangan');
  assert.match(SERVICE, /getModelMetadata\(\)/, 'metadata model dari library');
  // Tidak ada implementasi paket/protokol sendiri.
  assert.ok(!/0x[A-Fa-f0-9]{2}\s*,\s*0x/.test(SERVICE), 'tidak boleh ada paket biner buatan sendiri');
});

test('Web Bluetooth diperiksa dari objek global, tanpa menambah dependensi tipe', () => {
  assert.match(SERVICE, /navigator as unknown as \{ bluetooth\?: unknown \}/,
    'pemeriksaan dukungan tidak boleh mengandalkan tipe DOM yang tidak ada');
});

test('kegagalan sambungan tidak menyisakan klien yang menggantung', () => {
  // Klien lama memegang GATT yang sudah mati. Kalau tidak dilepas, sambungan
  // berikutnya gagal dengan pesan yang membingungkan.
  assert.match(SERVICE, /if \(this\.client\) \{[\s\S]{0,120}await this\.client\.disconnect\(\)/,
    'klien lama harus diputus sebelum menyambung ulang');
  assert.match(SERVICE, /throw new Error\('Sambungan printer terputus\. Sambungkan ulang\.'\)/,
    'pesan harus memberi tahu pengguna apa yang harus dilakukan');
});

test('heartbeat dimatikan saat mencetak dan dinyalakan lagi', () => {
  // Paket heartbeat bisa mengganggu aliran data gambar; contoh resmi mematikannya.
  assert.match(SERVICE, /stopHeartbeat\(\)/, 'heartbeat harus dimatikan saat mencetak');
  assert.match(SERVICE, /startHeartbeat\(\)/, 'dan dinyalakan lagi setelah selesai');
});

test('gambar dari server lain dimuat dengan CORS', () => {
  // Tanpa ini canvas tercemar dan encodeCanvas gagal.
  assert.match(SERVICE, /img\.crossOrigin = 'anonymous'/, 'gambar non-data-URL butuh crossOrigin');
  assert.match(SERVICE, /src\.startsWith\('data:'\)/, 'data-URL tidak perlu crossOrigin');
});

test('dependensi tercatat di package.json', () => {
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies?.['@mmote/niimbluelib'],
    'NiimBlueLib harus jadi dependensi, bukan disalin ke repo');
  assert.match(pkg.dependencies['@mmote/niimbluelib'], /^\^?0\.4/,
    'versi 0.4x dipakai karena API print task stabil di sana');
});

test('gambar diubah ke hitam-putih murni sebelum dikirim ke printer', () => {
  // Tanpa langkah ini SELURUH label tercetak hitam pekat: encoder NiimBlueLib
  // (`image_encoder.js` baris 73) memperlakukan setiap piksel yang bukan putih
  // murni sebagai tinta penuh, dan foto tidak punya piksel yang persis 255.
  assert.match(SERVICE, /ditherToBlackAndWhite/,
    'harus mengubah gambar ke hitam-putih murni sebelum encoding');
  assert.match(SERVICE, /ctx\.getImageData\(/,
    'piksel harus dibaca dari kanvas');
  assert.match(SERVICE, /ctx\.putImageData\(/,
    'hasilnya harus ditulis kembali sebelum encodeCanvas');
  assert.match(SERVICE, /ImageEncoder\.encodeCanvas\(canvas/,
    'yang dikodekan adalah kanvas setelah diubah');
});

test('dithering dilakukan SETELAH filter Admin', () => {
  // Kalau sebelum filter, filter mengembalikan nilai antara dan merusak hasil
  // hitam-putihnya — pengaturan terang/kontras Admin jadi tidak berpengaruh.
  // Catatan: yang dicari adalah PEMANGGILAN (dengan tanda kurung), bukan baris
  // `import` — mencari tanpa kurung membuat import di kepala berkas terpilih dan
  // urutannya jadi selalu "sebelum".
  const iFilter = SERVICE.indexOf('ctx.filter =');
  const iDither = SERVICE.indexOf('ditherToBlackAndWhite(\n');
  assert.ok(iFilter > 0, 'filter Admin harus ada');
  assert.ok(iDither > 0, 'pemanggilan dithering harus ada');
  assert.ok(iFilter < iDither,
    'filter Admin harus diterapkan lebih dulu baru diubah ke hitam-putih');
});

test('dithering dipakai lewat satu fungsi teruji, bukan ditulis ulang', () => {
  // Perhitungannya di services/oneBitImage.ts supaya bisa DIEKSEKUSI di test:
  // kesalahan di sini hanya terlihat di kertas.
  assert.match(SERVICE, /import \{[\s\S]{0,200}?ditherToBlackAndWhite[\s\S]{0,200}?\} from '\.\/oneBitImage\.ts'/,
    'harus mengimpor dari modul teruji, bukan menyalin perhitungannya');
  assert.strictEqual((SERVICE.match(/ditherToBlackAndWhite\(/g) || []).length, 1,
    'satu tempat saja yang mengubah gambar');
});

test('pilihan algoritma abu-abu dan penajaman diteruskan ke perhitungan, bukan diabaikan', () => {
  // Ini pernah jadi kesalahan nyata di panel Admin: nilai diteruskan ke UI tapi
  // diabaikan di jalur cetak, jadi yang terlihat tidak sama dengan yang keluar.
  assert.match(SERVICE, /adj\.grayscale \|\| DEFAULT_GRAYSCALE_ALGORITHM/,
    'algoritma dari Admin harus dipakai, dengan bawaan yang aman');
  assert.match(SERVICE, /Number\(adj\.sharpen\)/,
    'penajaman dari Admin harus dibaca');
  // Dibatasi 0..100 lalu diubah ke pecahan 0..1 — nilai di luar itu akan
  // membuat gambar rusak (bukan menajam).
  assert.match(SERVICE, /Math\.max\(0, Math\.min\(100, Number\(adj\.sharpen\) \|\| 0\)\)/,
    'penajaman harus dijepit ke 0..100 sebelum dipakai');
});

test('ukuran label rusak ditolak dengan pesan yang menyebut sebabnya', () => {
  // Tanpa ini, ukuran rusak berlanjut sampai ke getImageData dan berhenti dengan
  // "The source width is 0." — pesan yang tidak menunjuk ke mana pun.
  assert.match(SERVICE, /Ukuran label tidak sah/,
    'harus ada pemeriksaan ukuran sebelum membuat kanvas');
  assert.match(SERVICE, /const widthPx = Number\(size\?\.widthPx\)/,
    'lebar harus divalidasi dari field yang benar');
  assert.match(SERVICE, /canvas\.width = widthPx/,
    'kanvas memakai lebar yang sudah divalidasi');
  // Gambar tanpa ukuran juga ditolak, karena seluruh kanvas akan jadi tinta.
  assert.match(SERVICE, /naturalWidth/,
    'gambar tanpa ukuran harus ditolak sebelum digambar');
});

test('impor internal memakai ekstensi .ts', () => {
  // Bukan gaya penulisan: tanpa ekstensi, Node TIDAK bisa memuat berkas ini
  // langsung untuk diuji atau dijalankan, dan `prepareCanvas` jadi tidak pernah
  // bisa dibuktikan di luar browser. Vite menerima keduanya, jadi menambah
  // ekstensi tidak merugikan build.
  assert.match(SERVICE, /from '\.\/labelGeometry\.ts'/,
    'labelGeometry harus diimpor dengan ekstensi');
  assert.match(SERVICE, /from '\.\/oneBitImage\.ts'/,
    'oneBitImage harus diimpor dengan ekstensi');
  assert.ok(!/from '\.\/labelGeometry'\s/.test(SERVICE),
    'tidak boleh ada impor tanpa ekstensi');
});

test('batas waktu kirim halaman cukup untuk satu halaman penuh', () => {
  // Diukur: satu halaman 576x714 px = 714 paket / ~59 KB. Pada jeda bawaan
  // library 10 ms itu 7,1 detik; bawaan pageTimeoutMs cuma 10 detik, sehingga
  // halaman habis waktu di tengah dan label keluar tidak penuh.
  assert.match(SERVICE, /pageTimeoutMs: 60_000/,
    'batas waktu kirim harus jauh di atas perkiraan 7 detik');
  assert.ok(!/pageTimeoutMs: (\d|1[0-9])_?\d{3}\b/.test(SERVICE),
    'tidak boleh memakai batas waktu bawaan 10 detik');
});

test('jeda paket TIDAK dinolkan', () => {
  // Menolkan jeda paket membuat BLE menerima potongan paket yang tidak lengkap:
  // konsol menampilkan "Dropping invalid buffer 00 00 00 00" dan label keluar
  // hanya sebagian. Jeda bawaan library adalah bagian dari protokol.
  //
  // Komentar dibuang dulu: kode ini MENJELASKAN kenapa jeda tidak boleh nol,
  // jadi menyebut namanya di komentar adalah hal yang benar dan tidak boleh
  // ikut terhitung sebagai pelanggaran.
  const kode = SERVICE.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/setPacketInterval/.test(kode),
    'jangan menyentuh jeda paket: biarkan bawaan library');
});

test('kanvas memberi tahu browser bahwa pikselnya akan dibaca', () => {
  // Tanpa willReadFrequently, browser memindahkan kanvas GPU<->CPU dan
  // memperingatkan di konsol pada setiap encodeCanvas.
  assert.match(SERVICE, /getContext\('2d', \{ willReadFrequently: true \}\)/,
    'kanvas yang pikselnya dibaca harus memakai willReadFrequently');
});
