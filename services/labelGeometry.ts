/**
 * Geometri label termal — perhitungan murni, tanpa dependensi.
 *
 * Dipisah dari `niimbotPrinter.ts` supaya bisa benar-benar DIEKSEKUSI di test
 * tanpa Web Bluetooth maupun library printer. Perhitungan lebar adalah bagian
 * yang paling menentukan hasil cetak (salah 9 px = tepi label terpotong tanpa
 * error), jadi ia tidak boleh hanya diuji dengan memeriksa teks kode.
 */

/**
 * Lebar kepala cetak B1 Pro menurut PENGUKURAN DI KERTAS pada unit yang dipakai
 * UniSmiles: kolom 0-575 keluar, kolom 576 ke atas tidak, tanpa pesan error.
 *
 * CATATAN PENTING: NiimBlueLib (`@mmote/niimbluelib`) menulis 567 untuk model
 * B1_PRO. Angka itu berasal dari tabel model, bukan dari unit ini. Selisihnya
 * 9 px ≈ 0,76 mm — cukup untuk memotong tepi label. Karena pengukuran langsung
 * lebih kuat daripada tabel, yang dipakai adalah 576.
 *
 * Kalau nanti berganti unit printer, UKUR LAGI jangan salin angka ini.
 */
export const B1_PRO_PRINTHEAD_PX = 576;

/** DPI label B1 Pro (dari tabel model NiimBlueLib). */
export const LABEL_DPI = 300;

export interface LabelSize {
  /** Lebar gambar yang dikirim ke printer (px). Selalu dikunci ke kepala cetak. */
  widthPx: number;
  /** Tinggi gambar (px). */
  heightPx: number;
  /** Lebar kertas yang diminta (px), sebelum dikunci. */
  requestedWidthPx: number;
  /** Benar bila lebar terpaksa dipotong karena melebihi kepala cetak. */
  clamped: boolean;
}

/**
 * Hitung ukuran gambar untuk label dari ukuran kertas dalam milimeter.
 *
 * Lebar SELALU dikunci ke kepala cetak, dan tinggi ikut diskalakan dengan faktor
 * yang sama. Itu penting: kalau hanya lebarnya yang dipotong sementara tinggi
 * dibiarkan penuh, rasio gambar berubah (54 x 67 mm jadi 576 x 791 px = 0,73,
 * padahal kertasnya 0,81), sehingga gambar gepeng DAN tepi kanan hilang tanpa
 * pesan error apa pun.
 *
 * Konsekuensinya harus jujur disebutkan: ketika kertas lebih lebar daripada
 * kepala cetak, gambarnya diperkecil supaya muat seluruhnya, bukan dipotong.
 * Semua yang difoto tetap tercetak; yang berkurang hanya skalanya.
 */
export function labelSize(
  widthMm: number,
  heightMm: number,
  printheadPx: number = B1_PRO_PRINTHEAD_PX,
): LabelSize {
  // Nilai rusak (NaN, nol, negatif) jatuh ke 1 px, bukan NaN. Ukuran NaN akan
  // membuat canvas berlebar NaN dan encoder gagal tanpa pesan yang jelas.
  const px = (mm: number) => (Number.isFinite(mm) && mm > 0
    ? Math.max(1, Math.round((mm / 25.4) * LABEL_DPI))
    : 1);
  const requestedWidthPx = px(widthMm);
  const requestedHeightPx = px(heightMm);

  // Kanvas = ukuran KERTAS, tanpa dipangkas.
  //
  // SEBELUMNYA lebar dipangkas ke kepala cetak (576 px) dan tingginya ikut
  // diskalakan. Akibatnya skala gambar bukan lagi 300 dpi (menjadi ~271 dpi),
  // sehingga "margin 3 mm" tidak lagi 3 mm di kertas — seluruh kalibrasi
  // meleset. Untuk label yang punya area cetak, ukuran kertas harus utuh.
  //
  // Yang membatasi tinta sekarang adalah KOTAK CETAK: margin (dan batas kepala
  // cetak) memotongnya, jadi piksel di luar area cetak tidak pernah berisi
  // gambar. Itu juga yang membuat sisi kanan 54 mm yang tidak terjangkau
  // printer tidak lagi "memotong" foto — di sana memang tidak ada tinta.
  const clamped = requestedWidthPx > printheadPx;
  return { widthPx: requestedWidthPx, heightPx: requestedHeightPx, requestedWidthPx, clamped };
}

