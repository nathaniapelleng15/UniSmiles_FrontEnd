import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ditherToBlackAndWhite, grayscaleValue, sharpenGray, boxBlurGray,
  GRAYSCALE_OPTIONS, DEFAULT_GRAYSCALE_ALGORITHM, isGrayscaleAlgorithm,
  type GrayscaleAlgorithm,
} from './oneBitImage.ts';

/**
 * "Tidak blur" harus diukur, bukan diklaim.
 *
 * Yang membuat hasil cetak terlihat blur bukan dpi (kanvas selalu 300 dpi),
 * melainkan hilangnya perbedaan terang sebelum dither 1-bit. Jadi yang diukur
 * di sini adalah seberapa banyak DETAIL YANG TERSISA pada bitmap hasil dither —
 * titik-titik dirata-ratakan 3×3 lebih dulu (meniru cara mata dan kepala cetak
 * melebur titik), lalu diukur simpangan bakunya.
 *
 * Dua hal yang TIDAK bisa dipakai sebagai ukuran, dan sudah dicoba:
 *   - "beda antar piksel bersebelahan" pada bitmap 1-bit: pada dither ~50%
 *     hampir semua pasangan sudah berbeda, jadi angkanya mentok dan penajaman
 *     tampak tidak berpengaruh walau sebenarnya berpengaruh.
 *   - gambar blok bertepi keras: tepinya sudah jenuh di 0/255, jadi tidak ada
 *     yang bisa dinaikkan. Foto sungguhan punya gradien dan detail halus —
 *     di situlah penajaman bekerja.
 */

/** Foto uji: papan garis halus di atas gradien + noise sensor. */
function papanGaris(w: number, h: number, jarak: number, kontras: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  let s = 5;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const garis = (x % jarak) < 2 ? -kontras : 0;
      const v = Math.max(0, Math.min(255, Math.round(150 + (y / h) * 30 + garis + (rnd() - 0.5) * 2)));
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
  }
  return d;
}

/** Foto uji BERWARNA: di sinilah algoritma abu-abu berbeda satu sama lain.
 *
 *  Papan garis ini sengaja memakai warna-warna yang berbobot sangat berbeda
 *  (merah tua, hijau, biru) — pada gambar abu-abu semua algoritma memang
 *  menghasilkan hal yang sama, dan itu memang benar, bukan bug.
 */
function papanWarna(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const kolom = Math.floor(x / 30) % 3;
      const dasar = [ [190, 45, 45], [45, 170, 60], [50, 70, 200] ][kolom];
      const garis = (x % 6) < 2 ? -18 : 0;
      const v = (y / h) * 20 - 10;
      d[i] = Math.max(0, Math.min(255, dasar[0] + garis + v));
      d[i + 1] = Math.max(0, Math.min(255, dasar[1] + garis + v));
      d[i + 2] = Math.max(0, Math.min(255, dasar[2] + garis + v));
      d[i + 3] = 255;
    }
  }
  return d;
}

/** Banyak detail yang tersisa setelah titik-titik dither menyatu. */
export function detailTersisa(data: Uint8ClampedArray, w: number, h: number): number {
  const abu = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) abu[p] = 255 - data[p * 4];
  const halus = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let j = 0, n = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        j += abu[yy * w + xx]; n += 1;
      }
      halus[y * w + x] = j / n;
    }
  }
  let m = 0;
  for (let p = 0; p < w * h; p += 1) m += halus[p];
  m /= (w * h);
  let v = 0;
  for (let p = 0; p < w * h; p += 1) v += (halus[p] - m) ** 2;
  return Math.sqrt(v / (w * h));
}

function tinta(data: Uint8ClampedArray, w: number, h: number): number {
  let n = 0;
  for (let p = 0; p < w * h; p += 1) if (data[p * 4] === 0) n += 1;
  return n;
}

const W = 300, H = 300;

function proses(alg: GrayscaleAlgorithm, sharpen = 0) {
  const d = papanGaris(W, H, 6, 25);
  ditherToBlackAndWhite(d, W, H, 128, undefined, alg, sharpen);
  return { data: d, detail: detailTersisa(d, W, H), tinta: tinta(d, W, H) };
}

