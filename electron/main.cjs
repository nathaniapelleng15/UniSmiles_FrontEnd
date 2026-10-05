/**
 * Aplikasi desktop UniSmiles Photobooth.
 *
 * KENAPA ADA
 *
 * Di browser, Web Bluetooth menyimpan izin per-ORIGIN dan per-PROFIL, dan izin itu
 * bisa hilang (data situs dibersihkan, profil berbeda, mode kiosk). Gejalanya:
 * pemilih perangkat muncul lagi padahal printer sudah pernah dipasangkan — dan
 * TIDAK ADA kode di halaman web yang bisa memaksanya bertahan. Itu juga sebabnya
 * cetak OTOMATIS tidak bisa memasang printer: jalur itu menunggu unggahan, jadi
 * gestur klik sudah kedaluwarsa saat tiba di titik pemasangan.
 *
 * Di proses utama Electron, Bluetooth diakses lewat adapter OS. Tidak ada origin,
 * tidak ada izin halaman, tidak ada pemilih perangkat, tidak ada gestur yang
 * harus dijaga. Printer dicari dari nama atau alamatnya. Izin yang tersisa hanya
 * izin OS, sekali, milik aplikasi.
 *
 * YANG SENGAJA TIDAK BERUBAH
 *
 * UI tetap dimuat dari https://photobooth.uniinside.net, jadi seluruh perbaikan
 * photobooth tetap sampai dengan sekali deploy — aplikasi ini hanya menambahkan
 * jalur Bluetooth native. Penyusunan gambar (geometri label, margin, kepekatan)
 * tetap di renderer: kalibrasi tidak boleh punya dua sumber.
 *
 * BERKAS INI .cjs, BUKAN .js
 *
 * package.json paket ini memakai "type": "module", jadi berkas .js diperlakukan
 * sebagai ES module dan `require` di dalamnya gagal saat dimuat. Electron memuat
 * proses utama sebagai CommonJS.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, session, screen, protocol } = require('electron');

/** UI produksi. Bisa ditimpa untuk uji lokal lewat PHOTOBOOTH_URL. */
const URL_UI = process.env.PHOTOBOOTH_URL || 'https://photobooth.uniinside.net';

/**
 * UI ter-bundel: hasil `npm run build` ikut dipaketkan bersama aplikasi.
 *
 * KENAPA DIBUNDEL
 *
 * Selama ini UI dimuat dari hosting, sehingga satu perbaikan UI butuh deploy
 * hosting DAN versi shell desktop bisa menyimpang dari UI-nya (pernah terjadi:
 * tombol Back versi hosting masih navigasi web padahal shell sudah siap jalur
 * keluar desktop). Dengan UI ter-bundel, satu installer = shell + UI yang
 * selalu cocok, dan kiosk tidak bergantung pada ketersediaan hosting untuk
 * menampilkan antarmuka.
 *
 * PEMANGGILAN API TETAP KE CLOUD: URL backend ter-bake saat build
 * (VITE_API_BASE_URL → https://api.uniinside.net), jadi memuat UI dari skema
 * custom tidak mengubah tujuan API sama sekali.
 *
 * FALLBACK: bila dist/ tidak ada (installer lama), UI dimuat dari hosting
 * seperti sebelumnya. PHOTOBOOTH_UI=hosting memaksa jalur hosting untuk uji.
 */
const SKEMA_UI = 'app-photobooth';
const URL_UI_LOKAL = `${SKEMA_UI}://ui/index.html`;
const DIST_DIR = path.join(__dirname, '..', 'dist');

function distTersedia() {
  return fs.existsSync(path.join(DIST_DIR, 'index.html'));
}

function urlUiEfektif() {
  if (String(process.env.PHOTOBOOTH_UI || '') === 'hosting') return URL_UI;
  if (distTersedia()) return URL_UI_LOKAL;
  return URL_UI;
}

