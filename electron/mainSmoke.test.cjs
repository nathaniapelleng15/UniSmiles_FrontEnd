/**
 * Smoke test proses utama TANPA Electron asli (regresi 2026-09-30).
 *
 * KENAPA TEST INI ADA
 *
 * Pernah terjadi: main.cjs memakai `fs` tanpa pernah me-require-nya. Aplikasi
 * crash saat startup — `node --check` TIDAK menangkapnya (yang dicek hanya
 * sintaks, bukan referensi runtime), dan bug baru ketahuan di kiosk saat
 * aplikasi menolak dibuka. Test ini me-require main.cjs asli dengan stub
 * Electron dan membuktikan proses utama benar-benar sampai membuat jendela
 * (loadURL terpanggil), sehingga bug kelas "lupa require / salah nama variabel
 * di jalur startup" gagal di sini, bukan di lapangan.
 *
 * EKSPEKTASI URL UI:
 *  - dist/ ada       → app-photobooth://ui/index.html (UI ter-bundel)
 *  - dist/ tidak ada → fallback hosting (URL_UI, https://photobooth...)
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

test('proses utama hidup sampai jendela dibuat (tanpa crash referensi runtime)', async () => {
  const repoElectron = path.join(__dirname);
  const DIST_DIR = path.join(repoElectron, '..', 'dist');
  const distAda = fs.existsSync(path.join(DIST_DIR, 'index.html'));

  let uiDimuat = '';
  const jendelaPalsu = {
    webContents: {
      on: () => {},
      getURL: () => '',
      isLoading: () => false,
      isDestroyed: () => false,
      send: () => {},
      executeJavaScript: () => Promise.resolve(),
    },
    on: () => {},
    // Rekam URL yang dimuat — inilah bukti buatJendela() tercapai.
    loadURL: (url) => { uiDimuat = url; },
    setFullScreen: () => {},
    isFullScreen: () => true,
    isDestroyed: () => false,
    hide: () => {},
  };

  // Handler IPC direkam supaya test bisa memicu jalur keluar resmi di akhir —
  // tanpa ini interval polling (2 dtk) menjaga event loop hidup dan node --test
  // menggantung sampai timeout (pernah terjadi; lihat mainSmoke.test.cjs).
  const handlerIpc = new Map();
  const electronStub = {
    app: {
      whenReady: () => Promise.resolve(),
      on: () => {},
      quit: () => {},
      getPath: () => repoElectron,
      requestSingleInstanceLock: () => true,
    },
    BrowserWindow: function () { return jendelaPalsu; },
    ipcMain: {
      handle: (nama, handler) => handlerIpc.set(nama, handler),
      on: () => {},
    },
    session: {
      defaultSession: {
        setPermissionRequestHandler: () => {},
        webRequest: {
          onBeforeSendHeaders: () => {},
          onHeadersReceived: () => {},
        },
      },
    },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1080, height: 1920 } }) },
    protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  };

  const Module = require('module');
  const requireAsli = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === 'electron') return electronStub;
    return requireAsli.apply(this, arguments);
  };

  try {
    // Kalau ada ReferenceError di jalur startup (modul level maupun saat
    // whenReady), require/promise ini melempar dan test gagal.
    require(path.join(repoElectron, 'main.cjs'));
    await new Promise((r) => setTimeout(r, 250));

    assert.ok(uiDimuat, 'loadURL tidak pernah dipanggil — proses utama crash sebelum jendela dibuat');
    if (distAda) {
      assert.ok(
        uiDimuat.startsWith('app-photobooth://'),
        `dist/ ada tapi UI tidak dimuat dari protokol lokal: ${uiDimuat}`,
      );
    } else {
      assert.ok(
        uiDimuat.startsWith('https://'),
        `dist/ tidak ada tapi UI tidak fallback ke hosting: ${uiDimuat}`,
      );
    }

    // WAJIB: matikan aplikasi lewat jalur keluar resmi supaya semua interval
    // (polling exit-request, countdown) dibersihkan dan node --test bisa keluar.
    const tutup = handlerIpc.get('kioskembed:close');
    assert.ok(tutup, 'handler kioskembed:close tidak terdaftar');
    await tutup({}, {});
    await new Promise((r) => setTimeout(r, 700)); // lewati grace keluar (350ms)
  } finally {
    Module.prototype.require = requireAsli;
  }
});
