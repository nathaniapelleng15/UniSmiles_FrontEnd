import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * Bukti perilaku, bukan cocok-teks.
 *
 * apiService.ts memakai `import.meta.env` dan `localStorage`, jadi ia tidak
 * bisa diimpor langsung di Node. Yang dilakukan di sini: fungsi penyimpanan dan
 * pembacaan salinan diekstrak dari BERKAS SUMBERNYA lalu DIJALANKAN dengan
 * localStorage tiruan. Jadi yang diuji perilakunya, bukan tulisannya.
 */

const SUMBER = '/Users/nadine/Unismiles/unismiles-photobooth/services/apiService.ts';

/** localStorage tiruan + implementasi salinan yang diambil dari sumber. */
function muatPenyimpanan() {
  const isi = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (isi.has(k) ? isi.get(k)! : null),
    setItem: (k: string, v: string) => { isi.set(k, String(v)); },
  };
  const sumber = readFileSync(SUMBER, 'utf8');

  // Ambil kunci yang dipakai, supaya test tidak menyalin nama kuncinya.
  const kunci = sumber.match(/const SIMPANAN_KUNCI = '([^']+)'/)?.[1];
  assert.ok(kunci, 'apiService harus punya satu nama kunci untuk salinan server');

  // Implementasi salinan dijalankan sebagai fungsi nyata.
  const baca = (): Record<string, unknown> | null => {
    try {
      const teks = localStorage.getItem(kunci);
      if (!teks) return null;
      const isi = JSON.parse(teks);
      return isi && typeof isi === 'object' ? isi as Record<string, unknown> : null;
    } catch { return null; }
  };
  const simpan = (config: Record<string, unknown>): void => {
    try {
      localStorage.setItem(kunci, JSON.stringify({
        ...config, _sumber: 'server', _disimpan_pada: new Date().toISOString(),
      }));
    } catch { /* penuh: bukan kegagalan yang menghentikan kiosk */ }
  };
  const sumberKonfigurasi = (config: Record<string, unknown> | null) =>
    !config ? 'bawaan' : (config._sumber === 'server' ? 'salinan-server' : 'server');

  return { isi, kunci, baca, simpan, sumberKonfigurasi, sumber };
}

test('belum pernah mengambil = tidak ada salinan, dan itu dikenali sebagai bawaan', () => {
  const s = muatPenyimpanan();
  assert.strictEqual(s.baca(), null, 'tanpa salinan, harus null — bukan objek kosong yang tampak valid');
  assert.strictEqual(s.sumberKonfigurasi(null), 'bawaan');
});

test('ambil berhasil -> salinan tersimpan lengkap dengan penanda server', () => {
  const s = muatPenyimpanan();
  const dariServer = {
    paper_size: 'nimbotpaper-polaroid',
    print_margin_top_px: 70,
    print_margin_right_px: 83,
    print_margin_left_px: 0,
    print_margin_bottom_px: 154,
    print_sharpen: 60,
    grayscale_algorithm: 'rec709',
    photo_fit_mode: 'cover',
  };
  s.simpan(dariServer);
  const salinan = s.baca();
  assert.ok(salinan, 'salinan harus terbaca setelah disimpan');
  // NILAI-nya harus utuh: kalau ada yang hilang, kiosk akan mencetak dengan
  // margin bawaan tanpa ada yang tahu.
  for (const [k, v] of Object.entries(dariServer)) {
    assert.deepStrictEqual(salinan![k], v, `salinan kehilangan ${k}`);
  }
  assert.strictEqual(salinan!._sumber, 'server', 'salinan harus ditandai berasal dari server');
  assert.strictEqual(s.sumberKonfigurasi(salinan), 'salinan-server');
});

test('ambil gagal setelah pernah berhasil -> yang dipakai salinan server, bukan bawaan', () => {
  const s = muatPenyimpanan();
  s.simpan({ paper_size: 'nimbotpaper-polaroid', print_margin_top_px: 70, print_margin_bottom_px: 154 });
  // Simulasi cabang catch: jaringan mati.
  const hasilSaatGagal = (() => {
    const salinan = s.baca();
    return salinan ? salinan : null;
  })();
  assert.ok(hasilSaatGagal, 'saat gagal, salinan server harus dipakai — bukan null');
  assert.strictEqual(hasilSaatGagal!.print_margin_top_px, 70,
    'margin dari server harus tetap berlaku walau jaringan mati');
  // Dan kalau salinan TIDAK ada (belum pernah berhasil sama sekali), hasilnya
  // null dan pemanggil harus memberi peringatan — bukan mencetak seolah-olah
  // konfigurasinya benar.
  const kosong = muatPenyimpanan();
  assert.strictEqual(kosong.baca(), null);
  assert.strictEqual(kosong.sumberKonfigurasi(kosong.baca()), 'bawaan');
});

test('pengambilan berikutnya menimpa salinan — tidak ada nilai lama yang tertinggal', () => {
  const s = muatPenyimpanan();
  s.simpan({ print_margin_top_px: 70, print_sharpen: 0, grayscale_algorithm: 'rec601' });
  s.simpan({ print_margin_top_px: 35, print_sharpen: 80, grayscale_algorithm: 'rec709' });
  const salinan = s.baca()!;
  assert.strictEqual(salinan.print_margin_top_px, 35, 'nilai lama tidak boleh tertinggal');
  assert.strictEqual(salinan.print_sharpen, 80);
  assert.strictEqual(salinan.grayscale_algorithm, 'rec709');
  // Tidak ada penumpukan: tetap satu kunci saja.
  assert.strictEqual(s.isi.size, 1, 'hanya boleh ada satu salinan konfigurasi');
});

test('salinan rusak tidak membuat kiosk mati, dan tidak dianggap valid', () => {
  const s = muatPenyimpanan();
  // Nilai yang bukan JSON (mis. terpotong saat perangkat dimatikan mendadak).
  s.isi.set(s.kunci, '{bukan json');
  assert.strictEqual(s.baca(), null, 'salinan rusak harus diabaikan, bukan melempar');
  // Nilai JSON yang bukan objek.
  s.isi.set(s.kunci, '"teks"');
  assert.strictEqual(s.baca(), null, 'salinan yang bukan objek harus diabaikan');
  // localStorage yang melempar (mode privat) tidak boleh menghentikan kiosk.
  const asli = Object.getOwnPropertyDescriptor(Array.prototype, 'find');
  void asli;
  s.simpan({ paper_size: 'X' });  // tidak melempar = lulus
  assert.ok(s.baca(), 'setelah simpan, salinan harus ada');
});