/**
 * Transport dan jalur cetak diambil dari SALINAN di dalam app (electron/ble/),
 * bukan dari kiosk-agent lewat jalur relatif: jalur itu tidak ada di mesin kiosk
 * setelah aplikasi dipaketkan. Agar salinan tidak menyimpang, ada test yang
 * membandingkannya byte-per-byte dengan sumbernya.
 */
const { NiimbotNobleClient } = require('./ble/niimbotNobleClient.cjs');
const { cetakHalaman } = require('./ble/cetakHalaman.cjs');
const { pasangKioskEmbed } = require('./kiosk-embed.cjs');

// ---------------------------------------------------------------------------
// Protokol app-photobooth:// — melayani UI ter-bundel dari dist/
// ---------------------------------------------------------------------------

/** Skema custom harus privileged SEBELUM app ready agar dianggap secure. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: SKEMA_UI,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const MIME_UI = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
};

function daftarkanProtokolUi() {
  protocol.handle(SKEMA_UI, (request) => {
    try {
      const u = new URL(request.url);
      let rel = decodeURIComponent(u.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      // Normalisasi + tolak path traversal (../) — hanya berkas di dist/.
      const aman = path.normalize(rel).replace(/^([\\/])+/, '');
      const file = path.join(DIST_DIR, aman);
      if (!file.startsWith(DIST_DIR + path.sep) && file !== DIST_DIR) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(file).toLowerCase();
      const data = fs.readFileSync(file);
      return new Response(data, {
        headers: {
          'Content-Type': MIME_UI[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.error('[ui-lokal] Gagal melayani', request.url, err.message);
      return new Response('Internal error', { status: 500 });
    }
  });
}

/**
 * CORS untuk UI ter-bundel: samarkan Origin KELUAR, cocokkan ACAO MASUK.
 *
 * Backend menoleransi CORS strict (whitelist origin). Dari skema custom,
 * origin halaman adalah `app-photobooth://ui` — tidak ada di whitelist.
 * DUA sisi harus diatur, dan keduanya wajib:
 *
 *  1. PERMINTAAN (onBeforeSendHeaders): header Origin disamarkan ke origin
 *     hosting — backend memprosesnya seperti permintaan UI hosting selama ini.
 *
 *  2. RESPONS (onHeadersReceived): Chromium memvalidasi CORS terhadap origin
 *     SEBENARNYA halaman, BUKAN header Origin yang kita samarkan. Pelajaran
 *     lapangan (2026-09-30): tanpa sisi ini, backend menjawab
 *     `Access-Control-Allow-Origin: https://photobooth.uniinside.net`, tidak
 *     cocok dengan `app-photobooth://ui`, SEMUA fetch diblokir browser, dan
 *     halaman API key melaporkan "backend tidak dapat diakses". Solusinya:
 *     ganti nilai ACAO pada respons menjadi origin lokal — pasangan
 *     request/response ini sepenuhnya internal ke app, backend tidak berubah.
 */
