/// <reference types="vite/client" />

/**
 * Deklarasi tipe untuk variabel environment Vite (VITE_*)
 * Semua variabel harus diawali dengan VITE_ agar bisa diakses di frontend.
 */
interface ImportMetaEnv {
  /** URL Backend API Server. Contoh: http://localhost:8000 */
  readonly VITE_API_BASE_URL: string;
  /** API Key kiosk yang didapat dari Admin Dashboard */
  readonly VITE_KIOSK_API_KEY: string;
  /** ID Kiosk (opsional) */
  readonly VITE_KIOSK_ID?: string;
  /** Gemini API Key untuk fitur AI (opsional) */
  readonly VITE_GEMINI_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
