import assert from 'node:assert';
import { test } from 'node:test';
import {
  shouldArmIdleTimer,
  IDLE_SAFE_STEPS,
  IDLE_REDIRECT_MS,
  SIGNAGE_URL,
  resolveSignageBaseUrl,
  postExitRequest,
} from './idleReturn.ts';

const base = { step: 'LANDING', isCalibrating: false, idlePaused: false };

test('layar tunggu mengaktifkan timer', () => {
  for (const step of IDLE_SAFE_STEPS) {
    assert.strictEqual(shouldArmIdleTimer({ ...base, step }), true, `${step} harus mengaktifkan timer`);
  }
});

// Regresi paling penting: redirect otomatis di layar ini membuang sesi berbayar
// atau memutus pengunjung yang sedang berpose / memindai QR.
test('layar berisi pekerjaan pengunjung TIDAK mengaktifkan timer', () => {
  const protectedSteps = ['CAPTURE', 'PAYMENT', 'PAYMENT_SCAN', 'PAYMENT_CHECKING', 'EDIT', 'RESULT'];
  for (const step of protectedSteps) {
    assert.strictEqual(shouldArmIdleTimer({ ...base, step }), false, `${step} tidak boleh redirect otomatis`);
  }
});

test('step tidak dikenal tidak mengaktifkan timer', () => {
  assert.strictEqual(shouldArmIdleTimer({ ...base, step: 'SOMETHING_NEW' }), false);
  assert.strictEqual(shouldArmIdleTimer({ ...base, step: '' }), false);
});

test('operator di menu admin menahan timer', () => {
  assert.strictEqual(shouldArmIdleTimer({ ...base, idlePaused: true }), false);
});

test('maintenance mode menahan timer', () => {
  // idlePaused juga diisi saat maintenance aktif, jadi perilakunya sama.
  assert.strictEqual(shouldArmIdleTimer({ ...base, idlePaused: true, step: 'PACKAGE' }), false);
});

test('kalibrasi kamera menahan timer', () => {
  assert.strictEqual(shouldArmIdleTimer({ ...base, isCalibrating: true }), false);
});

test('jeda idle menang atas layar yang aman', () => {
  assert.strictEqual(shouldArmIdleTimer({ step: 'LANDING', isCalibrating: false, idlePaused: true }), false);
});

test('resolveSignageBaseUrl: origin http(s) saja, selain itu kosong', () => {
  assert.strictEqual(
    resolveSignageBaseUrl('https://photobooth.uniinside.net/air?x=1#f'),
    'https://photobooth.uniinside.net',
  );
  assert.strictEqual(resolveSignageBaseUrl('http://localhost:5173/'), 'http://localhost:5173');
  // App desktop memuat UI dari hosting tapi halaman itu sendiri file:// —
  // tidak ada origin HTTP, jadi exit-request lewat origin tidak memungkinkan.
  assert.strictEqual(resolveSignageBaseUrl('file:///C:/app/index.html'), '');
  assert.strictEqual(resolveSignageBaseUrl(''), '');
  assert.strictEqual(resolveSignageBaseUrl('bukan-url'), '');
});

test('postExitRequest: baseUrl kosong gagal cepat tanpa fetch', async () => {
  assert.strictEqual(await postExitRequest(''), false);
});

test('postExitRequest: jaringan gagal → false, tidak melempar', async () => {
  // Port yang hampir pasti tertutup + timeout pendek: fetch gagal, fungsi
  // wajib resolve false — pemanggil lanjut ke jalur keluar berikutnya.
  const ok = await postExitRequest('http://127.0.0.1:9', 300);
  assert.strictEqual(ok, false);
});

test('konfigurasi sesuai permintaan: 60 detik ke signage', () => {
  assert.strictEqual(IDLE_REDIRECT_MS, 60_000);
  assert.strictEqual(SIGNAGE_URL, 'https://signage.jagoai.dev/');
});
