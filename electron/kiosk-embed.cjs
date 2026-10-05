/**
 * Integrasi aplikasi photobooth dengan kiosk JagoAI Signage.
 *
 * KENAPA ADA
 *
 * Aplikasi ini diluncurkan dari tombol shortcut kiosk JagoAI. Proses utama
 * JagoAI menyembunyikan jendela kiosknya lalu menjalankan exe ini dengan
 * argumen: --jagoai-kiosk --jagoai-idle=<detik> --jagoai-hash. Tiga hal belum
 * pernah tersambung:
 *
 *   1. Kiosk tidak pernah tahu kapan photobooth ditutup — hanya event 'close'
 *      proses anak yang memberi tahu, dan itu tidak datang pada semua jalur
 *      keluar.
 *   2. Kiosk menutup aplikasi setelah idle-nya habis, tapi aplikasi tidak
 *      pernah menampilkan sisa waktunya — pengunjung diputus tanpa aba-aba.
 *   3. Saat idle habis, kiosk memanggil terminateActiveDesktopApp() TANPA
 *      memberi tahu renderer bahwa kamera akan dilepas. Signage yang bangun
 *      langsung berebut webcam dengan driver Windows yang belum selesai
 *      melepas device (kamera LUMINOUS C50 hanya bisa dipegang satu pihak).
 *      Pemilik kamera yang tahu kapan ia berhenti memakainya, jadi aplikasi
 *      inilah yang harus menghentikannya dengan rapi sebelum keluar.
 *
 * PEMBAGIAN TUGAS
 *
 *   - Berkas ini (proses utama): polling backend kiosk, keputusan keluar,
 *     pelepasan kamera, mematikan aplikasi.
 *   - electron/preload.cjs: menggambar pill hitung mundur di DOM halaman dan
 *     menyediakan window.kioskEmbed untuk renderer.
 */

const KIOSK_BACKEND = (process.env.JAGOAI_BACKEND_URL || 'http://localhost:3001').replace(/\/+$/, '');

/** Interval polling exit-request; sama dengan kiosk (2 detik). */
const POLL_MS = 2000;
/** Timeout probe HTTP: backend bisa hidup tapi tidak menjawab. */
const PROBE_TIMEOUT_MS = 1500;
/** Umur maksimum permintaan keluar agar tidak dianggap permintaan baru. */
const EXIT_REQUEST_MAX_AGE_MS = 15000;
/**
 * Batas idle bila kiosk tidak pernah mengumumkannya. Hanya dipakai untuk
 * MENAMPILKAN hitung mundur; yang menutup aplikasi tetap kiosk. Nilainya sama
 * dengan default kiosk (general.photoboothIdleTimeout = 30 detik).
 */
const IDLE_FALLBACK_SECONDS = 30;

/**
 * Batas idle untuk hitung mundur yang dikelola SENDIRI (self-managed).
 *
 * Dipakai bila kiosk tidak pernah terjangkau lewat polling dan TIDAK mengumumkan
 * batas lewat argumen. Nilainya sengaja sama dengan batas watcher kiosk
 * (desktopIdleWatcher, default 30 detik): kalau lebih panjang, kiosk akan
 * menutup aplikasi lebih dulu TANPA peringatan — pill hitung mundur menjadi
 * bohong. Dengan nilai yang sama, peringatan muncul sepanjang masa idle.
 */
const IDLE_SELF_MANAGED_SECONDS = 30;

function readFlag(argv, name) {
  if (argv.some((a) => a === name)) return '';
  const withValue = argv.find((a) => String(a).startsWith(`${name}=`));
  return withValue === undefined ? null : String(withValue).slice(name.length + 1);
}

/**
 * Apakah proses ini diluncurkan kiosk JagoAI?
 *
 * Dua bentuk diterima: `--jagoai-kiosk` polos dan `--jagoai-kiosk=1`. Versi
 * JagoAI sekarang mengirim yang polos, tapi bentuk bernilai dipakai argumen
 * tetangganya (`--jagoai-idle=NN`), jadi keduanya dikenali.
 */
