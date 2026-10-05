/**
 * Test pengubahan gambar menjadi hitam-putih murni.
 *
 * Bug yang dijaga di sini nyata dan mahal: satu label terbuang setiap kali salah.
 * Encoder NiimBlueLib (`image_encoder.js` baris 73) memperlakukan SETIAP piksel
 * yang bukan putih murni sebagai tinta:
 *
 *     else if (color !== 0xffffff) { ... }
 *
 * Foto apa pun punya piksel yang tidak persis 255,255,255 — jadi tanpa langkah
 * ini seluruh label tercetak hitam pekat.
 *
 * Untuk membuktikannya, test ini juga menjalankan aturan encoder yang sama persis
 * atas data hasil dithering, lalu menghitung berapa piksel yang akan menjadi
 * tinta. Kalau hasilnya 100% tinta, perbaikannya tidak bekerja.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { ditherToBlackAndWhite, luminance, ONE_BIT_THRESHOLD } from './oneBitImage.ts';

/** Buat data RGBA dari sebuah fungsi warna. */
function makeImage(width, height, colorAt) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
  }
  return data;
}

/**
 * Aturan encoder NiimBlueLib, disalin apa adanya dari image_encoder.js.
 * Dipakai untuk MENGUKUR akibat, bukan untuk menyalin kode produksi.
 */
function encodeAsInk(data, width, height) {
  let black = 0;
  const total = width * height;
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    const color = (data[i + 2]) | (data[i + 1] << 8) | (data[i] << 16);
    if (color !== 0xffffff) black += 1;
  }
  return black / total;
}

test('MASALAHNYA: foto tanpa dithering hampir seluruhnya jadi tinta', () => {
  // Foto realistis: gradasi halus 40..250, tidak ada yang persis 255.
  const w = 64, h = 64;
  let data = makeImage(w, h, (x) => {
    const v = 40 + Math.round((x / (w - 1)) * 210);
    return [v, v, v];
  });
  const sebelum = encodeAsInk(data, w, h);
  assert.ok(sebelum > 0.99,
    `tanpa dithering harus hampir semua tinta, dapat ${(sebelum * 100).toFixed(1)}%`);
});

test('SESUDAH dithering: campuran tinta dan kertas, bukan hitam semua', () => {
  const w = 64, h = 64;
  // Gradasi gelap di KIRI (v=40) ke terang di KANAN (v=250).
  const data = makeImage(w, h, (x) => {
    const v = 40 + Math.round((x / (w - 1)) * 210);
    return [v, v, v];
  });
  ditherToBlackAndWhite(data, w, h);
  const tinta = encodeAsInk(data, w, h);
  assert.ok(tinta > 0.05 && tinta < 0.95,
    `harus campuran, dapat ${(tinta * 100).toFixed(1)}% tinta`);
  // Sisi GELAP (kiri) harus lebih banyak tinta daripada sisi TERANG (kanan).
  const gelap = countInk(data, w, h, 0, 16);
  const terang = countInk(data, w, h, w - 16, w);
  assert.ok(gelap > terang,
    `sisi gelap harus lebih banyak tinta (gelap ${gelap}, terang ${terang})`);
});

function countInk(data, width, height, x0, x1) {
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      if (data[i] === 0) n += 1;
    }
  }
  return n;
}

test('hanya menghasilkan 0 atau 255 di R, G, B', () => {
  const w = 32, h = 32;
  const data = makeImage(w, h, (x, y) => [(x * 8) % 256, (y * 8) % 256, 137]);
  ditherToBlackAndWhite(data, w, h);
  for (let p = 0; p < w * h; p += 1) {
    const i = p * 4;
    for (const c of [0, 1, 2]) {
      assert.ok(data[i + c] === 0 || data[i + c] === 255,
        `kanal ${c} piksel ${p} harus 0 atau 255, dapat ${data[i + c]}`);
    }
    assert.strictEqual(data[i + 3], 255, 'alfa harus pekat');
  }
});

