import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiSource = fs.readFileSync(path.join(here, '..', 'services', 'apiService.ts'), 'utf8');

/**
 * Bug nyata: fitur kirim email belum diaktifkan di server (SMTP belum diisi),
 * backend menjawab 503 + code EMAIL_NOT_CONFIGURED, tetapi kiosk menampilkan
 * "Backend utama tidak dapat diakses." Pesan itu menyesatkan: operator jadi
 * mencari masalah jaringan, padahal tinggal mengisi kredensial SMTP.
 */
test('EMAIL_NOT_CONFIGURED tidak dilaporkan sebagai masalah koneksi', () => {
  assert.match(apiSource, /code === 'EMAIL_NOT_CONFIGURED'/,
    'kode error email harus dikenali khusus');
  assert.match(apiSource, /Fitur kirim email belum diaktifkan/,
    'pesannya harus menjelaskan fitur belum aktif, bukan koneksi gagal');
});

test('respons error backend tetap dibaca lebih dulu sebelum pesan cadangan', () => {
  // Pesan dari server harus menang; fallback hanya kalau server diam.
  assert.match(apiSource, /const message = serverMessage \|\| fallbackMessage;/);
});

test('pesan cadangan koneksi tetap tersedia untuk kegagalan jaringan asli', () => {
  // Kegagalan jaringan sungguhan masih perlu pesan "tidak dapat diakses".
  const callers = apiSource.match(/Backend utama tidak dapat diakses/g) || [];
  assert.ok(callers.length >= 1, 'pesan cadangan koneksi harus tetap ada');
});
