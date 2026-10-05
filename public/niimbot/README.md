# Cetak ke Niimbot B1 Pro dari Photobooth (Web Bluetooth)

Mencetak langsung dari browser photobooth ke printer label Niimbot B1 Pro lewat
Bluetooth — tanpa aplikasi perantara, tanpa driver OS, tanpa `npm install` di
komputer kiosk.

Driver: [iscarelli/niimbot-web-bluetooth](https://github.com/iscarelli/niimbot-web-bluetooth)
(MIT, zero-dependency, B1 Pro sudah divalidasi penulisnya di perangkat nyata).

---

## 1. Sebelum apa pun: lebar 54 mm TIDAK muat

Ini bagian terpenting, dan bukan soal perangkat lunak.

| | nilai |
|---|---|
| Kepala cetak B1 Pro | **576 px = 48,77 mm** (terverifikasi di kertas oleh penulis driver) |
| Label yang Anda minta | 54 mm = **638 px** |
| Yang terjadi | **62 px = 5,25 mm tidak tercetak**, tanpa pesan error |

Lebar 54 mm juga **melebihi spesifikasi** printer (lebar kertas 20-50 mm, lebar
cetak efektif 48 mm). Jadi label 54 mm tidak bisa dicetak utuh — sisi kanannya
hilang begitu saja.

**Yang realistis:**

| Pilihan | Lebar | Hasil |
|---|---|---|
| Aman | **48 mm** = 567 px | utuh, tanpa pemotongan |
| Batas | 50 mm = 591 px | 1,3 mm terpotong |
| Tidak muat | 54 mm = 638 px | 5,3 mm terpotong |

**Tinggi 67 mm aman** — 791 px, jauh di bawah batas tinggi printer (350 mm).

Halaman uji di repo ini **sudah memakai 48 × 67 mm** sebagai bawaan, dan
menampilkan peringatan kalau ukuran dikunci. Kalau Anda tetap ingin 54 mm,
masukkan 54 di kolom lebar dan peringatannya akan muncul — hasil cetaknya akan
terpotong, jadi jangan kaget.

---

## 1b. Kenyataan penting soal lebar 54 mm

Kertas label Anda **54 × 67 mm**, tetapi kepala cetak B1 Pro hanya **576 px =
48,77 mm**. Ini bukan soal pengaturan — ini batas perangkat keras.

Buktinya dari pengujian penulis driver di kertas: mencetak empat garis uji 4 px di
kolom 568, 572, 576, dan 580, garis di kolom 568 dan 572 **keluar**, kolom 576 dan
580 **tidak keluar**. Jadi kolom 0–575 tercetak, 576 ke atas tidak. Melebihi
kepala cetak **tidak memunculkan error apa pun** — hasilnya cuma terpotong diam-diam.

Akibatnya untuk kertas 54 mm:

| | nilai |
|---|---|
| Lebar yang diminta | 54 mm = 638 px |
| Yang tercetak | 576 px = **48,77 mm** |
| Hilang | 62 px = **5,25 mm** dari sisi kanan |

**Tiga pilihan Anda:**

1. **Terima 5,25 mm terpotong.** Halaman uji memperingatkan angkanya, jadi tidak
   ada kejutan. Kalau desain pada label punya margin di kanan, ini tidak masalah.
2. **Pakai kertas 50 × 67 mm.** Hanya 1,3 mm terpotong — hampir tidak terlihat.
3. **Pakai kertas 48 × 67 mm.** Tercetak penuh, nol pemotongan.

Yang **tidak** bisa dilakukan: mengecilkan gambar supaya 54 mm muat seluruhnya.
Kepala cetak tetap 48,77 mm; sisa 5,25 mm tidak dapat dijangkau, bukan hanya
tidak terpakai.

---

## 1c. Karena frame Admin tidak dipakai

Kertas label sudah membawa desainnya sendiri, jadi photobooth hanya mengisi
fotonya. Yang perlu diperhatikan akibat keputusan ini:

**Foto harus satu, dan itu polaroid.** Frame Admin tidak lagi menentukan jumlah
slot, jadi jumlah foto ditentukan di sisi photobooth (1 kali jepret), bukan dari
`frame_templates`.

**Rasio foto harus mendekati rasio kertas.** Driver **merentangkan** gambar
memenuhi label (`drawImage(bmp, 0, dy, w, h)`) — rasio yang berbeda membuat foto
gepeng, bukan terpotong. Rasio kertas 54 × 67 mm yang **tercetak** adalah
576 : 791 = 0,728.

Halaman uji menangani ini dengan opsi **"Jaga rasio foto"** (bawaan: aktif):
foto diskalakan mempertahankan rasio lalu diberi bingkai putih di sisinya. Foto
tidak gepeng, tetapi ada tepi putih. Kalau tidak dicentang, foto dipaksa
memenuhi label dan akan gepeng.

**Untuk hasil penuh tanpa bingkai:** ambil foto pada rasio 0,728 (misalnya
700 × 962 px). Halaman uji memberi tahu rasio fotonya saat berkas dipilih.

## 1d. Di mana pengaturan itu sekarang

Ukuran kertas, kepekatan, geser vertikal, dan penyesuaian tampilan foto **tidak
lagi diatur di halaman uji ini**. Semua pindah ke:

```
Admin -> Kiosk Manager -> pilih kiosk -> Printer Configuration
       -> "Photo & Print Calibration"
```

| Pengaturan | Rentang | Catatan |
|---|---|---|
| Brightness | 50–150% | foto hasil cetak |
| Contrast | 50–150% | foto hasil cetak |
| Saturation | 0–150% | 0 = hitam putih |
| Kepekatan termal | 1–5 | driver Niimbot |
| Geser vertikal | −200…200 px | kalibrasi posisi di kertas |
| Penyesuaian foto di label | jaga rasio / penuhi label | jaga rasio = tidak gepeng |
| Ukuran kertas | preset atau `CUSTOM LxT MM` | sudah ada sebelumnya |

Kenapa dipindah: nilai yang diatur di halaman localhost **tidak terbaca oleh
photobooth produksi** — halaman itu hanya ada di laptop. Nilai di Admin tersimpan
per kiosk dan dikirim lewat backend → kiosk-agent → photobooth.

**Jalur nilainya** (ini yang membuat perubahan benar-benar sampai ke cetakan):

```
Admin (form)
  -> backend /admin/kiosks/:id/printing-config   (divalidasi + disimpan)
  -> socket ke kiosk-agent                        (payload printing config)
  -> agent reportedState                          (WAJIB, bukan hanya disimpan)
  -> local bridge (:3011) -> photobooth           (dipakai saat menggambar foto)
```

Langkah `reportedState` itu mudah terlewat. Ukuran kertas pernah "tersimpan" di
Admin tetapi tidak pernah sampai ke photobooth justru karena agent menyimpannya
ke `printerConfig` tanpa melaporkannya. Test `photoAdjustmentFlow.test.js`
memeriksa setiap mata rantai ini.

Halaman uji sekarang **membaca** nilai itu dari agent (lewat
`http://localhost:3011/api/kiosk-status`) dan menampilkannya di bagian "Nilai
dari Pengaturan Admin". Kalau agent tidak jalan, halaman mengatakannya terus
terang dan memakai nilai netral.

**Yang TIDAK terpengaruh:** filter untuk OCR verifikasi pembayaran. Itu jalur
terpisah dengan filter sendiri yang sudah dikalibrasi agar nominal struk terbaca
(`contrast(1.24) brightness(1.04) saturate(0.9)`). Mengubahnya dari halaman
Pengaturan akan merusak verifikasi pembayaran, jadi sengaja tidak disambungkan.

## 2. Cara mencoba di laptop Anda

Web Bluetooth butuh **HTTPS atau localhost**. `localhost` sudah memenuhi syarat,
jadi tidak perlu sertifikat apa pun.

```bash
cd ~/Unismiles/unismiles-photobooth
npx vite --port 3000
```

Lalu buka di **Chrome atau Edge** (bukan Firefox, bukan Safari):

```
http://localhost:3000/niimbot-test.html
```

Urutannya:

1. **Nyalakan printer** B1 Pro (charge dulu bila lama tidak dipakai).
2. Klik **"Pakai gambar uji"** atau pilih PNG/JPG dari laptop Anda.
3. Klik **"1. Sambungkan printer"** → jendela pemilih perangkat Bluetooth muncul
   → pilih printer Anda (namanya berawalan `B1`).
4. Klik **"2. Cetak"**.

Langkah 3 sekaligus mencetak 1 label uji — itu cara paling andal memastikan
sambungan benar-benar hidup sebelum mencetak banyak.

Kalau pengaturan lebar ditolak, atau gambar terpotong di sisi kanan, kirim
tangkapan layar log di halaman itu.

---

## 3. Kalau pindah device — ini yang perlu dilakukan

Bagusnya: **tidak ada bagian khusus mesin di kode ini.** Halaman uji memakai
Web Bluetooth, yang sepenuhnya berjalan di browser.

**Yang TIDAK perlu dilakukan:**

- Tidak install driver printer di Windows
- Tidak install Node.js, MS Build Tools, atau Python di laptop/kiosk baru
- Tidak ada perubahan kode saat pindah perangkat

**Yang perlu dicek di perangkat baru:**

| Perangkat | Yang harus ada |
|---|---|
| **Windows / macOS (laptop)** | Chrome atau Edge versi baru. Bluetooth menyala. |
| **Android** | Chrome + **layanan lokasi harus aktif** (Android memblokir pemindaian BLE tanpa lokasi — bukan masalah pairing) |
| **iPhone / iPad** | Safari **tidak punya** Web Bluetooth. Pakai browser **Bluefy** |
| **Kiosk (photobooth)** | Halaman harus dibuka dari **HTTPS atau localhost**. Kiosk produksi sudah HTTPS, jadi aman |

**Satu hal yang sering terlewat di semua perangkat:**
Printer B1 Pro **melepas sambungan sendiri saat idle** (ia mati sendiri), dan
driver ini membuka pemilih perangkat hanya **sekali** per halaman. Jadi setiap
kali printer mati atau Anda refresh halaman, klik **"Sambungkan printer"** lagi —
Bluetooth tidak akan menyambung sendiri. Ini keterbatasan driver, bukan
kesalahan pemasangan. Kalau nanti dipakai di kiosk produksi, sambungan otomatis
perlu ditambahkan terpisah.

---

## 4. Yang belum selesai (jangan dianggap beres)

Yang sudah ada di repo ini adalah **halaman uji**, bukan integrasi ke alur
photobooth. Bedanya penting:

| | status |
|---|---|
| Cetak dari browser ke B1 Pro | ✅ halaman uji siap |
| Ukuran label 48 × 67 mm terhitung benar | ✅ diuji, 45 test lolos |
| Masuk otomatis setelah sesi foto selesai | ❌ belum |
| Ambil foto polaroid 1x dari photobooth | ❌ belum — masih perlu 1 sesi foto yang sudah ada |
| Rasio foto dikunci ke 0,728 saat menjepret | ❌ belum — sekarang disesuaikan setelah foto diambil |
| Ukuran dari Admin (Kiosk Manager) | ✅ sudah |
| Brightness/contrast/kepekatan/geser dari Admin | ✅ sudah |
| Sambungan otomatis (tanpa pilih perangkat) | ❌ belum |

Urutan yang disarankan: **uji manual dulu di laptop** (bagian 2). Kalau sudah
keluar label yang benar, baru saya sambungkan ke alur photobooth dan ke
pengaturan ukuran di Admin.

---

## 5. Catatan teknis

Driver: `niimbot.js` v2.6.0, di `public/niimbot/`. Dimuat sebagai tiga berkas:

```
public/niimbot/niimbot.js       driver (window.Niimbot)
public/niimbot/label-size.js    mm -> px (window.NiimbotLabelSize)
public/niimbot/registry.json    daftar model + ukuran label
public/niimbot-test.html        halaman uji
```

Model yang dipakai untuk B1 Pro (dari `registry.json`):

```js
{ name_prefixes: ['B1'], task: 'v4', density: 3, label_type: 1, speed: 1 }
```

Tiga hal yang mudah salah:

- **`task` harus `v4`**, bukan `b1`. B1 Pro 300 dpi memakai protokol v4; `b1`
  untuk model 203 dpi (B1 biasa, D110, N1). Driver akan menolak dengan pesan
  jelas kalau salah.
- **Gambar diambil lewat `fetch()`**, jadi gambar dari server harus mengizinkan
  CORS. Halaman uji memakai data-URL agar bebas masalah ini.
- **Gambar direntangkan ke ukuran label tanpa menghiraukan rasio.** Siapkan
  gambar pada rasio 48:67, kalau tidak hasilnya gepeng. Halaman uji memperingatkan
  hal ini saat Anda memilih berkas.
- **Cetak = 1-bit.** Piksel jadi hitam bila kecerahannya < 128 dan alpha > 32,
  jadi gambar nyaris transparan tercetak putih. Printer mendukung 16 skala
  abu-abu, tetapi driver ini melakukan threshold — foto akan tercetak seperti
  gambar hitam-putih titik-titik (dithering tidak otomatis).
