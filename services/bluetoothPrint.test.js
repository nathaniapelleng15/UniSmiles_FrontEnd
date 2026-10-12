/**
 * Test tombol "Cetak Bluetooth" di photobooth.
 *
 * Yang dijaga di sini adalah bahwa jalur cetak LANGSUNG benar-benar terpasang
 * dan tidak bergantung pada kiosk-agent maupun server:
 *
 *   photobooth -> Web Bluetooth -> NiimBlueLib -> NIIMBOT B1 Pro
 *
 * Kalau tombol ini sampai memanggil `queuePrintJob` (jalur server), artinya
 * fitur "tanpa agent" itu tidak benar-benar ada — photobooth akan tetap butuh
 * agent hidup, dan di kiosk yang agent-nya mati cetak akan gagal.
 *
 * Fungsi-fungsi yang bisa dijalankan (geometri label) diuji di
 * labelGeometry.test.ts; di sini yang diperiksa adalah sambungannya.
 */

import assert from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const BOOTH = readFileSync(path.join(ROOT, 'components', 'PhotoBooth.tsx'), 'utf8');

/**
 * Ambil isi satu fungsi agar pemeriksaan tidak tersentuh kode lain.
 *
 * Menerima dua bentuk: tanpa parameter (`const x = async () => {`) dan dengan
 * parameter (`const x = async (a, b) => {`). Keduanya muncul di berkas ini, dan
 * versi yang tidak menerima parameter akan gagal dengan pesan "harus ada" yang
 * menyesatkan — seolah fungsinya tidak ada padahal cuma bentuknya beda.
 */
function bodyOf(name, source = BOOTH) {
  const patterns = [
    `const ${name} = async () => {`,
    `const ${name} = async (`,
  ];
  let start = -1;
  for (const p of patterns) {
    start = source.indexOf(p);
    if (start > 0) break;
  }
  assert.ok(start > 0, `${name} harus ada`);
  const rest = source.slice(start);
  // Penutup sejajar indentasi pembuka (dua spasi untuk fungsi di dalam komponen,
  // nol spasi untuk fungsi di level modul).
  const endInner = rest.indexOf('\n  };');
  const endTop = rest.indexOf('\n};');
  const candidates = [endInner, endTop].filter(v => v > 0);
  assert.ok(candidates.length > 0, `${name} harus punya penutup`);
  return rest.slice(0, Math.min(...candidates));
}

test('tombol cetak Bluetooth ada dan memanggil jalur langsung', () => {
  assert.match(BOOTH, /id="btn-bluetooth-print"/, 'tombol harus punya id stabil untuk diuji/diklik');
  assert.match(BOOTH, /onClick=\{\(\) => void handleBluetoothPrint\(\)\}/, 'tombol harus memanggil handler langsung');
  assert.match(BOOTH, /isBluetoothPrintAvailable\(\)/, 'tombol hanya tampil kalau browser mendukung Web Bluetooth');
});