test('penajaman MENAIKKAN detail yang tersisa di bitmap — inilah "tidak blur"', () => {
  const tanpa = proses('rec601', 0);
  const sedang = proses('rec601', 1);
  const kuat = proses('rec601', 2);
  assert.ok(sedang.detail > tanpa.detail,
    `penajaman 1 harus menaikkan detail: ${sedang.detail.toFixed(2)} > ${tanpa.detail.toFixed(2)}`);
  assert.ok(kuat.detail > sedang.detail,
    `penajaman 2 harus lebih tinggi lagi: ${kuat.detail.toFixed(2)} > ${sedang.detail.toFixed(2)}`);
  // Naiknya harus nyata, bukan derau: diukur 20,21 -> 28,17 sekitar 39%.
  assert.ok(kuat.detail > tanpa.detail * 1.2,
    `kenaikan harus terlihat: ${tanpa.detail.toFixed(2)} -> ${kuat.detail.toFixed(2)}`);
  // Skala 0..2 dipakai karena 1 hanya menaikkan ~8% sedangkan 2 menaikkan ~39%.
  assert.ok((kuat.detail - sedang.detail) > (sedang.detail - tanpa.detail),
    'amount 2 harus lebih besar pengaruhnya daripada amount 1');
});

test('penajaman tidak menghabiskan tinta: gambar tetap terbaca, bukan hitam pekat', () => {
  // Risiko nyata penajaman: seluruh area jadi tinta. Dicek supaya "lebih tajam"
  // tidak dicapai dengan mengorbankan foto.
  const tanpa = proses('rec601', 0);
  for (const s of [0.5, 1, 2]) {
    const p = proses('rec601', s);
    const rasio = p.tinta / tanpa.tinta;
    assert.ok(rasio > 0.9 && rasio < 1.1,
      `penajaman ${s}: tinta harus tetap seimbang, dapat ${(rasio * 100).toFixed(0)}% dari semula`);
  }
});

test('setiap algoritma menghasilkan bitmap sendiri — bukan diam-diam sama', () => {
  const tanda = new Map<string, string>();
  for (const o of GRAYSCALE_OPTIONS) {
    // DUA gambar uji: berwarna (algoritma berbeda) dan abu-abu (harus sama).
    // Memakai satu gambar saja akan menyesatkan ke arah mana pun.
    for (const [nama, data] of [['warna', papanWarna(W, H)], ['abu', papanGaris(W, H, 6, 25)]] as [string, Uint8ClampedArray][]) {
      const salinan = Uint8ClampedArray.from(data);
      ditherToBlackAndWhite(salinan, W, H, 128, undefined, o.value, 0);
      let tintaAda = 0;
      for (let p = 0; p < W * H; p += 1) if (salinan[p * 4] === 0) tintaAda += 1;
      assert.ok(tintaAda > 0 && tintaAda < W * H, `${o.value}/${nama}: harus ada campuran hitam dan putih`);
      let sig = '';
      for (let k = 1; k <= 80; k += 1) sig += salinan[((k * 9973) % (W * H)) * 4] === 0 ? '1' : '0';
      tanda.set(`${nama}:${o.value}`, sig);
    }
  }
  // Pada gambar BERWARNA setiap algoritma harus berbeda hasilnya.
  const warna = GRAYSCALE_OPTIONS.map(o => [o.value, tanda.get(`warna:${o.value}`)] as const);
  for (const [nilai, sig] of warna) {
    const kembar = warna.find(([lain, s]) => lain !== nilai && s === sig);
    assert.strictEqual(kembar, undefined,
      `${nilai} menghasilkan bitmap identik dengan ${kembar?.[0]} pada foto berwarna — algoritmanya tidak berpengaruh`);
  }
  // Pada gambar ABU-ABU yang seragam, semua algoritma memang IDENTIK: tidak ada
  // warna yang bisa dibobot. Ini diperiksa supaya kalau suatu saat berbeda,
  // penyebabnya ketahuan (bukan dianggap prestasi).
  const abu = new Set(GRAYSCALE_OPTIONS.map(o => tanda.get(`abu:${o.value}`)));
  assert.strictEqual(abu.size, 1, 'foto abu-abu harus memberi hasil sama untuk semua algoritma');
});