function pasangRewriteOrigin() {
  let originHosting = URL_UI;
  try { originHosting = new URL(URL_UI).origin; } catch { /* URL_UI aneh — pakai apa adanya */ }
  const originLokal = `${SKEMA_UI}://ui`;

  // Diagnostik lapangan: DEBUG_CORS=1 mencetak setiap permintaan/respons lintas
  // origin yang lewat webRequest — dipakai memastikan apakah preflight OPTIONS
  // benar-benar tampak oleh webRequest (Chromium dikenal menyembunyikannya).
  const debugCors = String(process.env.DEBUG_CORS || '') === '1';

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (debugCors && !details.url.startsWith(`${SKEMA_UI}://`)) {
      console.log('[cors][req]', details.method, details.resourceType || '?', details.url.slice(0, 110),
        'initiator=', String(details.initiator || '(kosong)'),
        'origin=', details.requestHeaders['Origin'] || details.requestHeaders['origin'] || '-');
    }
    if (details.url.startsWith(`${SKEMA_UI}://`)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const initiator = String(details.initiator || '');
    const originKirim = details.requestHeaders['Origin'] || details.requestHeaders['origin'];
    if (initiator.startsWith(`${SKEMA_UI}://`) || originKirim === originLokal) {
      details.requestHeaders['Origin'] = originHosting;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const initiator = String(details.initiator || '');
    if (debugCors && !details.url.startsWith(`${SKEMA_UI}://`)) {
      const h = details.responseHeaders || {};
      const acao = Object.keys(h).find((k) => k.toLowerCase() === 'access-control-allow-origin');
      console.log('[cors][res]', details.statusCode, details.url.slice(0, 110),
        'initiator=', String(initiator || '(kosong)'), 'acao=', acao ? h[acao][0] : '(tidak ada)');
    }
    /**
     * GERBANG JANGAN BERDASARKAN INITIATOR. Pelajaran lapangan (2026-09-30):
     * untuk XHR/fetch, `details.initiator` sering KOSONG di onHeadersReceived,
     * sehingga gerbang lama tidak pernah lolos dan ACAO tidak tertulis ulang —
     * preflight gagal meski sisi request sudah disamarkan. Semua respons di
     * sesi ini yang bukan skema lokal hanya dikonsumsi renderer kita
     * (origin `app-photobooth://ui`), jadi menulis ulang ACAO untuk SEMUA
     * respons lintas origin aman dan menutup kasus initiator kosong.
     */
    if (details.url.startsWith(`${SKEMA_UI}://`)) {
      callback({});
      return;
    }
    const h = details.responseHeaders || {};
    let diubah = false;
    for (const kunci of Object.keys(h)) {
      if (kunci.toLowerCase() === 'access-control-allow-origin' && h[kunci][0] !== originLokal) {
        h[kunci] = [originLokal];
        diubah = true;
      }
    }
    callback(diubah ? { responseHeaders: h } : {});
  });
}

/** noble dimuat malas: menyentuh radio saat start memperlambat dan bisa menggantung. */
function muatNoble() {
  return require('@stoprocent/noble');
}

let jendela = null;
let klien = null;
let kioskEmbed = null;

/** Waktu tunggu adapter dilaporkan siap; noble memakai 'unknown' saat masih dingin. */
const TUNGGU_ADAPTER_MS = 8000;

async function putuskan() {
  if (klien) {
    try { await klien.disconnect(); } catch { /* sudah terputus */ }
  }
  klien = null;
}

/**
 * Nama printer yang sudah dikenal, dari localStorage renderer.
 *
 * Renderer mengirimnya, alih-alih proses utama menyimpan sendiri: nilai yang
 * dipakai memilih printer harus SATU sumber dengan yang dilihat operator di
 * pengaturan. Dua tempat menyimpan berarti bisa berbeda, dan gejalanya adalah
 * printer yang salah dicetak.
 */
let namaPrinterDikenal = null;

/**
 * Sambung ke printer tanpa dialog apa pun.
 *
 * Kalau nama belum dikenal, transport mencari sendiri (service NIIMBOT atau
 * awalan model) — jalur yang sudah terbukti menyambung 1,8 detik pada kiosk
 * tanpa nama, tanpa alamat, dan tanpa izin.
 */
async function sambung({ nama, alamat } = {}) {
  if (klien && klien.isConnected()) {
    return {
      deviceName: klien.nama || namaPrinterDikenal,
      address: klien.alamat,
      printTask: jenisPrintTask(klien),
    };
  }
  await putuskan();
  const target = nama || namaPrinterDikenal || null;
  klien = new NiimbotNobleClient({
    noble: muatNoble(),
    nama: target,
    alamat: alamat || null,
  });
  const hasil = await klien.connect();
  if (hasil?.deviceName) namaPrinterDikenal = hasil.deviceName;
  return {
    deviceName: hasil?.deviceName || target,
    address: hasil?.address || null,
    // Diteruskan ke renderer: itu yang memilih print task saat mencetak. Tanpa
    // ini renderer memakai bawaannya ('B1'), dan printer B1 Pro menerima
    // rangkaian perintah untuk model lain — pageEnd tidak dijawab, cetak gagal
    // dengan "Timeout waiting response (waited for e4)".
    printTask: hasil?.printTask || jenisPrintTask(klien),
  };
}

