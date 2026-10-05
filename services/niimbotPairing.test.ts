/**
 * Uji PERILAKU alur pairing printer label.
 *
 * Kenapa berkas terpisah dari bluetoothPrint.test.js: berkas itu memeriksa teks
 * sumber, dan pemeriksaan teks tidak bisa membuktikan hal terpenting di sini —
 * bahwa pemilih perangkat BENAR-BENAR tidak dibuka. Berkas ini menjalankan
 * kodenya dengan `navigator.bluetooth` palsu, dan `requestDevice` dicatat:
 * kalau ia pernah dipanggil, itulah popup "wants to pair" yang dikeluhkan.
 *
 * Web Bluetooth disimulasikan, bukan diganti: yang diuji adalah KEPUTUSAN
 * kode kita (pakai perangkat tersimpan, atau minta izin), bukan browser.
 */

import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOTH = readFileSync(path.join(ROOT, 'components', 'PhotoBooth.tsx'), 'utf8');
import { NiimbotPrinter } from './niimbotPrinter.ts';

/** Perangkat palsu; hanya bentuk yang dibaca kode kita. */
const perangkat = (name: string) => ({ name, gatt: { connect: async () => { throw new Error('tidak dipakai di uji ini'); } } });

/** Pasang navigator.bluetooth palsu dan catat setiap pemanggilan pemilih. */
function pasangBluetooth({ devices = [] as any[], getDevicesGagal = false, adaBluetooth = true } = {}) {
  const catatan = { requestDevice: 0, getDevices: 0 };
  const bt = {
    async getDevices() {
      catatan.getDevices += 1;
      if (getDevicesGagal) throw new Error('izin dicabut');
      return devices;
    },
    async requestDevice() {
      catatan.requestDevice += 1;
      throw new Error('pemilih perangkat dibuka — inilah popup yang tidak boleh muncul');
    },
  };
  // `navigator` di Node hanya punya getter, jadi tidak bisa di-assign langsung.
  Object.defineProperty(globalThis, 'navigator', {
    value: adaBluetooth ? { bluetooth: bt } : {},
    configurable: true,
    writable: true,
  });
  return catatan;
}

beforeEach(() => {
  pasangBluetooth();
  if (!(globalThis as any).window) {
    Object.defineProperty(globalThis, 'window', {
      value: { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } },
      configurable: true, writable: true,
    });
  }
});

test('backend tidak didukung -> dinyatakan, bukan dicoba', async () => {
  pasangBluetooth({ adaBluetooth: false });
  assert.equal(await new NiimbotPrinter().pairingState(), 'unsupported');
});

test('belum ada printer tersimpan -> pairingState meminta dipasangkan', async () => {
  pasangBluetooth({ devices: [] });
  assert.equal(await new NiimbotPrinter().pairingState(), 'no-stored-device');
});

test('printer sudah tersimpan -> siap, tanpa dialog', async () => {
  const catatan = pasangBluetooth({ devices: [perangkat('B1pro-i616')] });
  const p = new NiimbotPrinter();
  assert.equal(await p.pairingState(), 'ready');
  assert.deepEqual(await p.storedDeviceNames(), ['B1pro-i616']);
  // Inti permintaannya: membaca izin tidak membuka pemilih.
  assert.equal(catatan.requestDevice, 0, 'membaca izin tidak boleh membuka pemilih');
});

test('getDevices gagal (izin dicabut) -> tetap tidak membuka pemilih', async () => {
  const catatan = pasangBluetooth({ getDevicesGagal: true });
  assert.equal(await new NiimbotPrinter().pairingState(), 'no-stored-device');
  assert.equal(catatan.requestDevice, 0, 'izin dicabut harus jadi galat, bukan dialog');
});

test('sambung awal saat izin belum ada TIDAK PERNAH membuka pemilih', async () => {
  // Ini yang membuat popup tidak muncul sendiri saat halaman dimuat: preconnect
  // berhenti lebih dulu, sebelum ada kesempatan memanggil pemilih.
  const catatan = pasangBluetooth({ devices: [] });
  const hasil = await new NiimbotPrinter().preconnectSilently();
  assert.equal(hasil, null);
  assert.equal(catatan.requestDevice, 0, 'preconnect tidak boleh membuka pemilih');
});

