/**
 * Kebijakan pengembalian otomatis ke signage.
 *
 * Dipisah dari PhotoBooth.tsx supaya bisa diuji tanpa browser: keputusan
 * "boleh redirect sekarang?" adalah bagian berisiko, karena redirect di tengah
 * alur membuang sesi yang sudah dibayar.
 */

/**
 * Tujuan tombol Back (halaman pertama) dan Home (halaman akhir).
 *
 * HANYA dipakai di mode browser biasa (jalur 'navigate'). Di app desktop dan
 * overlay kiosk JagoAI, layar BUKAN milik photobooth: kembali berarti
 * menutup jendela/aplikasi ini (lihat kembaliKeSignage), bukan memuat halaman
 * signage ke dalam jendela sendiri.
 */
export const SIGNAGE_URL = 'https://signage.jagoai.dev/';

/** Lama menganggur sebelum kembali sendiri ke signage. */
export const IDLE_REDIRECT_MS = 60_000;

/**
 * Layar tunggu: pengunjung hanya memilih, tidak ada data yang bisa hilang.
 *
 * Layar lain sengaja TIDAK ada di sini. Di CAPTURE/PAYMENT_SCAN pengunjung
 * sedang berpose atau memindai QR tanpa menyentuh layar; di PAYMENT_CHECKING,
 * EDIT, dan RESULT ada sesi berbayar yang sedang diproses. Redirect otomatis di
 * sana akan membuang pekerjaan pengunjung.
 */
export const IDLE_SAFE_STEPS = ['LANDING', 'PACKAGE', 'LAYOUT'] as const;

/**
 * Event yang dihitung sebagai pengunjung masih aktif. Gerakan tangan di depan
 * kamera (gesture) sengaja tidak dihitung: orang yang lewat akan terus menahan
 * timer sehingga photobooth tidak pernah kembali ke signage.
 */
export const USER_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel'] as const;

export interface IdleContext {
  step: string;
  isCalibrating: boolean;
  /** Operator sedang di menu admin atau kiosk dalam maintenance mode. */
  idlePaused: boolean;
}

/** Apakah timer idle boleh berjalan di kondisi ini. */
export function shouldArmIdleTimer({ step, isCalibrating, idlePaused }: IdleContext): boolean {
  if (idlePaused || isCalibrating) return false;
  return (IDLE_SAFE_STEPS as readonly string[]).includes(step);
}

// ---------------------------------------------------------------------------
// Mode tertanam di kiosk JagoAI
// ---------------------------------------------------------------------------

/** Flag yang disuntikkan desktop launcher JagoAI saat meluncurkan aplikasi. */
export const KIOSK_EMBED_ARG = '--jagoai-kiosk';

/** Marker alternatif untuk jalur BrowserView: #jagoai-kiosk?jagoaiIdle=NN. */
export const KIOSK_EMBED_URL_MARKER = 'jagoai-kiosk';

/**
 * Photobooth sedang dijalankan DI DALAM kiosk JagoAI?
 *
 * Dua bentuk yang harus dikenali, keduanya nyata:
 *   1. Aplikasi desktop diluncurkan dari tombol shortcut kiosk → proses utama
 *      JagoAI menyuntikkan `--jagoai-kiosk` (dengan atau tanpa `=nilai`).
 *   2. Halaman dibuka sebagai overlay BrowserView → URL-nya memuat marker
 *      `#jagoai-kiosk`.
 *
 * Kenapa penting: saat tertanam, layar BUKAN milik photobooth. Mengarahkan
 * window ke URL signage akan memuat halaman signage DI DALAM jendela
 * photobooth — jendela itu tidak pernah tertutup dan TV tetap menampilkan
 * photobooth. Yang benar adalah keluar dari jendela/aplikasi ini.
 */
export function isKioskEmbedded(
  argv: readonly string[] = typeof process !== 'undefined' && process.argv ? process.argv : [],
  href: string = typeof location !== 'undefined' ? location.href : '',
): boolean {
  if (href && href.toLowerCase().includes(KIOSK_EMBED_URL_MARKER)) return true;
  return argv.some((arg) => {
    const s = String(arg);
    return s === KIOSK_EMBED_ARG || s.startsWith(`${KIOSK_EMBED_ARG}=`);
  });
}

