/**
 * Cetak satu halaman ter-encode ke printer label lewat Bluetooth native.
 *
 * KENAPA BERKAS INI ADA (bukan memakai BlePrinterAdapter kiosk-agent)
 *
 * BlePrinterAdapter menerima JALUR BERKAS lalu mendekode PNG-nya sendiri
 * (pngjs). Aplikasi desktop tidak punya berkas: renderer photobooth sudah
 * menyusun dan meng-encode gambar, lalu mengirim hasilnya lewat IPC. Menyalin
 * adapter ke sini akan menyeret jalur berkas, pngjs, dan PrinterAdapter yang
 * tidak dipakai — jadi yang diambil hanya bagian cetaknya.
 *
 * Urutan cetaknya SENGAJA identik dengan kiosk-agent/src/blePrinterAdapter.js:
 * itu urutan yang sudah mencetak label nyata di printer, dan urutan yang berbeda
 * akan terlihat sebagai "gambar terpotong" atau "label tidak maju".
 *
 * Yang TIDAK dipindah ke sini: geometri label, margin, dan kepekatan. Semua itu
 * tetap disusun photobooth di renderer, supaya kalibrasi punya SATU sumber.
 */
const { ImageEncoder, PageColorType } = require('@mmote/niimbluelib');

/** Model untuk memilih print task. B1 Pro memakai task B1. */
const MODEL_BAWAAN = 'B1';

/**
 * Cetak halaman yang sudah di-encode.
 *
 * @param {object} opsi
 * @param {import('@mmote/niimbluelib').NiimbotAbstractClient} opsi.klien klien yang SUDAH tersambung
 * @param {object} opsi.halaman hasil ImageEncoder (rowsData, cols, rows, pageColor)
 * @param {number} [opsi.copies]
 * @param {number} [opsi.density]
 * @param {string} [opsi.model]
 * @param {number} [opsi.labelType] Jenis kertas (LabelType). Dibiarkan kosong =
 *   dibaca otomatis dari printer; itu yang benar, karena bawaan pustaka
 *   (WithGaps) tidak cocok untuk kertas tanpa celah dan membuat satu label
 *   kosong ikut keluar di setiap cetakan.
 * @param {Function} [opsi.onProgress]
 */
async function cetakHalaman({ klien, halaman, copies = 1, density, model, paperEnd, labelType, onProgress }) {
  if (!klien || !klien.isConnected()) throw new Error('Printer belum tersambung.');

  const jumlah = Math.max(1, Number(copies) || 1);

  // PRINT TASK DARI MODEL YANG DIBACA PRINTER, bukan dari bawaan.
  //
  // Ini penyebab cetak gagal berulang kali: dengan bawaan 'B1', printer B1 Pro
  // menerima rangkaian perintah untuk model lain, sehingga pageEnd tidak pernah
  // dijawab dan cetak berakhir "Timeout waiting response (waited for e4)".
  // Pustaka memetakan B1_PRO ke task D110M_V4 (perintah printStart dan
  // ukuran halaman yang berbeda), jadi nilainya diambil dari printer.
  //
  // Urutannya: nilai dari pemanggil, lalu dari klien yang sudah bernegosiasi,
  // baru bawaan — supaya kiosk yang printernya belum terbaca tetap mencoba.
  const tugas = model || (typeof klien.getPrintTaskType === 'function' ? klien.getPrintTaskType() : null) || MODEL_BAWAAN;

  // JENIS KERTAS HARUS MENGIKUTI PRINTER, BUKAN BAWAAN PUSTAKA.
  //
  // Bawaan pustaka adalah WithGaps (kertas bergap). Printer ini melaporkan
  // jenisnya "Black" (tanda hitam) dengan celah 0 mm. Mengirim WithGaps membuat
  // printer MENCARI celah antar label yang tidak ada, lalu memajukan kertas terus
  // setelah halaman selesai — akibatnya satu label kosong ikut keluar di setiap
  // cetakan. Jenis yang benar dibaca dari printernya sendiri; kalau pembacaan
  // gagal, biarkan pustaka memakai bawaannya.
  let jenisKertas = labelType;
  if (jenisKertas === undefined && typeof klien.protocol?.getPaperInfo === 'function') {
    try {
      const info = await klien.protocol.getPaperInfo();
      const nilai = Number(info?.paperType);
      if (info?.valid === true && Number.isInteger(nilai) && nilai > 0) jenisKertas = nilai;
    } catch {
      // Diamkan: printer yang tidak melaporkan info kertas tetap bisa mencetak
      // dengan bawaan pustaka. Kegagalan cetak harus datang dari mencetak.
    }
  }

  // Heartbeat dimatikan selama mencetak: paketnya bisa mengganggu aliran data
  // gambar. Contoh resmi NiimBlueLib melakukan hal yang sama.
  if (typeof klien.stopHeartbeat === 'function') klien.stopHeartbeat();

  // Batas waktu kirim halaman diukur dari ukuran nyata: satu halaman 576x714 px
  // = 714 paket (~59 KB), dan pada jeda paket bawaan 10 ms itu sekitar 7 detik.
  // Batas bawaan 10 detik hampir pasti habis di tengah, dan gejalanya di kertas
  // adalah label keluar TIDAK PENUH. Kelonggaran besar jauh lebih murah
  // daripada label setengah jadi.
  const task = klien.protocol.newPrintTask(tugas, {
    totalPages: jumlah,
    ...(density ? { density } : {}),
    // Jenis kertas dari printer (lihat blok di atas). Tanpa ini, cetak memakai
    // bawaan pustaka dan label kosong ikut keluar.
    ...(jenisKertas === undefined ? {} : { labelType: jenisKertas }),
    statusPollIntervalMs: 100,
    statusTimeoutMs: 15000,
    pageTimeoutMs: 60000,
  });

  await task.printInit();
  for (let halamanKe = 1; halamanKe <= jumlah; halamanKe += 1) {
    await task.printPage(halaman, 1);
    if (typeof task.waitForPageFinished === 'function') await task.waitForPageFinished();
    onProgress?.(halamanKe, jumlah);
  }
  await task.waitForFinished();

  // printEnd MEMINDAHKAN kertas lagi — dan pada kertas label bergap itu berlebih.
  //
  // Pustakanya sendiri menyebut perilaku B1: "when last page (totalPages)
  // printed paper moved further". Karena cetakan kita selalu 1 halaman, halaman
  // itu SELALU halaman terakhir, jadi kertas sudah dimajukan oleh pageEnd.
  // Memanggil printEnd setelahnya membuat SATU perintah cetak mengeluarkan DUA
  // frame label — persis keluhan di lapangan.
  //
  // Perilakunya sekarang mengikuti opsi yang sama dengan jalur Web Bluetooth:
  //   'advance-and-separate' -> printEnd dipanggil (perilaku lama)
  //   'stop-at-printhead'    -> tidak dipanggil, kertas berhenti di kepala cetak
  if (paperEnd === 'stop-at-printhead') {
    return { ok: true, pages: jumlah, paperEnd: 'stop-at-printhead' };
  }
  await task.printEnd();

  return { ok: true, pages: jumlah };
}

module.exports = { cetakHalaman, MODEL_BAWAAN };
