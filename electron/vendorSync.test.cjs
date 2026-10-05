// Test: berkas yang di-vendor ke dalam aplikasi tidak boleh menyimpang.
//
// Transport di-vendor ke electron/ble/ karena jalur relatif ke kiosk-agent tidak
// ada di mesin kiosk. Salinan selalu berisiko: perbaikan di kiosk-agent bisa
// diam-diam tidak terpakai di aplikasi. Test ini membandingkan byte, jadi
// penyimpangan ketahuan di suite, bukan di printer.
const assert = require('node:assert');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const SUMBER = path.join(REPO, 'kiosk-agent', 'src', 'niimbotNobleClient.js');
const SALINAN = path.join(__dirname, 'ble', 'niimbotNobleClient.cjs');

test('transport yang di-vendor byte-identik dengan sumbernya', () => {
  const a = readFileSync(SUMBER);
  const b = readFileSync(SALINAN);
  assert.ok(a.equals(b),
    'electron/ble/niimbotNobleClient.cjs harus identik dengan kiosk-agent/src/niimbotNobleClient.js '
    + '— kalau menyimpang, perbaikan di sumber tidak terpakai di aplikasi. '
    + 'Salin ulang: cp kiosk-agent/src/niimbotNobleClient.js unismiles-photobooth/electron/ble/niimbotNobleClient.cjs');
});

test('salinan masih bergantung pada modul yang memang dipasang di aplikasi', () => {
  // Transport memakai @mmote/niimbluelib; kalau daftar require-nya bertambah,
  // dependensi itu harus ada di package.json aplikasi, bukan hanya di agent.
  const isi = readFileSync(SALINAN, 'utf8');
  const paket = JSON.parse(readFileSync(path.join(REPO, 'unismiles-photobooth', 'package.json'), 'utf8'));
  const butuh = [...isi.matchAll(/require\('([^'.][^']*)'\)/g)]
    .map((m) => m[1].split('/').slice(0, m[1].startsWith('@') ? 2 : 1).join('/'))
    // Modul bawaan Node selalu ada; yang perlu diperiksa hanya paket.
    .filter((n) => !n.startsWith('node:'));
  for (const nama of new Set(butuh)) {
    assert.ok(paket.dependencies?.[nama] || paket.devDependencies?.[nama],
      `modul "${nama}" dipakai transport tetapi tidak ada di package.json aplikasi`);
  }
});
