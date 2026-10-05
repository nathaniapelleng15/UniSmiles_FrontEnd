import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCAN_FRAME_GAP_MS, SCAN_READ_DELAY_MS, SUBMIT_INTERVAL_MS,
  MAX_FRAMES_TO_SEND, MAX_SUBMIT_ROUNDS,
  SUBMIT_POLL_TIMEOUT_MS, SUBMIT_POLL_INTERVAL_MS,
  shouldSubmitBatch, keepBestFrames, orderFramesForUpload,
  scanStatusText, CHECKING_TEXT, FROZEN_BADGE_TEXT, isSettledDecision, isServiceFailure,
  isRoundLimitReached,
  SCAN_GUIDE, guideFrameStyle,
} from './scanWindow.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const componentSource = fs.readFileSync(
  path.join(here, '..', 'components', 'PhotoBooth.tsx'), 'utf8'
);
const policySource = fs.readFileSync(path.join(here, 'scanWindow.ts'), 'utf8');

const frame = (sharpness) => ({ sharpness });

// ---------------------------------------------------------------------------
// Pelajaran yang dijaga ketat: JANGAN menilai keberhasilan dari gambar.
//
// Dua metrik sudah dicoba dan dua-duanya menipu:
//   ketajaman  -> ruangan kosong 1694-1955 vs struk 590 (ruangan menang)
//   kecerahan  -> di Mac ruangan 1,6%, tapi di kiosk yang terang tetap lolos
// Akibatnya sistem mengatakan "terbaca jelas" padahal tidak ada bukti bayar.
// ---------------------------------------------------------------------------

test('tidak ada penilaian mutu gambar di kebijakan maupun komponen', () => {
  const banned = [
    /scanQuality/, /SCAN_QUALITY/, /classifyFrame/, /hasScreen/, /isFrameUsable/,
    /brightRatio/, /SCREEN_BRIGHT_RATIO/, /GOOD_SHARPNESS/, /FAIR_SHARPNESS/,
    /countGoodFrames/, /scanHint/,
  ];
  for (const pattern of banned) {
    assert.ok(!pattern.test(policySource), `kebijakan masih memakai ${pattern}`);
    assert.ok(!pattern.test(componentSource), `komponen masih memakai ${pattern}`);
  }
});

test('UI tidak mengklaim gambar sudah jelas', () => {
  const claims = [/Terbaca jelas/, /Tangkapan bagus/, /Cukup jelas/, /Cari posisi/];
  for (const claim of claims) {
    assert.ok(!claim.test(componentSource), `UI masih mengklaim "${claim}"`);
  }
});

test('status yang ditampilkan jujur, tanpa batas percobaan palsu', () => {
  assert.match(scanStatusText(0, MAX_SUBMIT_ROUNDS), /Arahkan bukti bayar/i);
  const afterFail = scanStatusText(1, MAX_SUBMIT_ROUNDS);
  assert.match(afterFail, /Belum terbaca/i, 'akui belum terbaca, jangan mengklaim berhasil');
  assert.match(afterFail, /masih mencoba/i, 'tegaskan sistem terus mencoba');
  assert.match(CHECKING_TEXT, /Sedang membaca/i);
});

// ---------------------------------------------------------------------------
// Preview beku selagi bukti diperiksa: pengunjung tidak perlu terus
// mengangkat HP sampai verifikasi selesai. Beku saat batch dikirim, hidup
// lagi kalau pemindaian harus berlanjut.
// ---------------------------------------------------------------------------

test('preview dibekukan selagi bukti diperiksa backend', () => {
  assert.match(componentSource, /setScanFrozen\(true\)/, 'bekukan preview saat batch dikirim');
  assert.match(componentSource, /scanFrozenRef\.current = true/, 'loop render rAF membaca lewat ref agar tidak stale');
});

test('preview hidup lagi saat pemindaian berlanjut, direset, atau layar ditinggalkan', () => {
  assert.match(componentSource, /setScanFrozen\(false\)/, 'lepaskan bekuan agar kamera bisa dipakai lagi');
  assert.match(componentSource, /scanFrozenRef\.current = false/, 'ref ikut dilepas');
});

test('saat beku, pengunjung diberi tahu bahwa HP boleh diturunkan', () => {
  assert.match(CHECKING_TEXT, /Sedang membaca/i);
  assert.match(CHECKING_TEXT, /menurunkan HP|turunkan HP/i);
  assert.match(FROZEN_BADGE_TEXT, /turunkan HP/i);
  assert.match(componentSource, /FROZEN_BADGE_TEXT/, 'badge beku memakai teks bersama, bukan teks liar');
});

