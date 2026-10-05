import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  LABEL_DPI, B1_PRO_PRINTHEAD_PX, labelSize, mmToPx, labelFrameBox, printBox, drawRect,
} from './labelGeometry.ts';

/**
 * 300 dpi bukan preferensi, itu syarat kalibrasi.
 *
 * Semua angka di label ditulis sebagai MILIMETER lalu diterjemahkan ke piksel.
 * Kalau skalanya bukan tepat 300 dpi, "margin 5,93 mm" tidak lagi 5,93 mm di
 * kertas — seluruh kalibrasi meleset sekaligus, dan tidak ada pesan error yang
 * memberi tahu. Karena itu dpi di sini diuji sebagai ANGKA, bukan disamarkan
 * dalam perhitungan pinggiran.
 */

test('konstanta dpi jalur cetak tepat 300, dan kepala cetak tetap 576', () => {
  assert.strictEqual(LABEL_DPI, 300, 'LABEL_DPI harus 300 — angka lain membatalkan kalibrasi mm');
  assert.strictEqual(B1_PRO_PRINTHEAD_PX, 576, 'kepala cetak dari pengukuran di kertas, bukan tabel library');
});

test('kanvas = ukuran kertas pada 300 dpi, tepat 1 px = 1/300 inci', () => {
  const s = labelSize(54, 67);
  assert.strictEqual(s.widthPx, 638, '54 mm = 638 px hanya kalau 300 dpi');
  assert.strictEqual(s.heightPx, 791, '67 mm = 791 px hanya kalau 300 dpi');
  // Diperiksa terhadap definisi inci, bukan terhadap hasil pembagian yang sama.
  assert.strictEqual(mmToPx(25.4), LABEL_DPI, '25,4 mm = 1 inci = 300 px');
  assert.strictEqual(s.widthPx, Math.round((54 / 25.4) * 300));

  // Dan skalanya harus 300 dpi di KEDUA sumbu. Diperiksa dengan toleransi
  // setengah piksel: px/mm mentah untuk 54 mm dan 67 mm memang berbeda sedikit
  // karena piksel dibulatkan ke bilangan bulat (638/54 vs 791/67), dan itu
  // bukan kesalahan. Yang TIDAK boleh terjadi adalah toleransinya membesar —
  // itu tanda kanvas dipangkas ke kepala cetak (dpi jatuh ke ~271).
  for (const [mm, px] of [[54, s.widthPx], [67, s.heightPx]] as [number, number][]) {
    const ideal = (mm / 25.4) * 300;
    assert.ok(Math.abs(px - ideal) <= 0.5, `${mm} mm: ${px} px, seharusnya ${ideal.toFixed(2)} (±0,5 px pembulatan)`);
  }
  assert.strictEqual(s.widthPx / 54 - s.heightPx / 67, s.widthPx / 54 - 791 / 67, 'tidak ada pemangkasan tersembunyi');

  // Dan dpi tidak boleh bergantung pada lebar kepala cetak.
  assert.strictEqual(labelSize(54, 67, 384).widthPx, 638, 'dpi tidak ikut berubah dengan kepala cetak');
});

test('kotak cetak tetap 46,99 x 48,01 mm — dibuktikan lewat inci, bukan lewat kode yang sama', () => {
  const box = printBox(638, 791, 70, 83, 0, 154, B1_PRO_PRINTHEAD_PX);
  assert.deepEqual(box, { x: 0, y: 70, w: 555, h: 567 });
  // 555 px pada 300 dpi = 46,99 mm. Dihitung dari definisi inci.
  assert.ok(Math.abs((box.w / 300) * 25.4 - 46.99) < 0.01, 'lebar kotak 46,99 mm');
  assert.ok(Math.abs((box.h / 300) * 25.4 - 48.01) < 0.01, 'tinggi kotak 48,01 mm');
  assert.ok(box.x + box.w <= B1_PRO_PRINTHEAD_PX, 'tepi kanan masih di dalam kepala cetak');
});

/**
 * Sumber gambar harus punya CUKUP piksel, bukan sekadar kanvasnya 300 dpi.
 *
 * Foto yang kurang piksel membuat hasilnya tetap "300 dpi" tapi hasil
 * interpolasi — kabur, dan tidak terlihat dari angka kotak mana pun. Angka
 * sumber di bawah dibaca dari kode produksi, bukan diketik ulang, supaya test
 * ini menangkap kalau layout atau angka dpi diubah.
 */
test('foto sumber punya detail >= 300 dpi di dalam kotak (tidak ada upscale)', () => {
  const store = readFileSync(new URL('./storageService.ts', import.meta.url), 'utf8');
  const slot = store.match(/if \(id === '1x1'\) \{\s*slots = \[\{ x: \d+, y: \d+, width: (\d+), height: (\d+) \}\]/);
  assert.ok(slot, 'slot layout 1x1 harus terbaca dari storageService');
  const srcW = Number(slot![1]);
  const srcH = Number(slot![2]);

  const box = printBox(638, 791, 70, 83, 0, 154, B1_PRO_PRINTHEAD_PX);
  const r = drawRect('cover', 638, 791, srcW, srcH, 0, 0, 70, 83, 0, 154, B1_PRO_PRINTHEAD_PX);

  // Piksel sumber per piksel yang dicetak: >= 1 berarti tidak ada peregangan.
  const perX = srcW / r.dw;
  const perY = srcH / r.dh;
  assert.ok(perX >= 1, `sumber ${srcW} px untuk ${r.dw} px cetak: jangan diregangkan (${perX.toFixed(3)})`);
  assert.ok(perY >= 1, `sumber ${srcH} px untuk ${r.dh} px cetak: jangan diregangkan (${perY.toFixed(3)})`);
  // Dan dpi efektifnya dinyatakan apa adanya supaya kalau turun di bawah 300,
  // angka itu terlihat — bukan tersembunyi.
  assert.ok(LABEL_DPI * perX >= 300 && LABEL_DPI * perY >= 300,
    `dpi efektif ${(LABEL_DPI * perX).toFixed(0)}/${(LABEL_DPI * perY).toFixed(0)} harus >= 300`);
});

test('preset label Polaroid memakai angka px yang sama dengan 300 dpi', () => {
  const f = labelFrameBox('nimbotpaper-polaroid')!;
  assert.deepEqual(
    { topPx: f.topPx, rightPx: f.rightPx, leftPx: f.leftPx, bottomPx: f.bottomPx },
    { topPx: mmToPx(70 / (300 / 25.4)), rightPx: mmToPx(83 / (300 / 25.4)), leftPx: 0, bottomPx: mmToPx(154 / (300 / 25.4)) },
    'margin preset harus tepat pada 300 dpi',
  );
  assert.strictEqual(f.fitMode, 'cover');
});
