import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

// Pool koneksi MySQL (lebih efisien dari single connection)
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '3306'),
  user:     process.env.DB_USER     || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME     || 'unismile_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: '+07:00', // WIB
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
});

// Test koneksi saat startup
export const testConnection = async () => {
  try {
    const conn = await pool.getConnection();
    console.log('✅ MySQL terhubung ke database:', process.env.DB_NAME);
    
    // Auto-create transactions table if it doesn't exist
    await conn.query(`
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
    `);
    console.log('✅ Tabel transactions dipastikan ada.');
    conn.release();
  } catch (err) {
    console.error('❌ Gagal konek ke MySQL:', err.message);
    console.error(
      `   Config: ${process.env.DB_USER || 'root'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '3306'}/${process.env.DB_NAME || 'unismile_db'}`
    );
    console.error('   Pastikan MySQL Server sudah running dan credentials di .env sudah benar.');
    return false;
  }
};

export default pool;