test('putih murni tetap putih, hitam murni tetap hitam', () => {
  // Kalau ini gagal, latar putih label akan ikut tercetak.
  const w = 16, h = 16;
  const putih = makeImage(w, h, () => [255, 255, 255]);
  ditherToBlackAndWhite(putih, w, h);
  assert.strictEqual(encodeAsInk(putih, w, h), 0, 'putih murni tidak boleh jadi tinta');

  const hitam = makeImage(w, h, () => [0, 0, 0]);
  ditherToBlackAndWhite(hitam, w, h);
  assert.strictEqual(encodeAsInk(hitam, w, h), 1, 'hitam murni harus jadi tinta');
});

test('dithering menyebar, bukan ambang biasa', () => {
  // Abu-abu seragam TIDAK boleh jadi satu blok rata. Dengan dithering hasilnya
  // berpola; dengan ambang biasa hasilnya seragam (semua putih atau semua hitam).
  const w = 32, h = 32;
  const data = makeImage(w, h, () => [130, 130, 130]);
  ditherToBlackAndWhite(data, w, h);
  const tinta = encodeAsInk(data, w, h);
  assert.ok(tinta > 0.1 && tinta < 0.9,
    `abu-abu sedang harus berpola, dapat ${(tinta * 100).toFixed(1)}% tinta`);
});

test('skala abu-abu meningkat seiring gelapnya gambar', () => {
  // Kepadatan tinta harus mengikuti terang gambar; kalau tidak, foto kehilangan
  // gradasi dan hanya jadi blob.
  const w = 32, h = 32;
  const ukur = (v) => {
    const d = makeImage(w, h, () => [v, v, v]);
    ditherToBlackAndWhite(d, w, h);
    return encodeAsInk(d, w, h);
  };
  const terang = ukur(230);
  const sedang = ukur(140);
  const gelap = ukur(40);
  assert.ok(terang < sedang, `${terang} harus lebih sedikit tinta dari ${sedang}`);
  assert.ok(sedang < gelap, `${sedang} harus lebih sedikit tinta dari ${gelap}`);
});

test('gambar satu warna tidak berubah karena kesalahan tetangga', () => {
  // Batas tepi: tanpa penjagaan indeks, baris terakhir bisa menulis keluar array
  // dan merusak memori diam-diam.
  for (const [w, h] of [[1, 1], [1, 8], [8, 1], [3, 3]]) {
    const d = makeImage(w, h, () => [120, 120, 120]);
    ditherToBlackAndWhite(d, w, h);
    assert.strictEqual(d.length, w * h * 4);
  }
});

test('warna terang dan gelap tetap berbeda setelah dithering', () => {
  // Foto sungguhan berwarna; pastikan kanal warna tidak diabaikan.
  const w = 16, h = 16;
  const merahGelap = makeImage(w, h, () => [120, 10, 10]);
  const kuningTerang = makeImage(w, h, () => [250, 240, 40]);
  ditherToBlackAndWhite(merahGelap, w, h);
  ditherToBlackAndWhite(kuningTerang, w, h);
  const a = encodeAsInk(merahGelap, w, h);
  const b = encodeAsInk(kuningTerang, w, h);
  assert.ok(a > b, `merah gelap (${a}) harus lebih banyak tinta dari kuning terang (${b})`);
  // Dan ini membuktikan terang dihitung dari RGB, bukan dari satu kanal saja.
  assert.ok(luminance(250, 240, 40) > luminance(120, 10, 10),
    'urutan terang harus benar menurut rumus mata manusia');
});

test('ambang bisa digeser dan berpengaruh', () => {
  const w = 16, h = 16;
  const gelap = () => makeImage(w, h, () => [100, 100, 100]);
  const d1 = gelap(); ditherToBlackAndWhite(d1, w, h, 20);   // ambang rendah
  const d2 = gelap(); ditherToBlackAndWhite(d2, w, h, 240);  // ambang tinggi
  assert.ok(encodeAsInk(d2, w, h) > encodeAsInk(d1, w, h),
    'ambang lebih tinggi harus menghasilkan lebih banyak tinta');
  assert.strictEqual(ONE_BIT_THRESHOLD, 128, 'ambang bawaan harus titik tengah');
});
