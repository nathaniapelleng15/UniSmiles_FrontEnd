/**
 * Cetak ke printer label NIIMBOT dari browser, memakai NiimBlueLib.
 *
 * Kenapa library ini, bukan driver sendiri:
 *   NiimBlueLib (`@mmote/niimbluelib`) adalah library resmi yang dipakai
 *   niimblue (MultiMote/niimblue) — client web NIIMBOT dengan 760+ bintang, MIT,
 *   dan dipelihara. Protokol NIIMBOT tidak didokumentasikan vendor; menerapkan
 *   ulang handshake, task print, dan pembentukan paket dari nol berarti
 *   memelihara protokol hasil reverse-engineering sendiri. Library ini sudah
 *   mengerjakannya, termasuk tabel model (`getPrintTaskType`) dan encoder
 *   gambar.
 *
 * SATU DEVIASI YANG DISENGAJA — lebar kepala cetak:
 *   NiimBlueLib menulis `printheadPixels: 567` untuk B1_PRO. Pengujian di kertas
 *   pada printer B1 Pro yang dipakai UniSmiles menunjukkan kolom 0-575 KELUAR dan
 *   kolom 576 ke atas TIDAK keluar (tanpa pesan error apa pun). Karena itu
 *   gambar dikunci ke 576 px di sini, bukan 567.
 *
 *   Ini bukan mengabaikan library: 567 dan 576 sama-sama "lebar yang dicetak",
 *   dan angka 576 berasal dari pengukuran langsung di perangkat yang dipakai,
 *   bukan dari tabel model. Selisih 9 px (~0,76 mm) cukup untuk memotong tepi
 *   label — jadi yang dipakai adalah angka yang terbukti.
 */

import { B1_PRO_PRINTHEAD_PX, printBox, type LabelSize } from './labelGeometry.ts';
import {
  ditherToBlackAndWhite, ONE_BIT_THRESHOLD,
  type GrayscaleAlgorithm, DEFAULT_GRAYSCALE_ALGORITHM,
} from './oneBitImage.ts';
import {
  ImageEncoder,
  PageColorType,
  instantiateClient,
  type NiimbotAbstractClient,
  type PrinterModelMeta,
  type PrintTaskName,
  type PrintDirection,
} from '@mmote/niimbluelib';

/**
 * Apa yang dilakukan printer pada akhir cetak.
 *
 *  'advance-and-separate' (bawaan) — printEnd memajukan kertas ke posisi
 *      pemisah berikutnya. Untuk label berjarak (dengan celah) ini memang yang
 *      diinginkan: label keluar, siap disobek, dan majunya berhenti tepat di
 *      celah label berikutnya.
 *
 *  'stop-at-printhead' — tanpa printEnd. Kertas BERHENTI di posisi kepala cetak
 *      dan tidak dimajukan lagi, jadi tidak ada kertas terbuang.
 *
 * PENTING — yang mencetak potong adalah PERANGKAT, bukan protokol. B1 Pro tidak
 * punya pemotong; labelnya terpisah di garis perforasi/celah. Perintah
 * "HalfCut" (0x5C) ada di protokol untuk model lain yang punya pisau, sudah
 * dicoba dan tidak menghasilkan potongan di seri B. Jadi kalau yang dimaksud
 * "langsung cut" adalah label langsung terlepas, itu urusan kertas yang
 * dipakai, bukan setelan.
 */
export type PaperEndMode = 'advance-and-separate' | 'stop-at-printhead';

/**
 * Jenis kertas seperti dilaporkan printer (label, bergap, tanpa celah, tanda
 * hitam). DITURUNKAN dari tipe pustaka, bukan didefinisikan ulang: enum yang
 * disalin bisa menyimpang dari yang sebenarnya dikirim ke printer.
 */
type JenisKertas = Awaited<ReturnType<NiimbotAbstractClient['protocol']['getPaperInfo']>>['paperType'];

/**
 * Keadaan izin Bluetooth untuk ALAMAT INI.
 *
 * Izin Web Bluetooth disimpan per origin, bukan per situs atau per pengguna.
 * Karena itu pertanyaan "sudah diizinkan?" selalu berarti "di alamat ini?" —
 * printer yang dipasangkan dari localhost tidak dikenal di domain produksi, dan
 * itu penyebab pemilih perangkat muncul terus.
 *
 *  'unsupported'      Browser tidak punya Web Bluetooth.
 *  'no-stored-device' Belum pernah dipasangkan dari alamat ini, atau izinnya
 *                     dicabut. Pemilih memang perlu dibuka SEKALI.
 *  'ready'            Ada printer tersimpan. Sambungan berikutnya tanpa dialog.
 */
export type PrinterPairingState = 'unsupported' | 'no-stored-device' | 'ready';

/**
 * Pesan standar saat printer belum dipasangkan di browser ini.
 *
 * Konstanta, bukan literal yang ditulis ulang di tiap tempat. Sudah pernah
 * terjadi: pesan galat menulis "Siapkan printer" sementara tombolnya
 * "Siapkan Printer", dan satu perbedaan huruf membuat orang ragu apakah dia ada
 * di layar yang benar. Satu sumber menghilangkan kemungkinan itu.
 */
export const PRINTER_BELUM_DIPASANGKAN =
  'Printer belum dipasangkan di browser ini (sekali saja). Tekan “Siapkan Printer”.';

export interface PrintAdjustments {
  /** Kecerahan foto, persen (100 = tidak diubah). */
  brightness: number;
  /** Kontras foto, persen. */
  contrast: number;
  /** Saturasi foto, persen (0 = hitam putih). */
  saturation: number;
  /** Kepekatan termal 1-5 (diteruskan ke printer lewat print task). */
  density: number;
  /** Geser vertikal gambar pada kertas, piksel. Positif = turun. */
  offsetYPx: number;
  /** Geser mendatar gambar pada kertas, piksel. Positif = kanan. */
  offsetXPx: number;
  /** Margin atas: mulai cetak setelah sekian piksel dari tepi atas label. */
  marginTopPx: number;
  /** Margin kanan: hentikan cetak sekian piksel sebelum tepi kanan label. */
  marginRightPx: number;
  /** Margin kiri. */
  marginLeftPx: number;
  /** Margin bawah. */
  marginBottomPx: number;
  /**
   * 'fit' = muat seluruh foto, sisa label jadi putih (ada bingkai).
   * 'cover' = penuhi label, rasio dijaga, kelebihan dipotong (tanpa bingkai).
   * 'stretch' = penuhi label dengan merusak rasio (gepeng).
   */
  fitMode: 'fit' | 'cover' | 'stretch';
  /**
   * Algoritma abu-abu sebelum dither. Lihat GRAYSCALE_OPTIONS.
   * Bawaan 'rec601' = perilaku lama, supaya konfigurasi yang sudah ada tidak
   * berubah hasil cetaknya.
   */
  grayscale?: GrayscaleAlgorithm;
  /**
   * Penajaman (unsharp mask) 0-100, dikenakan pada abu-abu SEBELUM dither.
   * 0 = tidak menajamkan. Inilah yang paling menentukan hasil tidak blur:
   * dither 1-bit selalu melunakkan tepi, jadi tepinya dinaikkan lebih dulu.
   */
  sharpen?: number;
  /**
   * Perilaku akhir cetak. Bawaan 'advance-and-separate' = perilaku lama yang
   * sudah terbukti (label keluar, berhenti di celah berikutnya).
   */
  paperEnd?: PaperEndMode;
}