function isKioskRun(argv = process.argv) {
  return argv.some((a) => a === '--jagoai-kiosk' || String(a).startsWith('--jagoai-kiosk='));
}

/** Batas idle (detik) yang diumumkan kiosk lewat argumen. 0 = tidak diumumkan. */
function idleSecondsFromArgv(argv = process.argv) {
  const n = Number(readFlag(argv, '--jagoai-idle'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function pasangKioskEmbed({ getJendela, app, ipcMain, session }) {
  /**
   * Integrasi aktif bila:
   *  - diluncurkan kiosk JagoAI (flag --jagoai-kiosk), ATAU
   *  - dijalankan dalam mode kiosk normal — app ini memang khusus kiosk, jadi
   *    hitung mundur, deteksi aktivitas, dan jalur keluar harus hidup juga
   *    bila installer kiosk BELUM menyuntikkan flag.
   *
   * Mode operator (PHOTOBOOTH_WINDOWED=1) mematikan semuanya: jendela berbingkai
   * untuk memeriksa aplikasi tanpa terkena auto-return.
   */
  const aktif = isKioskRun() || String(process.env.PHOTOBOOTH_WINDOWED || '') !== '1';

  /**
   * Jendela dibaca lewat getter, bukan disimpan saat pemasangan: integrasi ini
   * dipasang SEBELUM jendela dibuat (kiosk perlu izin kamera dan IPC siap lebih
   * dulu).
   */
  const jendelaSekarang = () => (typeof getJendela === 'function' ? getJendela() : getJendela) || null;

  /** Sisa detik yang ditampilkan; -1 = belum mulai menghitung. */
  let sisa = -1;
  let intervalTampilan = null;
  let pollTimer = null;
  let selesai = false;
  let exitRequestSeen = 0;
  let idleBatasDetik = idleSecondsFromArgv();
  let warnedOffline = false;

  /**
   * Timer idle yang dikelola sendiri (fallback).
   *
   * Kiosk yang benar menutup aplikasi ini lewat exit-request — timer ini hanya
   * cadangan untuk kondisi jalur itu tidak ada (installer kiosk belum diupdate,
   * backend mati). Menutup aplikasi sama saja mengembalikan layar ke kiosk:
   * kiosk menampilkan kembali halaman iklannya saat proses anak berakhir.
   */
  let idleSelfTimer = null;
  /** Sudahkah hitung mundur dimulai (agar tidak dipasang dua kali)? */
  let hitungMundurDimulai = false;

  function pasangIdleSelfTimer() {
    if (idleSelfTimer) clearTimeout(idleSelfTimer);
    idleSelfTimer = setTimeout(() => {
      idleSelfTimer = null;
      if (selesai) return;
      console.log('[kiosk-embed] Batas idle tercapai (timer mandiri) — keluar');
      lepasKameraLaluKeluar();
    }, Math.max(1, idleBatasDetik) * 1000);
  }

  /**
   * Mulai hitung mundur (sekali saja) bila integrasi kiosk aktif tapi jalur
   * kiosk tidak tersedia (installer belum menyuntik flag / backend mati).
   * Sisa waktu dan timer mandiri dipasang di sini supaya pill benar-benar
   * tampil dan aplikasi tetap menutup diri saat idle.
   */
  function pastikanHitungMundurMandiri() {
    if (hitungMundurDimulai || selesai || !aktif) return;
    hitungMundurDimulai = true;
    if (!idleBatasDetik) idleBatasDetik = IDLE_SELF_MANAGED_SECONDS;
    if (sisa < 0) sisa = idleBatasDetik;
    mulaiTampilan();
    pasangIdleSelfTimer();
    kirimSisa();
  }

  function kirimSisa() {
    const jendela = jendelaSekarang();
    if (!jendela || jendela.isDestroyed()) return;
    const wc = jendela.webContents;
    if (!wc || wc.isDestroyed() || wc.isLoading()) return;
    wc.send('jagoai:countdown', sisa);
  }

  /**
   * Beacon aktivitas ke backend kiosk (POST /api/cms/activity/ping).
   *
   * KENAPA PENTING — pelajaran dari lapangan (2026-09-30)
   *
   * Kiosk menutup aplikasi lewat watcher-nya sendiri (desktopIdleWatcher),
   * yang sumber reset-nya hanya beacon ini dan input OS FISIK (uiohook).
   * Gesture udara dan interaksi lain yang tidak menghasilkan event OS tidak
   * pernah me-reset watcher — kiosk taskkill aplikasi di detik ke-30 PADAHAL
   * pill di sini baru saja direset dan menunjukkan sisa waktu banyak.
   * Meneruskan setiap aktivitas ke beacon membuat kedua timer bergerak sinkron.
   */
  let pingBerjalan = false;
  async function pingAktivitas() {
    if (pingBerjalan) return;
    pingBerjalan = true;
    try {
      await fetch(`${KIOSK_BACKEND}/api/cms/activity/ping`, {
        method: 'POST',
        signal: AbortSignal.timeout(1200),
      });
    } catch {
      // Backend kiosk tidak ada (dev lokal tanpa kiosk) — abaikan saja.
    } finally {
      pingBerjalan = false;
    }
  }

  /**
   * Lepas kamera dengan RAPI, lalu keluar.
   *
   * Kenapa tidak langsung app.quit(): menutup renderer memutus stream kamera
   * secara paksa di saat yang sama kiosk menyalakan lagi kameranya. Driver
   * Windows (DirectShow/MediaFoundation) butuh waktu melepas device LUMINOUS
   * C50, dan kiosk kalah race itu — kamera signage mati sampai device dicabut
   * secara fisik. Jadi: stop track di halaman, tunggu driver, baru keluar.
   */
  async function lepasKameraLaluKeluar(graceMs = 350) {
    if (selesai) return;
    selesai = true;
    clearInterval(pollTimer);
    clearInterval(intervalTampilan);
    if (idleSelfTimer) clearTimeout(idleSelfTimer);
    pollTimer = null;
    intervalTampilan = null;
    idleSelfTimer = null;

    const win = jendelaSekarang();
    const wc = win && !win.isDestroyed() ? win.webContents : null;
    if (wc && !wc.isDestroyed()) {
      const script = '(function(){try{'
        + 'document.querySelectorAll("video").forEach(function(v){'
        + 'try{if(v.srcObject){v.srcObject.getTracks().forEach(function(t){try{t.stop();}catch(e){}});}}catch(e){}'
        + 'try{v.srcObject=null;}catch(e){}'
        + 'try{v.pause();}catch(e){}'
        + '});}catch(e){}})()';
      try {
        await Promise.race([
          wc.executeJavaScript(script, false),
          new Promise((r) => setTimeout(r, 1200)),
        ]);
      } catch { /* renderer hang/crash — tetap lanjut keluar */ }
    }
    // Jendela disembunyikan lebih dulu supaya desktop tidak sempat terlihat
    // saat driver sedang melepas device.
    try { if (win && !win.isDestroyed()) win.hide(); } catch { /* sudah hilang */ }
    setTimeout(() => {
      try { app.quit(); } catch { process.exit(0); }
    }, Math.max(0, graceMs));
  }

  function mulaiTampilan() {
    if (intervalTampilan || selesai) return;
    intervalTampilan = setInterval(() => {
      if (selesai) return;
      if (sisa > 0) sisa -= 1;
      kirimSisa();
    }, 1000);
  }

  /**
   * Polling backend kiosk.
   *
   * Dua nilai dari SATU endpoint, dibaca dengan urutan TERBALIK dari kiosk:
   *   - idleLimitSeconds: batas idle efektif kiosk untuk aplikasi ini (global
   *     atau per-app dari Admin CMS) — inilah yang ditampilkan sebagai sisa.
   *   - exitRequestedAt: batas idle tercapai, atau tombol kembali ditekan di
   *     kiosk. Saat itu kiosk menutup aplikasi ini.
   *
   * PENTING soal urutan: batas yang diumumkan HARUS dibaca sebelum memeriksa
   * exitRequestedAt pada putaran yang sama. Kalau terbalik, saat batas idle
   * turun dari mis. 30 detik ke 10 detik, permintaan keluar lama yang tersimpan
   * langsung dianggap permintaan BARU (umurnya di bawah 15 detik) dan aplikasi
   * menutup diri sendiri seketika.
   */
  function mulaiPolling() {
    if (pollTimer || !jendelaSekarang()) return;
    pollTimer = setInterval(async () => {
      if (selesai) return;
      try {
        // Dua endpoint sekaligus: /activity/last membawa batas idle yang
        // diumumkan watcher kiosk (untuk menyinkronkan pill), /activity/exit-
        // request membawa permintaan keluar. Keduanya di sidecar lokal.
        const [hasilLast, hasilExit] = await Promise.allSettled([
          fetch(`${KIOSK_BACKEND}/api/cms/activity/last`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
          fetch(`${KIOSK_BACKEND}/api/cms/activity/exit-request`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) }),
        ]);

        if (hasilLast.status === 'fulfilled' && hasilLast.value.ok) {
          const last = await hasilLast.value.json().catch(() => null);
          const batasBaru = Number(last && last.idleLimitSeconds);
          if (Number.isFinite(batasBaru) && batasBaru > 0 && batasBaru !== idleBatasDetik) {
            // Kiosk mengumumkan batas idle miliknya (global/per-app dari Admin
            // CMS). Pill mengikuti supaya hitung mundur SINKRON dengan watcher
            // yang benar-benar menutup aplikasi — bukan dua angka berbeda.
            idleBatasDetik = Math.round(batasBaru);
            sisa = idleBatasDetik;
            kirimSisa();
            pasangIdleSelfTimer();
          }
        }

        if (hasilExit.status !== 'fulfilled' || !hasilExit.value.ok) return;
        const body = await hasilExit.value.json();
        warnedOffline = false;

        const diminta = Number(body && body.exitRequestedAt);
        if (Number.isFinite(diminta) && diminta > 0 && diminta !== exitRequestSeen) {
          exitRequestSeen = diminta;
          const umur = Date.now() - diminta;
          if (umur >= 0 && umur < EXIT_REQUEST_MAX_AGE_MS) {
            console.log('[kiosk-embed] Kiosk meminta aplikasi keluar (umur ' + umur + ' ms) — melepas kamera');
            lepasKameraLaluKeluar();
          }
        }
      } catch {
        // Backend kiosk tidak menjawab — normal kalau aplikasi dijalankan tanpa
        // kiosk. Sekali saja supaya konsol tidak dibanjiri pesan berulang.
        if (!warnedOffline) {
          warnedOffline = true;
          console.info('[kiosk-embed] Backend kiosk tidak menjawab di ' + KIOSK_BACKEND
            + ' — hitung mundur memakai ' + (idleBatasDetik || IDLE_FALLBACK_SECONDS) + 's. Pesan ini tidak diulang.');
        }
        // Jalur kiosk tidak tersedia → hidupkan hitung mundur mandiri supaya
        // pengunjung tetap melihat sisa waktu dan aplikasi tetap menutup diri
        // saat idle (bila flag tidak ada, batasnya = batas watcher kiosk).
        pastikanHitungMundurMandiri();
      }
    }, POLL_MS);
  }

  function mulaiKioskEmbed() {
    const jendela = jendelaSekarang();
    if (!aktif || !jendela || jendela.isDestroyed()) return;
    if (!idleBatasDetik) idleBatasDetik = IDLE_FALLBACK_SECONDS;

    jendela.webContents.on('did-finish-load', () => {
      // Hitung mundur dimulai pada muat halaman PERTAMA saja. Navigasi ulang di
      // dalam aplikasi tidak boleh mengembalikan sisa waktu ke penuh — itu
      // membuat auto-return tidak pernah tercapai.
      if (sisa < 0) {
        sisa = idleBatasDetik;
        mulaiTampilan();
        pasangIdleSelfTimer();
      }
      kirimSisa();
    });

    mulaiPolling();
  }

  /**
   * Kamera: jangan bergantung pada prompt izin OS. Pengunjung kiosk tidak punya
   * mouse maupun keyboard untuk menjawabnya, dan permintaan yang menggantung
   * membuat halaman menunggu. Izin selain kamera/mikrofon ditolak.
   */
  function pasangIzinKamera() {
    if (!session) return;
    const DIIZINKAN = new Set(['media', 'audioCapture', 'videoCapture']);
    session.defaultSession.setPermissionRequestHandler((_wc, izin, callback) => {
      callback(DIIZINKAN.has(izin));
    });
  }

  /**
   * IPC untuk renderer: SATU jalur keluar yang benar.
   *
   * Di kiosk, mengarahkan window ke URL signage akan memuat halaman signage DI
   * DALAM jendela photobooth — jendela itu tidak pernah tertutup. Yang benar
   * adalah membiarkan kiosk menutup aplikasi ini: jendela kiosk yang tadi
   * disembunyikan muncul kembali dengan halaman iklannya.
   */
  function daftarkanIpc() {
    ipcMain.handle('kioskembed:status', () => ({
      embedded: aktif,
      idleLimitSeconds: idleBatasDetik,
      sisaDetik: sisa,
    }));
    ipcMain.handle('kioskembed:close', (event) => {
      let asal = '';
      try { asal = event && event.sender ? event.sender.getURL() : ''; } catch { /* sender hilang */ }
      console.log('[kiosk-embed] Renderer meminta keluar:', asal || '(tidak diketahui)');
      // Berlaku juga di mode berdiri sendiri: kamera tetap dilepas rapi supaya
      // device tidak tertinggal dalam keadaan terpakai.
      lepasKameraLaluKeluar(aktif ? 350 : 0);
      return { ok: true };
    });

    /**
     * Aktivitas pengunjung dari preload (pointerdown/move, touch, key, wheel —
     * ditangkap fase capture sehingga kode halaman tidak bisa membungkamnya).
     * Tiga hal sekaligus: sisa waktu kembali penuh, timer mandiri direset, dan
     * BEACON ke backend kiosk supaya watcher kiosk ikut reset — tanpa ini kiosk
     * menutup aplikasi lebih awal padahal pill masih menunjukkan sisa waktu.
     */
    ipcMain.on('kioskembed:activity', () => {
      if (selesai || !aktif) return;
      if (sisa >= 0 && sisa < idleBatasDetik) {
        sisa = idleBatasDetik;
        kirimSisa();
      }
      if (hitungMundurDimulai || sisa >= 0) pasangIdleSelfTimer();
      pingAktivitas();
    });
  }

  pasangIzinKamera();
  daftarkanIpc();

  return {
    start: mulaiKioskEmbed,
    stop() {
      clearInterval(pollTimer);
      clearInterval(intervalTampilan);
      if (idleSelfTimer) clearTimeout(idleSelfTimer);
      pollTimer = null;
      intervalTampilan = null;
      idleSelfTimer = null;
      hitungMundurDimulai = false;
      selesai = true;
    },
    lepasKameraLaluKeluar,
    get embedded() { return aktif; },
    get idleLimitSeconds() { return idleBatasDetik; },
  };
}

module.exports = {
  KIOSK_BACKEND,
  IDLE_FALLBACK_SECONDS,
  POLL_MS,
  EXIT_REQUEST_MAX_AGE_MS,
  pasangKioskEmbed,
  isKioskRun,
  idleSecondsFromArgv,
};