test('bobot algoritma diuji sebagai angka, bukan dibaca dari dirinya sendiri', () => {
  // Nilai dihitung tangan dari definisinya. Kalau bobot di kode diubah, test ini
  // gagal — dan itu memang tujuannya, karena kesalahan bobot hanya terlihat di
  // kertas yang terbuang.
  assert.strictEqual(grayscaleValue('rec601', 255, 0, 0), 0.299 * 255);
  assert.strictEqual(grayscaleValue('rec601', 0, 255, 0), 0.587 * 255);
  assert.strictEqual(grayscaleValue('rec709', 255, 0, 0), 0.2126 * 255);
  assert.strictEqual(grayscaleValue('rec709', 0, 255, 0), 0.7152 * 255);
  assert.strictEqual(grayscaleValue('average', 30, 60, 90), 60);
  assert.strictEqual(grayscaleValue('green', 10, 20, 30), 20);
  assert.strictEqual(grayscaleValue('red', 10, 20, 30), 10);
  assert.strictEqual(grayscaleValue('blue', 10, 20, 30), 30);
  assert.strictEqual(grayscaleValue('max', 10, 20, 30), 30);
  assert.strictEqual(grayscaleValue('min', 10, 20, 30), 10);
  // Rec.709 memberi bobot lebih besar ke hijau daripada Rec.601 — itu sebabnya
  // ia bisa lebih tajam untuk foto berwarna.
  assert.ok(grayscaleValue('rec709', 0, 255, 0) > grayscaleValue('rec601', 0, 255, 0));

  // Putih tetap putih dan hitam tetap hitam di SEMUA algoritma. Kalau tidak,
  // latar label yang seharusnya kosong ikut bernoda.
  for (const o of GRAYSCALE_OPTIONS) {
    assert.ok(Math.abs(grayscaleValue(o.value, 255, 255, 255) - 255) < 0.001, `${o.value}: putih harus 255`);
    assert.ok(grayscaleValue(o.value, 0, 0, 0) < 0.001, `${o.value}: hitam harus 0`);
    for (const [r, g, b] of [[0, 255, 128], [255, 0, 0], [7, 3, 251]] as [number, number, number][]) {
      const v = grayscaleValue(o.value, r, g, b);
      assert.ok(v >= 0 && v <= 255, `${o.value}(${r},${g},${b}) = ${v} di luar 0..255`);
    }
  }
});

test('algoritma asing ditolak, dan bawaannya adalah perilaku lama', () => {
  assert.strictEqual(isGrayscaleAlgorithm('rec601'), true);
  assert.strictEqual(isGrayscaleAlgorithm('rec709'), true);
  assert.strictEqual(isGrayscaleAlgorithm('hijau'), false);
  assert.strictEqual(isGrayscaleAlgorithm(''), false);
  assert.strictEqual(isGrayscaleAlgorithm(null), false);
  assert.strictEqual(isGrayscaleAlgorithm(42), false);
  // Bawaan harus yang sudah terbukti di kertas, bukan yang paling tajam —
  // supaya menambah fitur ini TIDAK mengubah hasil cetak kiosk yang sudah pas.
  assert.strictEqual(DEFAULT_GRAYSCALE_ALGORITHM, 'rec601');
  assert.strictEqual(GRAYSCALE_OPTIONS[0].value, DEFAULT_GRAYSCALE_ALGORITHM, 'yang pertama di dropdown = bawaan');
});

test('pemanggilan tanpa argumen baru tetap berperilaku persis sama', () => {
  const a = papanGaris(80, 80, 6, 25);
  const b = papanGaris(80, 80, 6, 25);
  ditherToBlackAndWhite(a, 80, 80, 128, { x: 0, y: 0, w: 80, h: 80 });
  ditherToBlackAndWhite(b, 80, 80, 128, { x: 0, y: 0, w: 80, h: 80 }, 'rec601', 0);
  assert.deepEqual(Array.from(a), Array.from(b), 'bawaan harus identik dengan pemanggilan lama');
});

