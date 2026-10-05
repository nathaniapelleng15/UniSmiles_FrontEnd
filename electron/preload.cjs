/**
 * Jembatan renderer <-> proses utama.
 *
 * Renderer (UI photobooth) tidak punya akses Node. Yang dibuka di sini hanya
 * lima fungsi printer — sengaja sempit, supaya halaman web tidak bisa menyentuh
 * berkas, proses, atau perangkat lain.
 *
 * Nama fungsi dan bentuk datanya sengaja cocok dengan jalur Web Bluetooth, jadi
 * pemanggilnya di UI bisa memakai keduanya dengan cara yang sama:
 *   - sambung()  = pengganti navigator.bluetooth requestDevice/getDevices
 *   - cetak()    = pengganti client.sendRaw lewat Web Bluetooth
 */
const { contextBridge, ipcRenderer } = require('electron');

// exposeInMainWorld memasang di `window` (bukan `navigator`) — itulah satu-satunya
// tempat contextBridge bisa menaruh sesuatu. Pemanggilnya membaca dari globalThis.
contextBridge.exposeInMainWorld('kioskPrinter', {
  /** Selalu true di aplikasi desktop: transport native tidak butuh dukungan browser. */
  tersedia: () => ipcRenderer.invoke('printer:tersedia'),

  /** Sambung ke printer lewat Bluetooth native. Tanpa dialog, tanpa izin halaman. */
  sambung: (opsi = {}) => ipcRenderer.invoke('printer:sambung', opsi),

  /** Putuskan sambungan (dipakai saat keluar atau saat radio perlu dilepas). */
  terputus: () => ipcRenderer.invoke('printer:terputus'),

  /** Status sambungan sekarang. */
  status: () => ipcRenderer.invoke('printer:status'),

  /**
   * Cetak satu halaman yang sudah di-encode.
   * `halaman` = hasil ImageEncoder (rowsData, cols, rows, pageColor) — bentuk
   * yang sama dengan yang dikirim ke printer lewat Web Bluetooth.
   */
  cetak: (halaman, opsi = {}) => ipcRenderer.invoke('printer:cetak', { halaman, opsi }),
});

/**
 * Jembatan kiosk JagoAI.
 *
 * KENAPA ADA
 *
 * Aplikasi ini bisa diluncurkan dari kiosk JagoAI Signage. Di sana layar BUKAN
 * milik photobooth: mengarahkan window ke URL signage (perilaku lama tombol
 * Back/Home) akan memuat halaman signage DI DALAM jendela photobooth, dan
 * jendela itu tidak pernah tertutup. Yang benar adalah meminta aplikasi keluar,
 * lalu kiosk menampilkan kembali halaman iklannya.
 *
 * `status()` melaporkan apakah proses ini berjalan di bawah kiosk
 * (`embedded: true`) — renderer memakainya untuk memutuskan jalur keluar.
 */
contextBridge.exposeInMainWorld('kioskEmbed', {
  status: () => ipcRenderer.invoke('kioskembed:status'),
  /**
   * Keluar dari aplikasi dan kembalikan layar ke signage kiosk.
   * Proses utama melepas kamera dengan rapi dulu (driver Windows butuh waktu
   * melepas device sebelum signage memakainya kembali), baru menutup aplikasi.
   */
  close: () => ipcRenderer.invoke('kioskembed:close'),
  /**
   * Langganan sisa hitung mundur dari proses utama (detik). Nilai 0 atau
   * negatif berarti pill disembunyikan — pemanggil cukup menggambar ulang.
   */
  onCountdown: (callback) => {
    if (typeof callback === 'function') {
      ipcRenderer.on('jagoai:countdown', (_event, sisa) => callback(sisa));
    }
  },
  /**
   * Laporkan aktivitas pengunjung secara eksplisit (mis. dari handler tombol
   * UI). Jalur normal adalah deteksi otomatis di bawah — fungsi ini cadangan.
   */
  notifyActivity: () => ipcRenderer.send('kioskembed:activity'),
});

/**
 * Alias supaya kode yang sudah mengenal bridge BrowserView JagoAI
 * (`window.jagoai.closePhotobooth()`) tetap bekerja di aplikasi desktop.
 */
contextBridge.exposeInMainWorld('jagoai', {
  isDesktopApp: true,
  closePhotobooth: () => ipcRenderer.invoke('kioskembed:close'),
});

/**
 * Pill hitung mundur auto-return.
 *
 * Digambar di DOM halaman (isolated world berbagi DOM dengan halaman), bukan
 * sebagai jendela terpisah: jendela tambahan akan muncul di atas aplikasi lain
 * yang diluncurkan kiosk. Sisa detik datang dari proses utama lewat
 * 'jagoai:countdown' — hanya kiosk yang memegang timer idle sebenarnya, jadi
 * halaman tidak boleh menghitung sendiri (nanti tampilannya menyimpang).
 */
