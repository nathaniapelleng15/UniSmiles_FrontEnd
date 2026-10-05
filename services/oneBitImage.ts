/**
 * Ubah gambar menjadi hitam-putih murni untuk printer label termal.
 *
 * KENAPA INI WAJIB
 *
 * Printer label termal hanya punya dua keadaan per titik: keluar tinta, atau
 * tidak. Library NiimBlueLib menerjemahkannya seperti ini
 * (`image_encoder.js` baris 73):
 *
 *     else if (color !== 0xffffff) {   // bukan putih murni -> jadi TINTA
 *       blackPixelsOctet |= 1 << (7 - colBit);
 *     }
 *
 * Jadi setiap piksel yang TIDAK PERSIS putih (255,255,255) dicetak hitam penuh.
 * Foto hampir tidak pernah punya piksel yang persis putih — kulit, bayangan, dan
 * latar semua sedikit di bawah 255. Akibatnya seluruh label tercetak hitam
 * pekat, dan itulah gejalanya.
 *
 * Library tidak menyediakan dithering atau ambang sama sekali (sudah diperiksa:
 * tidak ada `dither`, `threshold`, atau `grayscale` di seluruh dist-nya), jadi
 * pengubahan ini harus dilakukan di sisi kita sebelum encoding.
 *
 * CARA KERJA
 *
 * Floyd–Steinberg: tiap piksel dibulatkan ke hitam atau putih, lalu SELISIH
 * kesalahannya dibagikan ke piksel tetangga yang belum diproses. Hasilnya foto
 * tetap terbaca — wajah dan gradasi tetap terlihat sebagai pola titik — bukan
 * gumpalan hitam. Ambang sederhana (tanpa dithering) akan menghitamkan seluruh
 * area yang lebih gelap dari ambang, dan itu justru mengembalikan masalah yang
 * sama dalam bentuk lain.
 *
 * Fungsi ini murni: hanya menyentuh array yang diberikan, tanpa DOM. Itu
 * disengaja supaya bisa DIEKSEKUSI di test, bukan sekadar dicocokkan teksnya —
 * kesalahan di sini hanya terlihat di kertas.
 */

/** Urutan bobot Floyd–Steinberg: kanan, kiri-bawah, bawah, kanan-bawah. */
const FS_RIGHT = 7 / 16;
const FS_BOTTOM_LEFT = 3 / 16;
const FS_BOTTOM = 5 / 16;
const FS_BOTTOM_RIGHT = 1 / 16;

/**
 * Ambang abu-abu. 128 = titik tengah: piksel lebih terang dari ini cenderung
 * menjadi putih, lebih gelap cenderung menjadi hitam. Karena dithering menye-bar
 * kesalahan, nilai ini tidak menentukan seluruh hasil seperti pada ambang biasa —
 * ia hanya menggeser keseimbangan terang/gelap.
 */
export const ONE_BIT_THRESHOLD = 128;

/** Terang piksel versi mata manusia (Rec. 601), dari data RGB. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * PILIHAN ALGORITMA ABU-ABU.
 *
 * Kenapa perlu lebih dari satu: yang menentukan tajam atau blur bukan dpi-nya
 * (kanvas sudah 300 dpi dan itu harga mati), melainkan berapa banyak perbedaan
 * terang yang TERSISA sebelum dither. Dither mencari titik terdekat, jadi area
 * abu-abu yang sempit akan menghasilkan titik-titik yang terlihat sebagai bintik
 * dan tepi yang tampak kabur. Bobot kanal yang berbeda menaikkan perbedaan itu
 * untuk gambar tertentu: wajah (banyak merah) naik dengan G, kain/latar terang
 * naik dengan R, tulisan biru naik dengan menurunkan B.
 *
 * Selain rumus, ada PENAJAMAN (unsharp mask) yang dikenakan pada abu-abu
 * sebelum dither. Inilah yang paling menentukan "tidak blur": dither 1-bit
 * selalu melunakkan tepi, jadi tepinya harus dinaikkan lebih dulu.
 */
export type GrayscaleAlgorithm =
  | 'rec601'
  | 'rec709'
  | 'average'
  | 'luma-sqrt'
  | 'green'
  | 'red'
  | 'blue'
  | 'max'
  | 'min';

