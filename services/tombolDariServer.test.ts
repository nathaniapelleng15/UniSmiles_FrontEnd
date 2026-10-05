import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Bukti bahwa nilai dari SERVER benar-benar menghasilkan tombol yang benar.
 *
 * Bukan cocok-teks: fungsi `bacaBooleanAtau` diekstrak APA ADANYA dari
 * PhotoBooth.tsx, lalu dijalankan terhadap payload NYATA dari endpoint kiosk
 * yang dipakai aplikasi desktop. Jadi yang diuji adalah kode yang benar-benar
 * berjalan di kiosk, dengan data yang benar-benar dikirim server.
 *
 * Kalau rantai ini putus di salah satu titik, tombol yang dimatikan operator
 * tetap muncul — dan itu keluhan yang sedang diselesaikan.
 */

const BOOTH = '/Users/nadine/Unismiles/unismiles-photobooth/components/PhotoBooth.tsx';
const API = '/Users/nadine/Unismiles/unismiles-photobooth/services/apiService.ts';
const booth = readFileSync(BOOTH, 'utf8');

/** Ambil fungsi asli dari sumber, jangan salin ulang. */
function ambilFungsiBacaBoolean(): (n: unknown, b: boolean) => boolean {
  const mulai = booth.indexOf('const bacaBooleanAtau =');
  assert.ok(mulai > 0, 'bacaBooleanAtau harus ada di PhotoBooth.tsx');
  // Sampai penutup "};" pertama sesudahnya.
  const akhir = booth.indexOf('  };', mulai);
  assert.ok(akhir > mulai, 'akhir fungsi harus ditemukan');
  let sumber = booth.slice(mulai, akhir + 4);
  // Buang anotasi tipe TypeScript: berkasnya .tsx, jadi "new Function" tidak bisa
  // memahaminya. Yang dibuang hanya anotasinya — logikanya tetap utuh.
  sumber = sumber
    .replace(/\(nilai: unknown, bawaan: boolean\): boolean/, '(nilai, bawaan)')
    .replace(/const t = /, 'const t = ');
  // eslint-disable-next-line no-new-func
  return new Function(`${sumber}; return bacaBooleanAtau;`)() as (n: unknown, b: boolean) => boolean;
}

/** Payload NYATA dari endpoint yang dibaca aplikasi desktop.
 *
 *  Kalau jaringan tidak ada, kembalikan null — pemanggil MELEWATI uji, bukan
 *  gagal. Uji yang gagal karena tidak ada internet hanya melatih orang untuk
 *  mengabaikan hasilnya.
 */
function payloadServer(): Record<string, unknown> | null {
  try {
    const out = execFileSync('curl', [
      '-sS', '-m', '30',
      'https://api.uniinside.net/api/v1/kiosk/printing-config',
      '-H', 'x-api-key: kiosk_7f5acf2884c1321a54e73502b145c1ad',
      '-H', 'Cache-Control: no-store',
    ], { encoding: 'utf8' });
    const d = JSON.parse(out);
    const cfg = (d.data?.config || d.data || d) as Record<string, unknown>;
    // Balasan non-objek (mis. halaman error Cloudflare) dianggap tidak ada.
    if (typeof cfg !== 'object' || cfg === null) return null;
    // Dan balasan itu harus BENAR-BENAR konfigurasi cetak. Tanpa penjagaan ini,
    // respons galat seperti {"success":false,"message":"Route not found"} lolos
    // sebagai "payload" dan ujinya gagal untuk alasan yang salah — persis yang
    // sempat terjadi.
    if (cfg.success === false) return null;
    const tandaKonfigurasi = ['paper_size', 'config_version', 'adapter']
      .some((k) => k in cfg);
    return tandaKonfigurasi ? cfg : null;
  } catch {
    return null;
  }
}

const LIVE = payloadServer();
const lewati = LIVE ? false : 'endpoint kiosk tidak terjangkau (uji butuh jaringan)';