/** Konversi milimeter ke piksel pada DPI label. */
export function mmToPx(mm: number, dpi: number = LABEL_DPI): number {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}


/**
 * Ukuran label (mm) dari pengaturan ukuran kertas Admin.
 *
 * Halaman Pengaturan Admin menyimpan ukuran kertas sebagai string, baik nama
 * preset maupun "CUSTOM 54X67 MM". Fungsi ini menerjemahkannya menjadi ukuran
 * label yang bisa dipakai printer.
 *
 * Bawaan 54 x 67 mm adalah kertas label yang dipakai saat ini. Lebarnya
 * MELEBIHI kepala cetak, jadi `labelSize()` akan mengunci gambarnya ke 576 px
 * dan sisi kanan 5,25 mm tidak tercetak — itu sifat printer, bukan kesalahan
 * di sini, dan sengaja tidak disembunyikan.
 */
export const DEFAULT_LABEL_MM = { widthMm: 54, heightMm: 67 } as const;

/**
 * Kertas label yang punya AREA CETAK sendiri (preset dari Admin).
 *
 * Label Polaroid bukan kertas kosong: bingkainya sudah tercetak, jadi ukuran
 * kertasnya harus dikenali walau yang tersimpan hanya NAMANYA, bukan "CUSTOM ..".
 * Marginnya tidak diambil dari sini melainkan dari pengaturan cetak (px), supaya
 * hanya ada satu angka yang berlaku saat mencetak.
 */
const LABEL_PAPER_MM: Record<string, { widthMm: number; heightMm: number }> = {
  'nimbotpaper-polaroid': { widthMm: 54, heightMm: 67 },
};

export function labelMmFromPaperSize(paperSize: string | null | undefined): { widthMm: number; heightMm: number } {
  const preset = LABEL_PAPER_MM[String(paperSize || '').trim().toLowerCase()];
  if (preset) return { ...preset };
  const match = String(paperSize || '').trim().match(/CUSTOM\s+(\d{1,3})\s*[X×]\s*(\d{1,3})\s*MM/i);
  if (match) {
    const widthMm = Number(match[1]);
    const heightMm = Number(match[2]);
    // Nilai 0 dari ukuran rusak akan membuat canvas 0 px dan encodeCanvas gagal
    // dengan pesan yang tidak informatif; jatuh ke bawaan lebih berguna.
    if (widthMm > 0 && heightMm > 0) return { widthMm, heightMm };
  }
  return { widthMm: DEFAULT_LABEL_MM.widthMm, heightMm: DEFAULT_LABEL_MM.heightMm };
}


/**
 * KOTAK CETAK untuk kertas yang BINGKAINYA sudah tercetak.
 *
 * Kertas label seperti Polaroid 54 x 67 mm bukan kertas kosong: bingkai film
 * strip-nya sudah tercetak, dan hanya ada satu bidang putih di tengahnya yang
 * boleh diisi tinta. Kalau foto diisi ke seluruh kertas, gambar menimpa bingkai
 * dan nomor frame — hasilnya terlihat "tidak sesuai" walau printernya benar.
 *
 * Angka di bawah = kotak putih label yang dipakai, dalam piksel pada 300 dpi:
 *
 *   kiri 0 px (0,00 mm) | kanan 83 px (7,03 mm)   -> 54 - 0 - 7,03 = 46,97 mm
 *   atas 70 px (5,93 mm) | bawah 154 px (13,04 mm) -> 67 - 5,93 - 13,04 = 48,03 mm
 *   kotak 555 x 567 px = 46,99 x 48,01 mm, di x=0 y=70
 *   jumlah: 0 + 555 + 83 = 638 px (54 mm), 70 + 567 + 154 = 791 px (67 mm)
 *
 * Riwayat penyesuaian di kertas: 46x46 -> 47x47 -> 47x48 (ukuran), lalu blok
 * kotak digeser TURUN supaya tepi ATAS foto tidak keluar dari bingkai
 * (atas 35 -> 70 px; bawah mengikuti agar tinggi kotak tetap 567).
 * Kotaknya TIDAK persegi (47:48) — itu permintaan eksplisit. Mode cover menjaga
 * foto tidak di-stretch: kelebihannya dipotong.
 *
 * Diukur dari kertas, bukan dari tabel model. Kanvas 638 x 791 TIDAK dipangkas:
 * yang membatasi tinta adalah kotak ini (tepi kanan 555 masih di bawah kepala
 * cetak 576, jadi tidak ada yang hilang diam-diam).
 *
 * Kalau masih bergeser, yang dikoreksi adalah offset X/Y di Pengaturan Printer —
 * BUKAN angka di sini, supaya ukuran kotaknya tetap 555 x 567 px.
 *
 * `fitMode: 'cover'` bukan pilihan gaya: bingkai yang sudah tercetak menuntut
 * kotaknya TERISI PENUH. Mode 'fit' menyisakan jalur putih di dalam bingkai saat
 * rasio foto berbeda, dan itu terlihat sebagai cetakan yang belum pas.
 */