test('jalur Bluetooth TIDAK lewat server atau agent', () => {
  const fn = bodyOf('printViaBluetoothCore');
  // Inti permintaan: tanpa kiosk agent. Kalau ada queuePrintJob / fetch print job
  // di sini, jalur ini kembali bergantung pada server.
  assert.ok(!/queuePrintJob/.test(fn), 'tidak boleh memakai queuePrintJob');
  assert.ok(!/getPrintJobStatus/.test(fn), 'tidak boleh menunggu status dari server');
  assert.ok(!/kioskAgentBridge/.test(fn), 'tidak boleh bergantung pada kiosk-agent');
  assert.ok(!/startPrintPolling/.test(fn), 'tidak boleh polling server');
  // Harus benar-benar memakai printer Bluetooth.
  assert.match(fn, /new NiimbotPrinter\(\)/, 'harus membuat klien printer sendiri');
  // Argumennya boleh {} (sambung-ulang tanpa dialog) atau { forceChooser: true }
  // (pemasangan sekali dari klik pengguna); yang penting menyambung, bukan
  // mengandalkan jalur lain.
  assert.match(fn, /printer\.connect\(/, 'harus menyambung printer');
  assert.match(fn, /printer\.print\(/, 'harus mencetak lewat printer langsung');
});

test('satu sambungan dipakai ulang, tidak menyambung tiap kali klik', () => {
  // Web Bluetooth menolak requestDevice di luar gestur pengguna, jadi
  // menyambung ulang tiap klik akan gagal setelah klik pertama.
  const fn = bodyOf('printViaBluetoothCore');
  assert.match(fn, /bluetoothPrinterRef\.current/, 'klien harus disimpan di ref');
  assert.match(fn, /if \(!printer\.isConnected\(\)\)/, 'hanya menyambung kalau belum tersambung');
});

test('batal memilih perangkat dibedakan dari kegagalan printer', () => {
  const fn = bodyOf('handleBluetoothPrint');
  assert.match(fn, /cancel\|user\|No device\|chooser/i,
    'pemilih yang ditutup harus dipesan sebagai bukan kegagalan printer');
  assert.match(fn, /Pemilih perangkat ditutup/,
    'pesannya harus memberi tahu apa yang harus dilakukan');
});

test('yang dicetak hanya isi slot, tanpa frame', () => {
  const fn = bodyOf('printViaBluetoothCore');
  // Inti keluhan: frame ikut tercetak, dan bagian di luar bingkai slot ikut
  // tercetak. Yang benar hanya isi slot.
  assert.match(fn, /await prepareSelectedPrintImage\(\)/,
    'harus menyiapkan crop foto yang telah dipilih');
  const preparation = bodyOf('prepareSelectedPrintImage');
  assert.match(preparation, /capturedPhotos\[selectedPrintPhotoIndex\]/, 'sumbernya foto pilihan pengguna');
  assert.ok(!/finalUploadedUrl|generateCompositeImage\(\)/.test(fn),
    'tidak boleh fallback ke grid/frame digital');
});

test('generatePrintImage TIDAK menggambar frame apa pun', () => {
  const fn = bodyOf('generatePrintImage');
  // Kalau salah satu dari ini ada di dalamnya, frame akan muncul lagi di kertas.
  assert.ok(!/overlayUrl/.test(fn), 'artwork frame tidak boleh digambar');
  assert.ok(!/backgroundConfig/.test(fn), 'background frame tidak boleh digambar');
  assert.ok(!/strokeRect/.test(fn), 'border slot tidak boleh digambar');
  assert.ok(!/getSlotBorderConfig/.test(fn), 'border slot tidak boleh dipakai');
  assert.ok(!/\.elements/.test(fn), 'elemen teks/stiker frame tidak boleh digambar');
  // Dan ukurannya dari slot, bukan dari kanvas layout.
  assert.match(fn, /config\.slots\[photoIndex\]/, 'ukuran harus dari slot foto pilihan');
  assert.match(fn, /canvas\.width = slot\.width/, 'lebar kanvas = lebar slot');
  assert.match(fn, /canvas\.height = slot\.height/, 'tinggi kanvas = tinggi slot');
});

test('helper gambar tidak diduplikasi di dua tempat', () => {
  // Dua salinan drawCover/loadImg cepat atau lambat berbeda perilaku, dan
  // perbedaannya hanya terlihat di kertas.
  assert.match(BOOTH, /const drawCoverInto = \(/,
    'satu definisi drawCover di level modul');
  assert.match(BOOTH, /const loadImageElement = \(/,
    'satu definisi loadImg di level modul');
  assert.ok(!/const drawCover = \(/.test(BOOTH), 'tidak boleh ada salinan drawCover lagi');
  assert.ok(!/const loadImg = \(src/.test(BOOTH), 'tidak boleh ada salinan loadImg lagi');
  // generateCompositeImage masih ada dan tetap memakai helper yang sama.
  assert.match(BOOTH, /const loadImg = loadImageElement/,
    'generateCompositeImage harus memakai helper modul');
});

test('pengaturan Admin dipakai di jalur Bluetooth', () => {
  const fn = bodyOf('printViaBluetoothCore');
  // Ukuran kertas dari Admin -> ukuran label.
  assert.match(fn, /labelMmFromPaperSize\(kioskPaperSize\)/,
    'ukuran label harus mengikuti ukuran kertas Admin');
  // Penyesuaian tampilan + kalibrasi termal.
  assert.match(fn, /\.\.\.photoAdjust/, 'brightness/contrast/saturasi/fit dari Admin harus dipakai');
  assert.match(fn, /density: Number\(thermalDensity\)/, 'kepekatan dari Admin harus dipakai');
  assert.match(fn, /offsetYPx: Number\(thermalOffsetYPx\)/, 'geser vertikal dari Admin harus dipakai');
});

test('kalibrasi termal datang dari agent, jadi Admin benar-benar berpengaruh', () => {
  // Tanpa langganan ini, kepekatan dan geser selalu nilai netral dan pengaturan
  // Admin terlihat tersimpan tanpa efek.
  assert.match(BOOTH, /setThermalDensity\(dens\)/, 'kepekatan dibaca dari laporan agent');
  assert.match(BOOTH, /setThermalOffsetYPx\(oy\)/, 'geser vertikal dibaca dari laporan agent');
  assert.match(BOOTH, /setKioskPaperSize\(agentState\.paperSize\)/,
    'ukuran kertas dibaca dari laporan agent');
  // Dan nilainya harus diperiksa dulu: siaran pertama membawa undefined untuk
  // hal yang tidak dilaporkan, sedangkan bawaannya TIDAK netral.
  assert.match(BOOTH, /if \(dens !== null\) setThermalDensity\(dens\)/,
    'agent tidak boleh menimpa dengan nilai kosong');
  assert.match(BOOTH, /if \(oy !== null\) setThermalOffsetYPx\(oy\)/,
    'agent tidak boleh menimpa dengan nilai kosong');
});

test('bridge agent tidak menimpa setelan backend dengan bawaannya', () => {
  // Bawaan bridge bukan netral: paperSize '4R', fitMode 'fit', kepekatan 3.
  // Kalau diterapkan tanpa syarat, pengaturan dari backend yang sudah masuk
  // akan tertimpa balik, dan cetakan berikutnya salah ukuran.
  const BRIDGE = readFileSync(path.join(ROOT, 'services', 'kioskAgentBridge.ts'), 'utf8');
  assert.match(BRIDGE, /photoBrightness\?: number/,
    'field yang tidak dilaporkan harus bertipe opsional (undefined = tidak dilaporkan)');
  assert.match(BOOTH, /if \(agentState\.paperSize\)/,
    'ukuran kertas hanya diterapkan kalau ada');
});

test('konfigurasi cetak diambil berkala, karena bridge tidak dipakai', () => {
  assert.match(BOOTH, /setInterval\(\(\) => \{ void apply\(\); \}, 30_000\)/,
    'tanpa bridge, perubahan Admin hanya sampai kalau halaman dimuat ulang');
});

test('status printer dilaporkan ke Admin supaya panel tidak kosong', () => {
  const inti = bodyOf('printViaBluetoothCore');
  assert.match(inti, /reportStatus\('READY'/, 'sambungan berhasil harus dilaporkan');
  // Pelaporan tidak boleh menggagalkan cetak: di-void, bukan di-await.
  assert.match(inti, /void printer\.reportStatus\('READY'/,
    'pelaporan tidak boleh di-await di jalur cetak');
  // Kegagalan dilaporkan oleh handler tombol, tempat jalur langsung dipanggil.
  const handler = bodyOf('handleBluetoothPrint');
  assert.match(handler, /reportStatus\('ERROR'/, 'kegagalan harus dilaporkan');
});

test('tombol terkunci saat sambungan/cetak berlangsung', () => {
  // Mencegah dua cetakan fisik dari klik ganda.
  assert.match(BOOTH, /disabled=\{[^}]*btPrintState === 'connecting'[^}]*btPrintState === 'printing'/,
    'tombol harus terkunci selama proses');
  assert.match(BOOTH, /id="bluetooth-print-status"/, 'harus ada status yang terlihat');
});

test('jalur cetak lama tetap ada, tidak digantikan', () => {
  // Fitur ini TAMBAHAN. Menghapus jalur lama akan memutus kiosk yang memang
  // memakai printer sistem lewat agent.
  assert.match(BOOTH, /const handleManualPrint = async/, 'cetak manual harus tetap ada');
  assert.match(BOOTH, /const handleAutoPrint = async/, 'cetak otomatis lewat agent harus tetap ada');
  assert.match(BOOTH, /queuePrintJob\(/, 'jalur server harus tetap ada');
  assert.match(BOOTH, /id="btn-print"/, 'tombol print utama harus tetap ada');
});

test('konsol tidak dibanjiri pesan kiosk-agent yang tidak aktif', () => {
  // kiosk-agent memang tidak selalu jalan; mencetak lewat Bluetooth tidak
  // memerlukannya. Pesan berulang tiap 5 detik menutupi error yang sebenarnya.
  const BRIDGE = readFileSync(path.join(ROOT, 'services', 'kioskAgentBridge.ts'), 'utf8');
  assert.match(BRIDGE, /warnedOffline/, 'harus ada penanda supaya pesan ditulis sekali');
  assert.match(BRIDGE, /console\.info\(/, 'pakai info, bukan error, untuk kondisi normal ini');
  assert.match(BRIDGE, /tidak diulang/, 'pesannya harus menyebut bahwa tidak akan diulang');
});

// --- Cetak otomatis tanpa memilih printer ---

test('cetak OTOMATIS memakai jalur langsung, bukan menunggu agent', () => {
  // Sebelumnya hanya tombol yang mencetak langsung; cetak otomatis menitipkan
  // pekerjaan ke server dan menunggu agent menariknya. Di kiosk ini agent tidak
  // jalan, jadi cetak otomatis tidak pernah sampai ke printer.
  // handleAutoPrint punya blok bersarang (try/catch), jadi dipotong sampai
  // fungsi berikutnya, bukan sampai penutup pertama.
  const start = BOOTH.indexOf('const handleAutoPrint');
  const fn = BOOTH.slice(start, BOOTH.indexOf('const recordPrintJob', start));
  assert.match(fn, /printViaBluetoothCore\(\)/,
    'cetak otomatis harus memakai jalur langsung yang sama');
  // Dibandingkan pada PEMANGGILAN-nya, bukan penyebutan di komentar: komentar
  // penjelas di atas blok ini menyebut queuePrintJob, dan itu akan membuat
  // perbandingan teks menyesatkan.
  const panggilLangsung = fn.indexOf('await printViaBluetoothCore()');
  const panggilServer = fn.indexOf('await queuePrintJob(');
  assert.ok(panggilLangsung > 0 && panggilServer > 0, 'kedua jalur harus ada');
  assert.ok(panggilLangsung < panggilServer,
    'jalur langsung harus dicoba SEBELUM jalur server');
  // Dan jalur server tetap ada sebagai cadangan, tidak dihapus.
  assert.match(fn, /queuePrintJob\(/, 'jalur server tetap ada sebagai cadangan');
});

test('cetak otomatis tidak membuka pemilih perangkat', () => {
  // Cetak otomatis tidak punya gestur pengguna, jadi requestDevice akan gagal.
  // Ekspor nama perangkat yang diingat membuat sambungan berikutnya tidak perlu
  // memilih, dan tidak bergantung pada interaksi.
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  assert.match(PRINTER, /rememberedDeviceName\(/,
    'bridge harus bisa membuka sambungan tanpa pemilih');
  assert.match(PRINTER, /REMEMBERED_DEVICE_KEY/, 'nama perangkat disimpan, bukan ditanyakan lagi');
});

// --- Koneksi otomatis ke printer yang sudah terpair ---

test('printer yang sudah terpair disambung tanpa pemilih perangkat', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const connect = PRINTER.slice(PRINTER.indexOf('async connect('), PRINTER.indexOf('private async finishConnect'));

  // getDevices() hanya mengembalikan perangkat yang SUDAH dipasangkan, dan boleh
  // dipanggil tanpa gestur pengguna — itu yang membuat cetak otomatis bisa.
  // Yang diperiksa adalah PEMAKAIANNYA di connect(), bukan sekadar keberadaan
  // helper: helper yang ada tapi tidak dipanggil tidak mengubah apa pun.
  assert.match(connect, /await this\.findPairedDevice\(\)/,
    'connect() harus mencari perangkat tersimpan, bukan selalu membuka pemilih');
  assert.match(connect, /authorizedDevice/,
    'perangkat tersimpan harus diteruskan ke connect()');

  // Jalur pemilih tetap ada sebagai cadangan (pasangan pertama / izin dicabut).
  assert.match(connect, /await this\.client\.connect\(\)/,
    'cadangan lewat pemilih harus tetap ada supaya tidak pernah lebih buruk dari sebelumnya');
});

test('perangkat tersimpan dipakai lebih dulu, bukan jalur pemilih', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const connect = PRINTER.slice(PRINTER.indexOf('async connect('), PRINTER.indexOf('private async finishConnect'));
  const cari = connect.indexOf('await this.findPairedDevice()');
  const pilih = connect.indexOf('await this.client.connect()');
  assert.ok(cari > 0, 'perangkat tersimpan harus dicari');
  assert.ok(cari < pilih, 'perangkat tersimpan harus dicoba SEBELUM membuka pemilih');
});

test('printer yang diingat dipilih duluan, bukan yang pertama ditemukan', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const start = PRINTER.indexOf('private async findPairedDevice');
  const fn = PRINTER.slice(start, PRINTER.indexOf('private async finishConnect', start));
  assert.match(fn, /remembered/, 'nama yang diingat harus dicari lebih dulu');
  assert.ok(fn.indexOf('remembered') < fn.indexOf('devices[0]'),
    'perangkat yang diingat harus menang atas perangkat pertama');
});

// --- Kertas: jangan dimajukan setelah cetak ---

test('kertas tidak dimajukan lagi kalau mode akhir cetak memintanya', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // printEnd-lah yang memajukan kertas di seri B1, jadi mode "berhenti di kepala
  // cetak" harus benar-benar melewatkannya — bukan sekadar menyetel flag di
  // tempat lain yang tidak memengaruhi aliran cetak.
  assert.match(PRINTER, /stop-at-printhead/, 'mode berhenti di kepala cetak harus ada');
  const print = PRINTER.slice(PRINTER.indexOf('async print('));
  const finallyBlock = print.slice(print.indexOf('finally'));
  const tanpaEnd = finallyBlock.slice(finallyBlock.indexOf('stop-at-printhead'));
  assert.ok(tanpaEnd.indexOf('printEnd') < tanpaEnd.indexOf('else'),
    'pemanggilan printEnd harus berada di cabang SEBELAH, bukan dijalankan selalu');
});

test('bawaan kertas tetap memajukan supaya label berikutnya sampai', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // Label 54x67 mm punya desain tercetak; kalau kertas tidak dimajukan, label
  // berikutnya tidak akan sampai ke posisi cetak. Jadi bawaannya tidak diubah.
  assert.match(PRINTER, /paperEnd: 'advance-and-separate'/,
    'bawaan harus tetap memajukan kertas');
});

// --- Popup pemilih perangkat: kapan boleh muncul ---

test('printer tersimpan diulang beberapa kali sebelum menyerah', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const connect = PRINTER.slice(PRINTER.indexOf('async connect('), PRINTER.indexOf('Cadangan lewat pemilih'));
  // Sekali coba lalu menyerah = pemilih terbuka padahal printer hanya sedang
  // tidur. Itu keluhannya.
  assert.match(connect, /JUMLAH_PERCOBAAN\s*=\s*(\d+)/,
    'jumlah percobaan harus eksplisit');
  const n = Number((connect.match(/JUMLAH_PERCOBAAN\s*=\s*(\d+)/) || [])[1] || 0);
  assert.ok(n >= 3, `percobaan harus beberapa kali, bukan ${n}`);
  assert.match(connect, /setTimeout/, 'harus ada jeda antar percobaan');
});

test('galat getDevices TIDAK ditelan diam-diam', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // Panggilan getDevices() dipusatkan di storedDevices() supaya keadaan izin
  // dan pemilihan perangkat membaca sumber yang sama.
  const start = PRINTER.indexOf('private async storedDevices');
  const fn = PRINTER.slice(start, PRINTER.indexOf('public async pairingState', start));
  // Dulu catch kosong: pemilih muncul tanpa alasan apa pun yang terlihat.
  assert.match(fn, /catch \(error\) \{[\s\S]{0,300}console\.(warn|info|error)/,
    'galat getDevices harus dilaporkan, bukan ditelan');
  assert.match(fn, /getDevices\(\) gagal/, 'sebutkan operasi mana yang gagal');
  // Dan hanya satu tempat yang boleh memanggilnya, supaya tidak ada dua
  // gambaran berbeda soal izin.
  const jumlah = (PRINTER.match(/await bt\.getDevices\(\)/g) || []).length;
  assert.strictEqual(jumlah, 1, 'getDevices() hanya boleh dipanggil di satu tempat');
});

test('perangkat tersimpan yang tidak menjawab TIDAK diarahkan ke pemilih', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const connect = PRINTER.slice(PRINTER.indexOf('async connect('));
  // Kalau printer ada dan tersimpan tapi mati, pemilih perangkat bukan solusi.
  // Melempar galat yang menyebut sebabnya lebih berguna daripada membuka dialog
  // yang tidak akan menemukan apa pun.
  assert.match(connect, /tersimpan tetapi tidak menjawab/,
    'harus ada pesan yang menyebut printer mati / di luar jangkauan');
});

test('pemilih perangkat disebut sebagai sekali per alamat', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // Pesannya bergeser saat gerbang forceChooser ditambahkan, jadi diperiksa
  // sebagai dua fakta terpisah: pemilih itu sekali per alamat, DAN hanya atas
  // permintaan pengguna.
  assert.match(PRINTER, /sekali per alamat/,
    'pengguna harus tahu pemilih tidak akan muncul terus');
  assert.match(PRINTER, /atas permintaan pengguna/,
    'pemilih harus disebut sebagai tindakan yang diminta, bukan otomatis');
});

test('izin Bluetooth dijelaskan per-alamat saat tidak ada perangkat', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // Penyebab paling sering saat getDevices() kosong, dan bukan kesalahan kode.
  assert.match(PRINTER, /PER-ORIGIN|per alamat|alamat ini/,
    'sebabkan dengan jelas: izin tersimpan per origin');
});

// --- Sisa byte dari operasi sebelumnya ---

test('sisa buffer dibuang SEBELUM cetak, bukan hanya sebelum sambung', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // `disconnect()` di library tidak mengosongkan packetBuf (diperiksa di
  // niimbluelib/dist/cjs/client/abstract_client.js), jadi sisa byte dari cetak
  // sebelumnya menempel ke notifikasi berikutnya dan seluruh buffer dibuang
  // sebagai "invalid" — yang hilang bisa balasan yang sedang ditunggu.
  assert.match(PRINTER, /clearStalePacketBuffer/,
    'harus ada pembersih sisa buffer');
  const print = PRINTER.slice(PRINTER.indexOf('async print('));
  // Diukur dari cabang WEB BLUETOOTH-nya, bukan dari awal fungsi: jalur aplikasi
  // desktop keluar lebih dulu (transport-nya di proses utama, bukan klien Web
  // Bluetooth), jadi yang harus bersih di sini adalah jalur yang memakai buffer
  // library. Memeriksa dari awal fungsi akan lulus hanya karena kebetulan urutan,
  // dan gagal begitu urutannya benar.
  const jalurWeb = print.slice(print.indexOf('if (!this.client) throw'));
  assert.match(jalurWeb.slice(0, 900), /this\.clearStalePacketBuffer\(\)/,
    'pembersihan harus di AWAL jalur web, sebelum paket apa pun dikirim');
});

test('pembersih buffer benar-benar mengosongkan packetBuf', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  const start = PRINTER.indexOf('private clearStalePacketBuffer');
  const fn = PRINTER.slice(start, PRINTER.indexOf('private async rememberDeviceName', start));
  assert.match(fn, /packetBuf\s*=\s*new Uint8Array\(\)/,
    'harus menulis ulang packetBuf dengan array kosong');
  // Dan menyebutkan berapa byte yang dibuang: tanpa itu, kejadian ini tidak
  // pernah terlihat di konsol kiosk.
  assert.match(fn, /console\.info/, 'jumlah byte yang dibuang harus dilaporkan');
});

// --- Berkas mati yang pernah ikut ter-commit ---

test('berkas sekali-pakai tidak ikut ter-commit', () => {
  // Ini beberapa kali terulang: skrip pengukuran dan cadangan ikut masuk repo.
  // Diperiksa dari daftar git, bukan dari disk, karena yang bermasalah adalah
  // apa yang TERKIRIM, bukan apa yang ada di mesin ini.
  const dilacak = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' }).split('\n');
  const terlarang = dilacak.filter(f => /\.(zip|bak|log)$/.test(f)
    || /^(tes|test|ukur|cek|mv|v|f|p)\.(ts|mts|js)$/.test(path.basename(f)));
  assert.deepStrictEqual(terlarang, [],
    'berkas sekali-pakai/cadangan harus dihapus dari repo: ' + terlarang.join(', '));
});

// --- Alur pairing: sekali di setup, lalu tanpa dialog ---

test('pencetakan TIDAK PERNAH membuka pemilih perangkat', () => {
  // Inilah permintaannya: setelah dipasangkan sekali, cetak berikutnya tidak
  // boleh memunculkan "wants to pair". Kalau jalur cetak memanggil connect()
  // tanpa memeriksa izin, pemilih akan terbuka lagi saat izin hilang — dan itu
  // terjadi di tengah proses cetak, tempat yang paling buruk.
  const inti = bodyOf('printViaBluetoothCore');
  assert.match(inti, /pairingState\(\)/,
    'jalur cetak harus memeriksa izin lebih dulu');
  assert.match(inti, /izin !== 'ready'/,
    'izin yang belum ada harus jadi galat, bukan dialog');
  assert.ok(!/pairNow/.test(inti),
    'jalur cetak tidak boleh memanggil pemilih perangkat');
});

test('pemilih perangkat hanya dibuka dari aksi pengguna', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // pairNow() -> connect({forceChooser:true}) -> client.connect() tanpa argumen.
  assert.match(PRINTER, /public async pairNow\(/,
    'harus ada satu pintu masuk untuk pemilihan perangkat');
  const pairNow = PRINTER.slice(PRINTER.indexOf('public async pairNow('));
  assert.match(pairNow.slice(0, 800), /forceChooser: true/,
    'pairNow harus memaksa pemilih, bukan memakai perangkat tersimpan');
  // Dan sesudah tersambung, izinnya diperiksa ULANG: tersambung sekarang tidak
  // sama dengan izin yang bertahan sampai cetak berikutnya.
  assert.match(pairNow, /pairingPersisted/,
    'pairNow harus melaporkan apakah izin benar-benar tersimpan');
  assert.match(pairNow, /storedDevices\(\)/, 'pemeriksaan itu memakai daftar perangkat tersimpan');
  const connect = PRINTER.slice(PRINTER.indexOf('async connect('), PRINTER.indexOf('private clearStalePacketBuffer'));
  assert.match(connect, /options\.forceChooser \? null : await this\.findPairedDevice\(\)/,
    'forceChooser harus melewati perangkat tersimpan');
});

test('sambung awal saat halaman siap tanpa dialog', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  assert.match(PRINTER, /preconnectSilently/,
    'harus ada sambung awal yang aman dipanggil otomatis');
  const fn = PRINTER.slice(PRINTER.indexOf('public async preconnectSilently'));
  // Dua jalur, dan keduanya harus aman dipanggil otomatis:
  //   desktop : tidak ada izin untuk diperiksa — printernya dicari langsung
  //   browser : berhenti dulu kalau izin belum ada, supaya dialog tidak dibuka
  assert.match(fn.slice(0, 1200), /const native = NiimbotPrinter\.nativeBridge\(\)/,
    'jalur desktop harus dikenali lebih dulu di sambung awal');
  assert.match(fn, /pairingState\(\) !== 'ready'\s*\)\s*return null/,
    'jalur browser harus berhenti dulu kalau izin belum ada (tidak boleh buka dialog)');
  // Daftar perangkat dilaporkan apa adanya sebelum memutuskan: satu baris ini
  // yang membedakan "tidak ada perangkat" dari "izin tidak bertahan".
  assert.match(fn, /Perangkat tersimpan untuk alamat ini/,
    'preconnect harus melaporkan isi daftar perangkat');
  // Dan PhotoBooth memanggilnya sekali saat siap.
  assert.match(BOOTH, /preconnectSilently\(\)/, 'photobooth harus memanggilnya saat siap');
});