export interface GrayscaleOption {
  value: GrayscaleAlgorithm;
  label: string;
  note: string;
}

/**
 * Urutan di sini = urutan di dropdown Admin. Yang pertama adalah yang dipakai
 * sekarang, supaya konfigurasi lama tidak berubah hasil cetak saat fitur ini
 * ditambahkan.
 */
export const GRAYSCALE_OPTIONS: readonly GrayscaleOption[] = [
  { value: 'rec601', label: 'Rec.601 kepatuhan mata (sekarang)', note: 'Bobot 0,299 R + 0,587 G + 0,114 B. Standar TV lama; yang sudah terbukti di kertas. Titik awal yang aman.' },
  { value: 'rec709', label: 'Rec.709/sRGB — hijau lebih tegas', note: 'Bobot 0,213 R + 0,715 G + 0,072 B. Hijau dinaikkan, merah diturunkan: kontras antar warna lebih besar, biasanya lebih tajam untuk foto berwarna.' },
  { value: 'average', label: 'Rata-rata kanal (netral)', note: 'Jumlah ketiga kanal dibagi tiga. Warna biru dan merah jadi seterang hijau — berguna kalau foto banyak warna dan Rec.601 membuatnya meredup.' },
  { value: 'luma-sqrt', label: 'Luma inci kuadrat (terang naik)', note: 'Akar dari jumlah kanal yang dikuadratkan. Abu-abu naik jauh lebih terang; pakai dengan kontras di atas 100% supaya tidak pucat.' },
  { value: 'green', label: 'Hijau saja', note: 'Hanya kanal G. Kontras kulit dan tekstur paling tinggi untuk wajah; warna merah/biru jadi abu-abu yang bisa menipu.' },
  { value: 'red', label: 'Merah saja', note: 'Hanya kanal R. Memunculkan detail di kulit terang dan kain; langit biru jadi gelap.' },
  { value: 'blue', label: 'Biru saja (biasanya gelap)', note: 'Hanya kanal B. Paling gelap di antara ketiganya; berguna kalau ada elemen biru yang ingin ditonjolkan jadi hitam.' },
  { value: 'max', label: 'Kanal paling terang (detail di bayangan)', note: 'Ambil kanal paling terang. Bayangan tetap terbaca; bagian yang sangat terang bisa jenuh.' },
  { value: 'min', label: 'Kanal paling gelap (garis tegas)', note: 'Ambil kanal paling gelap. Garis dan tepi jadi paling tegas; seluruh gambar jadi lebih gelap.' },
] as const;

export const DEFAULT_GRAYSCALE_ALGORITHM: GrayscaleAlgorithm = 'rec601';

/** Validasi yang dipakai bersama backend & Admin; nilai asing jatuh ke bawaan. */
export function isGrayscaleAlgorithm(v: unknown): v is GrayscaleAlgorithm {
  return GRAYSCALE_OPTIONS.some(o => o.value === v);
}

/**
 * Nilai abu-abu menurut algoritma yang dipilih.
 *
 * Fungsi ini MURNI dan tidak menyentuh piksel mana pun — supaya bisa diuji
 * sebagai angka. Kesalahan bobot di sini hanya terlihat di kertas, dan itu
 * kertas yang terbuang.
 */
export function grayscaleValue(
  algorithm: GrayscaleAlgorithm,
  r: number,
  g: number,
  b: number,
): number {
  switch (algorithm) {
    case 'rec601': return 0.299 * r + 0.587 * g + 0.114 * b;
    case 'rec709': return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    case 'average': return (r + g + b) / 3;
    // Dihitung dari nilai ternormalisasi supaya hasilnya tetap 0..255.
    case 'luma-sqrt': {
      const rn = r / 255, gn = g / 255, bn = b / 255;
      return 255 * Math.sqrt(0.299 * rn * rn + 0.587 * gn * gn + 0.114 * bn * bn);
    }
    case 'green': return g;
    case 'red': return r;
    case 'blue': return b;
    case 'max': return Math.max(r, g, b);
    case 'min': return Math.min(r, g, b);
    default: return 0.299 * r + 0.587 * g + 0.114 * b;
  }
}