export const LABEL_FRAME_BOX_PX: Record<string, {
  topPx: number;
  rightPx: number;
  leftPx: number;
  bottomPx: number;
  fitMode: 'cover' | 'fit' | 'stretch';
}> = {
  'nimbotpaper-polaroid': { topPx: 70, rightPx: 83, leftPx: 0, bottomPx: 154, fitMode: 'cover' },
};

/**
 * Kotak cetak untuk nama preset kertas, atau null kalau kertasnya kosong/generik
 * (kertas kosong tidak punya bingkai, jadi seluruh area cetak boleh dipakai).
 */
export function labelFrameBox(paperSize: string | null | undefined) {
  return LABEL_FRAME_BOX_PX[String(paperSize || '').trim().toLowerCase()] || null;
}

export interface DrawRect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  /** Bidang yang boleh berisi tinta. Di luar ini dibiarkan kosong (putih). */
  clipX: number;
  clipY: number;
  clipW: number;
  clipH: number;
}

/**
 * Kotak cetak dari margin empat sisi.
 *
 * Ini yang membuat "area cetak 46 x 46 mm, margin atas 6 mm, kiri 3 mm, bawah
 * 14 mm" bisa diwujudkan: foto tidak lagi mengisi seluruh kanvas, melainkan
 * kotak ini. Di luar kotak dibiarkan kosong.
 *
 * Margin yang melebihi kanvas dijepit, bukan dibiarkan menghasilkan ukuran
 * negatif — kanvas dengan lebar negatif akan gagal tanpa pesan yang jelas.
 */
export function printBox(
  canvasW: number,
  canvasH: number,
  marginTopPx = 0,
  marginRightPx = 0,
  marginLeftPx = 0,
  marginBottomPx = 0,
  printableWidthPx: number = canvasW,
  offsetXPx = 0,
  offsetYPx = 0,
): { x: number; y: number; w: number; h: number } {
  // UKURAN kotak ditentukan HANYA oleh margin. Offset tidak pernah mengubahnya.
  //
  // Ini yang membuat area tetap 46 x 46 mm: kalibrasi memindahkan kotaknya,
  // tidak mengecilkannya. Kalau ukuran ikut dijepit atau dikurangi, yang terjadi
  // bukan kalibrasi melainkan crop — foto terpotong dan areanya menyusut.
  const maxW = Math.max(0, Math.min(canvasW, printableWidthPx));
  const w = clampInt(canvasW - Math.max(0, marginLeftPx) - Math.max(0, marginRightPx), 0, maxW);
  const h = clampInt(canvasH - Math.max(0, marginTopPx) - Math.max(0, marginBottomPx), 0, canvasH);

  // Yang dibatasi hanya TEMPAT BERHENTI-nya: kotak tidak boleh keluar dari
  // kertas maupun dari jangkauan kepala cetak. Sampai di batas, ia berhenti —
  // ukurannya tetap.
  const x = clampInt(Math.max(0, marginLeftPx) + offsetXPx, 0, Math.max(0, maxW - w));
  const y = clampInt(Math.max(0, marginTopPx) + offsetYPx, 0, Math.max(0, canvasH - h));
  return { x, y, w, h };
}