export const DEFAULT_ADJUSTMENTS: PrintAdjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  density: 3,
  // Bawaan lama: tidak menajamkan, Rec.601. Menyalakan penajaman sebagai
  // bawaan akan mengubah hasil cetak semua kiosk yang sudah dikalibrasi.
  grayscale: DEFAULT_GRAYSCALE_ALGORITHM,
  sharpen: 0,
  offsetYPx: 0,
  offsetXPx: 0,
  marginTopPx: 0,
  marginRightPx: 0,
  marginLeftPx: 0,
  marginBottomPx: 0,
  fitMode: 'fit',
  paperEnd: 'advance-and-separate',
};

/** Geometri label: dihitung di `labelGeometry.ts` supaya bisa diuji tanpa hardware. */
import { drawRect } from './labelGeometry.ts';
export { labelSize, labelMmFromPaperSize, labelFrameBox, drawRect, printBox, firstSlot, DEFAULT_LABEL_MM, B1_PRO_PRINTHEAD_PX, LABEL_DPI } from './labelGeometry.ts';
export type { LabelSize } from './labelGeometry.ts';

export type PrintStatus =
  | { state: 'idle' }
  | { state: 'connecting' }
  | { state: 'connected'; deviceName: string; model: string; printTask: string }
  | { state: 'printing'; page: number; total: number }
  | { state: 'error'; message: string };

export class NiimbotPrinter {
  private client: NiimbotAbstractClient | null = null;
  private printTaskName: PrintTaskName = 'B1';

  /**
   * Keadaan sambungan untuk jalur aplikasi desktop.
   *
   * Jalur itu tidak memakai `client` (klien Web Bluetooth), jadi keadaannya
   * dicatat di sini. Perlu karena `isConnected()` dipakai untuk memutuskan
   * apakah perlu menyambung lagi.
   */
  private nativeTersambung = false;

  /**
   * Apakah printer bisa dijangkau.
   *
   * Di aplikasi desktop, transport Bluetooth native dipasang oleh proses utama
   * dan TIDAK butuh dukungan Web Bluetooth — jadi pemeriksaan ini harus lolos
   * di sana. Tanpa cabang itu, aplikasi desktop sendiri akan menolak mencetak.
   */
  static isSupported(): boolean {
    if (NiimbotPrinter.nativeBridge()) return true;
    // Diperiksa dari objek global, bukan lewat tipe: tipe DOM bawaan Proyek ini
    // tidak memuat Web Bluetooth, dan menambah dependensi tipe hanya untuk satu
    // pemeriksaan tidak sepadan.
    return typeof navigator !== 'undefined'
      && Boolean((navigator as unknown as { bluetooth?: unknown }).bluetooth);
  }

  /** Transport Bluetooth native, kalau aplikasi ini berjalan sebagai desktop app. */
  private static nativeBridge(): {
    sambung: (o?: { nama?: string; alamat?: string }) => Promise<{ deviceName: string; address: string; printTask?: string }>;
    status: () => Promise<{ tersambung: boolean; deviceName: string | null; address: string | null }>;
    terputus: () => Promise<unknown>;
    cetak: (halaman: unknown, opsi?: unknown) => Promise<unknown>;
  } | null {
    // Dibaca dari globalThis, BUKAN navigator: contextBridge hanya bisa menaruh
    // di window. Membacanya dari navigator akan selalu kosong — dan gejalanya
    // aplikasi desktop yang menolak mencetak tanpa alasan yang jelas.
    if (typeof globalThis === 'undefined') return null;
    return (globalThis as unknown as { kioskPrinter?: never }).kioskPrinter ?? null;
  }

  isConnected(): boolean {
    // Jalur aplikasi desktop tidak memakai `client` (itu klien Web Bluetooth),
    // jadi keadaannya dicatat sendiri saat sambung/putus. Tanpa ini, setiap
    // cetak akan menyambung ulang — dan di Windows menyambung ulang saat sudah
    // tersambung justru memutus koneksi yang sedang dipakai.
    if (NiimbotPrinter.nativeBridge()) return this.nativeTersambung;
    return Boolean(this.client?.isConnected());
  }

