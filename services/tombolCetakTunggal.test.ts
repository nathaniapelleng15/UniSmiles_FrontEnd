import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Hanya SATU tombol cetak yang boleh tampil, supaya pembeli tidak menebak.
 *
 * Tapi "hapus saja tombol Print" punya jebakan yang tidak terlihat dari UI:
 * kalau tombol itu dihapus dari kode, kiosk di perangkat yang TIDAK punya
 * Bluetooth (Web Bluetooth mati, atau aplikasi desktop tanpa izin) tidak punya
 * jalan mencetak sama sekali — dan itu baru ketahuan saat pembeli sudah berdiri
 * di depan mesin. Jadi:
 *
 *   - tombol Print harus muncul HANYA saat cetak Bluetooth tidak tersedia;
 *   - kodenya tetap ada;
 *   - kalau Bluetooth tersedia, tepat satu tombol cetak yang dirender.
 */

const BOOTH = '/Users/nadine/Unismiles/unismiles-photobooth/components/PhotoBooth.tsx';
const booth = readFileSync(BOOTH, 'utf8');

/** Bagian JSX yang mengurus tombol cetak. */
function bagianTombolCetak(): string {
  const mulai = booth.indexOf("selectedPackage === 'print' && tombol.print");
  assert.ok(mulai > 0, 'blok tombol cetak harus ditemukan');
  // Sampai tombol email (blok berikutnya), supaya batasnya jelas.
  const akhir = booth.indexOf('{tombol.email && (', mulai);
  assert.ok(akhir > mulai, 'batas blok tombol cetak harus ditemukan');
  return booth.slice(mulai, akhir);
}

test('tombol Print HANYA muncul saat cetak Bluetooth tidak tersedia', () => {
  const blok = bagianTombolCetak();
  // Syaratnya harus kebalikan dari ketersediaan Bluetooth — bukan sebaliknya,
  // dan bukan tanpa syarat.
  assert.match(blok, /\{!isBluetoothPrintAvailable\(\) && \(/,
    'tombol Print harus dibungkus !isBluetoothPrintAvailable()');
  // Dan tombol Bluetooth harus disyaratkan sebaliknya. Kalau keduanya sama-sama
  // tanpa syarat, dua tombol cetak tampil bersamaan lagi.
  assert.match(blok, /\{isBluetoothPrintAvailable\(\) && \(/,
    'tombol Bluetooth harus dibatasi ketersediaannya');
});

test('yang tampil hanya satu: tidak mungkin dua tombol cetak bersamaan', () => {
  const blok = bagianTombolCetak();
  // Kedua syarat harus saling meniadakan secara harfiah.
  const tanpaBluetooth = blok.includes('!isBluetoothPrintAvailable() && (');
  const denganBluetooth = blok.includes('isBluetoothPrintAvailable() && (');
  assert.ok(tanpaBluetooth && denganBluetooth,
    'kedua syarat harus ada, dan saling meniadakan');
  // id tombolnya juga harus di dalam blok itu, supaya jelas tidak ada duplikat
  // di tempat lain.
  assert.strictEqual((booth.match(/id="btn-print"/g) || []).length, 1, 'btn-print hanya boleh ada satu');
  assert.strictEqual((booth.match(/id="btn-bluetooth-print"/g) || []).length, 1, 'btn-bluetooth-print hanya boleh ada satu');
});

test('tombol jaring pengaman TIDAK dihapus — masih bisa dicapai', () => {
  const blok = bagianTombolCetak();
  // Handler dan id-nya harus masih di dalam blok tombol cetak.
  assert.ok(blok.includes('onClick={handlePrint}'), 'handlePrint harus masih dipakai di blok ini');
  assert.ok(blok.includes('id="btn-print"'), 'btn-print harus masih ada');
  assert.ok(blok.includes('handleManualPrint'), 'jalur cetak manual harus masih ada');
  // Handler-nya sendiri harus masih terdefinisi, bukan hanya dirujuk.
  assert.match(booth, /const handlePrint = \(\) => \{/, 'handlePrint harus masih terdefinisi');
  assert.match(booth, /const handleAutoPrint = async/, 'handleAutoPrint harus masih terdefinisi');
});

test('urutan: Bluetooth diperiksa lebih dulu, Print hanya cadangan', () => {
  const blok = bagianTombolCetak();
  const iPengesanan = blok.indexOf('{!isBluetoothPrintAvailable() && (');
  const iUtama = blok.indexOf('{isBluetoothPrintAvailable() && (');
  assert.ok(iPengesanan >= 0 && iUtama > iPengesanan,
    'jaring pengaman harus ditulis lebih dulu, tombol utama sesudahnya');
});

test('setelan show_print_button masih mengendalikan seluruh blok cetak', () => {
  // Mematikan tombol cetak di Admin harus tetap menyembunyikan KEDUANYA — kalau
  // tidak, setelannya jadi tidak berarti.
  const blok = bagianTombolCetak();
  assert.ok(blok.startsWith("selectedPackage === 'print' && tombol.print"),
    'seluruh blok cetak harus bergantung pada setelan tombol.print');
});