// ---------------------------------------------------------------------------
// Keputusan backend: pasangan status+decision tidak seragam, jangan sampai
// ada nilai yang tidak dikenali. Bug nyata: 'manual_review' terlewat sehingga
// tiap percobaan menunggu 20 detik sia-sia (terukur 24 detik per percobaan).
// ---------------------------------------------------------------------------

test('semua keputusan final backend dikenali', () => {
  // verified
  assert.strictEqual(isSettledDecision('verified', 'verified'), true);
  // belum terbaca
  assert.strictEqual(isSettledDecision('needs_retry', 'failed'), true);
  // ditolak
  assert.strictEqual(isSettledDecision('rejected', 'rejected'), true);
  // layanan gagal -> inilah yang dulu terlewat
  assert.strictEqual(isSettledDecision('manual_review', 'error'), true);
  // masih diproses
  assert.strictEqual(isSettledDecision('processing', 'received'), false);
  assert.strictEqual(isSettledDecision('', ''), false);
  assert.strictEqual(isSettledDecision(undefined, undefined), false);
});

test('manual_review dikenali sebagai kegagalan layanan', () => {
  assert.strictEqual(isServiceFailure('manual_review', 'error', ['INTERNAL_ERROR']), true);
  // Hanya statusnya yang error, decision kosong
  assert.strictEqual(isServiceFailure('', 'error', []), true);
  // Reason code menandai kegagalan internal
  assert.strictEqual(isServiceFailure('needs_retry', 'failed', ['INTERNAL_ERROR']), true);
  // Belum terbaca bukan kegagalan layanan
  assert.strictEqual(isServiceFailure('needs_retry', 'failed', ['IMAGE_BLURRY']), false);
  assert.strictEqual(isServiceFailure('rejected', 'rejected', ['DUPLICATE_REFERENCE']), false);
});

test('komponen memakai fungsi keputusan bersama, bukan logika sebaris', () => {
  assert.match(componentSource, /isSettledDecision\(decision, status\)/);
  assert.match(componentSource, /isServiceFailure\(decision, status, reasonCodes\)/);
  assert.ok(
    !/decision === 'manual_review'/.test(componentSource),
    'jangan menyalin logika keputusan di komponen'
  );
});

test('pesan kegagalan layanan tidak menyalahkan posisi bukti bayar', () => {
  assert.match(componentSource, /bermasalah di server/,
    'jelaskan bahwa masalahnya di server, bukan posisi kamera');
});

// ---------------------------------------------------------------------------
// Pengiriman: berkala, bukan menunggu kondisi gambar
// ---------------------------------------------------------------------------

test('pengiriman berbasis tempo, bukan penilaian gambar', () => {
  assert.strictEqual(shouldSubmitBatch([], 99_999), false, 'tanpa frame jangan kirim');
  assert.strictEqual(shouldSubmitBatch([frame(1)], 0), false, 'terlalu cepat');
  assert.strictEqual(shouldSubmitBatch([frame(1)], SUBMIT_INTERVAL_MS), true, 'tempo tercapai -> kirim');
  // Frame jelek tetap dikirim: backend yang menilai, bukan kita.
  assert.strictEqual(shouldSubmitBatch([frame(1)], SUBMIT_INTERVAL_MS * 2), true);
});

test('tempo kirim cukup cepat agar tidak terasa lambat', () => {
  assert.ok(SUBMIT_INTERVAL_MS >= 1000, `jangan terlalu sering, dapat ${SUBMIT_INTERVAL_MS}`);
  assert.ok(SUBMIT_INTERVAL_MS <= 6000, `jangan terlalu lambat, dapat ${SUBMIT_INTERVAL_MS}`);
});