  /**
   * Sambungkan ke printer.
   *
   * HARUS dipanggil dari interaksi pengguna langsung (klik tombol): Web
   * Bluetooth menolak `requestDevice()` di luar gestur pengguna. Ini juga alasan
   * sambungan tidak bisa dipulihkan otomatis setelah printer idle dan memutus
   * Bluetooth — pengguna perlu klik lagi.
   */
  async connect(
    options: { forceChooser?: boolean } = {},
  ): Promise<{ deviceName: string; model: string; printTask: string; printheadPx: number }> {
    // JALUR APLIKASI DESKTOP: Bluetooth native, tanpa izin halaman sama sekali.
    // Dicoba lebih dulu karena di sana Web Bluetooth memang tidak ada.
    const native = NiimbotPrinter.nativeBridge();
    if (native) {
      const hasil = await native.sambung({
        nama: options.forceChooser ? undefined : this.rememberedDeviceName() || undefined,
        alamat: this.rememberedAddress() || undefined,
      });
      // Alamat disimpan supaya sambungan berikutnya tidak perlu menebak: alamat
      // lebih pasti daripada nama iklan (yang bisa berubah atau tidak terbaca).
      this.rememberAddress(hasil?.address);
      this.rememberDeviceName(hasil?.deviceName);
      this.nativeTersambung = true;
      // PRINT TASK DARI MODEL YANG DIBACA PRINTER.
      //
      // Dulu di sini `model` dan `printTask` diisi this.printTaskName, yang
      // bawaannya 'B1'. Untuk B1 Pro itu model yang salah — pustaka memetakan
      // B1_PRO ke task D110M_V4, dengan perintah printStart dan ukuran halaman
      // yang berbeda — sehingga printer tidak menjawab pageEnd dan cetak gagal
      // dengan "Timeout waiting response (waited for e4)". Transport native
      // sekarang menegosiasi protokol dan mengirim jenis task-nya; dipakai di
      // sini supaya nilai yang dicetak benar sejak cetak pertama.
      if (hasil?.printTask) this.printTaskName = hasil.printTask as PrintTaskName;
      // DILAPORKAN KE ADMIN. Jalur desktop menyambung TANPA lewat finishConnect
      // (itu jalur Web Bluetooth), jadi tanpa baris ini panel Admin tidak pernah
      // menerima READY dari aplikasi kiosk — dan status galat lama tetap
      // terpampang walau printernya sudah tersambung dan siap mencetak.
      void this.reportStatus('READY', { printerName: hasil?.deviceName || undefined });
      return {
        deviceName: hasil?.deviceName || 'Printer label',
        model: this.printTaskName,
        printTask: this.printTaskName,
        printheadPx: 576,
      };
    }

    if (!NiimbotPrinter.isSupported()) {
      throw new Error('Browser ini tidak mendukung Web Bluetooth. Pakai Chrome atau Edge.');
    }

    // Klien baru setiap sambungan: client lama memegang GATT yang sudah mati.
    if (this.client) {
      try { await this.client.disconnect(); } catch { /* sudah terputus */ }
    }
    this.client = instantiateClient('bluetooth');

    // SAMBUNG TANPA PEMILIH PERANGKAT.
    //
    // `requestDevice()` selalu membuka pemilih perangkat, dan itu tidak bisa
    // dilewati. `navigator.bluetooth.getDevices()` sebaliknya — hanya tersedia
    // untuk situs yang sudah diberi izin (izin tersimpan sejak pasangan pertama,
    // dan Chrome mempertahankannya), dan hanya mengembalikan perangkat yang
    // SUDAH pernah dipasangkan. Justru itu yang dibutuhkan kiosk: printer yang
    // sama setiap kali, tanpa ada yang memilih apa pun.
    //
    // getDevices() boleh dipanggil TANPA gestur pengguna karena tidak membuka
    // dialog; itu yang membuat cetak otomatis mungkin. Kalau ternyata tidak ada
    // perangkat tersimpan (pasangan pertama, atau izin dicabut), jalur pemilih
    // tetap dipakai — jadi perilakunya tidak pernah lebih buruk dari sebelumnya.
    const found = options.forceChooser ? null : await this.findPairedDevice();
    if (found) {
      // Tipe dasar library hanya punya connect() tanpa argumen, sedangkan
      // implementasi Bluetooth menerima { authorizedDevice }. Jadi yang
      // disempitkan di sini adalah NILAI client-nya, bukan tipe library.
      const btClient = this.client as unknown as {
        connect(options?: { authorizedDevice?: unknown; usesTillItsAvailable?: boolean }): Promise<unknown>;
      };

      // DIULANG BEBERAPA KALI, bukan sekali.
      //
      // Percobaan pertama sering gagal untuk printer yang sedang tidur: alamat
      // tersimpan tetapi GATT belum siap menjawab. Kalau langsung menyerah,
      // pemilih perangkat terbuka padahal tidak ada yang perlu dipilih — dan
      // itulah keluhannya. Rentang total ~9 detik; kalau dalam rentang itu
      // printer menjawab, dialog tidak pernah muncul.
      const JUMLAH_PERCOBAAN = 6;
      let galatTerakhir: unknown = null;
      for (let coba = 1; coba <= JUMLAH_PERCOBAAN; coba += 1) {
        try {
          await btClient.connect({ authorizedDevice: found.device });
          return this.finishConnect();
        } catch (error) {
          galatTerakhir = error;
          // `usesTillItsAvailable` menyerahkan penungguan ke library dan
          // menangani printer yang menyala terlambat.
          try {
            await btClient.connect({ authorizedDevice: found.device, usesTillItsAvailable: true });
            return this.finishConnect();
          } catch (error2) {
            galatTerakhir = error2;
          }
          if (coba < JUMLAH_PERCOBAAN) {
            const jeda = 500 * coba;
            console.info(`[Printer] Sambungan ke "${String(found.device?.name || '?')}" belum berhasil `
              + `(percobaan ${coba}/${JUMLAH_PERCOBAAN}), dicoba lagi dalam ${jeda} ms.`);
            await new Promise((r) => setTimeout(r, jeda));
          }
        }
      }

      // Sampai di sini printer ADA dan tersimpan, tetapi tidak menjawab.
      // Disebut apa adanya: pemilih perangkat bukan solusinya, jadi jangan
      // diarahkan ke sana seolah itu langkah yang berguna.
      const nama = String(found.device?.name || 'printer');
      console.warn('[Printer] Gagal menyambung ke printer tersimpan setelah '
        + JUMLAH_PERCOBAAN + ' percobaan:', galatTerakhir);
      throw new Error(`Printer "${nama}" tersimpan tetapi tidak menjawab setelah `
        + `${JUMLAH_PERCOBAAN} percobaan. Pastikan printer menyala, dalam jangkauan, `
        + 'dan tidak sedang tersambung ke perangkat lain (HP).');
    }
    // JEDA PAKET: sengaja TIDAK diubah — dipakai bawaan library (10 ms).
    //
    // Sebelumnya di sini tertulis setPacketInterval(0): kirim tanpa jeda sama
    // sekali. BLE tidak sanggup untuk data sebesar satu halaman (714 paket,
    // ~59 KB), printer menerima potongan paket yang tidak lengkap, dan di konsol
    // muncul "Dropping invalid buffer 00 00 00 00" disertai label yang keluar
    // tidak penuh. Jeda ini bagian dari protokol, bukan angka yang bisa
    // dihilangkan untuk mempercepat cetak.

    // TIDAK ADA perangkat tersimpan untuk alamat ini.
    //
    // Pemilih HANYA dibuka kalau pemanggilnya memintanya secara eksplisit
    // (`forceChooser`, yaitu `pairNow()` dari klik tombol pemasangan). Semua
    // jalur lain berhenti di sini dengan galat: pencetakan, sambung-ulang, dan
    // pra-sambung saat halaman siap.
    //
    // Sebelumnya jalur ini terbuka untuk siapa pun yang memanggil connect(),
    // jadi satu pemanggil yang lupa memeriksa izin sudah cukup untuk memunculkan
    // dialog di tengah proses cetak. Sekarang tidak mungkin lagi — bukan karena
    // setiap pemanggil disiplin, tetapi karena tidak ada jalan lain ke pemilih.
    if (!options.forceChooser) {
      throw new Error(PRINTER_BELUM_DIPASANGKAN);
    }

    console.info('[Printer] Membuka pemilih perangkat atas permintaan pengguna. '
      + 'Ini sekali per alamat; berikutnya tersambung otomatis tanpa dialog.');

    // TANGKAP PERANGKAT YANG BARU DIPILIH.
    //
    // Kenapa perlu: nama perangkat yang dikembalikan CUMA-CUMA protokol printer
    // sering kosong (printer hanya mengirim nomor seri), sedangkan
    // `getDevices()` mengembalikan perangkat dengan nama yang DIBERIKAN BROWSER.
    // Keduanya sumber berbeda, jadi mengingat nama dari protokol lalu
    // mencocokkannya dengan nama dari browser TIDAK PERNAH cocok — dan
    // printer yang benar-benar tersimpan akan terus dianggap "belum dipasangkan".
    //
    // Event "connect" membawa perangkat yang sebenarnya dipakai, jadi itulah
    // rujukan yang benar.
    let dipilih: any = null;
    const tangkap = (event: any) => {
      if (!dipilih && event?.info) dipilih = event.info;
    };
    this.client.on('connect', tangkap);
    try {
      await this.client.connect();
    } finally {
      this.client.off('connect', tangkap);
    }
    return this.finishConnect(dipilih);
  }

