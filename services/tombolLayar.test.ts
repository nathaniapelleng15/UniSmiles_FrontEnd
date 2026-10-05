import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Ketiga tombol layar akhir (Cetak, Send Email, New Photo) harus bisa
 * dimatikan dari Admin TANPA kodenya dihapus.
 *
 * Itu dua hal berbeda dan keduanya harus dibuktikan:
 *   1. Tombolnya benar-benar disembunyikan saat dimatikan.
 *   2. Kode tombolnya MASIH ADA — handler, id, dan teksnya utuh — supaya
 *      menyalakannya kembali tidak butuh menulis ulang fiturnya.
 *
 * Plus satu hal yang paling mudah salah: nilainya boolean, dan `Boolean('0')`
 * bernilai TRUE. Kalau itu terjadi, tombol yang dimatikan operator tetap muncul
 * dan setelannya jadi tidak berarti.
 */

const BOOTH = '/Users/nadine/Unismiles/unismiles-photobooth/components/PhotoBooth.tsx';
const booth = readFileSync(BOOTH, 'utf8');

test('kode ketiga tombol MASIH ADA — tidak ada yang dihapus', () => {
  // Handler-nya. handlePrint tetap ada karena tombolnya dipakai sebagai jaring
  // pengaman di perangkat tanpa Bluetooth — bukan dihapus.
  assert.ok(booth.includes('onClick={handlePrint}'), 'handler handlePrint harus masih ada');
  assert.ok(booth.includes('handleBluetoothPrint'), 'jalur cetak Bluetooth harus masih ada');
  assert.ok(booth.includes('handleManualPrint'), 'jalur cetak manual harus masih ada');
  assert.ok(booth.includes('onClick={handleRetake}'), 'handler handleRetake harus masih ada');
  // id dan teksnya.
  assert.ok(booth.includes('id="btn-print"'), 'id btn-print harus masih ada');
  assert.ok(booth.includes('id="btn-email"'), 'id btn-email harus masih ada');
  assert.ok(booth.includes('Send Email'), 'tombol Send Email harus masih ada');
  assert.ok(booth.includes('New Photo'), 'tombol New Photo harus masih ada');
  // Formulir email-nya juga, karena tombolnya membuka form itu.
  assert.ok(booth.includes('email-form-container'), 'form email harus masih ada');
});