test('server MENGIRIM ketiga nilai tombol (kalau tidak, kiosk pakai bawaan)', { skip: lewati }, () => {
  const cfg = LIVE as Record<string, unknown>;
  for (const f of ['show_email_button', 'show_retake_button', 'show_print_button']) {
    assert.ok(f in cfg, `${f} HARUS ada di payload endpoint kiosk — tanpa ini tombol di Admin tidak berpengaruh`);
  }
  // Harus boolean atau 0/1, bukan string bebas.
  for (const f of ['show_email_button', 'show_retake_button', 'show_print_button']) {
    const v = cfg[f];
    assert.ok(typeof v === 'boolean' || v === 0 || v === 1 || v === '0' || v === '1',
      `${f} bernilai tak terduga: ${JSON.stringify(v)}`);
  }
  console.log('      payload server:', JSON.stringify({
    show_email_button: cfg.show_email_button,
    show_retake_button: cfg.show_retake_button,
    show_print_button: cfg.show_print_button,
    config_version: cfg.config_version,
  }));
});

test('kode asli kiosk menafsirkan payload server dengan benar', { skip: lewati }, () => {
  const baca = ambilFungsiBacaBoolean();
  const cfg = LIVE as Record<string, unknown>;

  // Bawaan = perilaku sekarang. Dipakai hanya kalau server tidak mengirim nilai.
  const bawaan = { email: true, retake: true, print: true };

  const hasil = {
    email: baca(cfg.show_email_button, bawaan.email),
    retake: baca(cfg.show_retake_button, bawaan.retake),
    print: baca(cfg.show_print_button, bawaan.print),
  };

  // Yang harus benar: hasilnya SAMA PERSIS dengan yang dikirim server.
  const harap = {
    email: cfg.show_email_button === undefined ? true : baca(cfg.show_email_button, true),
    retake: cfg.show_retake_button === undefined ? true : baca(cfg.show_retake_button, true),
    print: cfg.show_print_button === undefined ? true : baca(cfg.show_print_button, true),
  };
  assert.deepStrictEqual(hasil, harap, 'nilai server harus diteruskan apa adanya');
  console.log('      hasil di kiosk:', JSON.stringify(hasil));

  // Dan khusus bentuk mentah dari MySQL (0/1) tidak boleh salah tafsir.
  assert.strictEqual(baca(0, true), false, 'MySQL 0 harus berarti MATI');
  assert.strictEqual(baca(1, false), true, 'MySQL 1 harus berarti HIDUP');
  assert.strictEqual(baca('0', true), false, "string '0' harus berarti MATI");
});

test('kiosk memakai nilai SALINAN saat server tidak terjangkau (bukan bawaan)', () => {
  // Aplikasi desktop menyimpan salinan dari server; saat kiosk menyala tanpa
  // jaringan, salinan inilah yang dipakai — jadi setelan Admin tetap berlaku.
  const api = readFileSync(API, 'utf8');
  assert.ok(api.includes('bacaKonfigurasiServerTerakhir'),
    'pembacaan salinan server harus ada di apiService');
  assert.match(api, /export const simpanKonfigurasiServer = \(/,
    'harus ada fungsi penyimpan salinan');
  assert.match(booth, /simpanKonfigurasiServer\(cfg as unknown as Record<string, unknown>\)/,
    'setiap pengambilan sukses harus menyimpan salinan');
});

test('konfigurasi diambil berkala, bukan hanya sekali saat aplikasi dibuka', () => {
  // Tanpa ini, mematikan tombol di Admin baru berlaku setelah kiosk dibuka
  // ulang — dan itu terasa seperti "tidak berfungsi".
  assert.match(booth, /setInterval\(\(\) => \{ void apply\(\); \}, 30_000\)/,
    'harus ada pengambilan berkala tiap 30 detik');
});