  /**
   * Nama perangkat menurut BROWSER, untuk sambungan yang sedang berjalan.
   *
   * Dipisahkan dari nama protokol karena keduanya sumber berbeda dan hanya yang
   * ini yang cocok dengan `getDevices()`. Dipakai untuk menyimpan nama yang
   * benar setelah pemilihan dari pemilih.
   */
  private printDeviceName: string | null = null;

  /** Nama perangkat yang diingat, supaya tidak perlu memilih lagi. */
  private readonly REMEMBERED_DEVICE_KEY = 'unismiles.printer.deviceName';

  /** Nama yang dipakai terakhir kali, dibaca dari localStorage. */
  public rememberedDeviceName(): string | null {
    try {
      return window.localStorage.getItem(this.REMEMBERED_DEVICE_KEY);
    } catch {
      return null;
    }
  }

  /**
   * Alamat perangkat yang diingat (khusus jalur Bluetooth native).
   *
   * Alamat lebih pasti daripada nama: di Windows ia stabil, dan mencocokkannya
   * tidak bergantung pada bagaimana printer mengiklankan namanya. Di macOS
   * alamat bisa berubah antar sesi, jadi nama tetap disimpan sebagai cadangan.
   */
  private readonly REMEMBERED_ADDRESS_KEY = 'unismiles.printer.address';

  public rememberedAddress(): string | null {
    try {
      return window.localStorage.getItem(this.REMEMBERED_ADDRESS_KEY);
    } catch {
      return null;
    }
  }

  private rememberAddress(address: string | undefined): void {
    if (!address) return;
    try {
      window.localStorage.setItem(this.REMEMBERED_ADDRESS_KEY, address);
    } catch {
      // localStorage bisa dilarang. Bukan alasan menggagalkan cetak.
    }
  }

  private rememberDeviceName(name: string | undefined): void {
    if (!name) return;
    try {
      window.localStorage.setItem(this.REMEMBERED_DEVICE_KEY, name);
    } catch {
      // localStorage bisa dilarang (mode privat). Bukan alasan menggagalkan cetak.
    }
  }

  /**
   * Cari printer yang sudah dipasangkan, tanpa membuka pemilih.
   *
   * Diutamakan yang namanya sama dengan yang dipakai terakhir kali — di kiosk
   * biasanya hanya ada satu, tetapi kalau ada beberapa, printer yang benar harus
   * dipilih dengan pasti, bukan yang pertama kebetulan ditemukan.
   */
  /**
   * Perangkat yang SUDAH diizinkan untuk alamat ini.
   *
   * `getDevices()` adalah satu-satunya cara sah membacanya, dan ia hanya
   * mengembalikan perangkat yang pernah dipasangkan dari origin ini. Boleh
   * dipanggil tanpa gestur pengguna karena tidak membuka dialog — itulah yang
   * membuat cetak otomatis dan sambung-ulang tanpa popup mungkin.
   */
  private async storedDevices(): Promise<any[]> {
    const bt = (navigator as any).bluetooth;
    if (!bt || typeof bt.getDevices !== 'function') return [];
    try {
      const devices = await bt.getDevices();
      return Array.isArray(devices) ? devices : [];
    } catch (error) {
      console.warn('[Printer] getDevices() gagal:', error);
      return [];
    }
  }

  /** Keadaan izin untuk alamat ini. Dipakai panel pengaturan dan sebelum cetak. */
  /**
   * Apakah printer siap dicetak.
   *
   * Di aplikasi desktop jawabannya SELALU 'ready', dan itu memang benar: tidak
   * ada izin halaman yang perlu dimiliki, dan transport native mencari sendiri
   * printer label dari service/nama iklannya.
   *
   * Kenapa bukan 'no-stored-device' saat belum ada nama tersimpan: keadaan itu
   * berarti "perlu dipasangkan dulu", dan di aplikasi desktop TIDAK ADA yang
   * perlu dipasangkan. Kiosk yang baru dipasang (nama belum pernah tersimpan)
   * akan ditolak mencetak dengan pesan "belum dipasangkan" padahal printernya
   * ada dan bisa ditemukan — persis keluhan "device sudah tersambung tapi tidak
   * bisa print". Kalau printer memang tidak ada, kegagalannya muncul sebagai
   * "Printer tidak ditemukan" dari transport, yang menyebut sebab sebenarnya.
   */
  public async pairingState(): Promise<PrinterPairingState> {
    const native = NiimbotPrinter.nativeBridge();
    if (native) return 'ready';

    return this.pairingStateWeb();
  }

  private async pairingStateWeb(): Promise<PrinterPairingState> {
    if (!NiimbotPrinter.isSupported()) return 'unsupported';
    const devices = await this.storedDevices();
    if (devices.length === 0) return 'no-stored-device';
    return 'ready';
  }
  /** Nama printer yang sudah diizinkan untuk alamat ini. */
  public async storedDeviceNames(): Promise<string[]> {
    const devices = await this.storedDevices();
    return devices.map((d: any) => String(d?.name || '(tanpa nama)'));
  }

