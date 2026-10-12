import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

/**
 * apiService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Layer komunikasi Frontend Kiosk ↔ Backend API Server (Uni-Smiles v2.0)
 *
 * Autentikasi: x-api-key header (API Key kiosk dari .env)
 * Base URL   : VITE_API_BASE_URL dari .env (default: http://localhost:8000)
 *
 * Cara pakai API Key:
 *   1. Super Admin login ke Admin Dashboard
 *   2. Buka Kiosk Management → Register Kiosk
 *   3. Copy API Key yang di-generate
 *   4. Paste ke .env: VITE_KIOSK_API_KEY=<api_key>
 * ─────────────────────────────────────────────────────────────────────────────
 */

const getDefaultApiBaseUrl = (): string => 'http://localhost:8000';

const normalizeApiBaseUrl = (value: unknown): string => {
  const rawUrl = String(value || '').trim().replace(/\/+$/, '');
  const baseUrl = rawUrl.replace(/\/api\/v1(?:\/kiosk)?$/i, '').replace(/\/+$/, '');
  return baseUrl && !/example\.com|:5001(?:\/|$)|\/download(?:\/|$)/i.test(baseUrl)
    ? baseUrl
    : getDefaultApiBaseUrl();
};

export const isUsableKioskApiKey = (value: unknown): boolean => {
  const apiKey = String(value || '').trim();
  return Boolean(apiKey)
    && !/^<[^>]+>$/.test(apiKey)
    && !/(API_KEY_KIOSK_DARI_ADMIN|YOUR[_ -]?API[_ -]?KEY|CHANGE[_ -]?ME|REPLACE[_ -]?ME|PLACEHOLDER)/i.test(apiKey);
};

export const getApiConfig = () => {
  const stored = localStorage.getItem('pb_config');
  const registeredKioskApiKey = localStorage.getItem('unismiles_kiosk_api_key')?.trim() || '';
  let parsed: any = {};
  if (stored) {
    try { parsed = JSON.parse(stored); } catch (_) { parsed = {}; }
  }
  const rawUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_BASE_URL || parsed.backendUrl);
  const apiKey = [import.meta.env.VITE_KIOSK_API_KEY, registeredKioskApiKey, parsed.apiKey]
    .find(isUsableKioskApiKey) || '';
  return {
    baseUrl: rawUrl,
    backendUrl: `${rawUrl}/api/v1/kiosk`,
    apiKey,
    kioskId: import.meta.env.VITE_KIOSK_ID || parsed.kioskId || 'K-001'
  };
};

const readBooleanEnv = (value: unknown, fallback: boolean): boolean => {
  if (typeof value !== 'string') return fallback;
  return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
};

/** Feature flags are build-time settings; the kiosk API key is not involved. */
export const isAutoPrintEnabled = (): boolean => readBooleanEnv(
  import.meta.env.VITE_AUTO_PRINT_ENABLED ?? import.meta.env.AUTO_PRINT_ENABLED,
  true
);

export const isManualPrintFallbackEnabled = (): boolean => readBooleanEnv(
  import.meta.env.VITE_MANUAL_PRINT_FALLBACK_ENABLED,
  true
);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  session_code?: string;
  amount?: number;
  price?: number;
  url?: string;
  download_url?: string;
  transaction_code?: string;
}

export interface SessionData {
  id: string;
  kiosk_id: string;
  frame_template_id?: number | null;
  /** Harga yang dihitung backend untuk sesi ini, jika endpoint menyediakannya. */
  amount?: number | null;
  status: 'active' | 'completed' | 'abandoned';
  challenge_id?: string;
  /** Kode unik Rp1-Rp99 yang ditambahkan ke harga dasar untuk transaksi ini. */
  unique_code?: number | null;
  /**
   * false = pembayaran sedang dimatikan di sisi server untuk keperluan uji,
   * sehingga layar bayar dilewati. Sesi tetap ditandai 'verified' di database.
   */
  payment_required?: boolean;
  payment_method?: 'qris_visual_proof' | 'gopay_merchant_polling' | string;
}

export interface SessionPaymentStatus {
  payment_status: 'pending' | 'verified' | 'expired' | 'rejected' | string;
  payment_provider: string;
  payment_required_amount: number | null;
  payment_expires_at?: string | null;
}

export interface PhotoData {
  id?: number;
  session_id?: string;
  filename?: string;
  url: string;
}

export interface CompleteSessionResult {
  success: true;
  downloadUrl: string;
  message?: string;
}