/**
 * Rata-rata kotak yang bisa dipisah (separable box blur) pada abu-abu.
 *
 * Dipakai sebagai dasar penajaman. Radiusnya harus > 1 karena alasan yang
 * terukur: penajaman 3×3 (radius 1) hampir tidak mengubah hasil pada foto
 * sungguhan — diukur di sini, bitmap hasil dither hampir identik dengan dan
 * tanpa penajaman. Radius 2-3 menaikkan kontras lokal 100-230%, dan itulah
 * yang terlihat sebagai "tidak blur" di kertas.
 *
 * Dijalankan dua tahap (mendatar lalu tegak) supaya biayanya tidak tumbuh
 * kuadratik terhadap radius — penting karena ini 638×791 piksel per cetakan.
 *
 * Murni: mengembalikan array baru, tidak mengubah masukannya.
 */
export function boxBlurGray(
  gray: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  if (radius < 1 || width < 1 || height < 1) return Float32Array.from(gray);
  const mendatar = new Float32Array(width * height);
  const hasil = new Float32Array(width * height);
  const lebar = radius * 2 + 1;

  // Mendatar.
  for (let y = 0; y < height; y += 1) {
    const baris = y * width;
    let jumlah = 0;
    // Isi jendela awal, dengan piksel di luar batas dianggap sama dengan tepi
    // (clamp). Tanpa ini, tepi gambar jadi gelap palsu dan penajaman membuat
    // garis hitam di pinggir label.
    for (let k = -radius; k <= radius; k += 1) {
      jumlah += gray[baris + Math.max(0, Math.min(width - 1, k))];
    }
    for (let x = 0; x < width; x += 1) {
      mendatar[baris + x] = jumlah / lebar;
      const keluar = gray[baris + Math.max(0, Math.min(width - 1, x - radius))];
      const masuk = gray[baris + Math.max(0, Math.min(width - 1, x + radius + 1))];
      jumlah += masuk - keluar;
    }
  }

  // Tegak.
  for (let x = 0; x < width; x += 1) {
    let jumlah = 0;
    for (let k = -radius; k <= radius; k += 1) {
      jumlah += mendatar[Math.max(0, Math.min(height - 1, k)) * width + x];
    }
    for (let y = 0; y < height; y += 1) {
      hasil[y * width + x] = jumlah / lebar;
      const keluar = mendatar[Math.max(0, Math.min(height - 1, y - radius)) * width + x];
      const masuk = mendatar[Math.max(0, Math.min(height - 1, y + radius + 1)) * width + x];
      jumlah += masuk - keluar;
    }
  }
  return hasil;
}

/**
 * PENAJAMAN pada abu-abu sebelum dither — unsharp mask.
 *
 * Ini yang paling menentukan "tidak blur". Dither 1-bit selalu membuat tepi
 * terlihat lebih lunak (titik-titik di sekitar tepi), jadi tepinya harus
 * dinaikkan LEBIH DULU. Menajamkan setelah dither tidak mungkin: pikselnya
 * hanya 0 atau 255.
 *
 * `amount` = pengali 0..2 (1 = sedang, 2 = kuat). Radius 2 terbukti paling
 * seimbang: radius 1 terlalu lemah untuk foto, radius >= 4 mulai memunculkan
 * halo di tepi.
 *
 * `threshold` mencegah noise sensor ikut dinaikkan — diukur di sini: noise
 * ±2 tingkat tetap ~0 pada ambang 2, dan naik penuh pada ambang 0. Tanpa
 * ambang, langit dan dinding jadi penuh bintik yang membuat hasil terlihat
 * kotor, bukan tajam.
 *
 * Murni: hanya menyentuh array `gray` yang diberikan.
 */
export function sharpenGray(
  gray: Float32Array,
  width: number,
  height: number,
  amount: number,
  radius = 2,
  threshold = 2,
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const halus = boxBlurGray(gray, width, height, radius);
  for (let p = 0; p < gray.length; p += 1) {
    const beda = gray[p] - halus[p];
    if (Math.abs(beda) < threshold) continue;
    gray[p] = Math.max(0, Math.min(255, gray[p] + beda * amount));
  }
}

