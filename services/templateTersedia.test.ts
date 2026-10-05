import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * "Template belum tersedia dari backend utama" — apa yang sebenarnya terjadi,
 * dan kenapa pesannya menyesatkan.
 *
 * Diukur dulu: endpoint template menjawab HTTP 200 dua belas kali berturut, dan
 * aplikasi desktop MENYIMPAN daftar template yang lengkap di localStorage. Jadi
 * datanya ADA. Yang salah adalah penanganan kegagalannya:
 *
 *   1. `setFrames([])` di jalur gagal. Satu permintaan tersendat menghapus daftar
 *      yang sudah benar — padahal template tidak berubah. Dan karena daftar yang
 *      dihapus tidak pernah diambil kembali, kiosk tidak pulih sampai aplikasi
 *      dibuka ulang.
 *   2. Tidak ada percobaan ulang otomatis.
 *   3. Satu pesan untuk dua sebab berbeda: "backend tidak punya template" dan
 *      "daftar masih dimuat" — padahal tindakan perbaikannya berbeda.
 *
 * Test ini mengunci ketiganya, plus satu jebakan yang mudah terjadi lagi:
 * backend yang menjawab 200 dengan daftar kosong TIDAK boleh menyisakan layar
 * tanpa penjelasan.
 */

const BOOTH = '/Users/nadine/Unismiles/unismiles-photobooth/components/PhotoBooth.tsx';
const booth = readFileSync(BOOTH, 'utf8');

/** Badan fungsi refreshFrames, untuk memeriksa perilakunya. */
function badanRefreshFrames(): string {
  const mulai = booth.indexOf('const refreshFrames = useCallback(');
  assert.ok(mulai > 0, 'refreshFrames harus ada');
  // Hingga akhir deklarasi useCallback berikutnya (penanda akhir yang stabil).
  const akhir = booth.indexOf('}, []);', mulai);
  assert.ok(akhir > mulai, 'akhir refreshFrames harus ditemukan');
  return booth.slice(mulai, akhir);
}

test('kegagalan TIDAK mengosongkan daftar template', () => {
  const badan = badanRefreshFrames();
  // Ini inti perbaikannya: tidak boleh ada setFrames([]) di jalur gagal.
  assert.ok(!/setFrames\(\[\]\)/.test(badan),
    'refreshFrames tidak boleh mengosongkan daftar saat gagal — itu yang menyebabkan pesan "Template belum tersedia" padahal data ada');
});

test('kegagalan memakai salinan terakhir yang berhasil, bukan daftar kosong', () => {
  const badan = badanRefreshFrames();
  assert.ok(badan.includes('bacaTemplatesTersimpan()'),
    'salinan template terakhir harus dipakai saat backend tidak terjangkau');
  // Salinan harus disimpan setiap kali pengambilan berhasil.
  assert.match(badan, /localStorage\.setItem\(STORAGE_KEYS\.FRAMES/,
    'setiap keberhasilan harus menyimpan salinan');
  // Dan pembacanya harus ada di berkas ini.
  assert.match(booth, /export const bacaTemplatesTersimpan = \(\): FrameLayout\[\] => \{/,
    'fungsi pembaca salinan harus ada');
});

test('ada percobaan ulang otomatis sebelum menyerah', () => {
  const badan = badanRefreshFrames();
  // Tanpa percobaan ulang, gangguan jaringan sesaat langsung jadi galat layar.
  assert.match(badan, /percobaan = 3/, 'harus ada percobaan ulang dengan jumlah default');
  assert.match(badan, /setTimeout\(.*800 \* \(i \+ 1\)\)/, 'jeda antar percobaan harus ada');
});

test('dua sebab yang berbeda tidak lagi memakai pesan yang sama', () => {
  // Sebab 1: backend menjawab, tapi daftar kosong -> pesan yang menyuruh
  // memeriksa template aktif di Admin.
  assert.ok(booth.includes('Backend menjawab, tetapi daftar template kosong'),
    'daftar kosong dari backend harus punya pesan sendiri');
  // Sebab 2: daftar masih dimuat -> pesan menunggu, bukan "tidak tersedia".
  assert.ok(booth.includes('Template sedang dimuat dari server'),
    'daftar yang masih dimuat harus punya pesan menunggu');
  // Pesan lama yang menyesatkan tidak boleh dipakai lagi di jalur itu.
  assert.ok(!booth.includes("templateError || 'Template belum tersedia dari backend utama.'"),
    'pesan lama tidak boleh dipakai untuk kasus "masih dimuat"');
});

test('backend yang menjawab 200 dengan daftar kosong tidak menyisakan layar bisu', () => {
  const badan = badanRefreshFrames();
  // Harus ada penanganan khusus untuk keadaan itu (bukan hanya menunggu gagal).
  assert.ok(badan.includes('terakhirKosong'),
    'daftar kosong dari backend harus dilacak terpisah dari kegagalan jaringan');
  assert.match(badan, /setTemplateError\('Backend menjawab/, 
    'daftar kosong harus menghasilkan pesan, bukan layar tanpa penjelasan');
});

test('pesan "masih dimuat" hilang sendiri setelah template siap', () => {
  // Kalau tidak, pembeli yang menekan Start terlalu cepat melihat pesan galat
  // yang menetap padahal kiosknya sudah siap — dan menyimpulkan mesinnya rusak.
  assert.match(booth, /sebelumnya\.includes\('Template sedang dimuat'\)/,
    'pesan "sedang dimuat" harus dibersihkan saat daftar berhasil dimuat');
});