test('beberapa kali siapkan-halaman berturut-turut tetap tanpa pemilih', async () => {
  // Meniru reload halaman berulang dan cetak berulang: setiap instance baru
  // harus membaca izin yang sama dan tidak membuka dialog.
  const catatan = pasangBluetooth({ devices: [perangkat('B1pro-i616')] });
  for (let i = 0; i < 5; i += 1) {
    const p = new NiimbotPrinter();
    assert.equal(await p.pairingState(), 'ready', `putaran ${i}: harus siap`);
  }
  assert.equal(catatan.requestDevice, 0, 'berulang kali pun tidak boleh membuka pemilih');
  assert.equal(catatan.getDevices, 5, 'setiap putaran membaca dari browser, bukan dari cache basi');
});

test('printer tercatat tetapi browser tidak mengenalinya -> minta dipasangkan', async () => {
  // Keadaan paling menjebak: localStorage masih menyimpan nama printer, tetapi
  // izin untuk alamat ini tidak ada (dipasangkan dari alamat lain). Harus
  // dilaporkan sebagai belum siap, bukan diam-diam dicoba dan gagal.
  pasangBluetooth({ devices: [] });
  // Catatan nama ada (localStorage), tetapi browser tidak mengenali
  // perangkatnya. Dua sumber berbeda, dan yang menentukan adalah browser.
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: () => 'B1pro-i616', setItem: () => {}, removeItem: () => {} },
    configurable: true, writable: true,
  });
  assert.equal(await new NiimbotPrinter().pairingState(), 'no-stored-device');
});

test('connect() TANPA forceChooser tidak pernah membuka pemilih', async () => {
  // Inti perbaikan terakhir: pemilih jadi satu pintu. Sebelumnya siapa pun yang
  // memanggil connect() ikut membuka dialog kalau perangkat tersimpan tidak ada,
  // jadi satu pemanggil yang lupa memeriksa izin sudah cukup memunculkan popup
  // di tengah proses cetak.
  const catatan = pasangBluetooth({ devices: [] });
  await assert.rejects(
    () => new NiimbotPrinter().connect(),
    /belum dipasangkan/i,
    'connect() biasa harus MENOLAK, bukan membuka dialog',
  );
  assert.equal(catatan.requestDevice, 0, 'connect() biasa tidak boleh menyentuh pemilih');
});

test('sambung-ulang memakai perangkat tersimpan, bukan pemilih', () => {
  // Diperiksa dari sumber, bukan dijalankan: connect() ke perangkat tersimpan
  // mengulang sampai 6 kali dengan jeda, jadi menjalankannya di uji ini memakan
  // ~10 detik untuk membuktikan hal yang sama.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const connect = PRINTER.slice(PRINTER.indexOf('const found = options.forceChooser'),
    PRINTER.indexOf('if (!options.forceChooser)'));
  assert.match(connect, /connect\(\{ authorizedDevice: found\.device \}\)/,
    'jalur tersimpan harus memakai authorizedDevice');
  assert.ok(!/client\.connect\(\)/.test(connect),
    'jalur tersimpan tidak boleh memanggil connect() tanpa argumen');
});

test('pesan "belum dipasangkan" tetap satu sumber', () => {
  // Sudah pernah salah: pesan menulis "Siapkan printer" sementara tombolnya
  // "Siapkan Printer", dan satu perbedaan huruf membuat orang ragu apakah dia
  // ada di layar yang benar. Konstanta menghilangkan kemungkinan itu.
  //
  // Sejak pemasangan dipindah ke dalam klik "Cetak", pesan ini muncul di satu
  // tempat saja (jalur cetak tanpa gestur), jadi pemeriksaannya bukan lagi soal
  // tombol melainkan soal tidak ada penulisan ulang.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  assert.match(PRINTER, /export const PRINTER_BELUM_DIPASANGKAN/,
    'pesan harus konstanta, bukan literal yang ditulis ulang');
  assert.match(PRINTER, /throw new Error\(PRINTER_BELUM_DIPASANGKAN\)/,
    'gerbang pemilih harus memakai konstanta yang sama');
  assert.ok(!/belum dipasangkan di browser ini/.test(BOOTH),
    'PhotoBooth tidak boleh menulis ulang pesannya sendiri');
  assert.match(BOOTH, /PRINTER_BELUM_DIPASANGKAN/,
    'PhotoBooth harus mengimpor konstanta itu');
});

