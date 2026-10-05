-- Buat database jika belum ada
CREATE DATABASE IF NOT EXISTS unismile_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE unismile_db;

-- 1. Tabel untuk menyimpan template frame
CREATE TABLE IF NOT EXISTS frame_templates (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(100) NOT NULL COMMENT 'Nama template frame',
  slot_count    INT NOT NULL DEFAULT 1 COMMENT 'Jumlah slot foto dalam frame',
  layout_config TEXT NULL COMMENT 'JSON konfigurasi posisi layout slot',
  is_active     TINYINT(1) DEFAULT 1 COMMENT 'Status aktif (1) atau tidak aktif (0)',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. Tabel untuk menyimpan sesi foto (Session)
CREATE TABLE IF NOT EXISTS sessions (
  id                VARCHAR(100) PRIMARY KEY COMMENT 'ID Sesi (menggunakan timestamp/UUID)',
  session_code      VARCHAR(100) NULL COMMENT 'Kode sesi unik alternatif',
  frame_template_id INT NULL COMMENT 'Template frame yang digunakan',
  started_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at          TIMESTAMP NULL,
  status            VARCHAR(50) DEFAULT 'active' COMMENT 'status: active, completed, abandoned',
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_session_frame FOREIGN KEY (frame_template_id) REFERENCES frame_templates(id) 
    ON DELETE SET NULL 
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. Tabel untuk menyimpan hasil foto (sudah ada)
CREATE TABLE IF NOT EXISTS photos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  filename      VARCHAR(255)   NOT NULL COMMENT 'Nama file PNG di disk',
  url           VARCHAR(500)   NOT NULL COMMENT 'URL lengkap untuk download',
  session_id    VARCHAR(100)            COMMENT 'Timestamp sesi foto',
  file_size     INT                     COMMENT 'Ukuran file dalam bytes',
  layout_id     VARCHAR(20)             COMMENT 'Layout yang dipilih (1x1, 4x1, dll)',
  email_sent_to VARCHAR(255)            COMMENT 'Email tujuan pengiriman (jika dikirim via email)',
  email_sent_at TIMESTAMP NULL          COMMENT 'Waktu pengiriman email',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'Waktu foto dibuat',
  
  INDEX idx_session   (session_id),
  INDEX idx_created   (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. Migrasi/Populasi data sesi untuk foto yang sudah ada sebelum constraint dipasang
INSERT IGNORE INTO sessions (id, session_code, started_at, status)
SELECT DISTINCT session_id, session_id, MIN(created_at), 'completed'
FROM photos
WHERE session_id IS NOT NULL AND session_id != ''
GROUP BY session_id;

-- 5. Tambahkan Foreign Key ke tabel photos secara aman (jika belum ada)
ALTER TABLE photos
ADD CONSTRAINT fk_photo_session
FOREIGN KEY (session_id) REFERENCES sessions(id)
ON DELETE SET NULL
ON UPDATE CASCADE;


-- 6. Tabel untuk menyimpan log gesture tangan (Gesture Log)
CREATE TABLE IF NOT EXISTS gesture_logs (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  session_id       VARCHAR(100) NOT NULL COMMENT 'Relasi ke sesi',
  gesture_type     VARCHAR(50) NOT NULL COMMENT 'Tipe gesture (wave, fist, thumbs_up, dll)',
  confidence_score FLOAT NOT NULL COMMENT 'Tingkat akurasi deteksi (0.0 - 1.0)',
  action_triggered VARCHAR(100) NOT NULL COMMENT 'Aksi yang dijalankan (trigger_photo, next_filter, dll)',
  detected_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_gesture_session FOREIGN KEY (session_id) REFERENCES sessions(id) 
    ON DELETE CASCADE 
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. Tabel untuk menyimpan daftar filter gambar
CREATE TABLE IF NOT EXISTS filters (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL COMMENT 'Nama filter',
  type        VARCHAR(50) NOT NULL COMMENT 'Tipe filter (color, overlay, sticker)',
  preview_url VARCHAR(500) NULL COMMENT 'Preview url untuk icon filter',
  is_active   TINYINT(1) DEFAULT 1 COMMENT 'Status aktif',
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. Tabel relasi many-to-many foto dengan filter yang diaplikasikan (Photo Filter)
CREATE TABLE IF NOT EXISTS photo_filters (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  photo_id      INT NOT NULL,
  filter_id     INT NOT NULL,
  applied_order INT DEFAULT 1 COMMENT 'Urutan penerapan filter',
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_pf_photo FOREIGN KEY (photo_id) REFERENCES photos(id) 
    ON DELETE CASCADE 
    ON UPDATE CASCADE,
  CONSTRAINT fk_pf_filter FOREIGN KEY (filter_id) REFERENCES filters(id) 
    ON DELETE CASCADE 
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. Tabel untuk menyimpan transaksi pembayaran
CREATE TABLE IF NOT EXISTS transactions (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  transaction_code   VARCHAR(100) UNIQUE NOT NULL COMMENT 'Kode transaksi unik',
  session_id         VARCHAR(100) NOT NULL COMMENT 'Relasi ke sesi',
  layout_id          VARCHAR(50) NOT NULL COMMENT 'Layout ID yang dipilih',
  amount             DECIMAL(10, 2) NOT NULL COMMENT 'Nominal transaksi',
  payment_method     VARCHAR(50) DEFAULT 'QRIS' COMMENT 'Metode pembayaran',
  status             VARCHAR(50) DEFAULT 'success' COMMENT 'status: pending, success, failed',
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT fk_transaction_session FOREIGN KEY (session_id) REFERENCES sessions(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. Tabel profil pembayaran (QRIS)
CREATE TABLE IF NOT EXISTS payments (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  user_id       INT NULL COMMENT 'Relasi ke admin/user pemilik',
  payment_type  VARCHAR(50) DEFAULT 'QRIS' COMMENT 'Tipe pembayaran',
  payment_data  TEXT NULL COMMENT 'JSON data pembayaran (contoh: URL QRIS)',
  is_active     TINYINT(1) DEFAULT 1,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO payments (id, user_id, payment_type, payment_data, is_active) VALUES (1, 1, 'QRIS', '{"qris_image_url": "/uploads/qris.png"}', 1);

-- Verifikasi tabel yang terbuat
SELECT 'Schema berhasil dibuat!' AS status;
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES 
  WHERE TABLE_SCHEMA = 'unismile_db';