/**
 * Print task yang sesuai model printer, kalau modelnya terbaca.
 *
 * Diambil dari klien (yang baru bernegosiasi dengan printer), bukan ditebak:
 * pustaka memetakan B1_PRO ke task D110M_V4 — perintah printStart dan ukuran
 * halaman yang berbeda dari B1. Mengembalikan undefined kalau belum terbaca,
 * supaya pemanggil memakai bawaannya alih-alih nilai yang salah.
 */
function jenisPrintTask(k) {
  try {
    return (typeof k?.getPrintTaskType === 'function' ? k.getPrintTaskType() : null) || undefined;
  } catch {
    return undefined;
  }
}

/** Cetak halaman yang SUDAH di-encode renderer. Tanpa menyentuh gambar. */
async function cetak(halaman, opsi = {}) {
  if (!klien || !klien.isConnected()) {
    // Kiosk bisa kehilangan sambungan saat printer tidur. Menyambung ulang di
    // sini sah: tidak ada gestur yang perlu dijaga di aplikasi desktop.
    await sambung({});
  }
  return cetakHalaman({ klien, halaman, ...opsi });
}

function daftarkanIpc() {
  ipcMain.handle('printer:tersedia', () => true);
  ipcMain.handle('printer:sambung', (_e, opsi) => sambung(opsi || {}));
  ipcMain.handle('printer:terputus', async () => { await putuskan(); return { ok: true }; });
  ipcMain.handle('printer:status', () => ({
    tersambung: Boolean(klien && klien.isConnected()),
    deviceName: (klien && klien.nama) || namaPrinterDikenal,
    address: klien ? klien.alamat : null,
  }));
  ipcMain.handle('printer:cetak', (_e, { halaman, opsi }) => cetak(halaman, opsi || {}));

  /**
   * Keadaan adapter, untuk ditampilkan di pengaturan kiosk.
   *
   * Dilaporkan apa adanya — termasuk 'unknown' — supaya mode kegagalan yang
   * berbeda (radio mati vs izin belum diberikan) bisa dibedakan operator.
   */
  ipcMain.handle('printer:keadaan-adapter', async () => {
    const noble = muatNoble();
    const state = await new Promise((resolve) => {
      if (noble.state && noble.state !== 'unknown') return resolve(noble.state);
      const selesai = (s) => { clearTimeout(t); noble.removeListener('stateChange', selesai); resolve(s); };
      const t = setTimeout(() => resolve(noble.state || 'unknown'), TUNGGU_ADAPTER_MS);
      noble.on('stateChange', selesai);
    });
    return { state };
  });
}