/**
 * Posisi dan ukuran gambar di atas label, sesuai mode penyesuaian.
 *
 * Dipisah dari `prepareCanvas` supaya bisa DIEKSEKUSI di test — `prepareCanvas`
 * butuh canvas sungguhan sehingga perhitungannya tidak pernah teruji, dan
 * kesalahan di sini langsung terlihat di kertas sebagai foto gepeng atau
 * bingkai putih.
 *
 *  - 'fit'     : seluruh foto masuk ke kotak, sisanya putih (ADA bingkai).
 *  - 'cover'   : kotak terisi penuh, rasio dijaga, kelebihan dipotong (TANPA bingkai).
 *  - 'stretch' : kotak dipenuhi apa adanya (bisa gepeng).
 *
 * Semua mode memakai KOTAK CETAK sebagai acuan, bukan seluruh kanvas. Dengan
 * margin nol keduanya sama; dengan margin, foto menempati kotak itu saja dan
 * tidak pernah melimpah keluar.
 */
export function drawRect(
  mode: 'fit' | 'cover' | 'stretch',
  canvasW: number,
  canvasH: number,
  imgW: number,
  imgH: number,
  offsetYPx = 0,
  offsetXPx = 0,
  marginTopPx = 0,
  marginRightPx = 0,
  marginLeftPx = 0,
  marginBottomPx = 0,
  printableWidthPx: number = canvasW,
): DrawRect {
  // Offset diteruskan ke printBox: yang bergeser adalah AREA CETAK, bukan foto
  // di dalamnya. Dulu offset ditambahkan ke posisi gambar sementara kotaknya
  // tetap, sehingga kalibrasi justru memotong foto dan mengubah ukuran area.
  const box = printBox(canvasW, canvasH, marginTopPx, marginRightPx, marginLeftPx, marginBottomPx,
    printableWidthPx, offsetXPx, offsetYPx);
  const clip = { clipX: box.x, clipY: box.y, clipW: box.w, clipH: box.h };

  // Mode stretch (atau gambar rusak): KOTAK dipenuhi apa adanya.
  const base: DrawRect = { dx: box.x, dy: box.y, dw: box.w, dh: box.h, ...clip };
  if (mode === 'stretch' || imgW <= 0 || imgH <= 0 || box.w <= 0 || box.h <= 0) return base;

  // fit = muat di dalam kotak (faktor terkecil), cover = penuhi kotak (terbesar).
  // Bedanya hanya min vs max; keduanya MENJAGA rasio, jadi tidak ada gepeng.
  const scale = mode === 'cover'
    ? Math.max(box.w / imgW, box.h / imgH)
    : Math.min(box.w / imgW, box.h / imgH);

  // +2 px hanya untuk cover: menutup celah sub-piksel akibat pembulatan, supaya
  // tidak ada garis putih tipis di tepi.
  const pad = mode === 'cover' ? 2 : 0;
  const dw = Math.max(1, Math.round(imgW * scale) + pad);
  const dh = Math.max(1, Math.round(imgH * scale) + pad);

  // Dipusatkan di dalam KOTAK. Tidak ada offset di sini: kalau ada, foto akan
  // bergeser keluar kotak dan terpotong — persis yang harus dihindari.
  return {
    ...clip,
    dw,
    dh,
    dx: Math.round(box.x + (box.w - dw) / 2),
    dy: Math.round(box.y + (box.h - dh) / 2),
  };
}

/** Bulatkan lalu jepit ke rentang, supaya margin tidak pernah menghasilkan nilai negatif. */
function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}


export interface Slot {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Slot pertama dari konfigurasi layout — area yang dibingkai frame saat foto
 * diambil. Inilah satu-satunya bagian yang boleh dicetak.
 *
 * Dipisah dari komponen supaya bisa dieksekusi di test: kesalahan di sini
 * langsung terlihat di kertas sebagai bagian foto yang ikut tercetak di luar
 * bingkai, dan itu tidak akan tertangkap oleh test yang hanya mencocokkan teks.
 *
 * Mengembalikan null kalau slot tidak terbaca — pemanggil harus punya cadangan,
 * bukan diam-diam mencetak seluruh kanvas.
 */
export function firstSlot(
  slots: Slot[] | null | undefined,
): { width: number; height: number } | null {
  const slot = Array.isArray(slots) ? slots[0] : null;
  if (!slot) return null;
  const width = Math.round(Number(slot.width));
  const height = Math.round(Number(slot.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}
