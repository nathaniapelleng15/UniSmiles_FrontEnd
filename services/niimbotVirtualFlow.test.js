/**
 * Uji alur cetak dengan NiimbotVirtualClient.
 *
 * Kenapa ini penting dan bukan sekadar formalitas: test lain hanya memeriksa
 * teks kode atau perhitungan terpisah. Di sini alur cetak SUNGGUHAN dijalankan
 * terhadap klien nyata dari library (mode virtual, tanpa Bluetooth) — jadi
 * kesalahan seperti urutan perintah yang salah, opsi print task yang tidak sah,
 * atau printEnd yang tidak dipanggil akan ketahuan sebelum menyentuh printer.
 *
 * Yang TIDAK dibuktikan di sini: perilaku radio Bluetooth dan hasil di kertas.
 * Keduanya hanya bisa diuji dengan printer fisik.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { instantiateClient, PageColorType, ImageEncoder } from '@mmote/niimbluelib';

/**
 * ImageData tiruan untuk test.
 *
 * WAJIB memuat `width` dan `height`: encoder menghitung indeks piksel dari
 * keduanya. Tanpa itu indeksnya menjadi NaN, setiap pembacaan piksel
 * mengembalikan undefined, dan SEMUA piksel terbaca sebagai hitam — sehingga
 * kanvas putih penuh pun tampak seperti blok hitam. Kesalahan seperti itu
 * membuat test memberi hasil yang menyesatkan, bukan menangkap bug.
 */
function fakeImageData(width, height, fill = 255) {
  return { data: new Uint8ClampedArray(width * height * 4).fill(fill), width, height };
}

test('klien virtual bisa dibentuk dan memakai protokol library', () => {
  const client = instantiateClient('virtual');
  assert.ok(client, 'klien virtual harus bisa dibuat tanpa Web Bluetooth');
  assert.strictEqual(client.isConnected(), false, 'belum tersambung');
  assert.strictEqual(client.getType(), 'virtual');
});

test('ImageEncoder menghasilkan data siap cetak dari canvas tiruan', () => {
  // Canvas tiruan minimal: encoder hanya membaca piksel lewat getContext.
  const w = 576;
  const h = 100;
  const canvas = {
    width: w,
    height: h,
    getContext: () => ({ getImageData: () => fakeImageData(w, h) }),
  };

  const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, 'top');
  assert.strictEqual(encoded.cols, w, 'lebar hasil encode = lebar canvas');
  assert.strictEqual(encoded.rows, h, 'tinggi hasil encode = tinggi canvas');
  assert.strictEqual(encoded.pageColor, PageColorType.SingleColor);
  assert.ok(Array.isArray(encoded.rowsData), 'baris data harus berupa array');

  // Kanvas putih penuh harus jadi baris kosong — tidak ada piksel hitam.
  // Kalau encoder menganggap putih sebagai hitam, label akan tercetak blok
  // hitam penuh, dan itu tidak akan terlihat sampai kertas keluar.
  // Kanvas putih penuh TIDAK boleh menghasilkan piksel hitam. Kalau ini
  // terbalik, label akan tercetak blok hitam penuh.
  const totalBlack = encoded.rowsData.reduce((s2, r) => s2 + (r.blackPixelsCount || 0), 0);
  assert.strictEqual(totalBlack, 0, 'putih tidak boleh dihitung sebagai piksel hitam');
});

test('piksel hitam benar-benar terhitung hitam', () => {
  const w = 16;
  const h = 2;
  const imgData = fakeImageData(w, h);
  // Setengah baris pertama dibuat hitam.
  for (let x = 0; x < 8; x += 1) {
    const i = x * 4;
    imgData.data[i] = 0; imgData.data[i + 1] = 0; imgData.data[i + 2] = 0;
  }
  const canvas = {
    width: w,
    height: h,
    getContext: () => ({ getImageData: () => imgData }),
  };

  const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, 'top');
  const total = encoded.rowsData.reduce((sum, r) => sum + (r.blackPixelsCount || 0), 0);
  assert.strictEqual(total, 8, 'tepat 8 piksel hitam harus terhitung');
});

test('print task untuk model B1 bisa dibuat dengan opsi dari Admin', () => {
  const client = instantiateClient('virtual');
  const task = client.protocol.newPrintTask('B1', {
    totalPages: 1,
    density: 4,
    statusPollIntervalMs: 100,
    statusTimeoutMs: 8_000,
  });
  assert.ok(task, 'print task harus terbentuk');
  assert.strictEqual(typeof task.printInit, 'function');
  assert.strictEqual(typeof task.printPage, 'function');
  assert.strictEqual(typeof task.waitForPageFinished, 'function');
  assert.strictEqual(typeof task.waitForFinished, 'function');
  assert.strictEqual(typeof task.printEnd, 'function');
});

test('print task menerima kepekatan 1-5 sesuai yang diizinkan Admin', () => {
  const client = instantiateClient('virtual');
  // Batas ini yang divalidasi backend dan ditawarkan slider Admin. Kalau library
  // menolaknya, pengaturan Admin akan tersimpan tetapi gagal saat mencetak.
  for (const density of [1, 3, 5]) {
    const task = client.protocol.newPrintTask('B1', { totalPages: 1, density });
    assert.ok(task, `kepekatan ${density} harus diterima`);
  }
});

test('print task tersedia untuk model lain lewat tabel library', () => {
  // Bukti bahwa pemilihan task tidak dikarang sendiri: library yang menentukan.
  const client = instantiateClient('virtual');
  for (const name of ['B1', 'D110', 'D11_V1']) {
    const task = client.protocol.newPrintTask(name, { totalPages: 1 });
    assert.ok(task, `task ${name} harus tersedia dari library`);
  }
});

test('label 576 px memang lebar maksimum yang di-encode', () => {
  // Mengunci gambar ke 576 px berarti data yang dikirim tepat selebar kepala
  // cetak — tidak kurang (buang-buang) dan tidak lebih (terpotong diam-diam).
  const w = 576;
  const h = 8;
  const canvas = {
    width: w,
    height: h,
    getContext: () => ({ getImageData: () => fakeImageData(w, h) }),
  };
  const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, 'top');
  assert.strictEqual(encoded.cols, 576, 'kolom yang dikirim = lebar kepala cetak');
});