export interface TransactionPayload {
  transaction_code: string;
  amount: number;
  payment_method: 'QRIS' | 'Cash' | string;
  status: 'completed' | 'failed' | 'pending';
}

export interface GesturePayload {
  session_id: string;
  gesture_type: string;
  confidence_score: number;
  action_triggered: string;
}

export interface PrintLogPayload {
  kiosk_id: string;
  session_id: string;
  status: 'success' | 'failed';
  paper_stock_left?: number;
}

export type PrintJobStatus = 'queued' | 'printing' | 'success' | 'failed';

export interface PrintJobData {
  job_id: string;
  session_code: string;
  status: PrintJobStatus;
  copies: number;
}

export interface QueuePrintPayload {
  image_url: string;
  copies: number;
  paper_size: '4R' | string;
  orientation: 'portrait' | 'landscape';
  idempotency_key: string;
}

/** Error from a kiosk API request, retaining only safe status information. */
export class KioskApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'KioskApiError';
    this.status = status;
  }
}

const toKioskApiError = (error: any, fallbackMessage: string): KioskApiError => {
  const status = error?.response?.status;
  const responseData = error?.response?.data;
  const code = responseData?.code;
  const serverMessage = responseData?.message
    || responseData?.error
    || responseData?.detail
    || (typeof responseData === 'string' ? responseData : '');

  // Email belum dikonfigurasi bukan "backend tidak dapat diakses".
  //
  // Backend menjawab 503 + code EMAIL_NOT_CONFIGURED, tetapi pesan generik
  // membuat pengunjung (dan operator) mengira koneksi yang bermasalah, sehingga
  // dicari-cari masalah jaringan padahal SMTP memang belum diisi.
  if (code === 'EMAIL_NOT_CONFIGURED') {
    return new KioskApiError(
      'Fitur kirim email belum diaktifkan di server. Hubungi petugas untuk mengaktifkannya.',
      status,
    );
  }

  const message = serverMessage || fallbackMessage;
  return new KioskApiError(message, status);
};

// ─── Helper ───────────────────────────────────────────────────────────────────

export const apiClient = axios.create();

apiClient.interceptors.request.use((config) => {
  const appConfig = getApiConfig();
  config.baseURL = appConfig.backendUrl;
  config.headers['x-api-key'] = appConfig.apiKey;
  return config;
});

const request = async <T>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> => {
  const { apiKey } = getApiConfig();
  if (!isUsableKioskApiKey(apiKey)) {
    throw new KioskApiError('API key kiosk belum diisi. Masukkan API key asli dari Admin.', 401);
  }

  try {
    return await apiClient.request<T>(config);
  } catch (error: any) {
    if (error instanceof KioskApiError) throw error;
    throw toKioskApiError(error, 'Backend utama tidak dapat diakses.');
  }
};

// ─── Connection ──────────────────────────────────────────────────────────────

export const checkBackendConnection = async (): Promise<void> => {
  const response = await request<ApiResponse>({ method: 'GET', url: '/connection' });
  if (response.data.success === false) {
    throw new KioskApiError(response.data.message || 'Kiosk ditolak oleh backend.', response.status);
  }
};

/** Backward-compatible admin settings check; it now targets the main connection endpoint. */
export const checkBackendHealth = async (url: string, currentApiKey: string): Promise<boolean> => {
  const origin = normalizeApiBaseUrl(url);
  const apiKey = currentApiKey.trim();
  if (!isUsableKioskApiKey(apiKey)) return false;

  try {
    const response = await axios.get(`${origin}/api/v1/kiosk/connection`, {
      headers: { 'x-api-key': apiKey }
    });
    return response.status >= 200 && response.status < 300 && response.data?.success !== false;
  } catch (error) {
    console.error('❌ Backend utama tidak dapat dijangkau / API key tidak valid:', error);
    return false;
  }
};

// ─── Session ──────────────────────────────────────────────────────────────────

/**
 * Mulai sesi photobooth baru.
 * Dipanggil saat pengguna memilih frame dan memulai sesi.
 *
 * @param kioskId    - ID kiosk ini (contoh: "KSK-TLKM-01")
 * @param frameTemplateId - ID frame template yang dipilih (opsional)
 * @returns SessionData jika berhasil, null jika gagal
 */