  /**
   * Sambung TANPA dialog, kalau izin untuk alamat ini memang sudah ada.
   *
   * Dipanggil sekali saat halaman siap supaya cetak pertama tidak perlu
   * menunggu sambungan. Aman dipanggil otomatis: kalau izin belum ada, fungsi
   * ini berhenti lebih dulu — pemilih perangkat TIDAK PERNAH dibuka dari sini,
   * karena dialog di luar gestur pengguna bukan hanya mengganggu, ia gagal.
   *
   * @returns nama perangkat, atau null kalau izin belum ada / gagal.
   */
  public async preconnectSilently(): Promise<string | null> {
    // JALUR APLIKASI DESKTOP: sambung lebih awal, tanpa izin apa pun.
    //
    // Di sini tidak ada izin per-origin untuk diperiksa, jadi "apakah printer
    // siap" bukan pertanyaan soal izin — melainkan apakah printernya ada. Karena
    // itu kegagalan TIDAK dilaporkan sebagai galat: printer yang mati saat kiosk
    // hidup bukan alasan menghalangi pengambilan foto.
    const native = NiimbotPrinter.nativeBridge();
    if (native) {
      try {
        const nama = this.rememberedDeviceName();
        const alamat = this.rememberedAddress();
        // TANPA kriteria pun dicoba, bukan berhenti: transport native mencari
        // printer label dari service/nama iklannya sendiri (itu jalur yang sudah
        // terbukti di kiosk tanpa nama, tanpa alamat, dan tanpa izin). Berhenti
        // lebih dulu membuat kiosk yang baru dipasang tidak pernah tersambung
        // awal — dan cetak pertama jadi lambat padahal printernya ada.
        const hasil = await native.sambung({ nama: nama || undefined, alamat: alamat || undefined });
        this.nativeTersambung = true;
        console.info(`[Printer] Tersambung otomatis (Bluetooth native): "${hasil?.deviceName}". `
          + 'Tidak ada dialog izin di jalur ini.');
        return hasil?.deviceName || null;
      } catch (error: any) {
        console.info('[Printer] Sambung otomatis belum berhasil; akan dicoba lagi saat mencetak. '
          + String(error?.message || error));
        return null;
      }
    }

    // DILAPORKAN APA ADANYA, sekali per halaman.
    //
    // Izin Web Bluetooth tidak bisa diperiksa dari luar, dan gejalanya selalu
    // sama dari sisi pengguna ("kok masih minta izin"). Dua sebab yang berbeda —
    // daftar perangkat KOSONG versus daftar berisi tetapi izin tidak bertahan —
    // hanya bisa dibedakan dengan membaca daftarnya. Satu baris ini memisahkan
    // keduanya tanpa perlu menebak atau memasang ulang.
    // BUNDEL YANG SEDANG JALAN, disebut di konsol.
    //
    // Berkas lama tetap bisa diakses setelah deploy, jadi browser yang masih
    // memegang bundle sebelumnya akan menjalankan kode lama dan laporannya
    // membingungkan: seolah perbaikan terbaru tidak berpengaruh, padahal kode
    // yang diuji bukan kode yang baru dikirim. Satu baris ini menyatakan
    // berkas mana yang benar-benar dijalankan, sehingga "sudah di-reload atau
    // belum" bisa dipastikan, bukan ditebak.
    try {
      const sumber = (document.querySelector('script[type="module"]') as HTMLScriptElement | null)?.src;
      if (sumber) {
        console.info('[Printer] Bundel yang dijalankan: ' + sumber.split('/').pop());
      }
    } catch {
      // Bukan alasan menggagalkan apa pun; ini hanya keterangan.
    }

    const perangkat = await this.storedDevices();
    console.info('[Printer] Perangkat tersimpan untuk alamat ini: '
      + (perangkat.length === 0
        ? '(tidak ada)'
        : perangkat.map((d: any, i: number) => `${i}: "${d?.name || '(tanpa nama)'}"`).join(', ')));

    if (await this.pairingState() !== 'ready') return null;
    try {
      const info = await this.connect();
      return info.deviceName;
    } catch (error) {
      // Gagal bersambung bukan keadaan darurat di sini: pencetakan nanti akan
      // mencoba lagi, dan itulah saat yang tepat untuk melaporkan galatnya.
      console.info('[Printer] Sambung awal belum berhasil, akan dicoba saat cetak:', error);
      return null;
    }
  }

  /**
   * Buka pemilih perangkat SEKARANG — hanya dari gestur pengguna.
   *
   * Dipakai SATU KALI saat menyiapkan kiosk, sehingga pencetakan tidak pernah
   * perlu membuka dialog. Ini bukan jalan pintas: Web Bluetooth memang
   * mengharuskan pemilihan perangkat berada di dalam gestur pengguna, dan
   * fungsi ini hanya bisa dipanggil dari klik tombol.
   */
  public async pairNow(): Promise<{
    deviceName: string;
    model: string;
    printTask: string;
    printheadPx: number;
    /** Apakah browser benar-benar MENYIMPAN izin untuk alamat ini setelah dipilih. */
    pairingPersisted: boolean;
  }> {
    const info = await this.connect({ forceChooser: true });

    // DIPERIKSA ULANG, karena "printer tersambung" dan "izin tersimpan" adalah
    // dua hal berbeda — dan yang menentukan cetak berikutnya adalah yang kedua.
    //
    // Kalau perangkat yang baru dipilih TIDAK muncul di getDevices(), izinnya
    // tidak bertahan: sambungan ini hidup sampai halaman dimuat ulang, lalu
    // cetak berikutnya gagal lagi dengan "belum dipasangkan". Tanpa pemeriksaan
    // ini, gejalanya hanya terlihat sebagai "kok masih minta izin terus", dan
    // penyebabnya tidak pernah muncul di mana pun.
    // Diverifikasi dari NAMA BROWSER, bukan nama protokol: hanya nama browser
    // yang muncul di getDevices(). Memeriksa nama protokol pernah membuat
    // pemeriksaan ini melaporkan "izin tidak bertahan" padahal perangkatnya
    // tersimpan baik-baik saja.
    const perangkat = await this.storedDevices();
    const namaBrowser = this.printDeviceName;
    const tersimpan = perangkat.some((d: any) => d?.name === namaBrowser);

    if (!tersimpan) {
      const daftar = perangkat.map((d: any) => String(d?.name || '(tanpa nama)')).join(', ') || '(kosong)';
      console.warn('[Printer] Setelah dipilih, izin TIDAK terbaca untuk alamat ini. '
        + `Nama perangkat menurut browser: "${namaBrowser || 'tidak terbaca'}". `
        + `Perangkat tersimpan: ${daftar}. Artinya cetak berikutnya akan meminta izin lagi — `
        + 'biasanya karena mode penyamaran/incognito, izin situs diblokir, atau '
        + '"hapus data situs saat keluar".');
    } else {
      console.info(`[Printer] Izin tersimpan untuk alamat ini: "${namaBrowser}". `
        + 'Cetak berikutnya tidak akan menampilkan dialog.');
    }
    return { ...info, pairingPersisted: tersimpan };
  }

  private async findPairedDevice(): Promise<{ device: any; alasan: string } | null> {
    const devices = await this.storedDevices();

    if (devices.length === 0) {
      // Penyebab paling sering, dan bukan kesalahan kode: izin tersimpan
      // PER-ALAMAT. Kalau printer pernah dipasangkan dari alamat lain (mis. saat
      // panel masih di localhost), browser di alamat ini tidak tahu apa-apa
      // soal printer itu.
      const pernah = this.rememberedDeviceName();
      console.info(pernah
        ? `[Printer] Catatan printer "${pernah}" ada, tetapi browser tidak mengenalinya `
          + 'di alamat ini. Izin Bluetooth tersimpan per alamat — kemungkinan printer '
          + 'dipasangkan dari alamat lain, atau izinnya dicabut. Pasangkan sekali di '
          + 'alamat ini; berikutnya otomatis.'
        : '[Printer] Belum ada printer tersimpan untuk alamat ini. Pasangkan sekali '
          + 'lewat pemilih; berikutnya akan otomatis tanpa pemilih.');
      return null;
    }

    const nama = devices.map((d: any) => String(d?.name || '(tanpa nama)')).join(', ');
    const remembered = this.rememberedDeviceName();
    if (remembered) {
      const cocok = devices.find((d: any) => d?.name === remembered);
      if (cocok) return { device: cocok, alasan: 'printer terakhir yang dipakai' };
    }

    // Belum ada catatan, atau namanya berubah (mis. printer diganti).
    const kandidat = devices.find((d: any) => /^[A-Za-z]/.test(String(d?.name || '')));
    const dipilih = kandidat || devices[0];
    console.info(`[Printer] Printer tersimpan: ${nama}`
      + (remembered ? ` — catatan "${remembered}" tidak cocok` : '')
      + `, dipakai "${String(dipilih?.name || '?')}"`);
    return { device: dipilih, alasan: 'printer tersimpan pertama' };
  }

