/**
 * Test bahwa yang dicetak HANYA isi slot — tanpa frame, tanpa bagian di luar
 * bingkai.
 *
 * Berbeda dengan test lain di folder ini, yang diperiksa di sini adalah
 * pemanggilan menggambar yang SUNGGUHAN terjadi, bukan teks kode. Caranya:
 * konteks kanvas tiruan merekam setiap operasi, lalu hasilnya diperiksa.
 *
 * Kesalahan yang dijaga: "seluruh bagian foto ter-print" dan "frame ikut
 * ter-print". Keduanya tidak mungkin tertangkap dengan mencocokkan teks.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { paintPrintImage, paintCover } from './printImage.ts';

/** Konteks tiruan yang merekam semua operasi menggambar. */
function fakeCtx() {
  const ops = [];
  return {
    ops,
    fillStyle: '',
    fillRect(x, y, w, h) { ops.push({ op: 'fillRect', x, y, w, h, style: this.fillStyle }); },
    drawImage(_img, sx, sy, sw, sh, dx, dy, dw, dh) {
      ops.push({ op: 'drawImage', sx, sy, sw, sh, dx, dy, dw, dh });
    },
  };
}

// Slot 1x1 sebenarnya: 628x782 di kanvas layout 708x1062.
const SLOT = { width: 628, height: 782 };
const LAYOUT = { width: 708, height: 1062 };
// Foto kamera lanskap 4:3.
const FOTO = { naturalWidth: 1600, naturalHeight: 1200 };

test('foto digambar sebesar slot, bukan sebesar kanvas layout', () => {
  const ctx = fakeCtx();
  paintPrintImage(ctx, FOTO, SLOT);
  const draw = ctx.ops.find(o => o.op === 'drawImage');
  assert.ok(draw, 'foto harus digambar');
  assert.strictEqual(draw.dw, SLOT.width, 'lebar tujuan = lebar slot');
  assert.strictEqual(draw.dh, SLOT.height, 'tinggi tujuan = tinggi slot');
  // Kalau ini gagal, bagian di luar bingkai ikut tercetak.
  assert.notStrictEqual(draw.dw, LAYOUT.width, 'bukan lebar kanvas layout');
  assert.notStrictEqual(draw.dh, LAYOUT.height, 'bukan tinggi kanvas layout');
});

test('foto selalu mulai dari sudut 0,0 — tidak ada pergeseran slot', () => {
  // Position slot (x:40, y:40) sudah dipakai saat memotong; kalau ikut dipakai di
  // sini, gambar akan tergeser dan menyisakan tepi kosong.
  const ctx = fakeCtx();
  paintPrintImage(ctx, FOTO, SLOT);
  const draw = ctx.ops.find(o => o.op === 'drawImage');
  assert.strictEqual(draw.dx, 0, 'x tujuan harus 0');
  assert.strictEqual(draw.dy, 0, 'y tujuan harus 0');
});

test('tidak ada frame yang digambar sama sekali', () => {
  const ctx = fakeCtx();
  paintPrintImage(ctx, FOTO, SLOT);
  // Hanya boleh ada tepat satu fillRect (latar putih) dan satu drawImage.
  const fills = ctx.ops.filter(o => o.op === 'fillRect');
  const draws = ctx.ops.filter(o => o.op === 'drawImage');
  assert.strictEqual(fills.length, 1, 'hanya latar putih, tidak ada background frame');
  assert.strictEqual(draws.length, 1, 'hanya satu gambar: fotonya');
  // Tidak ada operasi lain — border/teks akan muncul sebagai strokeRect/fillText
  // di konteks sungguhan, dan tidak boleh ada di sini.
  assert.ok(!ctx.ops.some(o => o.op === 'strokeRect'), 'tidak boleh ada border slot');
  assert.ok(!ctx.ops.some(o => o.op === 'fillText'), 'tidak boleh ada teks frame');
  assert.strictEqual(fills[0].style, '#ffffff', 'latar harus putih, bukan warna frame');
});

test('bagian yang dipotong dihitung dari rasio foto, bukan asal penuh', () => {
  const ctx = fakeCtx();
  paintPrintImage(ctx, FOTO, SLOT);
  const d = ctx.ops.find(o => o.op === 'drawImage');
  // Foto lanskap di slot tegak: yang dipotong adalah SISI KIRI/KANAN (sw < lebar
  // asli), dan tinggi dipakai penuh.
  assert.ok(d.sw < FOTO.naturalWidth, 'lebar sumber harus dipotong');
  assert.strictEqual(d.sh, FOTO.naturalHeight, 'tinggi sumber dipakai penuh');
  // Dan pemotongan dilakukan dari tengah, bukan dari tepi.
  assert.ok(Math.abs(d.sx - (FOTO.naturalWidth - d.sw) / 2) < 1, 'dipotong dari tengah');
});

test('rasio gambar di slot sama dengan rasio slot', () => {
  // Ini yang menentukan apakah foto gepeng di kertas.
  const ctx = fakeCtx();
  paintPrintImage(ctx, { naturalWidth: 1000, naturalHeight: 1000 }, SLOT);
  const d = ctx.ops.find(o => o.op === 'drawImage');
  const rasioSlot = SLOT.width / SLOT.height;
  // Foto persegi di slot 0,803: tinggi dipakai penuh, lebar ikut menyusut.
  assert.strictEqual(d.sh, 1000, 'tinggi sumber penuh');
  assert.ok(Math.abs(d.sw / d.sh - rasioSlot) < 0.01,
    `rasio sumber yang diambil harus ${rasioSlot.toFixed(3)}, dapat ${(d.sw / d.sh).toFixed(3)}`);
});

test('paintCover tidak pernah menggepengkan', () => {
  // Untuk beberapa rasio berbeda, rasio sumber yang diambil harus selalu sama
  // dengan rasio tujuan.
  for (const [fw, fh] of [[1600, 1200], [1200, 1600], [1000, 1000], [3000, 800]]) {
    const c = fakeCtx();
    paintCover(c, { naturalWidth: fw, naturalHeight: fh }, SLOT.width, SLOT.height);
    const d = c.ops.find(o => o.op === 'drawImage');
    assert.ok(Math.abs((d.sw / d.sh) - (SLOT.width / SLOT.height)) < 0.01,
      `foto ${fw}x${fh}: rasio sumber harus sama dengan rasio slot`);
  }
});

test('ukuran nol tidak menghasilkan gambar rusak', () => {
  const c = fakeCtx();
  paintPrintImage(c, { naturalWidth: 100, naturalHeight: 0 }, { width: 628, height: 782 });
  const d = c.ops.find(o => o.op === 'drawImage');
  for (const k of ['sx', 'sy', 'sw', 'sh', 'dx', 'dy', 'dw', 'dh']) {
    assert.ok(Number.isFinite(d[k]), `${k} harus angka berhingga, dapat ${d[k]}`);
  }
});
