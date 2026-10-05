import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const boothSource = fs.readFileSync(path.join(here, '..', 'components', 'PhotoBooth.tsx'), 'utf8');
const bridgeSource = fs.readFileSync(path.join(here, '..', 'services', 'kioskAgentBridge.ts'), 'utf8');
const agentSource = fs.readFileSync(
  path.join(here, '..', '..', 'kiosk-agent', 'src', 'wsClient.js'), 'utf8'
);

/**
 * Bug nyata yang ditemukan: pengaturan ukuran kertas di Admin TIDAK PERNAH sampai
 * ke photobooth, sehingga ukuran tidak benar-benar dinamis.
 *
 * Tiga sebabnya:
 *   1. kiosk-agent tidak melaporkan paper_size dari Admin ke photobooth
 *      (reportedState.paperSize tidak pernah diperbarui dari printing config)
 *   2. getPaperSizeForLayout() ada tetapi tidak pernah dipanggil
 *   3. jembatan lokal ke photobooth dimatikan di .env
 */

test('agent melaporkan ukuran kertas dari Admin ke photobooth', () => {
  assert.match(
    agentSource,
    /if \(printing && printing\.paper_size\)\s*\{\s*this\.reportedState\.paperSize = printing\.paper_size;/,
    'paper_size dari konfigurasi Admin harus masuk ke reportedState'
  );
});

test('photobooth memakai ukuran dari Admin, bukan nilai tetap', () => {
  assert.match(boothSource, /const adminPaperSize = String\(kioskPaperSize/,
    'photobooth harus membaca ukuran dari kiosk agent');
  assert.ok(
    !/paper_size: String\(kioskPaperSize\)/.test(boothSource),
    'jangan mengirim kioskPaperSize mentah — nilai bawaannya selalu 4R'
  );
});

test('ada cadangan per layout kalau Admin belum mengatur', () => {
  // Fungsi ini dulu tidak pernah dipanggil, jadi layout 1x1 dan strip pun meminta 4R.
  assert.match(boothSource, /getPaperSizeForLayout\(selectedLayoutId\)/,
    'pemetaan per layout harus dipakai sebagai cadangan');
});

test('jembatan ke kiosk agent bisa dinyalakan lewat env', () => {
  assert.match(bridgeSource, /VITE_ENABLE_LOCAL_KIOSK_BRIDGE/,
    'bridge harus dikendalikan env supaya bisa dinyalakan di produksi');
  assert.match(bridgeSource, /VITE_LOCAL_BRIDGE_PORT/,
    'port bridge harus bisa disetel, agar sama dengan LOCAL_BRIDGE_PORT di agent');
});

test('papser size yang tidak dikenal tidak dikirim mentah-mentah', () => {
  // Nilai bawaan bridge adalah '4R'; setelah Admin mengatur, nilainya berganti.
  // Pastikan '4X6' (nilai bawaan agent) diperlakukan sebagai "belum diatur".
  assert.match(boothSource, /toUpperCase\(\) !== '4X6'/,
    'nilai bawaan agent harus dianggap belum diatur');
});