test('izin yang dicabut dibedakan dari belum pernah dipasangkan', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  // Catatan nama ada tetapi browser tidak mengenali perangkatnya = izin dicabut
  // atau dipasangkan dari alamat lain. Dua sebab berbeda, penanganannya sama
  // (pasangkan sekali lagi), tetapi pesannya harus menjelaskan yang mana.
  assert.match(PRINTER, /catatan printer|Catatan printer/i,
    'harus menyebut catatan yang ada supaya sebabnya jelas');
  assert.match(PRINTER, /tersimpan per alamat|PER-ALAMAT|per alamat/,
    'harus menjelaskan bahwa izin tersimpan per alamat');
});

test('keadaan izin diekspos untuk panel pengaturan', () => {
  const PRINTER = readFileSync(path.join(ROOT, 'services', 'niimbotPrinter.ts'), 'utf8');
  assert.match(PRINTER, /export type PrinterPairingState/,
    'keadaan izin harus bertipe eksplisit, bukan string bebas');
  for (const st of ['unsupported', 'no-stored-device', 'ready']) {
    assert.ok(PRINTER.includes(`'${st}'`), `keadaan '${st}' harus ada`);
  }
  assert.match(PRINTER, /storedDeviceNames\(\)/, 'nama printer terizin harus bisa dibaca');
});