export const startSession = async (
  kioskId: string,
  frameTemplateId: number
): Promise<SessionData> => {
  if (!Number.isInteger(frameTemplateId) || frameTemplateId <= 0) {
    throw new KioskApiError('Template frame tidak memiliki ID backend yang valid.');
  }

  const response = await request<ApiResponse>({
    method: 'POST',
    url: '/sessions/start',
    data: { frame_template_id: Number(frameTemplateId) }
  });
  const data = response.data;
  const sessionCode = data.session_code || (data.data as any)?.session_code;
  if (!data.success || !sessionCode) {
    throw new KioskApiError(data.message || 'Sesi gagal dibuat.', response.status);
  }

  const amount = Number(data.amount ?? data.price ?? (data.data as any)?.amount ?? (data.data as any)?.price);
  const challengeId = (data.data as any)?.verification_challenge_id || '';
  const uniqueCode = Number((data.data as any)?.unique_code);
  return {
    id: sessionCode,
    kiosk_id: kioskId,
    frame_template_id: frameTemplateId,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
    status: 'active',
    challenge_id: challengeId,
    unique_code: Number.isInteger(uniqueCode) && uniqueCode > 0 ? uniqueCode : null,
    payment_method: (data.data as any)?.payment_method || 'qris_visual_proof',
    // false = server sedang mematikan pembayaran (payment_profiles.payment_required
    // = false) untuk keperluan uji; layar bayar dilewati.
    payment_required: (data.data as any)?.payment_required !== false
  };
};

export const getSessionPaymentStatus = async (sessionCode: string): Promise<SessionPaymentStatus> => {
  const response = await request<ApiResponse<SessionPaymentStatus>>({
    method: 'GET',
    url: `/sessions/${encodeURIComponent(sessionCode)}/payment-status`,
  });
  const status = response.data.data;
  if (!response.data.success || !status) {
    throw new KioskApiError(response.data.message || 'Gagal memeriksa status pembayaran otomatis.', response.status);
  }
  return status;
};

/**
 * Selesaikan sesi dan catat transaksi.
 * Dipanggil setelah pembayaran QRIS dikonfirmasi.
 *
 * @param sessionId   - ID sesi yang aktif
 */
export const completeSession = async (
  sessionId: string
): Promise<CompleteSessionResult> => {
  const response = await request<ApiResponse>({
    method: 'PUT',
    url: `/sessions/${encodeURIComponent(sessionId)}/complete`
  });
  const data = response.data;
  const downloadUrl = data.download_url || (data.data as any)?.download_url;
  if (!data.success || !downloadUrl) {
    throw new KioskApiError(data.message || 'Sesi gagal diselesaikan atau download URL tidak tersedia.', response.status);
  }
  const absoluteDownloadUrl = /^https?:\/\//i.test(downloadUrl)
    ? downloadUrl
    : `${getApiConfig().baseUrl}${downloadUrl.startsWith('/') ? '' : '/'}${downloadUrl}`;
  return { success: true, downloadUrl: absoluteDownloadUrl, message: data.message };
};

// ─── Photo ────────────────────────────────────────────────────────────────────

/**
 * Upload foto hasil photobooth ke backend.
 * Backend menyimpan file ke folder uploads/ dan URL-nya ke database.
 * Saat hosting: URL akan menjadi URL CDN.
 *
 * @param photoBlob  - File/Blob foto (PNG/JPG)
 * @param sessionId  - ID sesi aktif
 * @param filename   - Nama file (opsional, default: timestamp.png)
 * @returns URL foto jika berhasil, null jika gagal
 */
export const uploadPhoto = async (
  photoBlob: Blob,
  sessionId: string,
  filename?: string,
  purpose?: 'print'
): Promise<string> => {
  const finalName = filename || `photo-${Date.now()}.png`;
  const formData = new FormData();
  formData.append('photo', photoBlob, finalName);
  if (purpose === 'print') formData.append('purpose', 'print');

  const response = await request<ApiResponse<PhotoData>>({
    method: 'POST',
    url: `/sessions/${encodeURIComponent(sessionId)}/photos`,
    data: formData
  });
  const data = response.data;
  const photoData = (data.data || data) as PhotoData;
  const photoUrl = photoData.url;
  if (!data.success || !photoUrl) {
    throw new KioskApiError(data.message || 'Upload foto gagal.', response.status);
  }

  const absoluteUrl = /^https?:\/\//i.test(photoUrl)
    ? photoUrl
    : `${getApiConfig().baseUrl}${photoUrl.startsWith('/') ? '' : '/'}${photoUrl}`;
  console.log(`📸 Foto terupload: ${absoluteUrl}`);
  return absoluteUrl;
};

