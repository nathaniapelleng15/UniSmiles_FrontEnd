/**
 * Menggambar gambar yang akan DICETAK: isi slot frame saja, tanpa frame-nya.
 *
 * Kenapa fungsi ini terpisah dari `PhotoBooth.generateCompositeImage`:
 * pratinjau dan berkas unduhan memang ingin frame lengkap — background, artwork,
 * border slot, dan teks. Printer tidak: kertas label sudah punya desain
 * tercetak, dan yang boleh tercetak hanya bagian yang MEMANG dibatasi frame saat
 * foto diambil.
 *
 * Dipisah ke modul yang tidak menyentuh DOM supaya bisa DIEKSEKUSI di test.
 * Sebelumnya perhitungan ini hidup di dalam komponen, sehingga kesalahan seperti
 * "seluruh bidang kamera ikut tercetak" tidak mungkin tertangkap oleh test —
 * hanya terlihat di kertas.
 */

export interface PrintSlot {
  width: number;
  height: number;
}

/** Konteks gambar seminimal mungkin yang dibutuhkan di sini. */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  drawImage(
    img: CanvasImageSource,
    sx: number, sy: number, sw: number, sh: number,
    dx: number, dy: number, dw: number, dh: number,
  ): void;
}

/** Sumber gambar seminimal mungkin: hanya ukuran aslinya yang dipakai. */
export interface SizedImage {
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Gambar `img` mengisi seluruh area dengan rasio dipertahankan — kelebihan
 * dipotong, bukan digepengkan. Perilaku "cover", sama dengan pratinjau.
 */
export function paintCover(
  ctx: PaintContext,
  img: SizedImage,
  width: number,
  height: number,
  dx = 0,
  dy = 0,
): void {
  const ir = img.naturalWidth / img.naturalHeight;
  const sr = width / height;
  let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
  if (ir > sr) { sw = sh * sr; sx = (img.naturalWidth - sw) / 2; }
  else { sh = sw / sr; sy = (img.naturalHeight - sh) / 2; }
  ctx.drawImage(img as unknown as CanvasImageSource, sx, sy, sw, sh, dx, dy, width, height);
}

/**
 * Isi kanvas dengan foto, sebatas slot.
 *
 * Sengaja hanya menggambar: latar putih lalu fotonya. Tidak ada background
 * frame, artwork frame, border slot, maupun elemen teks — kalau salah satu
 * ditambahkan di sini, frame akan muncul lagi di kertas.
 */
export function paintPrintImage(
  ctx: PaintContext,
  img: SizedImage,
  slot: PrintSlot,
): void {
  // Latar putih supaya sisa label tidak hitam kalau rasio foto berbeda.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, slot.width, slot.height);
  paintCover(ctx, img, slot.width, slot.height);
}
