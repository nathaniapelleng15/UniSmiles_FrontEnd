import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./kioskAgentBridge.ts', import.meta.url), 'utf8');

// Kenapa ini diuji dengan teks, bukan dengan DOM: yang diperiksa BUKAN hasil
// perilakunya, melainkan APA YANG DIPANGGIL. Kalau konstruktornya memasang
// WebSocket ke port yang mati, browser mencetak ERR_CONNECTION_REFUSED dan itu
// tidak bisa ditekan flag apa pun — pesan itu pernah menutupi error cetak.

test('alamat agent diperiksa dulu sebelum WebSocket dipasang', () => {
  assert.match(SRC, /AbortSignal\.timeout\(/,
    'harus ada probe dengan batas waktu, supaya tidak menggantung di port mati');
});

test('konstruktor tidak langsung menyambung', () => {
  const ctor = SRC.slice(SRC.indexOf('constructor()'), SRC.indexOf('public subscribe'));
  assert.doesNotMatch(ctor, /this\.connect\(\)/,
    'WebSocket tidak boleh dibuka sebelum alamatnya terbukti hidup');
  assert.doesNotMatch(ctor, /this\.pollFallback\(\)/,
    'polling tidak boleh dipasang sebelum alamatnya terbukti hidup');
  assert.match(ctor, /this\.start\(\)/, 'konstruktor memanggil pemeriksaan, bukan sambungan');
});

test('sambungan dan polling hanya dinyalakan setelah probe berhasil', () => {
  const start = SRC.slice(SRC.indexOf('private async start()'), SRC.indexOf('private connect()'));
  // Keduanya harus berada di dalam cabang "ada", bukan di jalur biasa.
  const cabang = start.slice(start.indexOf('if (ada)'));
  assert.match(cabang, /this\.connect\(\)/, 'WebSocket hanya di cabang ada');
  assert.match(cabang, /this\.pollFallback\(\)/, 'polling hanya di cabang ada');
  // Dan tidak ada pemanggilan tanpa syarat sebelum cabang itu.
  const sebelum = start.slice(0, start.indexOf('if (ada)'));
  assert.doesNotMatch(sebelum, /this\.connect\(\)|this\.pollFallback\(\)/,
    'tidak boleh menyambung sebelum hasil probe diketahui');
});

test('percobaan ulang jarang, bukan tiap 5 detik', () => {
  assert.doesNotMatch(SRC, /setTimeout\([^)]*\b5000\b/,
    'percobaan tiap 5 detik yang membanjiri konsol sudah dihapus');
  assert.match(SRC, /30000/, 'pemeriksaan ulang tiap 30 detik');
});

test('saat agent mati, polling dihentikan', () => {
  assert.match(SRC, /stopPolling\(\)/, 'harus ada cara menghentikan polling');
  const onclose = SRC.slice(SRC.indexOf('socket.onclose'));
  assert.match(onclose.slice(0, 300), /this\.stopPolling\(\)/,
    'polling harus berhenti saat sambungan ditutup, bukan berjalan ke port mati');
});

test('port tetap bisa diatur dari env', () => {
  assert.match(SRC, /VITE_ENABLE_LOCAL_KIOSK_BRIDGE/);
  assert.match(SRC, /VITE_LOCAL_BRIDGE_PORT/);
});