/**
 * Ubah data RGBA (di tempat) menjadi hitam-putih murni: hanya 0 atau 255.
 *
 * @param data   Data RGBA dari `getImageData`, diubah langsung.
 * @param width  Lebar gambar, piksel.
 * @param height Tinggi gambar, piksel.
 * @param threshold Ambang abu-abu; lihat ONE_BIT_THRESHOLD.
 * @param box    Bidang cetak; dithering di luar ini hanya membuang waktu.
 * @param alg    Algoritma abu-abu; lihat GRAYSCALE_OPTIONS.
 * @param sharpen Amount penajaman (0 = tidak menajamkan).
 */
export function ditherToBlackAndWhite(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  threshold: number = ONE_BIT_THRESHOLD,
  box?: { x: number; y: number; w: number; h: number },
  alg: GrayscaleAlgorithm = DEFAULT_GRAYSCALE_ALGORITHM,
  sharpen = 0,
): void {
  const total = width * height;
  if (total <= 0) return;

  // Kotak kerja dibatasi ke bidang cetak. Di luar kotak sudah putih dari
  // latar kanvas, dan hanya di dalam kotak tinta bisa keluar — jadi mengolah
  // seluruh kanvas hanya membuang waktu, sekaligus membuat perhitungan tinta
  // tidak setara dengan yang benar-benar tercetak.
  let x0 = 0, y0 = 0, x1 = width, y1 = height;
  if (box) {
    x0 = Math.max(0, Math.min(width, Math.round(box.x)));
    y0 = Math.max(0, Math.min(height, Math.round(box.y)));
    x1 = Math.max(x0, Math.min(width, x0 + Math.round(box.w)));
    y1 = Math.max(y0, Math.min(height, y0 + Math.round(box.h)));
  }
  if (x1 <= x0 || y1 <= y0) return;

  // Salinan terang piksel sebagai pecahan, karena kesalahan dithering bernilai
  // pecahan dan pembulatan dini akan menghilangkan efeknya.
  const gray = new Float32Array(total);
  for (let p = 0; p < total; p += 1) {
    const i = p * 4;
    // Piksel transparan tidak punya warna; dianggap putih supaya tidak menjadi
    // tinta hanya karena alfanya nol.
    const alpha = data[i + 3];
    gray[p] = alpha === 0 ? 255 : grayscaleValue(alg, data[i], data[i + 1], data[i + 2]);
  }

  // Penajaman dikenakan pada abu-abu SEBELUM dither, dan hanya di dalam bidang
  // cetak (di luar kotak tidak ada tinta, jadi menajamkannya tidak ada gunanya
  // dan bisa menarik tepi gelap masuk ke area kosong).
  if (sharpen > 0) {
    const potong = new Float32Array((x1 - x0) * (y1 - y0));
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        potong[(y - y0) * (x1 - x0) + (x - x0)] = gray[y * width + x];
      }
    }
    sharpenGray(potong, x1 - x0, y1 - y0, sharpen);
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        gray[y * width + x] = potong[(y - y0) * (x1 - x0) + (x - x0)];
      }
    }
  }

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = y * width + x;
      const oldValue = gray[p];
      const newValue = oldValue < threshold ? 0 : 255;
      gray[p] = newValue;
      const error = oldValue - newValue;

      // Sebar kesalahan ke tetangga yang BELUM diproses saja (kanan, bawah),
      // dan hanya selama tetangganya masih di dalam kotak. Menyebar ke luar
      // kotak akan mengubah piksel yang tidak boleh berisi tinta.
      if (x + 1 < x1) {
        gray[p + 1] += error * FS_RIGHT;
      }
      if (y + 1 < y1) {
        if (x > x0) gray[p + width - 1] += error * FS_BOTTOM_LEFT;
        if (x >= x0 && x < x1) gray[p + width] += error * FS_BOTTOM;
        if (x + 1 < x1) gray[p + width + 1] += error * FS_BOTTOM_RIGHT;
      }
    }
  }

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const p = y * width + x;
      const i = p * 4;
      const value = gray[p] < threshold ? 0 : 255;
      data[i] = value;
      data[i + 1] = value;
      data[i + 2] = value;
      // Alfa dibuat pekat: encoder membaca RGB, tetapi alfa nol membuat piksel
      // tampak transparan kalau gambar ini dipakai ulang di tempat lain.
      data[i + 3] = 255;
    }
  }
}