// --- Satu klik cetak = sekaligus memasangkan ---

test('cetak langsung memasang printer bila belum ada izin — tanpa tombol terpisah', () => {
  // Sebelumnya alurnya dua langkah: klik Cetak -> gagal -> banner -> klik
  // "Siapkan Printer" -> baru pemilih. Sekarang klik Cetak mengurus keduanya,
  // jadi tidak ada langkah perantara yang bisa dilewatkan operator.
  const inti = bodyOf('printViaBluetoothCore');
  assert.match(inti, /printer\.connect\(izin === 'ready' \? \{\} : \{ forceChooser: true \}\)/,
    'izin belum ada -> pemilih dibuka dari klik yang sama, lalu langsung cetak');
  assert.ok(!/Buka Admin/.test(inti),
    'pesan TIDAK boleh menyuruh berkeliling mencari pengaturan');
  // Tombol terpisahnya harus benar-benar hilang, bukan sekadar tidak dipakai.
  assert.ok(!/btn-pair-printer-here/.test(BOOTH), 'tombol pemasangan terpisah harus dihapus');
  assert.ok(!/handlePairPrinterDiSini/.test(BOOTH), 'fungsi pemasangan terpisah harus dihapus');
});

test('cetak OTOMATIS tetap tidak boleh membuka pemilih', () => {
  // Ini gerbang yang menjaga keamanan alur: jalur otomatis bisa berjalan tanpa
  // klik pengguna, dan Web Bluetooth menolak pemilih di luar gestur pengguna.
  // Kalau gerbang ini hilang, cetak otomatis akan mencoba membuka dialog dan
  // gagal dengan pesan yang menyesatkan.
  const inti = bodyOf('printViaBluetoothCore');
  assert.match(inti, /if \(izin !== 'ready' && !options\.izinkanPasang\)/,
    'penolakan harus bergantung pada izin DAN opsi izinkanPasang');
  assert.match(inti, /throw new Error\(PRINTER_BELUM_DIPASANGKAN\)/,
    'tanpa gestur: MENOLAK, bukan mencoba membuka dialog');
  // Hanya SATU pemanggil yang boleh memasang: tombol "Cetak Bluetooth", yang
  // gestur kliknya masih berlaku saat pemilih dibuka. Jalur cetak otomatis
  // sengaja TIDAK memintanya — ia menunggu unggahan lebih dulu, sehingga
  // gesturnya bisa kedaluwarsa dan pemilih akan gagal dibuka di sana.
  const jumlah = (BOOTH.match(/printViaBluetoothCore\(\{ izinkanPasang: true \}\)/g) || []).length;
  assert.strictEqual(jumlah, 1, 'hanya jalur klik-langsung yang boleh memasang');
  assert.match(BOOTH, /handleAutoPrint[\s\S]{0,4000}?await printViaBluetoothCore\(\);/,
    'cetak otomatis tetap memanggil tanpa izin memasang');
});

test('pemilih yang ditutup tidak dilaporkan sebagai kegagalan printer', () => {
  // Menutup pemilih itu pilihan pengguna, bukan kerusakan printer. Pesan yang
  // menyebutnya "gagal" membuat orang mencari masalah di tempat yang salah.
  const fn = BOOTH.slice(BOOTH.indexOf('const handleBluetoothPrint'));
  // Jendela 2000: komentar kebijakan kunci cetak di awal fungsi bertambah,
  // sehingga pesannya terdorong keluar dari jendela 1200 lama.
  assert.match(fn.slice(0, 2000), /Pemilih perangkat ditutup/,
    'menutup pemilih bukan kegagalan; pesannya harus menyatakan itu');
});

test('status cetak tidak lagi menjanjikan pemilih yang tidak akan muncul', () => {
  const banner = BOOTH.slice(BOOTH.indexOf('id="bluetooth-print-status"'));
  assert.ok(!/Membuka pemilih perangkat Bluetooth/.test(banner.slice(0, 900)),
    'jalur cetak tidak pernah membuka pemilih, jadi jangan menuliskannya');
  assert.match(banner.slice(0, 900), /Menyambungkan ke printer…/, 'ganti dengan yang benar');
});