function buatJendela() {
  /*
   * DEFAULT: LAYAR PENUH TANPA BINGKAI.
   *
   * Sebelumnya jendela biasa berbingkai. Di kiosk itu salah pada dua hal:
   * tombol minimize/maximize/close terlihat oleh pengunjung, dan ukuran jendela
   * (1080x1920 dibatasi workArea) tidak pernah benar-benar seukuran layar TV
   * vertikal — tepi desktop ikut tampak.
   *
   * `frame: false` yang menghilangkan tombol jendela; `fullscreen: true` yang
   * membuatnya benar-benar seukuran layar (menutup taskbar juga). Diatur saat
   * pembuatan jendela, bukan sesudahnya, supaya tidak ada satu frame pun
   * tampil berbingkai.
   *
   * JALAN KELUAR untuk operator/dev: set PHOTOBOOTH_WINDOWED=1 → jendela biasa
   * berbingkai seperti dulu, supaya aplikasi bisa diperiksa tanpa terjebak
   * layar penuh. F11 menukar layar penuh saat aplikasi berjalan.
   */
  const windowed = String(process.env.PHOTOBOOTH_WINDOWED || '') === '1';
  const { width: layarW, height: layarH } = screen.getPrimaryDisplay().workAreaSize;
  jendela = new BrowserWindow({
    width: Math.min(1080, layarW),
    height: Math.min(1920, layarH),
    center: true,
    backgroundColor: '#000000',
    fullscreen: !windowed,
    frame: false,
    autoHideMenuBar: true,
    ...(windowed ? {} : { kiosk: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      // Renderer tetap terisolasi: tidak ada Node di sana. Jalur Bluetooth
      // hanya lewat IPC, jadi halaman web tidak bisa menyentuh perangkat OS.
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // F11 menukar layar penuh — tanpa ini, jendela berbingkai yang sudah
  // di-fullscreen tidak bisa dikembalikan tanpa mengedit berkas ini.
  jendela.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      jendela.setFullScreen(!jendela.isFullScreen());
    }
  });

  /**
   * Jaring pengaman tombol Back.
   *
   * UI lama yang masih ter-hosting kadang menavigasi window ke URL signage
   * (perilaku lama tombol Back). Di app desktop itu salah: halaman signage
   * dimuat DI DALAM jendela photobooth, jendela tidak pernah tertutup, kiosk
   * tidak pernah kembali, dan kamera tetap dipegang aplikasi ini. UI baru
   * sudah memakai jalur yang benar (window.kioskEmbed.close), tapi salinan
   * hosting butuh waktu ter-deploy — jadi selama itu, navigasi keluar dari
   * origin UI menuju host signage DICEGAT dan ditafsirkan sebagai permintaan
   * kembali ke kiosk: kamera dilepas rapi, aplikasi keluar, jendela kiosk
   * muncul kembali.
   */
  jendela.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url);
      const now = jendela.webContents.getURL();
      if (!now) return;
      const asal = new URL(now);
      if (target.origin === asal.origin) return;
      const menujuSignage = /(^|\.)jagoai\.dev$/.test(target.hostname)
        || (target.hostname === 'localhost' && target.port === '3001');
      if (menujuSignage && kioskEmbed) {
        event.preventDefault();
        console.log('[main] Navigasi ke signage dicegat — ditafsirkan permintaan kembali ke kiosk:', url);
        kioskEmbed.lepasKameraLaluKeluar();
      }
    } catch {
      // URL tidak valid — biarkan perilaku bawaan.
    }
  });
  const tujuanUi = urlUiEfektif();
  console.log('[main] UI dimuat dari:', tujuanUi, tujuanUi === URL_UI_LOKAL ? '(ter-bundel)' : '(hosting)');
  jendela.loadURL(tujuanUi);
  jendela.on('closed', () => { jendela = null; });
}

app.whenReady().then(() => {
  daftarkanIpc();

  // UI ter-bundel: protokol file server + penyamaran Origin untuk CORS.
  if (distTersedia()) {
    daftarkanProtokolUi();
    pasangRewriteOrigin();
  } else {
    console.warn('[main] dist/ tidak ditemukan — UI dimuat dari hosting:', URL_UI);
  }

  /**
   * Integrasi kiosk JagoAI: izin kamera tanpa prompt, hitung mundur
   * auto-return, dan jalur keluar yang melepas kamera dengan rapi.
   * Semua no-op bila aplikasi tidak diluncurkan kiosk (--jagoai-kiosk).
   */
  kioskEmbed = pasangKioskEmbed({ getJendela: () => jendela, app, ipcMain, session });

  buatJendela();
  kioskEmbed.start();

  app.on('activate', () => {
    if (!jendela) {
      buatJendela();
      kioskEmbed.start();
    }
  });
});

app.on('window-all-closed', () => {
  putuskan().finally(() => app.quit());
});