test('tidak ada batas waktu pemindaian', () => {
  assert.ok(!/SCAN_WINDOW_MS/.test(policySource), 'jangan pakai jendela waktu');
  assert.ok(!/SCAN_WINDOW_MS/.test(componentSource));
  assert.ok(!/scanRemainingSeconds/.test(componentSource));
  assert.match(componentSource, /while \(true\) \{/, 'loop sampai hasil final');
});

test('jatah kiriman per sesi tidak dibatasi (permintaan: bebas scan berkali-kali)', () => {
  // 0 = tanpa batas. Pengunjung harus bisa mencoba sebanyak yang diperlukan.
  assert.strictEqual(MAX_SUBMIT_ROUNDS, 0, 'batas jumlah percobaan harus dimatikan');
  assert.strictEqual(isRoundLimitReached(0), false);
  assert.strictEqual(isRoundLimitReached(5), false);
  assert.strictEqual(isRoundLimitReached(50), false);
  assert.strictEqual(isRoundLimitReached(999), false);
  assert.match(componentSource, /isRoundLimitReached\(rounds\)/, 'komponen memakai helper batas');
  assert.ok(
    !/rounds >= MAX_SUBMIT_ROUNDS/.test(componentSource),
    'jangan membandingkan langsung, karena 0 berarti tanpa batas'
  );
});

test('batas masih bisa diaktifkan lewat konfigurasi kalau diperlukan', () => {
  assert.strictEqual(isRoundLimitReached(3, 5), false);
  assert.strictEqual(isRoundLimitReached(5, 5), true);
  assert.strictEqual(isRoundLimitReached(9, 5), true);
});

test('teks status tidak menyebut "X dari Y" saat tanpa batas', () => {
  const text = scanStatusText(3, 0);
  assert.match(text, /masih mencoba/i);
  assert.ok(!/\d+\s*dari\s*\d+/.test(text), `jangan tampilkan batas palsu: ${text}`);
});

test('ada penjaga agar layar tidak menggantung saat layanan bermasalah', () => {
  assert.ok(SUBMIT_POLL_TIMEOUT_MS >= 5000 && SUBMIT_POLL_TIMEOUT_MS <= 60_000);
  assert.match(componentSource, /SUBMIT_POLL_TIMEOUT_MS/);
  assert.ok(SUBMIT_POLL_INTERVAL_MS > 0);
});

// ---------------------------------------------------------------------------
// Hasil: berhasil hanya kalau backend setuju
// ---------------------------------------------------------------------------

test('berhasil hanya ditentukan hasil backend', () => {
  assert.match(componentSource, /if \(result\.verified\)/, 'harus menunggu keputusan backend');
  assert.match(componentSource, /setVerificationStatus\('verified'\)/);
  assert.match(componentSource, /setStep\('CAPTURE'\)/, 'lanjut otomatis ke halaman berikutnya');
});

test('belum terbaca berarti lanjut mencoba, bukan gagal', () => {
  assert.match(componentSource, /kept = \[\];/, 'buang frame lama agar tidak dikirim ulang');
  assert.match(componentSource, /scanStatusText\(rounds, MAX_SUBMIT_ROUNDS\)/, 'beri tahu masih dicoba');
});

test('bukti sudah dipakai dihentikan final, bukan diulang', () => {
  assert.match(componentSource, /DUPLICATE_REFERENCE/);
  assert.match(componentSource, /setVerificationStatus\('rejected'\)/);
});

test('pengunjung diberi jeda sebelum frame pertama diambil', () => {
  assert.ok(SCAN_READ_DELAY_MS >= 1000);
  assert.match(componentSource, /setTimeout\(r, SCAN_READ_DELAY_MS\)/);
});

test('jeda antar frame cukup cepat agar terasa real-time', () => {
  assert.ok(SCAN_FRAME_GAP_MS > 0 && SCAN_FRAME_GAP_MS <= 1000, `dapat ${SCAN_FRAME_GAP_MS}`);
});

// ---------------------------------------------------------------------------
// Buffer & bingkai
// ---------------------------------------------------------------------------

test('hanya frame terbaik yang disimpan, tidak menumpuk', () => {
  let kept = [];
  for (let i = 0; i < 200; i += 1) kept = keepBestFrames(kept, frame(i));
  assert.strictEqual(kept.length, MAX_FRAMES_TO_SEND);
  assert.strictEqual(kept[0].sharpness, 199);
});

test('frame terbaik dikirim lebih dulu', () => {
  const ordered = orderFramesForUpload([frame(10), frame(900), frame(300)]);
  assert.deepStrictEqual(ordered.map((f) => f.sharpness), [900, 300, 10]);
});

test('daftar frame kosong tidak melempar error', () => {
  assert.deepStrictEqual(orderFramesForUpload([]), []);
  assert.strictEqual(keepBestFrames([], frame(5)).length, 1);
});

test('bingkai panduan tetap ada sebagai petunjuk visual', () => {
  const style = guideFrameStyle();
  assert.strictEqual(style.width, `${SCAN_GUIDE.widthRatio * 100}%`);
  assert.strictEqual(style.height, `${SCAN_GUIDE.heightRatio * 100}%`);
  assert.match(componentSource, /guideFrameStyle\(\)/);
  assert.ok(SCAN_GUIDE.heightRatio > SCAN_GUIDE.widthRatio);
});