  /**
   * Kosongkan sisa byte yang tertinggal dari operasi sebelumnya.
   *
   * KENAPA PERLU
   *
   * `disconnect()` di library hanya memutus GATT dan menghentikan heartbeat —
   * `packetBuf` TIDAK ikut dikosongkan (diperiksa di
   * niimbluelib/dist/cjs/client/abstract_client.js: buffer hanya dibersihkan di
   * dalam `processRawPacket`). Kalau operasi sebelumnya berhenti di tengah
   * paket, sisa byte-nya masih ada.
   *
   * Sisa itu menempel ke notifikasi berikutnya sehingga buffer tidak lagi
   * berawalan header paket, dan library membuang seluruh isinya:
   *
   *   Dropping invalid buffer 00 00 00 00
   *
   * Akibatnya bisa lebih dari sekadar pesan: paket pertama sesi berikutnya
   * ikut terbuang, dan yang hilang bisa berupa balasan yang sedang ditunggu.
   * Karena itu dibersihkan SEBELUM setiap cetak, bukan hanya sebelum sambung.
   */
  private clearStalePacketBuffer(): void {
    const c = this.client as unknown as { packetBuf?: Uint8Array } | null;
    if (!c) return;
    const sisa = c.packetBuf?.length ?? 0;
    if (sisa > 0 && typeof console !== 'undefined') {
      console.info(`[Printer] Membuang ${sisa} byte sisa dari operasi sebelumnya.`);
    }
    c.packetBuf = new Uint8Array();
  }

  /**
   * Bagian connect() setelah sambungan terbentuk.
   *
   * @param perangkatDipilih Perangkat browser yang dipakai sambungan ini, kalau
   *   pemilih baru saja dibuka. Ini sumber nama yang BENAR untuk pencocokan
   *   berikutnya — lihat catatan di connect().
   */
  private async finishConnect(
    perangkatDipilih?: any,
  ): Promise<{ deviceName: string; model: string; printTask: string; printheadPx: number }> {
    // Sisa byte dari handshake sambungan dibuang di sini juga, bukan hanya
    // sebelum cetak: sambungan baru sendiri meninggalkan ekor (terlihat sebagai
    // "Dropping invalid buffer 00 00 00 00" dua kali per sesi). Membiarkannya
    // membuat paket pertama cetak ikut berisiko terbuang.
    this.clearStalePacketBuffer();

    const info = this.client!.getPrinterInfo();
    const meta = this.client.getModelMetadata();
    const detected = this.client.getPrintTaskType();
    if (detected) {
      this.printTaskName = detected;
    }

    // Nama dari BROWSER lebih dulu. Nama dari protokol hanya cadangan, dan
    // sering kosong — printer mengirim nomor seri, bukan nama.
    const namaBrowser = typeof perangkatDipilih?.name === 'string' && perangkatDipilih.name
      ? perangkatDipilih.name
      : null;
    const namaProtokol = (info as { deviceName?: string } | undefined)?.deviceName || null;
    const deviceName = namaBrowser || namaProtokol || 'tidak diketahui';
    if (namaBrowser) {
      // Sengaja dicatat: kalau dua sumber ini berbeda, itu penting diketahui saat
      // pencocokan berikutnya gagal.
      this.printDeviceName = namaBrowser;
      if (namaProtokol && namaProtokol !== namaBrowser) {
        console.info(`[Printer] Nama perangkat: browser "${namaBrowser}", protokol `
          + `"${namaProtokol}". Yang dipakai untuk pencocokan: "${namaBrowser}".`);
      }
    }
    this.rememberDeviceName(deviceName);

    // Laporkan ke Admin. Tidak di-await: status bukan alasan menunda cetak.
    void this.reportStatus('READY', { printerName: deviceName });

    return {
      deviceName,
      model: meta?.model || 'tidak diketahui',
      printTask: this.printTaskName,
      // Dari pengukuran di kertas, bukan dari tabel model — lihat catatan berkas.
      printheadPx: B1_PRO_PRINTHEAD_PX,
    };
  }