test('dither tetap hanya menyentuh bidang cetak, walau ada penajaman', () => {
  // Penajaman bekerja pada potongan di dalam kotak. Kalau batasnya bocor, tepi
  // gelap bisa masuk ke area kosong dan menodai bingkai yang sudah tercetak.
  const data = papanGaris(W, H, 6, 25);
  const box = { x: 40, y: 40, w: 120, h: 120 };
  const asli = Uint8ClampedArray.from(data);
  ditherToBlackAndWhite(data, W, H, 128, box, 'rec709', 2);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const didalam = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
      if (didalam) continue;
      const i = (y * W + x) * 4;
      assert.deepEqual([data[i], data[i + 1], data[i + 2]],
        [asli[i], asli[i + 1], asli[i + 2]], `piksel di luar kotak (${x},${y}) tidak boleh diubah`);
    }
  }
});

test('sharpenGray membiarkan noise sensor, menaikkan tepi, dan menjaga terang rata-rata', () => {
  // Ambang 2 dipilih dari pengukuran: noise ±2 tingkat tetap ~0, sedangkan
  // ambang 0 menaikkannya penuh. Tanpa ambang, langit dan dinding penuh bintik.
  let s = 3;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const bising = new Float32Array(W * H);
  for (let p = 0; p < W * H; p += 1) bising[p] = 200 + (rnd() - 0.5) * 3;
  const bisingAsli = Float32Array.from(bising);
  sharpenGray(bising, W, H, 2);
  let ubah = 0;
  for (let p = 0; p < W * H; p += 1) ubah += Math.abs(bising[p] - bisingAsli[p]);
  assert.ok(ubah / (W * H) < 0.5,
    `noise ±1,5 tingkat tidak boleh dinaikkan (rata2 perubahan ${(ubah / (W * H)).toFixed(3)})`);

  // Area rata benar-benar tidak berubah.
  const rata = new Float32Array(40 * 40).fill(180);
  const rataAsli = Float32Array.from(rata);
  sharpenGray(rata, 40, 40, 2);
  assert.deepEqual(Array.from(rata), Array.from(rataAsli), 'area rata tidak boleh berubah');

  // Tepi: kontras naik, DAN terang rata-rata hampir tetap (inti unsharp mask).
  // Kalau hanya salah satu sisi yang naik, yang terjadi bukan penajaman
  // melainkan pergeseran terang — foto jadi gelap/terang diam-diam.
  const N = 40;
  const tepi = new Float32Array(N * N);
  for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) tepi[y * N + x] = x < N / 2 ? 40 : 220;
  const rataSebelum = 130;
  const kontrasSebelum = 180;
  sharpenGray(tepi, N, N, 2);
  const nilai = Array.from(tepi);
  assert.ok(Math.max(...nilai) - Math.min(...nilai) > kontrasSebelum, 'kontras di tepi harus naik');
  const rataSetelah = nilai.reduce((a, b) => a + b, 0) / nilai.length;
  assert.ok(Math.abs(rataSetelah - rataSebelum) < 20,
    `terang rata-rata harus hampir tetap: ${rataSebelum} -> ${rataSetelah.toFixed(1)}`);
});

test('boxBlurGray: area rata tetap, tepi jadi landai, dan tepi gambar tidak diklaim gelap', () => {
  // Clamp di tepi: tanpa itu, pinggir gambar dianggap gelap dan penajaman
  // membuat garis hitam di tepi label.
  const rata = new Float32Array(60 * 60).fill(150);
  const hasil = boxBlurGray(rata, 60, 60, 2);
  for (const p of [0, 59, 59 * 60, 60 * 60 - 1]) {
    assert.ok(Math.abs(hasil[p] - 150) < 0.001, 'tepi gambar tidak boleh dianggap gelap');
  }
  // Tepi tajam jadi landai (itulah gunanya blur).
  const tepi = new Float32Array(60 * 60);
  for (let y = 0; y < 60; y += 1) for (let x = 0; x < 60; x += 1) tepi[y * 60 + x] = x < 30 ? 0 : 255;
  const halus = boxBlurGray(tepi, 60, 60, 3);
  const diTengah = halus[30 * 60 + 30];
  assert.ok(diTengah > 0 && diTengah < 255, `tepi harus jadi landai, dapat ${diTengah}`);
  // Radius 0 / array kecil: aman, tidak ada akses di luar batas.
  const kecil = new Float32Array([5, 6, 7, 8]);
  assert.deepEqual(Array.from(boxBlurGray(kecil, 2, 2, 0)), [5, 6, 7, 8]);
  boxBlurGray(new Float32Array(0), 0, 0, 2);
});