let pill = null;
let pillNum = null;
let pillPulse = null;

function pastikanPill() {
  if (!document.body) return;
  if (pill && !pill.isConnected) document.body.appendChild(pill);
  if (pill) return;

  pill = document.createElement('div');
  pill.id = '__jagoai-countdown';
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-live', 'polite');
  pill.style.cssText = [
    'position:fixed', 'top:14px', 'right:14px', 'z-index:2147483647',
    'display:none', 'align-items:center', 'gap:8px', 'padding:8px 14px',
    'border-radius:999px', 'background:rgba(10,14,23,0.35)',
    'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
    'border:1px solid rgba(255,255,255,0.14)', 'color:rgba(255,255,255,0.55)',
    'font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif',
    'pointer-events:none', 'white-space:nowrap', 'opacity:0',
    'transition:opacity .35s ease, background .3s ease, color .3s ease',
    'box-shadow:0 4px 18px rgba(0,0,0,0.25)',
  ].join(';');

  const label = document.createElement('span');
  label.textContent = 'Kembali otomatis dalam';
  pillNum = document.createElement('strong');
  pillNum.style.cssText = [
    'min-width:26px', 'height:26px', 'display:inline-flex',
    'align-items:center', 'justify-content:center', 'border-radius:50%',
    'background:rgba(255,255,255,0.12)', 'color:rgba(255,255,255,0.75)',
    'font-size:13px', 'transition:background .3s ease',
  ].join(';');
  pill.appendChild(label);
  pill.appendChild(pillNum);
  document.body.appendChild(pill);
}

function pulsaPill(aktif) {
  if (!pill) return;
  if (aktif && !pillPulse) {
    // Web Animations API — tidak terkena blokir CSP halaman.
    pillPulse = pill.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }],
      { duration: 900, iterations: Infinity },
    );
  } else if (!aktif && pillPulse) {
    pillPulse.cancel();
    pillPulse = null;
  }
}

function gambarHitungMundur(sisa) {
  if (typeof sisa !== 'number' || sisa <= 0) {
    if (pill) {
      pill.style.opacity = '0';
      pulsaPill(false);
      setTimeout(() => {
        if (pill && pill.style.opacity === '0') pill.style.display = 'none';
      }, 400);
    }
    return;
  }

  pastikanPill();
  if (!pill || !pillNum) return;

  const kritis = sisa <= 3;
  pill.style.background = kritis ? 'rgba(220,38,38,0.88)' : 'rgba(10,14,23,0.35)';
  pill.style.border = kritis ? '1px solid rgba(255,255,255,0.35)' : '1px solid rgba(255,255,255,0.14)';
  pill.style.color = kritis ? '#ffffff' : 'rgba(255,255,255,0.55)';
  pillNum.style.background = kritis ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.12)';
  pillNum.style.color = kritis ? '#ffffff' : 'rgba(255,255,255,0.75)';
  pulsaPill(kritis);

  pillNum.textContent = sisa + 's';
  pill.style.display = 'flex';
  void pill.offsetWidth; // paksa reflow agar transisi opacity jalan
  pill.style.opacity = '1';
}

ipcRenderer.on('jagoai:countdown', (_event, sisa) => {
  try {
    gambarHitungMundur(sisa);
  } catch {
    // Halaman mengubah DOM sendiri — percobaan berikutnya memperbaikinya.
  }
});

// ---------------------------------------------------------------------------
// Deteksi aktivitas pengunjung → reset hitung mundur di proses utama.
//
// KENAPA DI PRELOAD, BUKAN DI HALAMAN
//
// Halaman tidak perlu tahu ada hitung mundur, dan event di halaman bisa
// di-stopPropagation() oleh kode UI sehingga tidak pernah sampai ke window.
// Listener di preload memakai capture (fase tangkap) — event ditangkap SEBELUM
// halaman sempat menghentikannya.
// ---------------------------------------------------------------------------

/** Jeda antar laporan aktivitas (ms) — jangan membanjiri IPC saat drag/scroll. */
const JEDA_LAPOR_MS = 1000;
let terakhirLapor = 0;

function laporkanAktivitas() {
  const kini = Date.now();
  if (kini - terakhirLapor < JEDA_LAPOR_MS) return;
  terakhirLapor = kini;
  ipcRenderer.send('kioskembed:activity');
}

for (const nama of ['pointerdown', 'pointermove', 'touchstart', 'keydown', 'wheel']) {
  window.addEventListener(nama, laporkanAktivitas, { passive: true, capture: true });
}

// Halaman photobooth adalah SPA: navigasi internal bisa melepas pill dari DOM.
if (document.body) {
  pastikanPill();
} else {
  window.addEventListener('DOMContentLoaded', pastikanPill, { once: true });
}