  /**
   * Laporkan status printer ke backend supaya panel Admin bisa menampilkannya.
   *
   * Hanya browser yang tahu status ini: printer label NIIMBOT tersambung lewat
   * Web Bluetooth di sini, dan tidak muncul sebagai printer sistem — jadi
   * kiosk-agent tidak bisa melaporkannya.
   *
   * Kegagalan pelaporan TIDAK boleh menggagalkan cetak: status hanya informasi
   * bagi Admin, sedangkan label yang tidak tercetak adalah kerugian nyata.
   */
  async reportStatus(
    status: 'READY' | 'OFFLINE' | 'ERROR' | 'UNKNOWN',
    details: { printerName?: string; paperStatus?: string; lastError?: string } = {},
  ): Promise<void> {
    const apiKey = readKioskApiKey();
    const baseUrl = readApiBaseUrl();
    if (!apiKey || !baseUrl) return;

    // NAMA PRINTER TIDAK BOLEH HILANG SAAT GALAT.
    //
    // Laporan galat datang dari jalur cetak, yang tidak selalu membawa nama
    // printer. Kalau dikirim null, backend menimpanya dan panel Admin berubah
    // dari "B1pro-i616" menjadi "—" — jadi yang hilang justru keterangan yang
    // paling dibutuhkan saat mencetak gagal. Nama yang sudah dikenal dipakai
    // sebagai cadangan.
    const nama = details.printerName || this.printDeviceName || this.rememberedDeviceName() || null;

    try {
      await fetch(`${baseUrl.replace(/\/$/, '')}/kiosk/printer-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({
          status,
          printer_name: nama,
          paper_status: details.paperStatus ?? null,
          last_error: details.lastError ?? null,
        }),
      });
    } catch {
      // Sengaja ditelan: lihat catatan di atas.
    }
  }

  async disconnect(): Promise<void> {
    const native = NiimbotPrinter.nativeBridge();
    if (native) {
      try { await native.terputus(); } catch { /* sudah terputus */ }
      this.nativeTersambung = false;
      return;
    }
    if (!this.client) return;
    try { await this.client.disconnect(); } catch { /* sudah terputus */ }
    this.client = null;
  }

  /**
   * Siapkan gambar siap-cetak dari sumber apa pun (data-URL atau URL).
   *
   * Dua hal yang dilakukan di sini dan tidak dilakukan driver mentah:
   *
   *  1. Pengaturan tampilan dari Admin diterapkan (brightness/contrast/saturasi).
   *     Tanpa ini, pengaturan Admin hanya tersimpan tanpa efek.
   *  2. Gambar diletakkan pada kanvas seukuran label. Mode 'fit' menjaga rasio
   *     dan mengisi sisanya dengan putih; mode 'stretch' memenuhi label apa
   *     adanya (bisa gepeng). Penting: saat mengisi latar putih, filter TIDAK
   *     boleh aktif — kalau aktif, brightness 100% pun ikut mengubah putih.
   */
  async prepareCanvas(
    source: string,
    size: LabelSize,
    adj: PrintAdjustments = DEFAULT_ADJUSTMENTS,
  ): Promise<HTMLCanvasElement> {
    // Diperiksa dengan pesan yang menyebut sebabnya.
    //
    // Kalau ukuran ini rusak, `canvas.width` menjadi 0 dan browser hanya
    // mengeluh "The source width is 0." saat getImageData — pesan yang tidak
    // menunjuk ke mana pun. Penyebab aslinya hampir selalu objek ukuran yang
    // memakai nama field berbeda (mis. `w_px` sebagai ganti `widthPx`), atau
    // ukuran kertas yang tidak terbaca. Lebih baik gagal di sini dengan kalimat
    // yang bisa ditindaklanjuti.
    const widthPx = Number(size?.widthPx);
    const heightPx = Number(size?.heightPx);
    if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
      throw new Error(
        `Ukuran label tidak sah (${widthPx} x ${heightPx} px). `
        + 'Pastikan ukuran kertas di Admin terbaca dan objek ukuran memakai '
        + 'field widthPx/heightPx dari labelSize().',
      );
    }

    const img = await loadImage(source);
    // Ukuran gambar nol (foto rusak atau gagal dimuat sebagian) akan membuat
    // seluruh kanvas menjadi tinta; tolak lebih awal.
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error('Gambar yang akan dicetak tidak punya ukuran yang sah.');
    }

    const canvas = document.createElement('canvas');
    canvas.width = widthPx;
    canvas.height = heightPx;
    // willReadFrequently: kanvas ini digambar SEKALI lalu pikselnya dibaca untuk
    // pengubahan hitam-putih. Tanpa petunjuk ini, browser memindahkan kanvas
    // bolak-balik antara GPU dan memori utama, dan memperingatkan di konsol.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D tidak tersedia di browser ini.');

    // Latar putih dulu, tanpa filter.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Baru gambar fotonya, dengan pengaturan dari Admin.
    ctx.save();
    ctx.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturation}%)`;

    // Perhitungan dipindah ke drawRect() supaya bisa diuji tanpa canvas.
    const r = drawRect(adj.fitMode, canvas.width, canvas.height, img.naturalWidth, img.naturalHeight,
      adj.offsetYPx, adj.offsetXPx, adj.marginTopPx, adj.marginRightPx, adj.marginLeftPx, adj.marginBottomPx,
      // Batas keras: kertas label lebih lebar dari kepala cetak, jadi kotak
      // cetak tidak boleh melewatinya walau marginnya mengatakan lain.
      B1_PRO_PRINTHEAD_PX);
    // Dipotong ke bidang cetak: piksel di luar margin dibiarkan putih. Tanpa
    // langkah ini, margin tidak akan pernah terlihat — foto menutupi seluruh
    // kanvas, jadi tidak ada ruang kosong yang bisa muncul.
    ctx.beginPath();
    ctx.rect(r.clipX, r.clipY, r.clipW, r.clipH);
    ctx.clip();
    ctx.drawImage(img, r.dx, r.dy, r.dw, r.dh);
    ctx.restore();

    // WAJIB, dan dilakukan setelah filter: encoder NiimBlueLib mencetak setiap
    // piksel yang bukan putih murni sebagai tinta penuh
    // (`color !== 0xffffff` di image_encoder.js). Foto tidak punya piksel yang
    // persis putih, jadi tanpa langkah ini SELURUH label keluar hitam pekat.
    // Library tidak menyediakan dithering maupun ambang, jadi dihitung di sini.
    //
    // Diletakkan setelah filter supaya pengaturan terang/kontras dari Admin ikut
    // menentukan hasil hitam-putihnya — kalau sebelum, filter akan mengembalikan
    // nilai antara dan merusak hasil dithering.
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    // Bidang cetak yang sama dengan yang dipakai menggambar: dithering di luar
    // kotak hanya membuang waktu, dan menjaga perhitungan tinta tetap setara
    // dengan yang benar-benar keluar di kertas.
    const inkBox = printBox(canvas.width, canvas.height,
      adj.marginTopPx, adj.marginRightPx, adj.marginLeftPx, adj.marginBottomPx, B1_PRO_PRINTHEAD_PX,
      adj.offsetXPx, adj.offsetYPx);
    // Algoritma abu-abu dan penajaman dari Admin. Keduanya dikenakan SEBELUM
    // dither — setelah dither pikselnya hanya 0/255, jadi penajaman tidak lagi
    // mungkin dan pilihan algoritma tidak berpengaruh.
    //
    // Skala: UI memakai 0..100, penajaman memakai 0..2 (2 = kuat). Dibagi 50,
    // bukan 100, supaya 100 di UI benar-benar menghasilkan penajaman kuat —
    // diukur: amount 2 menaikkan detail tersisa ~16% (garis halus) sampai ~39%
    // (kontras lebih tinggi), sedangkan amount 1 hanya ~8%.
    ditherToBlackAndWhite(
      imageData.data, canvas.width, canvas.height, ONE_BIT_THRESHOLD, inkBox,
      adj.grayscale || DEFAULT_GRAYSCALE_ALGORITHM,
      Math.max(0, Math.min(100, Number(adj.sharpen) || 0)) / 50,
    );
    ctx.putImageData(imageData, 0, 0);

    return canvas;
  }

  /**
   * Cetak satu gambar.
   *
   * Alur mengikuti contoh resmi NiimBlueLib: encodeCanvas -> printInit ->
   * printPage -> waitForPageFinished -> waitForFinished -> printEnd.
   */
  async print(
    image: string,
    size: LabelSize,
    copies = 1,
    adj: PrintAdjustments = DEFAULT_ADJUSTMENTS,
    onProgress?: (page: number, total: number) => void,
  ): Promise<void> {
    // JALUR APLIKASI DESKTOP DIPERIKSA LEBIH DULU — ini urutannya, bukan selera.
    //
    // Di aplikasi desktop `this.client` memang TIDAK PERNAH ada: transportnya
    // Bluetooth native di proses utama, bukan klien Web Bluetooth. Memeriksa
    // `this.client` lebih dulu membuat SETIAP cetak gagal dengan "Printer belum
    // tersambung." padahal `connect()` sudah berhasil dan printer benar-benar
    // tersambung — persis keluhannya.
    //
    // Penyusunan gambar tetap di sini (geometri, margin, kepekatan), lalu hasil
    // ter-encode dikirim ke proses utama. Jadi kalibrasi tetap satu sumber dan
    // hasilnya identik dengan jalur browser.
    //
    // `this.isConnected()` sengaja TIDAK diperiksa di sini: proses utama sudah
    // menyambung ulang sendiri kalau sambungannya lepas (lihat cetak() di
    // main.cjs), dan menyambung ulang dari sisi ini justru bisa memutus
    // sambungan yang sedang dipakai.
    const native = NiimbotPrinter.nativeBridge();
    if (native) {
      const canvas = await this.prepareCanvas(image, size, adj);
      const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, 'top');
      await native.cetak(encoded, {
        density: adj.density,
        copies,
        model: this.printTaskName,
        // Diteruskan supaya jalur desktop punya perilaku kertas yang SAMA dengan
        // jalur browser. Tanpa ini, jalur desktop selalu memanggil printEnd dan
        // satu cetakan mengeluarkan dua frame label.
        paperEnd: adj.paperEnd,
      });
      onProgress?.(copies, copies);
      return;
    }

    if (!this.client) throw new Error('Printer belum tersambung.');
    if (!this.client.isConnected()) throw new Error('Sambungan printer terputus. Sambungkan ulang.');

    // Sisa byte dari cetak sebelumnya dibuang dulu: kalau tidak, ia menempel ke
    // notifikasi pertama dan seluruh buffer ikut terbuang sebagai "invalid".
    this.clearStalePacketBuffer();

    const canvas = await this.prepareCanvas(image, size, adj);
    const meta = this.client.getModelMetadata();
    const direction = (meta?.printDirection ?? 'top') as PrintDirection;

    // SingleColor = satu warna (hitam) pada label 1-bit. Itu yang dipakai
    // printer label termal biasa; DoubleColor hanya untuk model pita dua warna.
    const encoded = ImageEncoder.encodeCanvas(canvas, PageColorType.SingleColor, direction);

    // Heartbeat dimatikan selama mencetak: paketnya bisa mengganggu aliran data
    // gambar. Contoh resmi NiimBlueLib melakukan hal yang sama.
    this.client.stopHeartbeat();

    // JENIS KERTAS MENGIKUTI PRINTER, BUKAN BAWAAN PUSTAKA.
    //
    // Bawaan pustaka adalah WithGaps (kertas bergap). Printer di lapangan
    // melaporkan jenisnya "Black" (tanda hitam) dengan celah 0 mm; mengirim
    // WithGaps membuat printer MENCARI celah antar label yang tidak ada, lalu
    // memajukan kertas terus setelah halaman — satu label kosong ikut keluar di
    // setiap cetak. Sumber kebenarannya printernya sendiri; kalau pembacaan
    // gagal, biarkan pustaka memakai bawaannya.
    let jenisKertas: JenisKertas;
    try {
      const info = await this.client.protocol.getPaperInfo();
      if (info?.valid && info.paperType) jenisKertas = info.paperType;
    } catch {
      // Diamkan: printer yang tidak melaporkan info kertas tetap bisa mencetak.
    }

    const task = this.client.protocol.newPrintTask(this.printTaskName, {
      totalPages: copies,
      density: adj.density,
      ...(jenisKertas === undefined ? {} : { labelType: jenisKertas }),
      statusPollIntervalMs: 100,
      statusTimeoutMs: 15_000,
      // BATAS WAKTU KIRIM HALAMAN — diukur, bukan ditebak.
      //
      // Satu halaman 576x714 px menjadi 714 paket / ~59 KB (diukur dengan
      // PacketGenerator.writeImageData). Pada jeda paket bawaan library 10 ms
      // itu berarti 7,1 detik. Bawaan di sini cuma 10 detik, jadi satu halaman
      // hampir pasti habis waktunya di tengah — gejalanya di kertas adalah label
      // keluar TIDAK PENUH (mis. hanya 1/4 gambar), disertai
      // "Dropping invalid buffer" di konsol karena potongan paket yang tertunda
      // ikut terbaca sebagai paket baru.
      //
      // Diberi kelonggaran besar: BLE bisa melambat kalau ada perangkat lain,
      // dan gagal karena lambat jauh lebih murah daripada label setengah jadi.
      pageTimeoutMs: 60_000,
    });

    try {
      await task.printInit();
      for (let page = 1; page <= copies; page += 1) {
        await task.printPage(encoded, 1);
        await task.waitForPageFinished();
        onProgress?.(page, copies);
      }
      await task.waitForFinished();
    } finally {
      if (adj.paperEnd === 'stop-at-printhead') {
        // Sengaja TIDAK memanggil printEnd. Di seri B1, pageEnd sudah
        // menghentikan kertas di posisi kepala cetak; printEnd-lah yang
        // memajukannya lagi. Tanpa printEnd, kertas tidak maju — tidak ada
        // kertas terbuang. Konsekuensinya gambar berikutnya mulai dari posisi
        // yang sama, jadi ini untuk mencetak satu kali per lembar.
        //
        // Hati-hati: hati-hati jangan sampai ini jadi bawaan. Untuk kertas
        // berlabel (54x67 mm) yang punya desain tercetak, label berikutnya TIDAK
        // akan sampai ke posisi cetak kalau kertas tidak dimajukan.
        void task;
      } else {
        // printEnd WAJIB pada mode bawaan: itu yang mengeluarkan kertas sampai
        // berhenti di pemisah label berikutnya.
        try { await task.printEnd(); } catch { /* sudah selesai */ }
      }
      try { this.client.startHeartbeat(); } catch { /* opsional */ }
    }
  }
}

/** Muat gambar dari data-URL atau URL menjadi HTMLImageElement. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Gambar dari server lain butuh CORS agar tidak mengotori canvas.
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Gambar tidak bisa dimuat.'));
    img.src = src;
  });
}


/**
 * Kunci API kiosk.
 *
 * Dibaca dari localStorage dengan kunci yang sama dipakai `storageService`, lalu
 * dari env build. Kalau tidak ada, pelaporan status dilewati — lebih baik tidak
 * ada status di Admin daripada mencetak dengan kredensial salah.
 */
function readKioskApiKey(): string {
  try {
    const direct = localStorage.getItem('unismiles_kiosk_api_key');
    if (direct) return direct.trim();
    const cfg = localStorage.getItem('unismiles_config');
    if (cfg) {
      const parsed = JSON.parse(cfg);
      if (parsed?.apiKey) return String(parsed.apiKey).trim();
    }
  } catch { /* localStorage bisa diblokir; perlakukan sebagai tidak ada */ }
  return String(import.meta.env.VITE_KIOSK_API_KEY || '').trim();
}

/** Base URL API backend. */
function readApiBaseUrl(): string {
  return String(import.meta.env.VITE_API_BASE_URL || '').trim();
}