/** Queue a final, already-uploaded image for the kiosk printer. */
export const queuePrintJob = async (
  sessionCode: string,
  payload: QueuePrintPayload
): Promise<PrintJobData> => {
  try {
    const res = await apiClient.post<ApiResponse<PrintJobData>>(
      `/sessions/${encodeURIComponent(sessionCode)}/print`,
      payload,
      { validateStatus: status => status === 200 || status === 202 }
    );
    const data = res.data;
    const job = data?.data;
    if (!data?.success || !job?.job_id || !job.status) {
      throw new KioskApiError(data?.message || 'Print job tidak dapat dibuat.', res.status);
    }
    return job;
  } catch (error: any) {
    if (error instanceof KioskApiError) throw error;
    throw toKioskApiError(error, 'Backend print tidak dapat diakses.');
  }
};

/* 
const getPrintErrorMessage = (status?: number): string => {
  switch (status) {
    case 404: return 'Sesi, job print, atau gambar final tidak ditemukan.';
    case 409: return 'Permintaan print ditolak karena konflik sesi. Silakan coba lagi.';
    case 500: return 'Server print sedang bermasalah. Silakan coba lagi.';
    case 503: return 'Kiosk Agent sedang offline. Pastikan aplikasi Kiosk Agent berjalan.';
    default: return 'Print gagal. Periksa koneksi kiosk dan kondisi printer, lalu coba lagi.';
  }
};
*/

/** Read the current status of a queued kiosk print job. */
export const getPrintJobStatus = async (jobId: string): Promise<PrintJobData> => {
  try {
    const res = await apiClient.get<ApiResponse<PrintJobData>>(
      `/print-jobs/${encodeURIComponent(jobId)}`
    );
    const data = res.data;
    const job = data?.data;
    if (!data?.success || !job?.job_id || !job.status) {
      throw new KioskApiError(data?.message || 'Status print tidak valid.', res.status);
    }
    return job;
  } catch (error: any) {
    if (error instanceof KioskApiError) throw error;
    throw toKioskApiError(error, 'Status print tidak dapat diperiksa.');
  }
};

export const getPhotosBySession = async (sessionId: string): Promise<PhotoData[]> => {
  return []; // Not used in V1 kiosk API docs directly for kiosk display, but kept for compat
};

/**
 * Pengaturan cetak untuk kiosk ini, lewat HTTP.
 *
 * Dipakai jalur cetak Bluetooth langsung, yang tidak melewati kiosk-agent.
 * Tanpa ini, ukuran kertas / kepekatan / geser vertikal dari Admin tidak pernah
 * sampai ke photobooth kecuali agent berjalan — sehingga pengaturan Admin
 * tampak tersimpan tanpa efek.
 */
/**
 * Salinan konfigurasi cetak terakhir yang BERHASIL dibaca dari server.
 *
 * Ini bukan "konfigurasi lokal" — sumbernya tetap server, dan setiap
 * pengambilan sukses menimpanya. Gunanya satu: kiosk yang menyala sebelum
 * jaringannya siap (atau sesaat setelah server di-restart) tidak boleh mencetak
 * dengan BAWAAN SENDIRI. Dulu ia memakai '4R' dengan margin nol, jadi label
 * keluar tanpa kotak cetak — dan itu terjadi tanpa pesan apa pun.
 *
 * Nilainya sengaja TIDAK pernah dibaca dari file yang bisa diedit tangan:
 * disimpan di localStorage sebagai hasil salinan, dan selalu ditandai
 * server:true supaya jelas dari mana asalnya.
 */
const SIMPANAN_KUNCI = 'pb_printing_config_server';

