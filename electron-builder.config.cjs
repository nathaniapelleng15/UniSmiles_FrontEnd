/**
 * Konfigurasi paket installer aplikasi desktop.
 *
 * Dua hal yang WAJIB benar di sini, dan keduanya pernah jadi masalah:
 *
 * 1. `asar: false` untuk berkas aplikasi. noble memuat binding native
 *    (`prebuilds/*.node`) lewat jalur relatif di dalam paketnya; membaca dari
 *    dalam arsip asar tidak dapat diandalkan, dan kegagalannya adalah "Bluetooth
 *    tidak tersedia" — pesan yang menuding radio, bukan kemasan.
 *
 * 2. `NSBluetoothAlwaysUsageDescription` untuk macOS. Tanpa kalimat itu, macOS
 *    menghentikan aplikasi saat menyentuh Bluetooth (bukan sekadar menolak), dan
 *    izin yang tinggal SATU kali itu tidak pernah muncul. Isinya harus menjelaskan
 *    untuk apa, karena operator kiosk yang membacanya.
 *
 * Izin kamera tidak perlu didaftarkan di sini: Electron memakai izin OS saat
 * diminta lewat sesi, dan photobooth sudah punya jalurnya.
 */
module.exports = {
  appId: 'net.uniinside.photobooth',
  productName: 'UniSmiles Photobooth',
  directories: { output: 'release' },
  files: [
    'electron/**/*',
    'package.json',
    // UI ter-bundel: hasil `npm run build` ikut dipaketkan dan dilayani lewat
    // protokol app-photobooth:// (lihat electron/main.cjs). Aplikasi desktop
    // jadi mandiri — satu installer memuat shell + UI yang versinya selalu
    // cocok, dan kiosk tidak bergantung pada hosting untuk menampilkan UI.
    // Fallback ke hosting tetap ada bila dist/ tidak ada (installer lama).
    'dist/**',
    '!src/**',
    '!services/**',
    '!components/**',
    '!node_modules/**/{test,tests,__tests__,docs,example,examples}/**',
  ],
  // Native binding harus tetap sebagai berkas nyata, bukan di dalam arsip.
  asar: false,
  /**
   * JANGAN rebuild modul native.
   *
   * noble memakai binding N-API di folder prebuilds (node.napi.node) yang
   * ABI-stabil — itu justru alasan N-API ada, jadi ia berjalan di Electron tanpa
   * dikompilasi ulang. Membiarkan rebuild menyala membuat electron-rebuild
   * mencoba mengompilasi paket `usb` (dipakai hanya oleh jalur Linux/dongle HCI,
   * TIDAK PERNAH di macOS/Windows — lihat lib/resolve-bindings.js) dan gagal,
   * sehingga installer tidak pernah jadi.
   */
  npmRebuild: false,
  asarUnpack: ['**/*.node'],
  extraMetadata: { main: 'electron/main.cjs' },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.photography',
    extendInfo: {
      // WAJIB: tanpa ini macOS menghentikan proses saat menyentuh Bluetooth.
      NSBluetoothAlwaysUsageDescription:
        'Diperlukan untuk mengirim foto ke printer label NIIMBOT. '
        + 'Izin ini hanya sekali; setelah itu cetak berjalan tanpa dialog.',
    },
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    perMachine: true,
    allowToChangeInstallationDirectory: true,
  },
};