test('pemanggilan library tanpa argumen berada SETELAH gerbang', () => {
  // Yang menjamin tidak ada jalan lain ke pemilih: pemanggilan tanpa argumen
  // harus berada setelah gerbang, dan sebelum akhir connect(). Jaraknya longgar
  // karena di antaranya ada penangkap event "connect" — yang penting urutannya.
  //
  // Diperiksa juga bahwa pemanggilan tanpa argumen itu hanya SATU di seluruh
  // berkas: kalau ada yang kedua di luar jangkauan gerbang, semuanya bocor.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const i = PRINTER.indexOf('if (!options.forceChooser)');
  const j = PRINTER.indexOf('await this.client.connect();', i);
  const akhirConnect = PRINTER.indexOf('/**\n   * Bagian connect()', i);
  assert.ok(i > 0 && j > i && (akhirConnect === -1 || j < akhirConnect),
    'client.connect() tanpa argumen harus berada di dalam cabang forceChooser');
  const jumlah = (PRINTER.match(/await this\.client\.connect\(\);/g) || []).length;
  assert.strictEqual(jumlah, 1, 'hanya boleh ada satu jalan ke pemilih');
});

test('nama perangkat diambil dari BROWSER, bukan dari protokol', () => {
  // Ini akar masalah yang dilaporkan: nama dari protokol printer sering KOSONG
  // (printer mengirim nomor seri, bukan nama), sedangkan getDevices()
  // mengembalikan perangkat dengan nama dari browser. Mengingat nama protokol
  // lalu mencocokkannya dengan nama browser TIDAK PERNAH cocok, sehingga printer
  // yang benar-benar tersimpan terus dianggap "belum dipasangkan".
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const finish = PRINTER.slice(PRINTER.indexOf('private async finishConnect'));
  assert.match(finish.slice(0, 1400), /namaBrowser/,
    'finishConnect harus menerima/ memakai nama dari browser');
  assert.match(finish.slice(0, 1400), /namaBrowser \|\| namaProtokol/,
    'nama browser harus DIUTAMAKAN atas nama protokol');
  // Dan perangkat yang dipilih ditangkap dari event "connect" library.
  const connect = PRINTER.slice(PRINTER.indexOf('const found = options.forceChooser'));
  assert.match(connect, /this\.client\.on\('connect'/, 'perangkat dipilih harus ditangkap dari event');
  assert.match(connect, /this\.finishConnect\(dipilih\)/, 'lalu diteruskan ke finishConnect');
});

test('pairNow memverifikasi izin memakai nama BROWSER', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const fn = PRINTER.slice(PRINTER.indexOf('public async pairNow'));
  assert.match(fn.slice(0, 2200), /d\?\.name === namaBrowser/,
    'pencocokan harus memakai nama browser — nama protokol tidak pernah cocok');
  assert.match(fn.slice(0, 2200), /printDeviceName/,
    'harus memakai nama browser yang tercatat saat sambung');
});

test('preconnect melaporkan isi daftar perangkat apa adanya', () => {
  // Satu baris ini yang membedakan "daftar kosong" dari "izin tidak bertahan",
  // dua sebab yang gejalanya sama dari sisi pengguna.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const fn = PRINTER.slice(PRINTER.indexOf('public async preconnectSilently'));
  // Dipotong sampai akhir fungsi (sambung di jalur web), bukan 2600 huruf:
  // jalur desktop di depan fungsi memakan jatah itu, sehingga pemeriksaan ini
  // gagal hanya karena teksnya bergeser — bukan karena perilakunya berubah.
  const badan = fn.slice(0, fn.indexOf('private async findPairedDevice'));
  assert.match(badan, /Perangkat tersimpan untuk alamat ini/,
    'harus melaporkan daftar perangkat saat halaman siap');
  assert.match(badan, /perangkat\.length === 0/,
    'harus menyatakan terang-terangan kalau daftarnya kosong');
});

test('sisa buffer dibuang setelah sambung juga', () => {
  // Handshake sambungan sendiri meninggalkan ekor (terlihat sebagai
  // "Dropping invalid buffer" dua kali per sesi).
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const finish = PRINTER.slice(PRINTER.indexOf('private async finishConnect'));
  assert.match(finish.slice(0, 900), /this\.clearStalePacketBuffer\(\)/,
    'sisa buffer harus dibuang setelah sambungan terbentuk');
});

test('bundel yang dijalankan disebut di konsol', () => {
  // Berkas lama tetap bisa diakses setelah deploy, jadi laporan dari browser yang
  // masih memegang bundle sebelumnya terlihat seperti "perbaikan tidak bekerja".
  // Satu baris ini membuat "sudah di-reload atau belum" bisa dipastikan.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  assert.match(PRINTER, /Bundel yang dijalankan/,
    'harus menyebut berkas yang sedang dijalankan');
  assert.match(PRINTER, /script\[type="module"\]/, 'diambil dari elemen script yang dimuat');
});
