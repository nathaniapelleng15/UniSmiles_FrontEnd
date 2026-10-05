# Catatan untuk halaman Admin — sumber tunggal konfigurasi frame

Frame di kiosk harus dirender 100% dari data yang disimpan oleh Admin. Jangan
membuat ulang ukuran, warna, slot, atau posisi elemen berdasarkan `slot_count`
dan jangan memakai preset/hardcode kiosk jika konfigurasi Admin tersedia.

Gunakan payload canonical berikut saat menyimpan dan mengembalikan template:

```json
{
  "layout_id": "4x1",
  "width": 600,
  "height": 1700,
  "backgroundConfig": {
    "type": "solid",
    "color": "#9DA6B4"
  },
  "slots": [
    { "index": 0, "x": 30, "y": 30, "width": 540, "height": 340 }
  ],
  "slotBorder": {
    "color": "#FFFFFF",
    "width": 2
  },
  "elements": [],
  "overlayUrl": "https://.../frame-overlay.png"
}
```

Ketentuan penting:

- `width` dan `height` adalah ukuran canvas asli Admin dalam pixel.
- `slots` memakai pixel canvas yang sama; jangan mengubahnya menjadi ukuran
  viewport/browser.
- Simpan `backgroundConfig` lengkap, termasuk gradient type, angle, stops,
  dan warna.
- Simpan `elements` lengkap beserta posisi, ukuran, font, warna, opacity,
  rotation, dan z-index.
- `overlayUrl` harus menunjuk ke artwork frame transparan jika Admin memakai
  border, logo, atau dekorasi gambar. Artwork harus berukuran dan berasio sama
  dengan canvas.
- Endpoint kiosk `/templates` harus mengembalikan konfigurasi ini utuh pada
  setiap style/template. Jangan hanya mengembalikan `image_url`, `slot_count`,
  atau preview thumbnail.
- Jika payload dikirim sebagai `layout_config`, field tersebut harus berisi
  object canonical di atas, bukan JSON yang kehilangan `width`, `height`, atau
  `slots`.

Prompt titipan untuk implementasi Admin:

> Jadikan konfigurasi frame di Admin sebagai single source of truth. Saat save
> dan saat GET `/templates`, pertahankan canvas width/height, backgroundConfig,
> slots dalam pixel canvas, elements lengkap, dan overlayUrl tanpa normalisasi
> ulang ke preset. Preview Admin dan kiosk harus memakai payload yang sama.
> Jangan menghitung ulang slot dari slot_count dan jangan mengubah koordinat
> berdasarkan ukuran layar.