test('ketiga tombol dirender bersyarat pada setelan dari server', () => {
  // Cetak: syaratnya digabung dengan syarat paket, jadi tombolnya hanya tampil
  // kalau paket cetak DAN setelannya aktif.
  assert.match(booth, /selectedPackage === 'print' && tombol\.print/,
    'tombol cetak harus bergantung pada setelan tombol.print');
  // Email dan retake.
  assert.match(booth, /\{tombol\.email && \(/, 'tombol email harus bergantung pada tombol.email');
  assert.match(booth, /\{tombol\.retake && \(/, 'tombol New Photo harus bergantung pada tombol.retake');
});

test('bawaan semua AKTIF — membuka panel tidak mengubah perilaku', () => {
  // Ini yang menentukan apakah kiosk yang sudah berjalan berubah atau tidak.
  assert.match(booth, /useState\(\{ email: true, retake: true, print: true \}\)/,
    'bawaan ketiga tombol harus aktif');
  const admin = readFileSync('/Users/nadine/Unismiles/unismiles-admin/src/components/PrinterConfiguration.tsx', 'utf8');
  for (const f of ['show_email_button', 'show_retake_button', 'show_print_button']) {
    assert.match(admin, new RegExp(`${f}: true,`), `${f} harus bawaannya true di panel`);
  }
  const be = readFileSync('/Users/nadine/Unismiles/unismiles-backend/utils/printingConfigValidation.js', 'utf8');
  assert.match(be, /bacaBoolean\(merged\[field\], true\)/, 'backend harus memakai bawaan true');
  assert.match(be, /bacaBoolean\(row\[f\], true\)/, 'pembacaan dari DB juga bawaan true');
});

test('nilai dari server diterapkan, dan TIDAK menghapus nilai yang tidak dikirim', () => {
  // Kalau server mengirim satu tombol saja, dua lainnya harus tetap seperti
  // sebelumnya — bukan tiba-tiba hilang karena dianggap "tidak ada".
  assert.match(booth, /email: bacaBooleanAtau\(cfg\.show_email_button, prev\.email\)/,
    'tombol email harus memakai nilai sebelumnya sebagai cadangan');
  assert.match(booth, /retake: bacaBooleanAtau\(cfg\.show_retake_button, prev\.retake\)/);
  assert.match(booth, /print: bacaBooleanAtau\(cfg\.show_print_button, prev\.print\)/);
});

test('pembaca boolean tidak tertipu string 0/false', () => {
  // Salinan fungsi yang sama dengan yang ada di komponen, diuji langsung.
  const baca = (nilai: unknown, bawaan: boolean): boolean => {
    if (nilai === undefined || nilai === null || nilai === '') return bawaan;
    if (typeof nilai === 'boolean') return nilai;
    if (typeof nilai === 'number') return nilai !== 0;
    const t = String(nilai).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'ya'].includes(t)) return true;
    if (['false', '0', 'no', 'off', 'tidak'].includes(t)) return false;
    return bawaan;
  };
  // Yang paling penting: bentuk yang datang dari DB dan dari JSON.
  assert.strictEqual(baca('0', true), false, "string '0' harus berarti MATI");
  assert.strictEqual(baca('false', true), false);
  assert.strictEqual(baca(0, true), false, 'angka 0 dari TINYINT harus berarti MATI');
  assert.strictEqual(baca('1', false), true);
  assert.strictEqual(baca(1, false), true);
  assert.strictEqual(baca(true, false), true);
  assert.strictEqual(baca(false, true), false);
  // Tidak dikirim: pakai nilai sebelumnya, bukan dianggap mati.
  assert.strictEqual(baca(undefined, true), true);
  assert.strictEqual(baca(null, true), true);
  assert.strictEqual(baca('', true), true);
  assert.strictEqual(baca(undefined, false), false);
  // Nilai aneh: jangan mengubah apa pun.
  assert.strictEqual(baca('mungkin', true), true);
});

test('backend dan photobooth memakai aturan boolean yang SAMA', () => {
  // Dua pembaca boolean yang berbeda adalah cara paling mudah membuat nilai
  // yang sama ditafsirkan berbeda di dua sisi.
  const be = readFileSync('/Users/nadine/Unismiles/unismiles-backend/utils/printingConfigValidation.js', 'utf8');
  const daftarTerima = /'true', '1', 'yes', 'on', 'ya'/;
  const daftarTolak = /'false', '0', 'no', 'off', 'tidak'/;
  assert.match(be, daftarTerima, 'backend harus menerima daftar yang sama');
  assert.match(be, daftarTolak, 'backend harus menolak daftar yang sama');
  assert.match(booth, daftarTerima, 'photobooth harus menerima daftar yang sama');
  assert.match(booth, daftarTolak, 'photobooth harus menolak daftar yang sama');
});

test('kolom tombol ada di SEMUA jalur: validasi, model, controller, agent', () => {
  const be = readFileSync('/Users/nadine/Unismiles/unismiles-backend/utils/printingConfigValidation.js', 'utf8');
  const model = readFileSync('/Users/nadine/Unismiles/unismiles-backend/models/kioskPrintingConfigModel.js', 'utf8');
  const ctrl = readFileSync('/Users/nadine/Unismiles/unismiles-backend/controllers/printingConfigController.js', 'utf8');
  const agent = readFileSync('/Users/nadine/Unismiles/kiosk-agent/src/wsClient.js', 'utf8');
  for (const f of ['show_email_button', 'show_retake_button', 'show_print_button']) {
    assert.ok(be.includes(f), `validasi harus mengenal ${f}`);
    assert.ok(model.includes(f), `model harus menulis/membaca ${f}`);
    assert.ok(ctrl.includes(f), `controller endpoint kiosk harus mengirim ${f} — kalau tidak, tombol tetap muncul di kiosk`);
    assert.ok(agent.includes(f), `agent harus meneruskan ${f}`);
  }
});