/** Baca salinan terakhir; null kalau belum pernah berhasil mengambil. */
export const bacaKonfigurasiServerTerakhir = (): Record<string, unknown> | null => {
  try {
    const teks = localStorage.getItem(SIMPANAN_KUNCI);
    if (!teks) return null;
    const isi = JSON.parse(teks);
    return isi && typeof isi === 'object' ? isi as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

/** Simpan salinan setelah pengambilan berhasil. */
export const simpanKonfigurasiServer = (config: Record<string, unknown>): void => {
  try {
    localStorage.setItem(SIMPANAN_KUNCI, JSON.stringify({
      ...config,
      // Ditandai supaya jelas: ini salinan DARI SERVER, bukan setelan lokal
      // yang bisa dipakai untuk menimpa server.
      _sumber: 'server',
      _disimpan_pada: new Date().toISOString(),
    }));
  } catch {
    // Penyimpanan penuh / mode privat: mencetak tetap jalan dengan nilai yang
    // baru dibaca, jadi ini bukan kegagalan yang perlu menghentikan kiosk.
  }
};

export const fetchPrintingConfig = async (): Promise<{
  paper_size?: string;
  photo_brightness?: number;
  photo_contrast?: number;
  photo_saturation?: number;
  photo_fit_mode?: string;
  thermal_density?: number;
  thermal_offset_y_px?: number;
  thermal_offset_x_px?: number;
  print_margin_top_px?: number;
  print_margin_right_px?: number;
  print_margin_left_px?: number;
  print_margin_bottom_px?: number;
  /**
   * Algoritma konversi abu-abu sebelum dither (lihat GRAYSCALE_OPTIONS di
   * photobooth). Tidak divalidasi ulang di sini karena nilai asing ditangani
   * pemakainya dengan jatuh ke nilai sebelumnya.
   */
  grayscale_algorithm?: string;
  /** Penajaman 0..100; 0 = tidak menajamkan (perilaku lama). */
  print_sharpen?: number;
  /**
   * Tombol layar akhir, dikendalikan Admin.
   *
   * Bawaannya (tidak ada nilainya) AKTIF, karena itu perilaku yang sudah
   * berjalan. Kodenya tidak pernah dihapus — hanya tidak ditampilkan, jadi
   * menyalakannya kembali tidak perlu build ulang.
   */
  show_email_button?: boolean;
  show_retake_button?: boolean;
  show_print_button?: boolean;
} | null> => {
  try {
    const response = await request<ApiResponse<any>>({
      method: 'GET',
      url: '/printing-config',
      headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' },
      params: { _t: Date.now() }
    });
    return response.data?.data || null;
  } catch {
    // Jaringan mati / kiosk belum terdaftar.
    //
    // Dulu di sini mengembalikan null dan pemanggil kembali ke BAWAAN SENDIRI
    // ('4R', margin 0) — label keluar tanpa kotak cetak, tanpa pesan apa pun.
    // Sekarang yang dipakai adalah salinan TERAKHIR DARI SERVER: nilainya tetap
    // berasal dari backend, hanya umurnya lebih tua. Lebih baik mencetak dengan
    // konfigurasi server yang sedikit lama daripada dengan bawaan yang tidak
    // pernah disetujui siapa pun.
    const salinan = bacaKonfigurasiServerTerakhir();
    return salinan ? (salinan as never) : null;
  }
};

/** Tandai bahwa konfigurasi cetak ini datang dari server, bukan dari salinan. */
export type SumberKonfigurasi = 'server' | 'salinan-server' | 'bawaan';

/**
 * Apakah nilai ini berasal dari server (langsung atau salinan terakhirnya).
 *
 * Ada supaya pemanggil bisa membedakan "konfigurasi server yang agak lama"
 * (masih benar posisinya) dari "bawaan aplikasi" (label keluar tanpa kotak
 * cetak). Perbedaan itu tidak terlihat dari isi objeknya saja.
 */
export const sumberKonfigurasi = (config: Record<string, unknown> | null): SumberKonfigurasi => {
  if (!config) return 'bawaan';
  return config._sumber === 'server' ? 'salinan-server' : 'server';
};

export const fetchTemplates = async (): Promise<any[]> => {
  const response = await request<ApiResponse<any[]>>({
    method: 'GET',
    url: '/templates',
    headers: { 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' },
    params: { _t: Date.now() }
  });
  const templates = response.data.data;
  if (!response.data.success || !Array.isArray(templates) || templates.length === 0) {
    throw new KioskApiError(response.data.message || 'Template backend kosong atau tidak dapat dibaca.', response.status);
  }
  return templates;
};

export const fetchPaymentProfile = async (): Promise<string | null> => {
  const response = await request<ApiResponse<any[]>>({ method: 'GET', url: '/payments' });
  const payment = response.data.data?.[0];
  if (!response.data.success || !payment) {
    throw new KioskApiError(response.data.message || 'Profil pembayaran tidak tersedia.', response.status);
  }
  const paymentData = typeof payment.payment_data === 'string'
    ? JSON.parse(payment.payment_data)
    : payment.payment_data;
  const qrisPath = paymentData?.qris_image_url;
  if (!qrisPath) throw new KioskApiError('QRIS belum dikonfigurasi di backend.', response.status);
  return /^https?:\/\//i.test(qrisPath)
    ? qrisPath
    : `${getApiConfig().baseUrl}${qrisPath.startsWith('/') ? '' : '/'}${qrisPath}`;
};

export const verifyPayment = async (sessionId: string): Promise<boolean> => {
  const response = await request<ApiResponse>({
    method: 'POST',
    url: `/sessions/${encodeURIComponent(sessionId)}/payment`
  });
  if (!response.data.success) {
    throw new KioskApiError(response.data.message || 'Pembayaran ditolak backend.', response.status);
  }
  return true;
};

export const submitPaymentEvidence = async (
  sessionCode: string,
  frames: Blob[],
  challengeId: string
): Promise<any> => {
  const formData = new FormData();
  formData.append('challenge_id', challengeId);
  frames.forEach((frame, idx) => {
    formData.append('frames', frame, `frame_${idx}.jpg`);
  });

  const response = await request<ApiResponse>({
    method: 'POST',
    url: `/sessions/${encodeURIComponent(sessionCode)}/payment-verifications`,
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    }
  });

  if (!response.data.success) {
    throw new KioskApiError(response.data.message || 'Gagal mengirim bukti pembayaran.', response.status);
  }
  return response.data.data;
};

export const getPaymentVerificationStatus = async (
  sessionCode: string,
  attemptId: string
): Promise<any> => {
  const response = await request<ApiResponse>({
    method: 'GET',
    url: `/sessions/${encodeURIComponent(sessionCode)}/payment-verifications/${encodeURIComponent(attemptId)}`
  });
  if (!response.data.success) {
    throw new KioskApiError(response.data.message || 'Gagal memeriksa status verifikasi.', response.status);
  }
  return response.data.data;
};

// ─── Email ────────────────────────────────────────────────────────────────────

/**
 * Kirim digital copy foto ke email pelanggan.
 * Backend akan mengirim email dengan link download foto.
 *
 * @param sessionId - ID sesi
 * @param email     - Alamat email pelanggan
 */
export const sendPhotoByEmail = async (
  sessionId: string,
  email: string
): Promise<{ success: boolean; message?: string }> => {
  const response = await request<ApiResponse>({
    method: 'POST',
    url: `/sessions/${encodeURIComponent(sessionId)}/send-email`,
    data: { email }
  });
  if (!response.data.success) {
    throw new KioskApiError(response.data.message || 'Gagal mengirim email.', response.status);
  }
  console.log(`📧 Email terkirim ke ${email}`);
  return { success: true, message: response.data.message };
};

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Log gesture yang dideteksi oleh sistem kamera kiosk.
 * Digunakan untuk AI gesture control (contoh: V-sign = ambil foto).
 */
export const logGesture = async (payload: GesturePayload): Promise<boolean> => {
  try {
    const res = await apiClient.post<ApiResponse>('/gestures', payload);
    return res.data.success;
  } catch (error: any) {
    console.error('Error saat logGesture:', error?.response?.data || error);
    return false;
  }
};

/**
 * Catat log print dari kiosk.
 * Digunakan untuk monitoring stok kertas dan status printer.
 */
export const recordPrintLog = async (payload: PrintLogPayload): Promise<boolean> => {
  try {
    const res = await apiClient.post<ApiResponse>('/prints', payload);
    return res.data.success;
  } catch (error: any) {
    console.error('Error saat recordPrintLog:', error?.response?.data || error);
    return false;
  }
};

// ─── Frame Templates & Filters (Read-only dari backend) ───────────────────────

/**
 * Ambil semua frame templates dari backend.
 * Dipanggil saat startup kiosk untuk sync data terbaru dari admin.
 */
export const getFrameTemplates = async () => {
  try {
    const res = await apiClient.get('/templates');
    return res.data.success ? res.data.data : [];
  } catch (error: any) {
    console.error('Error saat getFrameTemplates:', error?.response?.data || error);
    return [];
  }
};

/**
 * Ambil semua filter aktif dari backend.
 * Dipanggil saat startup kiosk untuk sync filter terbaru dari admin.
 */
export const getFilters = async () => {
  try {
    const res = await apiClient.get('/filters');
    return res.data.success ? res.data.data : [];
  } catch (error: any) {
    console.error('Error saat getFilters:', error?.response?.data || error);
    return [];
  }
};