/** Jalan keluar yang tersedia untuk mengembalikan layar ke signage. */
export interface ReturnDeps {
  /** Overlay BrowserView JagoAI (window.jagoai.closePhotobooth). */
  jagoaiClose?: (() => void) | null;
  /** Aplikasi desktop: menutup jendela sendiri (window.kioskEmbed.close). */
  kioskClose?: (() => void) | null;
  /**
   * Kiosk hanya kembali kalau diberi tahu lewat backend-nya
   * (POST /api/cms/activity/exit-request). Dipakai saat jalur lain tidak ada.
   */
  postExitRequest?: (() => Promise<boolean>) | null;
}

export type ReturnOutcome = 'bridge' | 'app' | 'exit-request' | 'navigate';

// ---------------------------------------------------------------------------
// Jalur keluar lewat backend kiosk (dipakai app desktop yang memuat UI dari
// hosting: file:// tidak punya origin HTTP, jadi exit-request perlu origin
// yang bisa dihitung dari URL halaman)
// ---------------------------------------------------------------------------

/** Batas waktu tunggu balasan POST exit-request sebelum dianggap gagal. */
export const EXIT_REQUEST_TIMEOUT_MS = 1000;

/**
 * Origin backend kiosk dari URL halaman sekarang.
 *
 * Backend kiosk dilayani origin yang sama dengan UI (reverse proxy yang sama),
 * jadi POST cukup ditujukan ke origin halaman. Mode file:// (app desktop
 * memuat UI dari hosting) tidak punya origin http — hasilnya '', dan pemanggil
 * memilih jalur keluar lain.
 */
export function resolveSignageBaseUrl(href: string): string {
  if (!href) return '';
  try {
    const u = new URL(href);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

/**
 * Minta kiosk menutup aplikasi ini lewat backend-nya
 * (POST /api/cms/activity/exit-request).
 *
 * Resolve true HANYA bila backend mengonfirmasi. Jaringan lambat, timeout,
 * atau jawaban tidak dikenal → false, dan pemanggil memilih jalur berikutnya.
 */
export async function postExitRequest(
  baseUrl: string,
  timeoutMs = EXIT_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/cms/activity/exit-request`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const body = await res.json().catch(() => null);
    return Boolean(body && body.success);
  } catch {
    return false;
  }
}

/**
 * Kembalikan layar ke signage.
 *
 * Urutan dicoba dari yang paling langsung: tutup overlay, tutup aplikasi,
 * minta kiosk menutup, dan terakhir pindah window (mode browser biasa — di
 * sana memang tidak ada kiosk yang bisa menutup apa pun).
 */
export async function kembaliKeSignage(deps: ReturnDeps = {}): Promise<ReturnOutcome> {
  if (typeof deps.jagoaiClose === 'function') {
    deps.jagoaiClose();
    return 'bridge';
  }
  if (typeof deps.kioskClose === 'function') {
    deps.kioskClose();
    return 'app';
  }
  if (typeof deps.postExitRequest === 'function') {
    try {
      if (await deps.postExitRequest()) return 'exit-request';
    } catch {
      // Kiosk tidak menjawab (offline/mati) — jangan menggantung pengunjung.
    }
  }
  return 'navigate';
}

/**
 * Tipe bridge yang disuntikkan preload di sisi aplikasi desktop.
 *
 * Dideklarasikan di sini (bukan vite-env.d.ts) supaya berada di berkas yang
 * sama dengan pemakaiannya — kembaliKeSignage membaca bridge ini.
 */
declare global {
  interface Window {
    /** Bridge overlay BrowserView JagoAI (preload jalur BrowserView kiosk). */
    jagoai?: { closePhotobooth?: () => void };
    /** Bridge app desktop UniSmiles (electron/preload.cjs). */
    kioskEmbed?: {
      close?: () => void;
      status?: () => Promise<{ embedded: boolean; idleLimitSeconds: number; sisaDetik: number }>;
      /** Berlangganan sisa hitung mundur dari proses utama (detik; 0 = tersembunyi). */
      onCountdown?: (callback: (sisaDetik: number) => void) => void;
      /**
       * Laporkan aktivitas pengunjung ke proses utama (reset hitung mundur +
       * beacon ke backend kiosk). Gesture udara tidak menghasilkan event
       * pointer/keyboard, jadi HAUS dipanggil manual dari useAirGesture.
       */
      notifyActivity?: () => void;
    };
  }
}
