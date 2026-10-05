import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Settings, Camera, ChevronRight, Download, RefreshCw, 
  Check, Image as ImageIcon, ChevronLeft, SwitchCamera, Send, Mail, QrCode, Printer,
  Lock, Unlock, Scan, X, ChevronUp, ChevronDown, Loader2, Wand2, LayoutTemplate, AlertCircle, AlertTriangle
} from 'lucide-react';
import { FrameLayout, FrameStyle, PhotoFilter, GridLayoutId, VirtualBackground, FrameElement, STORAGE_KEYS } from '../types';
import { getStoredFilters, getLayoutConfig, getStoredBackgrounds, getAppConfig } from '../services/storageService';
import { useAirGesture } from './useAirGesture';
import { kioskAgentBridge } from '../services/kioskAgentBridge';
import { NiimbotPrinter, PRINTER_BELUM_DIPASANGKAN, labelSize as computeLabelSize, labelMmFromPaperSize, labelFrameBox, firstSlot, DEFAULT_ADJUSTMENTS, type PrintAdjustments } from '../services/niimbotPrinter';
import { paintCover as paintCoverInto, paintPrintImage } from '../services/printImage';
import { DEFAULT_GRAYSCALE_ALGORITHM, isGrayscaleAlgorithm } from '../services/oneBitImage';
import { SIGNAGE_URL, IDLE_REDIRECT_MS, shouldArmIdleTimer, isKioskEmbedded, kembaliKeSignage, resolveSignageBaseUrl, postExitRequest } from '../services/idleReturn';
import {
  SCAN_FRAME_GAP_MS, SCAN_READ_DELAY_MS, MAX_SUBMIT_ROUNDS,
  SUBMIT_POLL_TIMEOUT_MS, SUBMIT_POLL_INTERVAL_MS,
  keepBestFrames, orderFramesForUpload, shouldSubmitBatch,
  scanStatusText, CHECKING_TEXT, FROZEN_BADGE_TEXT, isSettledDecision, isServiceFailure, isRoundLimitReached,
  guideFrameStyle, SCAN_GUIDE,
} from '../services/scanWindow';
import {
  startSession, completeSession, uploadPhoto, sendPhotoByEmail, fetchPaymentProfile,
  verifyPayment, fetchTemplates, queuePrintJob, getPrintJobStatus, KioskApiError,
  getApiConfig, isAutoPrintEnabled, isManualPrintFallbackEnabled,
  submitPaymentEvidence, getPaymentVerificationStatus, fetchPrintingConfig,
  getSessionPaymentStatus, simpanKonfigurasiServer, sumberKonfigurasi
} from '../services/apiService';

// Global Scale (Now 1.0 since we removed transform scale from index.html)
const GLOBAL_SCALE = 1.0;

// Sound Effects
const SHUTTER_SOUND_URL = "https://assets.mixkit.co/active_storage/sfx/2578/2578-preview.mp3";
const COUNTDOWN_SOUND_URL = "https://cdn.pixabay.com/download/audio/2022/03/24/audio_cda640386c.mp3?filename=beep-6-96243.mp3";

// Total time for one photo session (including any retakes). The mapping keeps
// the requested package timings and gives the same +1 minute progression for
// layouts with another number of slots.
const getCaptureDurationSeconds = (slotCount: number): number => {
  if (slotCount <= 1) return 3 * 60;
  return (slotCount + 2) * 60;
};

/**
 * Ukuran kertas per layout — DIPAKAI HANYA SEBAGAI CADANGAN.
 *
 * Sumber utama ukuran kertas adalah pengaturan Admin (Kiosk Manager → Printer
 * Configuration → Paper Size), yang dikirim ke kiosk lewat kiosk-agent.
 *
 * Sebelumnya fungsi ini tidak pernah dipanggil sama sekali: kode langsung memakai
 * kioskPaperSize yang selalu bernilai '4R', sehingga layout 1x1 dan strip pun
 * meminta kertas 4R. Fungsi ini dipakai lagi sebagai cadangan supaya permintaan
 * ukuran kertas tetap masuk akal kalau Admin belum mengatur apa pun.
 */
const getPaperSizeForLayout = (layoutId: string | null): string => {
  switch(layoutId) {
    case '1x1': return '3R';
    case '2x1': return 'Strip';
    case '3x1': return 'Strip';
    case '4x1': return 'Strip';
    case '2x2': return '4R';
    case '2x3': return '4R';
    case '3x3': return '6R';
    default: return '4R';
  }
};

const formatCaptureTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
};

interface PhotoBoothProps {
  onAdminClick: () => void;
  // Menahan pengembalian otomatis ke signage. Diisi true saat modal admin
  // terbuka atau maintenance mode aktif, supaya operator tidak terlempar keluar
  // di tengah pengaturan.
  idlePaused?: boolean;
}

type BoothStep = 'LANDING' | 'PACKAGE' | 'LAYOUT' | 'PAYMENT' | 'PAYMENT_SCAN' | 'PAYMENT_CHECKING' | 'CAPTURE' | 'EDIT' | 'RESULT';
type PrintState = 'idle' | 'preparing' | 'uploading' | 'queued' | 'printing' | 'success' | 'failed';

const ACTIVE_PRINT_STORAGE_KEY = 'unismiles_active_print_job';
const PRINT_POLL_TIMEOUT_MS = 60_000;

// Tujuan tombol Back/Home dan kebijakan timer idle tinggal di services/idleReturn
// supaya bisa diuji tanpa browser.
const SIGNAGE_HOME_URL = SIGNAGE_URL;

// Catatan: tidak ada lagi ambang ketajaman yang menolak pemindaian di sisi
// kiosk. Ketajaman hanya dipakai untuk mengurutkan frame dan memberi tahu
// pengunjung apakah posisinya sudah tepat; keputusan berhasil/gagal diambil
// vision service dari teks yang benar-benar terbaca.


interface PersistedPrintJob {
  sessionCode: string;
  jobId: string;
  imageUrl: string;
  idempotencyKey: string;
  status: 'queued' | 'printing';
  createdAt: number;
}

const makeIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getPersistedPrintJob = (): PersistedPrintJob | null => {
  try {
    const raw = sessionStorage.getItem(ACTIVE_PRINT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedPrintJob;
    if (!parsed.sessionCode || !parsed.jobId || !parsed.imageUrl || !parsed.idempotencyKey) return null;
    return parsed;
  } catch (_) {
    return null;
  }
};

const persistPrintJob = (job: PersistedPrintJob): void => {
  try { sessionStorage.setItem(ACTIVE_PRINT_STORAGE_KEY, JSON.stringify(job)); } catch (_) { /* optional recovery only */ }
};

const clearPersistedPrintJob = (): void => {
  try { sessionStorage.removeItem(ACTIVE_PRINT_STORAGE_KEY); } catch (_) { /* optional recovery only */ }
};

const getPrintErrorMessage = (error: unknown): string => {
  const status = error instanceof KioskApiError ? error.status : undefined;
  switch (status) {
    case 401: return 'Kiosk API key tidak valid. Periksa konfigurasi kiosk.';
    case 403: return 'Kiosk sedang offline atau tidak memiliki izin mencetak.';
    case 404: return 'Sesi, job print, atau gambar final tidak ditemukan.';
    case 409: return 'Permintaan print ditolak karena konflik sesi. Silakan coba lagi.';
    case 500: return 'Server print sedang bermasalah. Silakan coba lagi.';
    default: return 'Print gagal. Periksa koneksi kiosk dan kondisi printer, lalu coba lagi.';
  }
};

// Harga bisa dikirim backend sebagai `price`, `layout_price`, atau di dalam
// layout_config (format lama). Jangan gunakan harga UI sebagai sumber payment.
const positiveNumber = (...values: unknown[]): number | null => {
  for (const value of values) {
    const numberValue = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof numberValue === 'number' && Number.isFinite(numberValue) && numberValue > 0) return numberValue;
  }
  return null;
};

const normalizeFrameBackground = (style: any, config: any): any => {
  const source = style?.backgroundConfig ?? style?.background_config
    ?? config?.backgroundConfig ?? config?.background_config ?? config?.background ?? style?.background;
  if (!source || typeof source !== 'object') return { type: 'solid', color: '#ffffff' };
  const type = source.type ?? source.kind ?? 'solid';
  if (type !== 'gradient') return { ...source, type, color: source.color ?? source.backgroundColor ?? '#ffffff' };
  const rawStops = source.gradientStops ?? source.gradient_stops ?? source.stops ?? [];
  return {
    ...source,
    type: 'gradient',
    gradientType: source.gradientType ?? source.gradient_type ?? source.style ?? 'linear',
    gradientAngle: Number(source.gradientAngle ?? source.gradient_angle ?? source.angle ?? 90),
    gradientStops: rawStops.map((stop: any) => ({
      color: stop.color ?? stop.hex ?? '#ffffff',
      offset: Number(stop.offset ?? stop.position ?? stop.percent ?? 0)
    }))
  };
};

// Admin stores the linear-gradient angle as a canvas/vector angle
// (0deg = right, 90deg = down). CSS uses the opposite gradient direction
// for the same axis, so convert only when building CSS. This keeps the
// Admin first stop at the same visual side (e.g. 88deg: cyan top, pink bottom).
const adminAngleToCssAngle = (angle: number): number => 90 + angle;

const bustFrameAssetCache = (url: string | undefined): string | undefined => {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
};

// Admin versions use both `elements` and `assetElements` for artwork placed
// on a frame. Kiosk rendering uses FrameElement, so normalize both payloads
// into the same shape here instead of silently dropping uploaded logos.
const resolveFrameAssetUrl = (value: unknown): string => {
  if (typeof value !== 'string' || !value) return '';
  if (/^(data:|blob:|https?:\/\/)/i.test(value)) return value;
  const root = getApiConfig().baseUrl;
  return value.startsWith('/') ? `${root}${value}` : `${root}/${value}`;
};

const normalizeFrameElements = (style: any, config: any): FrameElement[] => {
  const primaryElements = Array.isArray(style?.elements)
    ? style.elements
    : (Array.isArray(config?.elements) ? config.elements : []);
  const assetElements = [
    ...(Array.isArray(style?.assetElements) ? style.assetElements : []),
    ...(Array.isArray(style?.asset_elements) ? style.asset_elements : []),
    ...(Array.isArray(config?.assetElements) ? config.assetElements : []),
    ...(Array.isArray(config?.asset_elements) ? config.asset_elements : [])
  ].map((element: any) => ({ ...element, __assetElement: true }));
  const rawElements = [
    ...primaryElements,
    ...assetElements
  ];
  const seen = new Set<string>();
  const canvasWidth = Number(config?.width ?? config?.canvasWidth ?? 0);
  const canvasHeight = Number(config?.height ?? config?.canvasHeight ?? 0);

  return rawElements.map((raw: any, index: number) => {
    const source = raw?.content ?? raw?.url ?? raw?.src ?? raw?.imageUrl ?? raw?.image_url ?? '';
    const isText = raw?.type === 'text' || (raw?.text && !source);
    const rawId = String(raw?.id ?? `frame-element-${index}`);
    const id = seen.has(rawId) ? `${rawId}-${index}` : rawId;
    seen.add(rawId);

    let x = Number(raw?.x ?? 50);
    let y = Number(raw?.y ?? 50);
    let width = Number(raw?.width ?? raw?.w ?? (isText ? 0 : 20));
    // New Admin payloads use percentages for elements; support older pixel
    // payloads when a canvas size is present.
    if (canvasWidth > 0 && x > 100) x = (x / canvasWidth) * 100;
    if (canvasHeight > 0 && y > 100) y = (y / canvasHeight) * 100;
    if (canvasWidth > 0 && width > 100) width = (width / canvasWidth) * 100;
    let height = Number(raw?.height ?? raw?.h ?? 0);
    if (canvasHeight > 0 && height > 100) height = (height / canvasHeight) * 100;

    return {
      ...raw,
      id,
      type: isText ? 'text' : 'sticker',
      content: isText ? String(raw?.content ?? raw?.text ?? '') : bustFrameAssetCache(resolveFrameAssetUrl(source)),
      x, y, width,
      height,
      rotation: Number(raw?.rotation ?? 0),
      opacity: Number(raw?.opacity ?? 1),
      zIndex: Number(raw?.zIndex ?? raw?.z_index ?? index),
      anchor: raw?.anchor ?? (raw?.__assetElement ? 'top-left' : 'center')
    } as FrameElement;
  });
};

const normalizeTemplatePrices = (templates: any[]): FrameLayout[] => templates.map((layout: any) => {
  let layoutConfig = layout?.layout_config;
  if (typeof layoutConfig === 'string') {
    try { layoutConfig = JSON.parse(layoutConfig); } catch (_) { layoutConfig = null; }
  }
  const price = positiveNumber(
    layout?.price,
    layout?.layout_price,
    layout?.base_price,
    layoutConfig?.price,
    layoutConfig?.layout_price,
    layoutConfig?.base_price,
    ...(Array.isArray(layout?.styles) ? layout.styles.flatMap((style: any) => [style?.price, style?._price, style?._layoutConfig?.price, style?._layoutConfig?.layout_price]) : [])
  );
  const normalizedStyles = Array.isArray(layout?.styles)
    ? layout.styles.map((style: any) => {
        // Admin may return the canonical frame object either inside
        // `_layoutConfig`/`layout_config` or directly on the style itself.
        // Keep both response shapes equivalent before rendering.
        // API contract priority: explicit frameConfig first, then
        // layout_config, then the legacy internal field.
        let styleConfig = style?.frameConfig ?? style?.frame_config
          ?? style?.layout_config ?? style?._layoutConfig;
        const hasOwnVisualConfig = style?.backgroundConfig || style?.background_config
          || style?.previewUrl || style?.preview_url || style?.overlayUrl || style?.overlay_url;
        if (!styleConfig && (Array.isArray(style?.slots) || style?.width || style?.height || hasOwnVisualConfig)) {
          styleConfig = style;
        }
        styleConfig = styleConfig ?? style?.frameConfig ?? style?.frame_config
          ?? layout?.frameConfig ?? layout?.frame_config ?? layoutConfig;
        if (typeof styleConfig === 'string') {
          try { styleConfig = JSON.parse(styleConfig); } catch (_) { styleConfig = null; }
        }
        const canvasWidth = styleConfig?.width ?? styleConfig?.canvasWidth
          ?? style?.canvasWidth ?? style?.width
          ?? layout?.canvasWidth ?? layout?.width
          ?? layoutConfig?.canvasWidth ?? layoutConfig?.width;
        const canvasHeight = styleConfig?.height ?? styleConfig?.canvasHeight
          ?? style?.canvasHeight ?? style?.height
          ?? layout?.canvasHeight ?? layout?.height
          ?? layoutConfig?.canvasHeight ?? layoutConfig?.height;

        // Older responses put slots in style._layoutConfig (array), while
        // the canvas dimensions live in the parent layout_config. Preserve
        // both by wrapping the slots in the normalized object shape.
        if (Array.isArray(styleConfig) && (canvasWidth || canvasHeight)) {
          styleConfig = { slots: styleConfig, width: canvasWidth, height: canvasHeight, units: 'pixel' };
        } else if (styleConfig && typeof styleConfig === 'object' && !Array.isArray(styleConfig)) {
          styleConfig = {
            ...styleConfig,
            width: styleConfig.width ?? styleConfig.canvasWidth ?? canvasWidth,
            height: styleConfig.height ?? styleConfig.canvasHeight ?? canvasHeight,
            // Geometry may be inherited from the layout, but never inherit
            // its background: each Admin style owns its own gradient.
            slots: styleConfig.slots ?? layoutConfig?.slots,
            // Canonical Admin slots are pixels. Only an explicit percentage
            // unit is allowed to opt into percentage coordinates.
            units: styleConfig.units ?? styleConfig.slotUnits ?? 'pixel'
          };
        } else if (canvasWidth || canvasHeight) {
          styleConfig = { width: canvasWidth, height: canvasHeight, units: 'pixel' };
        }
        const canonical = styleConfig && typeof styleConfig === 'object' && !Array.isArray(styleConfig)
          ? styleConfig
          : null;
        return canonical
          ? {
              ...style,
              _layoutConfig: canonical,
              backgroundConfig: normalizeFrameBackground(style, canonical),
              elements: normalizeFrameElements(style, canonical),
              // Admin may overwrite an existing uploaded file at the same URL.
              // Bust the browser cache so the kiosk displays the new artwork.
              overlayUrl: bustFrameAssetCache(style.overlayUrl ?? style.overlay_url ?? canonical.overlayUrl ?? canonical.overlay_url),
              slotBorder: style.slotBorder ?? style.slot_border ?? canonical.slotBorder ?? canonical.slot_border,
              slotBorderColor: style.slotBorderColor ?? style.slot_border_color ?? canonical.slotBorderColor ?? canonical.slot_border_color,
              slotBorderWidth: style.slotBorderWidth ?? style.slot_border_width ?? canonical.slotBorderWidth ?? canonical.slot_border_width
            }
          : style;
      })
    : layout?.styles;
  const normalizedLayout = normalizedStyles ? { ...layout, styles: normalizedStyles } : layout;
  return price === null ? normalizedLayout : { ...normalizedLayout, price };
});

/**
 * Salinan terakhir daftar template yang BERHASIL dibaca dari backend.
 *
 * Dipakai saat backend sedang tidak terjangkau: daftar template hampir tidak
 * pernah berubah, jadi salinan lama jauh lebih benar daripada daftar kosong.
 * Yang disimpan adalah hasil yang SUDAH dinormalisasi, jadi bentuknya sama
 * dengan yang dipakai layar.
 *
 * Sengaja mengembalikan array kosong (bukan melempar) kalau tidak ada atau
 * rusak: pemanggilnya perlu membedakan "tidak ada salinan" dari "gagal baca",
 * dan keduanya berakhir sama — pakai pesan galat.
 */
export const bacaTemplatesTersimpan = (): FrameLayout[] => {
  try {
    const mentah = localStorage.getItem(STORAGE_KEYS.FRAMES);
    if (!mentah) return [];
    const data = JSON.parse(mentah);
    return Array.isArray(data) ? (data as FrameLayout[]) : [];
  } catch {
    return [];
  }
};

// --- OPTIMIZATION: Global Image Cache ---
// Stores URL -> Base64 mapping to prevent re-fetching same assets
const imageCache = new Map<string, string>();
const ASSET_FETCH_TIMEOUT_MS = 4000;
const ASSET_PROXY_TIMEOUT_MS = 2500;
const ASSET_PROCESSING_TIMEOUT_MS = 8000;
const RENDER_IMAGE_TIMEOUT_MS = 6000;

// --- Helper: Robust Image to Base64 with Timeout & Cache ---
const convertImageToBase64 = async (url: string): Promise<string> => {
  // 1. Check Cache
  if (!url || url.startsWith('data:')) return url;
  if (imageCache.has(url)) return imageCache.get(url)!;

  // Helper to fetch with timeout and convert to base64
  const fetchAndConvert = async (targetUrl: string, timeout = ASSET_FETCH_TIMEOUT_MS): Promise<string> => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(targetUrl, { 
            signal: controller.signal,
            credentials: 'omit', // Standard CORS request without cookies
            referrerPolicy: 'no-referrer', // Prevent sending Referer header to avoid hotlink blocks
            mode: 'cors'
        });
        clearTimeout(id);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        const blob = await response.blob();
        return new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                if (typeof reader.result === 'string') resolve(reader.result);
                else reject(new Error('Reader result is not string'));
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
      } catch (e) {
        clearTimeout(id);
        throw e;
      }
  };

  // Helper: Try to load via Image object and draw to canvas (last resort for CORS-friendly but fetch-unfriendly servers)
  const imageObjectLoad = (targetUrl: string): Promise<string> => {
      return new Promise((resolve, reject) => {
          const img = new Image();
          const timeoutId = window.setTimeout(() => reject(new Error('Image load timeout')), ASSET_FETCH_TIMEOUT_MS);
          img.crossOrigin = 'Anonymous'; // Required for toDataURL
          img.referrerPolicy = 'no-referrer'; 
          img.onload = () => {
              window.clearTimeout(timeoutId);
              const canvas = document.createElement('canvas');
              canvas.width = img.width;
              canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              if (!ctx) { reject(new Error('Canvas ctx null')); return; }
              ctx.drawImage(img, 0, 0);
              try {
                  const data = canvas.toDataURL('image/png');
                  resolve(data);
              } catch (e) { reject(e); } // Likely tainted canvas
          };
          img.onerror = () => {
              window.clearTimeout(timeoutId);
              reject(new Error('Image load error'));
          };
          img.src = targetUrl;
      });
  };

  // List of Proxies to Try in Order
  // Using multiple services maximizes chance of bypassing 403s
  const PROXIES = [
      (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
      (u: string) => `https://wsrv.nl/?url=${encodeURIComponent(u)}&output=png`,
      (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
      (u: string) => `https://images.weserv.nl/?url=${encodeURIComponent(u)}&output=png`,
      (u: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,
  ];

  let resultBase64: string | null = null;

  // 1. Try Direct Fetch first (optimistic)
  try {
      resultBase64 = await fetchAndConvert(url);
  } catch (e) {
      // console.warn("Direct fetch failed, trying proxies...");
  }

  // 2. Try Proxies if direct failed
  if (!resultBase64) {
      const proxyResults = await Promise.all(PROXIES.map(async proxyGen => {
          try {
              return await fetchAndConvert(proxyGen(url), ASSET_PROXY_TIMEOUT_MS);
          } catch (_) {
              return null;
          }
      }));
      resultBase64 = proxyResults.find(Boolean) || null;
  }

  // 3. Last Resort: Image Object Load (bypass fetch API restrictions)
  if (!resultBase64) {
      try {
          resultBase64 = await imageObjectLoad(url);
      } catch (e) {
          console.error(`All strategies failed for: ${url}`);
      }
  }

  if (resultBase64 && resultBase64.startsWith('data:')) {
      imageCache.set(url, resultBase64);
      return resultBase64;
  }
  
  // If all else fails, return original URL. 
  // It might fail in html2canvas (taint), but at least it tries.
  return url;
};

// --- Components ---

interface BoothWrapperProps {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  onAdminClick?: () => void;
  hideAdmin?: boolean;
  isLocked?: boolean;
  onToggleLock?: () => void;
  uiMode: 'normal' | 'air-touch';
  hideHeader?: boolean;
  customBg?: string;
  onBack?: () => void;
  hideLogos?: boolean;
  isVertical?: boolean;
}

const BoothWrapper: React.FC<BoothWrapperProps> = ({ children, title, subtitle, onAdminClick, hideAdmin, isLocked, onToggleLock, uiMode, hideHeader, customBg, onBack, hideLogos, isVertical }) => (
  <div className={`h-full w-full ${customBg || 'bg-[#0c1633]'} text-white flex flex-col overflow-hidden select-none relative`}>
      {/* Logos at Bottom Center for all wrapper screens */}
      {!hideLogos && (
          <div className={`absolute bottom-4 left-1/2 -translate-x-1/2 w-max flex items-center justify-center opacity-80 pointer-events-none z-40 ${isVertical ? 'gap-6 scale-75' : 'gap-10 md:gap-12 scale-90 md:scale-100'}`}>
              <img src="/assets/LOGO UNI INSIDE.png" alt="Uni Inside" className={`object-contain ${isVertical ? 'h-8' : 'h-12 md:h-16'}`} />
              <img src="/assets/LOGO KOLAB.png" alt="Kolab" className={`object-contain ${isVertical ? 'h-8' : 'h-12 md:h-16'}`} />
              <img src="/assets/LOGO UNI SMILE.png" alt="Uni Smile" className={`rounded-xl object-contain ${isVertical ? 'h-8' : 'h-12 md:h-16'}`} />
          </div>
      )}

      {!hideHeader && (
        <div className={`px-6 w-full flex justify-center relative items-center bg-white/10 backdrop-blur-md border-b border-white/10 shrink-0 z-10 ${uiMode === 'air-touch' ? 'py-8' : isVertical ? 'py-3' : 'py-5'}`}>
            {/* Header actions are absolutely positioned so the title stays centered in the viewport. */}
            {onBack && (
                <div className={`absolute left-3 top-1/2 -translate-y-1/2 z-20 ${isVertical ? '' : 'md:left-6'}`}>
                    {/**
                     * Ukuran & gaya TIRTA tombol Back halaman awal (btn-back-landing):
                     * pil ChevronLeft + teks dengan padding yang sama per mode
                     * (px-6 py-4 normal, px-8 py-6 text-2xl air-touch). Sebelumnya
                     * gambar BACK.png dengan tinggi sendiri (h-12/h-24) sehingga
                     * tombol kembali terlihat berbeda antar halaman.
                     */}
                    <button
                        onClick={onBack}
                        className={`flex items-center gap-2 rounded-full backdrop-blur-sm transition-colors bg-white/10 text-white/70 hover:bg-white/20 border-2 border-white/20 font-bold ${uiMode === 'air-touch' ? 'px-8 py-6 text-2xl' : 'px-6 py-4'}`}
                        aria-label="Back"
                    >
                        <ChevronLeft size={uiMode === 'air-touch' ? 40 : 28} /> Back
                    </button>
                </div>
            )}

            {/* This remains in normal flow, independently centered from Back and settings actions. */}
            <div className="max-w-[62vw] text-center pointer-events-none">
                {title && <h2 className={`font-display font-bold tracking-tight leading-none drop-shadow-lg ${uiMode === 'air-touch' ? 'text-4xl' : isVertical ? 'text-xl' : 'text-3xl md:text-4xl'}`}>{title}</h2>}
                {subtitle && <p className={`text-white/90 mt-1 drop-shadow-md ${uiMode === 'air-touch' ? 'text-xl' : isVertical ? 'text-xs' : 'text-base md:text-lg'}`}>{subtitle}</p>}
            </div>

            {/* Absolute positioned right actions */}
            <div className={`absolute right-4 top-1/2 -translate-y-1/2 flex z-20 ${uiMode === 'air-touch' ? 'gap-6' : 'gap-3'}`}>
                {onToggleLock && (
                <button id="btn-toggle-cursor-lock" onClick={onToggleLock} className={`rounded-full transition-colors active:scale-95 border-2 ${uiMode === 'air-touch' ? 'p-6' : 'p-4'} ${isLocked ? 'bg-red-500/80 border-red-400' : 'bg-green-500/20 border-green-400/50 hover:bg-green-500/40'}`} style={{ display: uiMode === 'air-touch' ? 'block' : 'none' }}>
                    {isLocked ? <Lock size={uiMode === 'air-touch' ? 40 : 32} /> : <Unlock size={uiMode === 'air-touch' ? 40 : 32} />}
                </button>
                )}
                {!hideAdmin && onAdminClick && (
                    <button id="btn-admin-settings" onClick={onAdminClick} className={`hover:bg-white/20 rounded-full transition-colors active:scale-95 ${uiMode === 'air-touch' ? 'p-6' : isVertical ? 'p-2' : 'p-4'}`}>
                        <Settings size={uiMode === 'air-touch' ? 40 : isVertical ? 22 : 32}/>
                    </button>
                )}
            </div>
        </div>
      )}
      <div className="flex-1 overflow-hidden relative flex flex-col">
          {children}
      </div>
  </div>
);

// --- Helper: resolve actual layout config from DB frame's _layoutConfig or fallback to preset ---
// DB templates store slot data in _layoutConfig in two formats:
//   1. Array [{x, y, w, h}]           — admin "generate" route (absolute pixels on 1200×1800)
//   2. Object {slots:[{x,y,width,height}], orientation} — admin "upload" route (percentage-based, 0-100)
const getEffectiveLayoutConfig = (style: FrameStyle | null | undefined, layoutId: string | null | undefined) => {
    const fallback = getLayoutConfig(layoutId || '1x1');
    if (layoutId === '1x1') return fallback; // Force override for Instax Mini
    if (!style) return fallback;
    // API contract priority: frameConfig > layout_config > legacy field.
    let raw = (style as any).frameConfig ?? (style as any).frame_config
        ?? (style as any).layout_config ?? (style as any)._layoutConfig;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (_) { raw = null; }
    }
    if (!raw) {
    }
    if (!raw && (Array.isArray((style as any).slots) || (style as any).width || (style as any).height)) {
        // Direct canonical style payload: { width, height, slots, ... }.
        raw = style as any;
    }
    if (raw && !Array.isArray(raw) && typeof raw === 'object' && raw.layout_config) {
        raw = raw.layout_config;
        if (typeof raw === 'string') {
            try { raw = JSON.parse(raw); } catch (_) { raw = null; }
        }
    }
    if (!raw) return fallback;

    // The admin editor owns the canvas size. Do not force its slots into the
    // old local presets: that changes the aspect ratio when the admin resizes
    // a frame. Support both the current fields and a few legacy API shapes.
    const rawCanvas = raw && !Array.isArray(raw) && typeof raw === 'object'
        ? (raw.canvas || raw.frame || raw.layout || raw)
        : {};
    const styleMeta = style as any;
    const targetW = Number(rawCanvas.width ?? rawCanvas.canvasWidth ?? styleMeta.canvasWidth ?? styleMeta.width);
    const targetH = Number(rawCanvas.height ?? rawCanvas.canvasHeight ?? styleMeta.canvasHeight ?? styleMeta.height);
    const width = Number.isFinite(targetW) && targetW > 0 ? targetW : fallback.width;
    const height = Number.isFinite(targetH) && targetH > 0 ? targetH : fallback.height;

    // Case 1: Array of {x, y, w, h} — absolute pixel values from admin layout generator
    if (Array.isArray(raw) && raw.length > 0) {
        const slots = raw
            .map((s: any) => ({
                x: Number(s.x ?? 0),
                y: Number(s.y ?? 0),
                width: Number(s.w ?? s.width ?? 0),
                height: Number(s.h ?? s.height ?? 0),
            }))
            .filter(s => s.width > 0 && s.height > 0);
        if (slots.length > 0) return { width, height, slots };
    }

    // Case 2: Object {slots:[{x, y, width, height}]} — percentage-based (0-100) or pixel slots.
    // The admin editor has historically emitted both width/height and w/h.
    if (raw && typeof raw === 'object' && Array.isArray(raw.slots) && raw.slots.length > 0) {
        const first = raw.slots[0];
        const sourceW = Number(rawCanvas.width) > 0 ? Number(rawCanvas.width) : width;
        const sourceH = Number(rawCanvas.height) > 0 ? Number(rawCanvas.height) : height;
        const firstSlotWidth = Number(first.width ?? first.w);
        const firstSlotHeight = Number(first.height ?? first.h);
        const declaredUnits = String(raw.units ?? raw.slotUnits ?? raw.coordinateType ?? '').toLowerCase();
        // A canonical Admin payload always uses pixel coordinates. Infer
        // percentages only for legacy payloads that have no canvas dimensions
        // and explicitly look like 0..100 coordinates.
        const hasCanvasDimensions = Number(rawCanvas.width) > 0 || Number(rawCanvas.height) > 0;
        const isPct = declaredUnits === 'percent' || declaredUnits === 'percentage' || declaredUnits === '%'
            || (!hasCanvasDimensions && declaredUnits !== 'pixel' && declaredUnits !== 'pixels'
                && Number.isFinite(firstSlotWidth) && Number.isFinite(firstSlotHeight)
                && firstSlotWidth <= 100 && firstSlotHeight <= 100);
        const slots = raw.slots
            .map((s: any) => ({
                x: Math.round((Number(s.x ?? 0) / (isPct ? 100 : sourceW)) * width),
                y: Math.round((Number(s.y ?? 0) / (isPct ? 100 : sourceH)) * height),
                width: Math.round((Number(s.width ?? s.w ?? 0) / (isPct ? 100 : sourceW)) * width),
                height: Math.round((Number(s.height ?? s.h ?? 0) / (isPct ? 100 : sourceH)) * height),
            }))
            .filter((s: any) => s.width > 0 && s.height > 0);
        if (slots.length > 0) return { width, height, slots };
    }

    return fallback;
};

// Slot borders are part of the Admin frame styling, not a thumbnail-only hint.
// Accept the names used by the different Admin/API versions.
const getSlotBorderConfig = (style: FrameStyle | null | undefined) => {
    const raw = (style as any)?._layoutConfig;
    const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const border = config.slotBorder ?? config.slot_border ?? (style as any)?.slotBorder
        ?? (style as any)?.slot_border ?? {};
    const color = border.color ?? config.slotBorderColor ?? config.slot_border_color
        ?? config.borderColor ?? config.border_color ?? config.accentColor ?? config.accent_color
        ?? (style as any)?.slotBorderColor ?? (style as any)?.slot_border_color
        ?? (style as any)?.borderColor ?? (style as any)?._accentColor
        ?? '#ffffff';
    const width = Number(border.width ?? config.slotBorderWidth ?? config.slot_border_width
        ?? config.borderWidth ?? config.border_width ?? (style as any)?.slotBorderWidth
        ?? (style as any)?.slot_border_width ?? (style as any)?.borderWidth ?? 2);
    return { color, width: Number.isFinite(width) && width > 0 ? width : 2 };
};

/** Muat gambar jadi elemen, dengan batas waktu supaya render tidak menggantung. */
const loadImageElement = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';
        const timeoutId = window.setTimeout(() => reject(new Error('Render image load timeout')), RENDER_IMAGE_TIMEOUT_MS);
        img.onload = () => {
            window.clearTimeout(timeoutId);
            resolve(img);
        };
        img.onerror = () => {
            window.clearTimeout(timeoutId);
            reject(new Error('Render image load error'));
        };
        img.src = src;
    });

/**
 * Gambar `img` mengisi dw x dh di posisi dx/dy dengan perilaku "cover": rasio
 * dipertahankan, kelebihan dipotong, tidak digepengkan.
 *
 * Perhitungannya di `services/printImage.ts` supaya bisa DIEKSEKUSI di test —
 * kesalahan rasio di sini hanya terlihat di kertas.
 */
const drawCoverInto = (
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    dx: number, dy: number, dw: number, dh: number,
) => paintCoverInto(ctx as any, img, dw, dh, dx, dy);

/**
 * Gambar yang DICETAK: isi slot frame, tanpa frame-nya.
 *
 * Kenapa terpisah dari `generateCompositeImage`:
 *  - `generateCompositeImage` menghasilkan gambar tampilan lengkap — background,
 *    artwork frame, border slot, dan elemen teks. Itu yang benar untuk pratinjau
 *    dan untuk berkas yang diunduh pengguna.
 *  - Kertas label sudah punya desain tercetak, jadi mengirim gambar lengkap ke
 *    printer membuat frame muncul dua kali.
 *  - Lebih penting lagi: yang boleh tercetak hanya bagian yang MEMANG dibatasi
 *    frame saat pengambilan foto. Mengirim gambar lengkap berarti bagian luar
 *    bingkai slot ikut tercetak — persis keluhan "seluruh bagian foto ter-print".
 *
 * Geometri slot diambil dari konfigurasi layout yang sama dengan pratinjau, jadi
 * area yang tercetak sama persis dengan area yang dibingkai di layar.
 */
const generatePrintImage = async (
    photo: string,
    frame: FrameStyle | null | undefined,
    layoutId: GridLayoutId | null | undefined,
): Promise<string | null> => {
    if (!photo) return null;
    try {
        const config = getEffectiveLayoutConfig(frame, layoutId);
        const slot = firstSlot(config.slots);
        if (!slot) return null;

        const img = await loadImageElement(photo);
        const canvas = document.createElement('canvas');
        canvas.width = slot.width;
        canvas.height = slot.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;

        // Satu tempat saja yang tahu cara menggambar: services/printImage.ts.
        // Di test modul itu, operasi menggambarnya direkam dan diperiksa —
        // sehingga frame yang tidak sengaja ikut tergambar akan ketahuan.
        paintPrintImage(ctx as any, img, slot);

        return canvas.toDataURL('image/png');
    } catch (e) {
        console.warn('Gambar cetak gagal disiapkan, memakai foto mentah:', e);
        return null;
    }
};

// --- Detailed Frame Thumbnail ---
const FrameThumbnail: React.FC<{ style: FrameStyle, layoutId: string }> = ({ style, layoutId }) => {
    const config = getEffectiveLayoutConfig(style, layoutId);
    const slotBorder = getSlotBorderConfig(style);
    let bgStyle: React.CSSProperties = { width: '100%', height: '100%', position: 'absolute', top: 0, left: 0 };
    
    // Simple estimation for thumbnails: assume thumbnail width is around 150px
    const THUMB_WIDTH = 150;
    const scaleFactor = THUMB_WIDTH / config.width;
    
    if (style.backgroundConfig.type === 'solid') {
        bgStyle.backgroundColor = style.backgroundConfig.color;
    } else if (style.backgroundConfig.type === 'gradient') {
        const stops = style.backgroundConfig.gradientStops?.map(s => `${s.color} ${s.offset}%`).join(', ');
        if (style.backgroundConfig.gradientType === 'radial') {
            bgStyle.background = `radial-gradient(circle, ${stops})`;
        } else {
            bgStyle.background = `linear-gradient(${adminAngleToCssAngle(style.backgroundConfig.gradientAngle ?? 90)}deg, ${stops})`;
        }
    } else {
        bgStyle.backgroundColor = '#ffffff';
    }

    const accentColor = (style as any)._accentColor || 'rgba(17,24,39,0.3)';

    return (
        <div className="relative w-full h-full overflow-hidden bg-white shadow-sm" style={{ aspectRatio: `${config.width} / ${config.height}` }}>
            <div style={bgStyle}></div>
            {style.overlayUrl && (
                <img 
                    src={style.overlayUrl} 
                    alt="overlay" 
                    className="absolute inset-0 w-full h-full object-cover z-0 pointer-events-none"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
            )}
            {config.slots.map((slot, i) => (
                <div key={`slot-${i}`} className="absolute transition-colors flex items-center justify-center font-black text-[10px]"
                    style={{
                        left: `${(slot.x / config.width) * 100}%`,
                        top: `${(slot.y / config.height) * 100}%`,
                        width: `${(slot.width / config.width) * 100}%`,
                        height: `${(slot.height / config.height) * 100}%`,
                        // Match the Admin editor: slot areas are visibly
                        // filled, not only a barely visible 9% overlay.
                        // Keep the frame artwork itself untouched; this fill
                        // is only the thumbnail placeholder for empty slots.
                        backgroundColor: 'rgba(156, 163, 175, 0.48)',
                        border: `${Math.max(1, slotBorder.width * 0.75)}px solid ${slotBorder.color || accentColor}`,
                        color: accentColor,
                        zIndex: 1,
                    }}
                >
                    <span className="opacity-70 font-bold">{i + 1}</span>
                </div>
            ))}
            {style.elements.map((el) => {
                const widthVal = el.width && !isNaN(Number(el.width)) && Number(el.width) > 0 ? Number(el.width) : 20;
                
                // Scale text properties
                const fontSize = (el.fontSize || 40) * scaleFactor;
                const strokeWidth = 0.5; // Fixed small stroke for thumbnails

                return (
                    <div key={el.id} style={{
                            position: 'absolute', left: `${el.x}%`, top: `${el.y}%`,
                            transform: `${el.anchor === 'top-left' ? '' : 'translate(-50%, -50%) '}rotate(${el.rotation}deg)`,
                            width: el.type === 'text' ? 'auto' : `${widthVal}%`,
                            height: el.type === 'text' || !el.height ? 'auto' : `${el.height}%`,
                            zIndex: 10, opacity: el.opacity,
                        }}
                    >
                        {el.type === 'text' ? (
                            <span style={{
                                fontFamily: el.fontFamily, 
                                fontSize: `${fontSize}px`, 
                                fontWeight: el.fontWeight, 
                                fontStyle: el.fontStyle, 
                                textDecoration: el.textDecoration,
                                color: el.color, 
                                whiteSpace: 'nowrap',
                                textShadow: el.effect === 'shadow' ? '1px 1px 1px rgba(0,0,0,0.5)' : el.effect === 'neon' ? `0 0 2px ${el.color}, 0 0 4px ${el.color}` : 'none',
                                WebkitTextStroke: el.effect === 'outline' ? `${strokeWidth}px black` : 'none',
                            }}>{el.content}</span>
                        ) : (
                            <img 
                                src={el.content} 
                                alt="asset" 
                                style={{ width: '100%', height: 'auto', display: 'block' }} 
                                loading="lazy"
                                // Important: No crossOrigin here for thumbnails, ensures display even if CORS fails
                                onError={(e) => {
                                    // Fallback to a clear error indicator if asset fails
                                    e.currentTarget.style.display = 'none';
                                }}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
};

export const PhotoBooth: React.FC<PhotoBoothProps> = ({ onAdminClick, idlePaused = false }) => {
  const [step, setStep] = useState<BoothStep>('LANDING');
  const [uiMode, setUiMode] = useState<'normal' | 'air-touch'>('normal');
  const [monitorOrientation, setMonitorOrientation] = useState<'horizontal' | 'vertical'>('horizontal');

  // State
  const [selectedPackage, setSelectedPackage] = useState<'print' | 'digital' | null>(null);
  const [selectedLayoutId, setSelectedLayoutId] = useState<GridLayoutId | null>(null);
  const [capturedPhotos, setCapturedPhotos] = useState<string[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<PhotoFilter | null>(null);

  /**
   * Penyesuaian tampilan foto hasil cetak dari halaman Pengaturan Admin.
   *
   * Sebelumnya nilai-nilai ini ter-hardcode di sini (contrast 1.24 / brightness
   * 1.04 / saturate 0.9) sehingga untuk mengubahnya harus menyentuh kode dan
   * deploy ulang. Sekarang datang dari Admin lewat perantara kiosk-agent.
   *
   * Bawaan netral (100%) supaya kalau agent tidak melaporkan apa pun, foto
   * tetap dicetak apa adanya — bukan diam-diam berubah.
   */
  const [photoAdjust, setPhotoAdjust] = useState({
    brightness: 100,
    contrast: 100,
    saturation: 100,
    fitMode: 'fit' as 'fit' | 'stretch' | 'cover',
    // Algoritma abu-abu dan penajaman dari Admin. Bawaannya = perilaku lama
    // (Rec.601 tanpa penajaman), jadi kiosk yang belum menerima nilai baru
    // mencetak persis seperti sebelumnya.
    grayscale: DEFAULT_GRAYSCALE_ALGORITHM as string,
    sharpen: 0,
  });
  // Kalibrasi termal dari Admin, dipakai jalur cetak Bluetooth langsung.
  const [thermalDensity, setThermalDensity] = useState(3);
  const [thermalOffsetYPx, setThermalOffsetYPx] = useState(0);
  const [thermalOffsetXPx, setThermalOffsetXPx] = useState(0);
  // Margin kosong dari tepi label. Dipakai saat foto harus mulai mencetak
  // setelah sekian piksel — menggeser saja tidak bisa membuat ruang kosong.
  const [printMarginTopPx, setPrintMarginTopPx] = useState(0);
  const [printMarginRightPx, setPrintMarginRightPx] = useState(0);
  const [printMarginLeftPx, setPrintMarginLeftPx] = useState(0);
  const [printMarginBottomPx, setPrintMarginBottomPx] = useState(0);
  const [selectedFrame, setSelectedFrame] = useState<FrameStyle | null>(null);
  const [editTab, setEditTab] = useState<'FRAMES' | 'FILTERS'>('FRAMES');
  
  // Important: processedFrame holds the version where all asset URLs are converted to Base64
  const [processedFrame, setProcessedFrame] = useState<FrameStyle | null>(null);
  const [areAssetsReady, setAreAssetsReady] = useState(false);
  
  // Automatic print state. The ref closes the small gap before React re-renders
  // so a double-click cannot queue two jobs.
  const [printState, setPrintState] = useState<PrintState>('idle');
  const [printJobId, setPrintJobId] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const printActionInFlightRef = useRef(false);
  const printPollTokenRef = useRef(0);
  const printPollTimerRef = useRef<number | null>(null);
  const isPrintActive = ['preparing', 'uploading', 'queued', 'printing'].includes(printState);
  
  const [backgrounds, setBackgrounds] = useState<VirtualBackground[]>([]);
  const [selectedBackground, setSelectedBackground] = useState<VirtualBackground | null>(null);
  const [frames, setFrames] = useState<FrameLayout[]>([]);
  const [filters, setFilters] = useState<PhotoFilter[]>([]);
  /**
   * Tombol layar akhir yang boleh tampil. Dikendalikan dari Admin lewat
   * konfigurasi server; bawaannya SEMUA AKTIF = perilaku yang sudah berjalan.
   *
   * Kode ketiga tombolnya tetap ada apa adanya — hanya dirender bersyarat. Jadi
   * mematikannya tidak menghapus fitur apa pun, dan menyalakannya kembali cukup
   * dari Admin tanpa build ulang.
   */
  const [tombol, setTombol] = useState({ email: true, retake: true, print: true });
  // Pembaca boolean yang tidak tertipu string '0'/'false': Boolean('0') = true,
  // dan itu akan menampilkan tombol yang sudah dimatikan operator.
  const bacaBooleanAtau = (nilai: unknown, bawaan: boolean): boolean => {
    if (nilai === undefined || nilai === null || nilai === '') return bawaan;
    if (typeof nilai === 'boolean') return nilai;
    if (typeof nilai === 'number') return nilai !== 0;
    const t = String(nilai).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'ya'].includes(t)) return true;
    if (['false', '0', 'no', 'off', 'tidak'].includes(t)) return false;
    return bawaan;
  };
  const [kioskPaperSize, setKioskPaperSize] = useState('4R');

  /**
   * Cetak LANGSUNG ke printer label lewat Web Bluetooth — tanpa kiosk-agent.
   *
   * Kenapa ini ada: printer NIIMBOT tidak muncul sebagai printer sistem dan
   * tidak bisa dijangkau agent. Jalur lewat server (queuePrintJob) hanya bekerja
   * kalau agent hidup di PC yang sama dengan printer. Untuk kiosk yang printer-nya
   * tersambung ke browser ini, jalur langsung menghilangkan satu titik gagal.
   *
   * Web Bluetooth hanya boleh membuka pemilih perangkat dari INTERAKSI
   * PENGGUNA LANGSUNG, jadi tombolnya harus diklik. Sambungan juga terikat pada
   * satu tab, bukan pada akun — membuka tab lain berarti menyambung lagi.
   */
  const bluetoothPrinterRef = useRef<NiimbotPrinter | null>(null);
  const [btPrintState, setBtPrintState] = useState<'idle' | 'connecting' | 'printing' | 'done' | 'failed'>('idle');
  const [btPrintError, setBtPrintError] = useState<string | null>(null);
  const [btPrinterName, setBtPrinterName] = useState<string | null>(null);

  const isBluetoothPrintAvailable = useCallback(() => NiimbotPrinter.isSupported(), []);

  /**
   * Inti cetak lewat Web Bluetooth — TANPA menyentuh state UI.
   *
   * Dipisah dari tombolnya supaya cetak OTOMATIS bisa memakai jalur yang sama.
   * Sebelumnya hanya tombol yang bisa mencetak langsung, sedangkan cetak
   * otomatis menitipkan pekerjaan ke server (queuePrintJob) dan menunggu
   * kiosk-agent di PC yang sama menariknya. Di kiosk ini agent memang tidak
   * jalan, jadi cetak otomatis tidak pernah sampai ke printer.
   */
  const printViaBluetoothCore = async (options: { izinkanPasang?: boolean } = {}): Promise<void> => {
      const rawPhoto = capturedPhotos[0] || null;
      const frameForPrint = processedFrame || selectedFrame;
      const image = (rawPhoto ? await generatePrintImage(rawPhoto, frameForPrint, selectedLayoutId) : null)
        || rawPhoto
        || (finalUploadedUrl?.startsWith('http') || finalUploadedUrl?.startsWith('data:') ? finalUploadedUrl : null)
        || await generateCompositeImage();
      if (!image) throw new Error('Foto final belum tersedia.');

      const printer = bluetoothPrinterRef.current || new NiimbotPrinter();
      bluetoothPrinterRef.current = printer;

      if (!printer.isConnected()) {
        // SATU KLIK CETAK = SAMBUNG DAN CETAK.
        //
        // Pemasangan pertama dan sambung-ulang dilayani di tempat yang sama,
        // supaya tidak ada dua tombol untuk satu maksud dan tidak ada langkah
        // perantara yang bisa dilewatkan operator:
        //
        //   izin sudah ada -> sambung tanpa dialog, langsung cetak
        //   izin belum ada -> pemilih terbuka DARI KLIK INI (klik cetak sudah
        //                     gestur pengguna, jadi sah), lalu langsung cetak
        //
        // Izin Web Bluetooth tersimpan PER-ALAMAT dan bertahan sendiri; karena
        // itu pemilih hanya muncul sekali, dan sesudahnya jalur ini tidak lagi
        // membuka dialog apa pun.
        const izin = await printer.pairingState();
        if (izin === 'unsupported') {
          throw new Error('Browser ini tidak mendukung Web Bluetooth. Pakai Chrome atau Edge, dan buka lewat HTTPS.');
        }
        if (izin !== 'ready' && !options.izinkanPasang) {
          // Pemanggil tanpa klik pengguna (cetak otomatis) TIDAK boleh meminta
          // perangkat: tanpa gestur, permintaan itu gagal. Jadi MENOLAK, bukan
          // mencoba lalu gagal — dan pesannya ada di sebelah tombolnya.
          throw new Error(PRINTER_BELUM_DIPASANGKAN);
        }
        const info = await printer.connect(izin === 'ready' ? {} : { forceChooser: true });
        setBtPrinterName(info.deviceName);
        void printer.reportStatus('READY', { printerName: info.deviceName });
      }

      const mm = labelMmFromPaperSize(kioskPaperSize);
      const size = computeLabelSize(mm.widthMm, mm.heightMm);

      // KERTAS BERBINGKAI (mis. Polaroid 54 x 67 mm): kotak cetaknya diambil dari
      // preset label, bukan dibiarkan nol.
      //
      // Kenapa di sini, bukan di halaman Admin: margin kotak cetak tidak punya
      // kolom pengaturan di halaman Pengaturan Printer, jadi backend selalu
      // mengirim 0 — dan margin 0 berarti "pakai SELURUH area cetak". Akibatnya
      // foto menimpa bingkai yang sudah tercetak, dan di kertas terlihat sebagai
      // cetakan yang tidak sesuai walau printernya bekerja benar.
      //
      // Kalau kiosk SUDAH punya margin sendiri (ada yang bukan 0), nilai itu yang
      // menang: kalibrasi di lapangan tidak boleh ditimpa preset.
      const frameBox = labelFrameBox(kioskPaperSize);
      const marginKiosk = [printMarginTopPx, printMarginRightPx, printMarginLeftPx, printMarginBottomPx]
        .some(v => Number(v) > 0);
      const margin = marginKiosk
        ? {
            topPx: Number(printMarginTopPx) || 0,
            rightPx: Number(printMarginRightPx) || 0,
            leftPx: Number(printMarginLeftPx) || 0,
            bottomPx: Number(printMarginBottomPx) || 0,
          }
        : {
            topPx: frameBox?.topPx ?? 0,
            rightPx: frameBox?.rightPx ?? 0,
            leftPx: frameBox?.leftPx ?? 0,
            bottomPx: frameBox?.bottomPx ?? 0,
          };

      const adjustments: PrintAdjustments = {
        ...DEFAULT_ADJUSTMENTS,
        ...photoAdjust,
        // Bingkai yang sudah tercetak menuntut kotaknya TERISI PENUH: mode 'fit'
        // menyisakan jalur putih di dalam bingkai begitu rasio foto berbeda.
        // 'stretch' tetap dihormati karena itu permintaan eksplisit.
        fitMode: !marginKiosk && frameBox && photoAdjust.fitMode === 'fit'
          ? frameBox.fitMode
          : photoAdjust.fitMode,
        // KERTAS LABEL BERGAP: jangan majukan kertas DUA kali.
        //
        // Dengan satu halaman, pageEnd sudah memajukan kertas karena itu halaman
        // terakhir (perilaku B1 di pustakanya). Memanggil printEnd sesudahnya
        // membuat satu perintah cetak mengeluarkan dua frame label. Kertas kosong
        // (tanpa bingkai) tidak punya celah antar-label seperti ini, jadi hanya
        // label preset yang memakai mode berhenti-di-kepala-cetak.
        paperEnd: frameBox ? 'stop-at-printhead' : DEFAULT_ADJUSTMENTS.paperEnd,
        density: Number(thermalDensity) || DEFAULT_ADJUSTMENTS.density,
        offsetYPx: Number(thermalOffsetYPx) || 0,
        offsetXPx: Number(thermalOffsetXPx) || 0,
        marginTopPx: margin.topPx,
        marginRightPx: margin.rightPx,
        marginLeftPx: margin.leftPx,
        marginBottomPx: margin.bottomPx,
        // Ditulis eksplisit, bukan hanya ikut dari spread: kalau nilainya rusak
        // (konfigurasi lama, atau nilai asing dari API), yang dipakai harus
        // perilaku lama — bukan nilai yang membuat grayscaleValue jatuh diam-diam.
        grayscale: isGrayscaleAlgorithm(photoAdjust.grayscale)
          ? photoAdjust.grayscale
          : DEFAULT_GRAYSCALE_ALGORITHM,
        sharpen: Math.max(0, Math.min(100, Number(photoAdjust.sharpen) || 0)),
      };

      await printer.print(image, size, 1, adjustments);
  };

  const handleBluetoothPrint = async () => {
    // SEKALI SAJA (2026-09-30): setelah cetak sukses, tombol terkunci. Retake
    // foto sudah tak mungkin di tahap ini, cetak ulang hanya menghabiskan
    // kertas tanpa foto baru — pengunjung yang kehilangan cetakan cukup
    // diminta ulang oleh petugas tanpa lewat layar ini.
    if (btPrintState === 'done') return;
    if (btPrintState === 'connecting' || btPrintState === 'printing') return;
    if (!NiimbotPrinter.isSupported()) {
      setBtPrintState('failed');
      setBtPrintError('Browser ini tidak mendukung Web Bluetooth. Pakai Chrome atau Edge, dan buka lewat HTTPS.');
      return;
    }

    setBtPrintError(null);
    setBtPrintState('connecting');

    try {
      // `izinkanPasang`: dipanggil dari klik tombol "Cetak Bluetooth", jadi
      // pemilih perangkat boleh terbuka di sini kalau printer belum pernah
      // dipasangkan pada alamat ini. Itu yang membuat satu klik cukup.
      await printViaBluetoothCore({ izinkanPasang: true });
      setBtPrintState('done');
    } catch (error: any) {
      const msg = String(error?.message || error);
      setBtPrintState('failed');
      // Pemilih yang dibatalkan bukan kegagalan printer; menyebutnya error
      // membuat orang mencari masalah di tempat yang salah.
      setBtPrintError(/cancel|user|No device|chooser/i.test(msg)
        ? 'Pemilih perangkat ditutup. Klik lagi untuk menyambungkan printer.'
        : msg);
      void bluetoothPrinterRef.current?.reportStatus('ERROR', { lastError: msg });
    }
  };

  useEffect(() => {
      /**
       * KENAPA HANYA MENIMPA KALAU AGENT BENAR-BENAR MELAPORKAN
       *
       * Bridge menyiarkan keadaan awalnya segera saat layar berlangganan, dan
       * bawaannya BUKAN netral: paperSize '4R', fitMode 'fit', kepekatan 3,
       * geser 0. Kalau itu diterapkan, ia MENIMPA pengaturan dari backend yang
       * mungkin sudah masuk lebih dulu — kertas kembali ke 4R dan cetakan
       * berikutnya memakai ukuran dan margin yang salah.
       *
       * Jadi agent hanya diterapkan kalau nilainya ADA. Bridge menyiarkan
       * `undefined` untuk hal yang tidak dilaporkannya (lihat `currentState`
       * di kioskAgentBridge.ts), dan itulah penanda yang dipakai.
       */
      const unsubscribe = kioskAgentBridge.subscribe((agentState) => {
          const num = (v: unknown): number | null => {
            if (v === undefined || v === null || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
          };

          const b = num(agentState.photoBrightness);
          const c = num(agentState.photoContrast);
          const sat = num(agentState.photoSaturation);
          if (b !== null || c !== null || sat !== null || agentState.photoFitMode !== undefined) {
            setPhotoAdjust(prev => ({
              brightness: b ?? prev.brightness,
              contrast: c ?? prev.contrast,
              saturation: sat ?? prev.saturation,
              // Agent hanya mengenal fit|stretch; 'cover' datang dari backend.
              fitMode: agentState.photoFitMode === 'stretch' ? 'stretch' : prev.fitMode,
            }));
          }
          // Penajaman & algoritma abu-abu dari agent. Dibaca terpisah dari blok
          // di atas: kalau digabung, kiosk yang hanya mengirim salah satu nilai
          // akan membuat nilai lainnya tidak pernah diterapkan.
          // Tombol layar juga bisa datang dari agent. Hanya diterapkan kalau
          // agent MEMANG melaporkannya (undefined = belum tahu), supaya tidak
          // menimpa nilai yang sudah benar dari server dengan "tidak ada".
          if (agentState.showEmailButton !== undefined
            || agentState.showRetakeButton !== undefined
            || agentState.showPrintButton !== undefined) {
            setTombol(prev => ({
              email: bacaBooleanAtau(agentState.showEmailButton, prev.email),
              retake: bacaBooleanAtau(agentState.showRetakeButton, prev.retake),
              print: bacaBooleanAtau(agentState.showPrintButton, prev.print),
            }));
          }
          const tajam = num(agentState.printSharpen);
          if (tajam !== null || agentState.grayscaleAlgorithm !== undefined) {
            setPhotoAdjust(prev => ({
              ...prev,
              sharpen: tajam ?? prev.sharpen,
              // Divalidasi terhadap daftar: nilai asing membuat grayscaleValue
              // jatuh ke bawaan tanpa terlihat, dan hasil cetak berbeda tanpa
              // penjelasan.
              grayscale: isGrayscaleAlgorithm(agentState.grayscaleAlgorithm)
                ? agentState.grayscaleAlgorithm
                : prev.grayscale,
            }));
          }
          if (agentState.paperSize) {
              setKioskPaperSize(agentState.paperSize);
          }
          const dens = num(agentState.thermalDensity);
          if (dens !== null) setThermalDensity(dens);
          const oy = num(agentState.thermalOffsetYPx);
          if (oy !== null) setThermalOffsetYPx(oy);
      });
      return () => unsubscribe();
  }, []);

  /**
   * Ambil pengaturan cetak lewat HTTP juga.
   *
   * Konfigurasi cetak dikirim lewat WebSocket, yang hanya hidup kalau
   * kiosk-agent berjalan — dan tombol "Cetak Bluetooth" justru dipakai ketika
   * agent tidak ada. Tanpa pengambilan ini, ukuran kertas / kepekatan / geser
   * vertikal dari Admin tidak pernah sampai, sehingga pengaturan Admin terlihat
   * tersimpan tanpa efek apa pun.
   *
   * Agent tetap menang kalau ia melaporkan nilai: ia lebih baru.
   */
  useEffect(() => {
    let cancelled = false;
    const apply = async () => {
      const cfg = await fetchPrintingConfig();
      if (cancelled || !cfg) {
        // Tidak ada konfigurasi server SAMA SEKALI: belum pernah berhasil
        // diambil, dan tidak ada salinan untuk dipakai. Keadaan ini harus
        // terlihat, karena label akan keluar tanpa kotak cetak (margin 0) dan
        // penyebabnya bukan di layar kiosk.
        console.warn(
          'Konfigurasi cetak dari server belum pernah terbaca. Cetak memakai '
          + 'bawaan aplikasi — ukuran/margin dari Admin TIDAK berlaku. '
          + 'Periksa kunci API kiosk dan alamat backend.',
        );
        return;
      }
      // Simpan salinan dari server: dipakai hanya kalau pengambilan berikutnya
      // gagal (jaringan belum siap), supaya kiosk tidak pernah kembali ke
      // bawaan yang tidak pernah disetujui siapa pun.
      simpanKonfigurasiServer(cfg as unknown as Record<string, unknown>);
      const n = (v: unknown, fallback: number) => {
        const x = Number(v);
        return Number.isFinite(x) ? x : fallback;
      };
      // Tombol layar: HANYA diubah kalau server mengirim nilainya. Kalau tidak
      // dikirim (baris lama / API versi lama), bawaannya tetap aktif — bukan
      // tiba-tiba hilang.
      setTombol(prev => ({
        email: bacaBooleanAtau(cfg.show_email_button, prev.email),
        retake: bacaBooleanAtau(cfg.show_retake_button, prev.retake),
        print: bacaBooleanAtau(cfg.show_print_button, prev.print),
      }));
      if (cfg.paper_size) setKioskPaperSize(cfg.paper_size);
      if (cfg.thermal_density !== undefined) setThermalDensity(n(cfg.thermal_density, 3));
      if (cfg.thermal_offset_y_px !== undefined) setThermalOffsetYPx(n(cfg.thermal_offset_y_px, 0));
      if (cfg.thermal_offset_x_px !== undefined) setThermalOffsetXPx(n(cfg.thermal_offset_x_px, 0));
      if (cfg.print_margin_top_px !== undefined) setPrintMarginTopPx(n(cfg.print_margin_top_px, 0));
      if (cfg.print_margin_right_px !== undefined) setPrintMarginRightPx(n(cfg.print_margin_right_px, 0));
      if (cfg.print_margin_left_px !== undefined) setPrintMarginLeftPx(n(cfg.print_margin_left_px, 0));
      if (cfg.print_margin_bottom_px !== undefined) setPrintMarginBottomPx(n(cfg.print_margin_bottom_px, 0));
      setPhotoAdjust(prev => ({
        brightness: n(cfg.photo_brightness, prev.brightness),
        contrast: n(cfg.photo_contrast, prev.contrast),
        saturation: n(cfg.photo_saturation, prev.saturation),
        // Algoritma abu-abu dan penajaman. Divalidasi terhadap daftar, bukan
        // diterima apa adanya: nilai asing akan membuat grayscaleValue jatuh
        // ke bawaan tanpa terlihat, dan hasil cetak berbeda tanpa penjelasan.
        grayscale: isGrayscaleAlgorithm(cfg.grayscale_algorithm)
          ? cfg.grayscale_algorithm
          : prev.grayscale,
        sharpen: n(cfg.print_sharpen, prev.sharpen),
        fitMode: cfg.photo_fit_mode === 'cover' || cfg.photo_fit_mode === 'stretch'
          ? cfg.photo_fit_mode
          : 'fit',
      }));
    };
    void apply();
    // DIAMBIL BERKALA, bukan sekali.
    //
    // Dulu ini hanya sekali saat layar siap, dan itu cukup karena bridge agent
    // yang mendorong perubahan berikutnya. Di kiosk ini bridge memang dimatikan
    // (printer dijangkau langsung lewat Web Bluetooth), jadi tanpa pengambilan
    // berkala setiap perubahan di Admin — kepekatan, kalibrasi, margin — baru
    // berlaku setelah halaman dimuat ulang. Admin terlihat tersimpan tanpa efek.
    //
    // Ambang 30 detik: cukup responsif untuk kiosk yang jarang diubah
    // pengaturannya, dan jauh lebih ringan daripada soket yang gagal terus.
    const iv = window.setInterval(() => { void apply(); }, 30_000);
    return () => { cancelled = true; window.clearInterval(iv); };
  }, []);
  
  const [customSubtitle, setCustomSubtitle] = useState('');
  const [customLogoUrl, setCustomLogoUrl] = useState('');

  // Camera & Capture
  const videoRef = useRef<HTMLVideoElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [flash, setFlash] = useState(false);
  const [isAutoCapturing, setIsAutoCapturing] = useState(false);
  const [retakeIndex, setRetakeIndex] = useState<number | null>(null);
  const [reviewPhotoIndex, setReviewPhotoIndex] = useState<number | null>(null);
  const [captureDeadline, setCaptureDeadline] = useState<number | null>(null);
  const [remainingCaptureSeconds, setRemainingCaptureSeconds] = useState(0);
  const [captureExpired, setCaptureExpired] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraRetryCount, setCameraRetryCount] = useState(0);
  
  // Hands / Gesture
  const handsRef = useRef<any>(null);
  const [gestureEnabled, setGestureEnabled] = useState(false);
  const [isCursorLocked, setIsCursorLocked] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [calibrationBox, setCalibrationBox] = useState({ minX: 0.3, maxX: 0.7, minY: 0.25, maxY: 0.75 });
  // This ref is updated EVERY render so the MediaPipe callback always has fresh closures
  const onHandResultsRef = useRef<(results: any) => void>(() => {});

  // Open-hand start-photo hold state (separate from 3s click-hold)
  const openHandCaptureHoldStart = useRef<number | null>(null);
  const OPEN_HAND_START_MS = 1500; // 1.5 s to trigger startAutoCapture
  /** Label pose yang sedang menahan mulai-capture (✋ / ✌️ / 👍) untuk UI. */
  const captureHoldPoseLabel = useRef('');
  /**
   * Jeda persiapan RETAKE (2026-09-30): klik "Retake Foto" dulu LANGSUNG
   * menghitung mundur 3-2-1 — pengunjung belum sempat membentuk pose karena
   * tombolnya ada di dialog konfirmasi, tangannya baru lepas dari layar.
   * Kini hitung mundur baru dimulai setelah jeda ini.
   */
  const retakeReadyTimer = useRef<number | null>(null);
  const RETAKE_READY_DELAY_MS = 2500;

  // Air Gesture Hook
  const { state: gestureState, processLandmarks, processNoHand } = useAirGesture(
    gestureEnabled && !isCursorLocked,
    calibrationBox,
    {
      onHoldClick: (_el) => {},
      onHoldPose: (durationMs, _el) => {
        if (step === 'CAPTURE' && !isAutoCapturing && capturedPhotos.length === 0) {
          if (!openHandCaptureHoldStart.current) {
            openHandCaptureHoldStart.current = Date.now();
            captureHoldPoseLabel.current = gestureState.gesture === 'thumb_up' ? '👍'
              : gestureState.gesture === 'peace' ? '✌️' : '✋';
          } else if (durationMs >= OPEN_HAND_START_MS) {
            if (!isAutoCapturing) {
              openHandCaptureHoldStart.current = null;
              setIsAutoCapturing(true);
            }
          }
        } else {
          openHandCaptureHoldStart.current = null;
        }
      },
    }
  );

  // Reset capture hold ketika pose dilepas (✋ / ✌️ / 👍 sama berlaku)
  useEffect(() => {
    const g = gestureState.gesture;
    if (g !== 'open_hand' && g !== 'peace' && g !== 'thumb_up') {
      openHandCaptureHoldStart.current = null;
    }
  }, [gestureState.gesture]);

  // Convenient destructure
  const cursorPos = gestureState.cursorPos;
  const isPinching = gestureState.isPinching;

  // UI State
  const [isResultPanelCollapsed, setIsResultPanelCollapsed] = useState(false);
  
  const configRef = useRef({ gestureEnabled: false, isCursorLocked: false, countdown: null as number | null, calibrationBox: { minX: 0.3, maxX: 0.7, minY: 0.25, maxY: 0.75 } });
  // ✅ Sync every render (no useEffect delay) so MediaPipe callback always reads fresh values
  configRef.current = { gestureEnabled, isCursorLocked, countdown, calibrationBox };

  const loopStateRef = useRef({ step, isCalibrating, selectedBackground, calibrationBox });
  loopStateRef.current = { step, isCalibrating, selectedBackground, calibrationBox };
  
  const shutterAudioRef = useRef<HTMLAudioElement | null>(null);
  const countdownAudioRef = useRef<HTMLAudioElement | null>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [currentDeviceId, setCurrentDeviceId] = useState<string>('');

  const selfieSegmentationRef = useRef<any>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const isCameraRunning = useRef(false);

  // Result & Upload State
  const [email, setEmail] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isSent, setIsSent] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'preparing' | 'uploading' | 'success' | 'error'>('idle');
  const [sessionCode, setSessionCode] = useState<string>('');
  const [qrisUrl, setQrisUrl] = useState<string | null>(null);
  const [qrisLoading, setQrisLoading] = useState(false);
  const [finalUploadedUrl, setFinalUploadedUrl] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  // Harga dari response start session adalah harga authoritative dari backend.
  const [sessionAmount, setSessionAmount] = useState<number | null>(null);
  const [uniqueCode, setUniqueCode] = useState<number | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<string>('qris_visual_proof');
  const [paymentPollingState, setPaymentPollingState] = useState<'idle' | 'checking' | 'waiting' | 'retrying' | 'expired'>('idle');
  
  // New visual payment verification states
  const [challengeId, setChallengeId] = useState<string>('');
  const [verificationAttemptId, setVerificationAttemptId] = useState<string>('');
  const [verificationStatus, setVerificationStatus] = useState<string>('');
  const [verificationReasonCodes, setVerificationReasonCodes] = useState<string[]>([]);
  const [scanningProgress, setScanningProgress] = useState<number>(0);
  const [scanningHint, setScanningHint] = useState<string>('');
  // Status pemindaian otomatis di layar pembayaran. Tidak ada hitungan waktu:
  // pemindaian berjalan sampai tangkapannya bagus dan buktinya terverifikasi.
  const [scanActive, setScanActive] = useState<boolean>(false);
  // Percobaan ke-berapa, ditampilkan apa adanya supaya pengunjung tahu
  // sistem masih mencoba (bukan mengklaim gambar sudah bagus).
  const [submitRound, setSubmitRound] = useState<number>(0);
  // Keep email sending and the automatic upload on the same promise. Without
  // this, a visitor can submit the email while the backend still has no photo
  // attached to the session.
  const finalPhotoUploadPromiseRef = useRef<Promise<string | null> | null>(null);
  const sessionCompletedRef = useRef(false);
  // Timer pengembalian otomatis ke signage saat photobooth menganggur.
  const idleTimerRef = useRef<number | null>(null);
  // Menyetel true akan menghentikan loop pemindaian yang sedang berjalan
  // (pengunjung menekan Back, reset, atau sesi sudah terverifikasi).
  const scanCancelRef = useRef(false);
  // Preview kamera dibekukan selagi bukti bayar diperiksa backend: frame
  // terakhir tetap tampil, jadi pengunjung boleh menurunkan HP tanpa harus
  // mengangkatnya sampai verifikasi selesai. State untuk UI, ref untuk loop
  // render rAF yang tidak ikut dibuat ulang tiap render.
  const [scanFrozen, setScanFrozen] = useState<boolean>(false);
  const scanFrozenRef = useRef(false);

  /**
   * Satu-satunya jalan keluar ke signage, dipakai tombol Back (halaman pertama),
   * tombol Home (halaman akhir), dan timer idle.
   *
   * Urutan jalur keluar (kembaliKeSignage):
   *   1. window.jagoai.closePhotobooth() — overlay BrowserView kiosk JagoAI.
   *   2. window.kioskEmbed.close() — app desktop UniSmiles: proses utama melepas
   *      kamera dengan rapi lalu menutup aplikasi; jendela kiosk yang disembunyikan
   *      muncul kembali dengan halaman iklannya.
   *   3. POST /api/cms/activity/exit-request ke origin halaman — kiosk memantau
   *      beacon ini dan menutup aplikasi (jalur untuk app desktop yang memuat UI
   *      dari hosting: file:// tidak punya origin, jadi origin dihitung dari URL).
   *   4. navigate ke SIGNAGE_URL — HANYA sisa mode browser biasa, di sana layar
   *      memang milik halaman ini.
   *
   * NAVIGASI WEB SENGJA TERAKHIR. Dulu goToSignage langsung
   * `window.location.href = SIGNAGE_URL` — di app desktop itu memuat halaman
   * signage DI DALAM jendela photobooth: jendela tidak pernah tertutup, TV tidak
   * pernah kembali ke kiosk, dan aplikasi photoboth tetap memegang kamera.
   */
  const goToSignage = useCallback(() => {
    void kembaliKeSignage({
      jagoaiClose: window.jagoai?.closePhotobooth ?? null,
      kioskClose: window.kioskEmbed?.close ?? null,
      postExitRequest: async () => {
        const base = resolveSignageBaseUrl(window.location.href);
        if (!base) return false;
        return postExitRequest(base);
      },
    }).then((hasil) => {
      if (hasil === 'navigate') {
        window.location.href = SIGNAGE_HOME_URL;
      }
    });
  }, []);

  const ensureSessionCompleted = async () => {
    if (!sessionCode) throw new KioskApiError('Sesi belum dibuat.');
    if (sessionCompletedRef.current && downloadUrl) {
      return { success: true as const, downloadUrl };
    }
    const completed = await completeSession(sessionCode);
    sessionCompletedRef.current = true;
    setDownloadUrl(completed.downloadUrl);
    return completed;
  };

  /**
   * Ambil daftar template dari backend.
   *
   * Kegagalan TIDAK mengosongkan daftar. Dulu `setFrames([])` di jalur gagal,
   * dan itu berbahaya: template tidak berubah dari sebelumnya hanya karena satu
   * permintaan tersendat. Akibatnya kiosk menampilkan "Template belum tersedia
   * dari backend utama" padahal endpoint-nya sehat dan datanya ada — dan karena
   * frame yang dihapus tidak pernah diambil kembali, layar tidak pulih sendiri
   * sampai aplikasi dibuka ulang.
   *
   * Sekarang: kalau pengambilan gagal, salinan TERAKHIR YANG BERHASIL dipakai
   * (tersimpan di localStorage). Daftar template hampir tidak pernah berubah,
   * jadi salinan lama jauh lebih benar daripada daftar kosong.
   */
  const refreshFrames = useCallback(async (percobaan = 3) => {
    let terakhirKosong = false;
    for (let i = 0; i < percobaan; i += 1) {
      try {
        const templates = await fetchTemplates();
        const freshFrames = normalizeTemplatePrices(templates);
        if (freshFrames.length > 0) {
          try {
            localStorage.setItem(STORAGE_KEYS.FRAMES, JSON.stringify(freshFrames));
          } catch (e) {
            // Penyimpanan penuh / diblokir: daftar di memori tetap dipakai,
            // hanya salinan untuk keadaan darurat yang tidak tersedia.
            console.warn('[PhotoBooth] Salinan template tidak tersimpan:', e);
          }
          setFrames(freshFrames);
          setTemplateError(null);
          // Kalau pembeli sempat menekan Start sebelum daftar selesai dimuat,
          // pesannya harus hilang sendiri begitu template siap — bukan menetap
          // dan membuat pembeli mengira kiosknya rusak.
          setFlowError((sebelumnya) => (
            sebelumnya && sebelumnya.includes('Template sedang dimuat') ? null : sebelumnya
          ));
          return true;
        }
        // Backend MENJAWAB, tapi daftarnya kosong. Ini keadaan yang berbeda dari
        // gagal jaringan, dan harus punya pesan sendiri — kalau tidak, layarnya
        // diam tanpa penjelasan.
        terakhirKosong = true;
      } catch (error) {
        terakhirKosong = false;
        // Percobaan berikutnya ada di bawah; hanya kegagalan terakhir yang
        // dilaporkan ke layar.
        if (i < percobaan - 1) {
          await new Promise((r) => setTimeout(r, 800 * (i + 1)));
          continue;
        }
        const message = error instanceof KioskApiError
          ? error.message
          : 'Template gagal dimuat dari backend utama.';
        // Salinan terakhir dari server menang atas daftar kosong.
        const salinan = bacaTemplatesTersimpan();
        if (salinan.length > 0) {
          setFrames(salinan);
          setTemplateError(null);
          console.warn('[PhotoBooth] Template dari backend gagal; memakai salinan terakhir:', message);
          return true;
        }
        setTemplateError(message);
        return false;
      }
      if (i < percobaan - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
    if (terakhirKosong) {
      // Salinan lama masih jauh lebih benar daripada tidak bisa mulai sama
      // sekali, jadi dipakai dulu; pesannya tetap muncul supaya terlihat.
      const salinan = bacaTemplatesTersimpan();
      if (salinan.length > 0) setFrames(salinan);
      setTemplateError('Backend menjawab, tetapi daftar template kosong. Periksa template aktif di panel Admin.');
    }
    return false;
  }, []);

  useEffect(() => {
    void refreshFrames();

    const allFilters = getStoredFilters().filter(f => f.enabled);
    setFilters(allFilters);
    setBackgrounds(getStoredBackgrounds());
    
    // Initial QRIS fetch (also re-fetched each time PAYMENT step opens)
    
    const appConfig = getAppConfig();
    setCustomSubtitle(appConfig.customSubtitle || '');
    setCustomLogoUrl(appConfig.customLogoUrl || '');
    
    const mode = appConfig.uiMode || 'normal';
    setUiMode(mode);
    setGestureEnabled(mode === 'air-touch');
    setMonitorOrientation(appConfig.monitorOrientation || 'horizontal');

    shutterAudioRef.current = new Audio(SHUTTER_SOUND_URL);
    shutterAudioRef.current.preload = 'auto';
    countdownAudioRef.current = new Audio(COUNTDOWN_SOUND_URL);
    countdownAudioRef.current.preload = 'auto';

    if ((window as any).SelfieSegmentation) {
      const selfieSegmentation = new (window as any).SelfieSegmentation({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}` });
      selfieSegmentation.setOptions({ modelSelection: 1, selfieMode: true });
      selfieSegmentation.onResults(onSegmentationResults);
      selfieSegmentationRef.current = selfieSegmentation;
    }

    if ((window as any).Hands) {
      const hands = new (window as any).Hands({ locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
      hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
      // ✅ FIX: wrap in a stable closure that calls the always-fresh ref
      // This avoids the stale-closure bug where processLandmarks/processNoHand
      // are captured once at init (when gestureEnabled=false) and never update.
      hands.onResults((results: any) => onHandResultsRef.current(results));
      handsRef.current = hands;
    }
  }, [refreshFrames]);

  const [isMaintenanceActive, setIsMaintenanceActive] = useState(false);
  const [allowedLayouts, setAllowedLayouts] = useState<string[] | undefined>();

  // Use Kiosk Agent Bridge for physical hardware state
  useEffect(() => {
    const unsubscribe = kioskAgentBridge.subscribe((agentState) => {
      setIsMaintenanceActive(agentState.maintenanceMode);
      setAllowedLayouts(agentState.allowedLayouts);
    });
    return () => unsubscribe();
  }, []);

  // Kosongkan photobooth yang ditinggal: setelah 60 detik tanpa sentuhan di
  // layar tunggu, kembali ke signage supaya TV tidak tertinggal di halaman
  // photobooth. Pesan & gesture kamera sengaja tidak dihitung sebagai aktivitas
  // — kalau dihitung, orang yang lewat di depan kamera akan terus menahan timer
  // dan tujuan fitur ini tidak tercapai.
  useEffect(() => {
    if (!shouldArmIdleTimer({ step, isCalibrating, idlePaused })) {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      return;
    }

    const armTimer = () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(goToSignage, IDLE_REDIRECT_MS);
    };

    // pointerdown menangkap mouse dan sentuhan sekaligus; keydown untuk remote
    // atau keyboard yang menempel di kiosk.
    const activityEvents = ['pointerdown', 'keydown', 'wheel'] as const;
    activityEvents.forEach((event) => window.addEventListener(event, armTimer, { passive: true }));
    armTimer();

    return () => {
      activityEvents.forEach((event) => window.removeEventListener(event, armTimer));
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [step, idlePaused, isCalibrating, goToSignage]);

  // Admin updates can happen while the kiosk page stays open. Refresh when
  // the kiosk is idle; never replace frame data during an active photo flow.
  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible' && step === 'LANDING') refreshFrames();
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenVisible);
    const interval = window.setInterval(refreshWhenVisible, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, [refreshFrames, step]);

  // Keep the main preview tied to the currently selected layout and the latest
  // Admin response. Previously a frame from the previous layout could remain
  // selected, so the thumbnails showed one template while the large preview
  // rendered another template's color, slots, and dimensions.
  useEffect(() => {
    if (!selectedLayoutId) return;
    const availableStyles = frames.filter(f => f.id === selectedLayoutId).flatMap(f => f.styles);
    if (availableStyles.length === 0) return;

    const currentStyle = selectedFrame ? availableStyles.find(style => style.id === selectedFrame.id) : null;
    if (!currentStyle || currentStyle !== selectedFrame) {
        setSelectedFrame(currentStyle || availableStyles[0]);
        setProcessedFrame(null);
        setAreAssetsReady(false);
    }
  }, [selectedLayoutId, frames, selectedFrame]);

  // --- OPTIMIZATION: Process Frame Assets to Base64 ---
  useEffect(() => {
    let isMounted = true;
    let safetyTimeout: number | null = null;
    const clearSafetyTimeout = () => {
        if (safetyTimeout !== null) {
            window.clearTimeout(safetyTimeout);
            safetyTimeout = null;
        }
    };

    const processFrameAssets = async () => {
        // Validation checks
        if (!selectedFrame) {
            clearSafetyTimeout();
            if (isMounted) {
                setProcessedFrame(null);
                setAreAssetsReady(true);
            }
            return;
        }
        
        // Only run when entering RESULT step
        if (step !== 'RESULT') {
            clearSafetyTimeout();
            if (isMounted) {
                if (areAssetsReady) setAreAssetsReady(false);
                if (processedFrame) setProcessedFrame(null);
            }
            return;
        }

        // Optimization: Avoid re-processing if ID is identical
        if (processedFrame?.id === selectedFrame.id && areAssetsReady) {
            clearSafetyTimeout();
            return;
        }

        // Check if there are any stickers OR overlayUrl to process
        const hasStickers = selectedFrame.elements && selectedFrame.elements.some((el: FrameElement) => el.type === 'sticker' && el.content.startsWith('http'));
        const hasOverlay = Boolean(selectedFrame.overlayUrl?.startsWith('http'));

        if (!hasStickers && !hasOverlay) {
             clearSafetyTimeout();
             if (isMounted) {
                setProcessedFrame(selectedFrame);
                setAreAssetsReady(true);
                setUploadStatus('idle');
             }
             return;
        }

        if (isMounted) {
            setAreAssetsReady(false);
            setUploadStatus('preparing');
        }

        const newFrame = JSON.parse(JSON.stringify(selectedFrame));
        
        try {
            // Convert all sticker image URLs to Base64 in PARALLEL
            const newElements = await Promise.all(newFrame.elements.map(async (el: FrameElement) => {
                if (el.type === 'sticker' && el.content.startsWith('http')) {
                    try {
                        const base64 = await convertImageToBase64(el.content);
                        return { ...el, content: base64 };
                    } catch (innerErr) {
                        console.error("Failed to convert specific asset, keeping URL:", el.content);
                        return el; // Keep original URL as fallback
                    }
                }
                return el;
            }));

            // The Admin frame image is part of the frame itself (borders,
            // logos, decorations, etc.). Keep it in the processed frame so
            // the kiosk preview and exported image use the same visual layer.
            if (newFrame.overlayUrl?.startsWith('http')) {
                try {
                    newFrame.overlayUrl = await convertImageToBase64(newFrame.overlayUrl);
                } catch (_) {
                    // Keep the original URL as a DOM preview fallback.
                }
            }

            if (isMounted) {
                clearSafetyTimeout();
                newFrame.elements = newElements;
                setProcessedFrame(newFrame);
                // Force ready
                setAreAssetsReady(true);
                setUploadStatus('idle');
            }
            
        } catch (e) {
            console.error("Asset processing failed globally", e);
            // Critical Fail-safe: Allow user to proceed with raw URLs
            if (isMounted) {
                clearSafetyTimeout();
                setProcessedFrame(selectedFrame); // Fallback to raw frame
                setAreAssetsReady(true); 
                setUploadStatus('idle');
            }
        }
    };

    // Safety Timeout: do not leave the result screen blocked by a remote asset.
    safetyTimeout = window.setTimeout(() => {
        if (step === 'RESULT' && isMounted) {
            console.warn("Asset processing timed out. Forcing ready state.");
            setProcessedFrame(current => current || selectedFrame);
            setAreAssetsReady(true);
            setUploadStatus('idle');
        }
    }, ASSET_PROCESSING_TIMEOUT_MS);

    processFrameAssets();

    return () => {
        isMounted = false;
        clearSafetyTimeout();
    };
  }, [selectedFrame, step]); // Removed extra deps to prevent looping



  // ✅ Update ref every render — MediaPipe callback always calls the latest version
  // This fixes stale closure: processLandmarks captured at init had enabled=false
  onHandResultsRef.current = (results: any) => {
      const { gestureEnabled: ge, isCursorLocked: locked, countdown: cd } = configRef.current;

      if (!ge || locked || (cd !== null && cd > 0)) {
          processNoHand();
          return;
      }

      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
          processLandmarks(results.multiHandLandmarks[0]);
      } else {
          processNoHand();
      }
  };

  const adjustSensitivity = (level: number) => {
      const maxMargin = 0.35; const minMargin = 0.1; 
      const margin = minMargin + ((level - 1) / 4) * (maxMargin - minMargin);
      setCalibrationBox({ minX: margin, maxX: 1 - margin, minY: margin * 0.8, maxY: 1 - (margin * 1.2) });
  };

  // ── Air Cursor React Component ─────────────────────────────────────────────
  const AirCursor: React.FC = () => {
    const isVisible = gestureEnabled && cursorPos !== null && !isCursorLocked;
    const { gesture, holdFired, isPinching, isScrolling } = gestureState;

    let gestureClass = '';
    let labelText = '';
    if (gesture === 'pinch') {
      gestureClass = isScrolling ? 'pinch scrolling' : 'pinch';
      labelText    = isScrolling ? '↕ Geser' : '🤏 Klik';
    } else if (gesture === 'open_hand') {
      gestureClass = 'open-hand';
      labelText    = '✋ Arahkan';
    }

    return (
      <div
        id="air-cursor"
        className={`air-cursor ${gestureClass} ${holdFired ? 'hold-fired' : ''}`}
        style={{ 
          left: cursorPos?.x ?? 0, 
          top: cursorPos?.y ?? 0,
          display: isVisible ? 'block' : 'none'
        }}
      >
        <div className="air-cursor__ring" />
        <div className="air-cursor__dot" />
        {labelText && <div className="air-cursor__label">{labelText}</div>}
      </div>
    );
  };

  // Capture-screen open-hand hold progress (0-1 over OPEN_HAND_START_MS)
  // Derived from gestureState which updates every frame via setState in the hook
  const captureHoldProgress = (() => {
    const g = gestureState.gesture;
    const poseTahan = g === 'open_hand' || g === 'peace' || g === 'thumb_up';
    if (step !== 'CAPTURE' || !poseTahan || isAutoCapturing) return 0;
    if (!openHandCaptureHoldStart.current) return 0;
    // gestureState.holdProgress is the 3s hold-click progress (0-1 over 3s)
    // We want 1.5s progress, so scale: progress = elapsed / 1500ms
    // Since gestureState re-renders each frame, Date.now() will be fresh
    return Math.min(1, (Date.now() - openHandCaptureHoldStart.current) / OPEN_HAND_START_MS);
  })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // NOTE: gestureState is in deps through rendering – this IIFE re-runs every render triggered by gestureState changes

  // Improved Stop Camera to be more robust
  const stopCamera = () => {
    isCameraRunning.current = false;
    if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
    }
    if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        stream.getTracks().forEach(track => {
            track.stop();
            // Explicitly remove track to ensure it's detached
            stream.removeTrack(track);
        });
        videoRef.current.srcObject = null;
    }
  };

  // Robust Start Camera with Error Handling and Retry Mechanism
  useEffect(() => {
    let isActive = true;
    const shouldUseCamera = step === 'CAPTURE' || step === 'PAYMENT_SCAN' || isCalibrating || gestureEnabled;

    // Do not ask for camera permission while the visitor is still choosing a
    // package/layout or browsing the result screen UNLESS air gesture is enabled.
    if (!shouldUseCamera) {
      stopCamera();
      setCameraError(null);
      return;
    }
    
    const startCamera = async () => {
      // Clear previous error when starting
      if (isActive) setCameraError(null);

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
            throw new Error('Browser ini tidak mendukung akses kamera. Buka photobooth melalui Chrome/Edge di http://localhost:3000.');
        }
        const constraints: MediaStreamConstraints = {
            video: {
                // Resolusi dinaikkan: pada webcam murah, mode 4:3 sering memberi
                // detail piksel lebih banyak untuk teks kecil dibanding 16:9.
                width: { ideal: 2560, min: 1280 },
                height: { ideal: 1440, min: 720 },
                frameRate: { ideal: 30 }
            }
        };
        
        if (currentDeviceId) {
            (constraints.video as MediaTrackConstraints).deviceId = { exact: currentDeviceId };
        }
        
        // Attempt to get user media
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // If effect cleaned up during await, stop stream immediately
        if (!isActive) {
            stream.getTracks().forEach(t => t.stop());
            return;
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // Kamera TV signage sering masih fokus ke latar saat layar HP
          // diangkat ke depan lensa, sehingga struk terbaca buram. Minta
          // fokus kontinu lewat track supaya lensa terus mengejar objek
          // terdekat. Diabaikan diam-diam kalau kamera tidak mendukung.
          try {
            const track = stream.getVideoTracks()[0];
            const caps: any = track?.getCapabilities?.() || {};
            if (caps.focusMode?.includes('continuous')) {
              await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] });
            }
          } catch (_) { /* kamera tanpa kontrol fokus: tetap lanjut */ }
          videoRef.current.onloadedmetadata = async () => {
              try { 
                  if (!isActive) return;
                  await videoRef.current?.play(); 
                  if (isActive && !isCameraRunning.current) { 
                      isCameraRunning.current = true; 
                      processVideo(); 
                  } 
              } catch (e) { 
                  console.error("Play error", e); 
              }
          };
        }
        
        // Only enumerate devices if we successfully got a stream (permission granted)
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        if (isActive) {
            setDevices(allDevices.filter(d => d.kind === 'videoinput'));
        }

      } catch (err: any) {
        console.error("Camera error:", err);
        if (isActive) {
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                setCameraError("Akses kamera ditolak. Klik ikon kamera di address bar localhost:3000, pilih Allow, lalu tekan Retry.");
            } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
                setCameraError("Kamera tidak ditemukan. Pastikan kamera terpasang dan tidak dinonaktifkan di System Settings.");
            } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
                setCameraError("Kamera sedang dipakai aplikasi lain. Tutup aplikasi tersebut, lalu tekan Retry.");
            } else if (err.name === 'SecurityError' || !window.isSecureContext) {
                setCameraError("Browser memblokir kamera. Jalankan photobooth dari http://localhost:3000, bukan dari file atau alamat backend.");
            } else {
                setCameraError("Kamera gagal dibuka: " + (err.message || "error tidak diketahui") + ". Tekan Retry setelah memeriksa izin browser.");
            }
        }
      }
    };

    startCamera();

    return () => {
      isActive = false;
      stopCamera();
    };
  }, [step, isCalibrating, gestureEnabled, currentDeviceId, cameraRetryCount]);

  const toggleCamera = () => {
    if (devices.length < 2) return;
    const currentIndex = devices.findIndex(d => d.deviceId === (currentDeviceId || devices[0].deviceId));
    setCurrentDeviceId(devices[(currentIndex + 1) % devices.length].deviceId);
  };

  const retryCamera = () => {
      setCameraRetryCount(prev => prev + 1);
  };

  const processVideo = async () => {
    if (!isCameraRunning.current || !videoRef.current) return;
    if (videoRef.current.paused || videoRef.current.ended) { animationFrameRef.current = requestAnimationFrame(processVideo); return; }

    const videoElement = videoRef.current;
    if (handsRef.current && configRef.current.gestureEnabled) await handsRef.current.send({ image: videoElement });

    const { step: currentStep, isCalibrating: currentIsCalibrating, selectedBackground: currentBackground } = loopStateRef.current;
    if (scanFrozenRef.current) {
        // Preview dibekukan (bukti bayar sedang diperiksa): frame terakhir
        // dibiarkan tampil, jangan menggambar ulang sampai pemindaian lanjut.
        animationFrameRef.current = requestAnimationFrame(processVideo);
        return;
    }
    if (currentIsCalibrating || currentStep === 'PAYMENT' || currentStep === 'PAYMENT_SCAN' || currentStep === 'CAPTURE') {
        if (currentBackground && selfieSegmentationRef.current && currentStep !== 'LANDING') {
             try { await selfieSegmentationRef.current.send({ image: videoElement }); } catch (e) { drawVideoDirectly(); }
        } else {
             drawVideoDirectly();
        }
    }
    animationFrameRef.current = requestAnimationFrame(processVideo);
  };

  const drawVideoDirectly = () => {
    const canvas = processingCanvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    const { isCalibrating: currentIsCalibrating, calibrationBox: currentBox } = loopStateRef.current;
    if (currentIsCalibrating) {
        const boxX = currentBox.minX * canvas.width; const boxY = currentBox.minY * canvas.height;
        const boxW = (currentBox.maxX - currentBox.minX) * canvas.width; const boxH = (currentBox.maxY - currentBox.minY) * canvas.height;
        ctx.strokeStyle = '#22c55e'; ctx.lineWidth = 6; ctx.strokeRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = 'rgba(34, 197, 94, 0.2)'; ctx.fillRect(boxX, boxY, boxW, boxH);
    }
    ctx.restore();
  };

  const onSegmentationResults = (results: any) => {
    // Hasil segmentasi yang datang terlambat tidak boleh menimpa frame beku.
    if (scanFrozenRef.current) return;
    const canvas = processingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (canvas.width !== results.image.width) { canvas.width = results.image.width; canvas.height = results.image.height; }
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(results.segmentationMask, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'destination-over';
    
    if (bgImageRef.current) {
         const bg = bgImageRef.current;
         const scale = Math.max(canvas.width / bg.width, canvas.height / bg.height);
         const x = (canvas.width / 2) - (bg.width / 2) * scale;
         const y = (canvas.height / 2) - (bg.height / 2) * scale;
         ctx.drawImage(bg, x, y, bg.width * scale, bg.height * scale);
    } else { ctx.fillStyle = '#00FF00'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.restore();
  };

  const loadBgImage = (url: string) => {
    const img = new Image(); img.crossOrigin = "Anonymous"; img.src = url;
    img.onload = () => { bgImageRef.current = img; };
  };

  // --- Actions ---
  const handleStart = () => {
      if (frames.length === 0) {
        // Bedakan dua sebab yang berbeda, karena tindakan perbaikannya berbeda:
        //   - templateError terisi = backend memang menjawab dengan kegagalan
        //   - belum ada galat     = daftar masih dimuat; pembeli menekan Start
        //     terlalu cepat, dan yang dibutuhkan cuma menunggu sebentar.
        // Dulu keduanya memakai pesan yang sama, sehingga masalah jaringan
        // sesaat terlihat seperti backend tidak punya template sama sekali.
        setFlowError(
          templateError
          || 'Template sedang dimuat dari server. Mohon tunggu sebentar, lalu tekan Start lagi.',
        );
        return;
      }
      // Ensure state is clear when starting fresh
      setSelectedPackage(null);
      setCapturedPhotos([]);
      setCaptureDeadline(null);
      setRemainingCaptureSeconds(0);
      setRetakeIndex(null);
      setReviewPhotoIndex(null);
      setCaptureExpired(false);
      setFinalUploadedUrl(null);
      setDownloadUrl(null);
      setUploadError(null);
      setFlowError(null);
      setTemplateError(null);
      setSessionCode('');
      setProcessedFrame(null);
      setSessionAmount(null);
      setUniqueCode(null);
      setPaymentMethod('qris_visual_proof');
      setPaymentPollingState('idle');
      setVerificationStatus('');
      setVerificationReasonCodes([]);
      setPrintState('idle');
      setPrintJobId(null);
      setPrintError(null);
      printActionInFlightRef.current = false;
      printPollTokenRef.current += 1;
      if (printPollTimerRef.current !== null) window.clearTimeout(printPollTimerRef.current);
      clearPersistedPrintJob();
      finalPhotoUploadPromiseRef.current = null;
      sessionCompletedRef.current = false;
      setStep('PACKAGE');
  };
  const handlePackageSelect = (pkg: 'print' | 'digital') => {
      setSelectedPackage(pkg);
      setStep('LAYOUT');
  };
  const handleLayoutSelect = async (id: GridLayoutId) => { 
    setFlowError(null);
    setPaymentPollingState('checking');
    setSelectedLayoutId(id); 
    const availableStyles = frames.filter(frame => frame.id === id).flatMap(frame => frame.styles);
    // Select the first style of the new layout immediately. Do not leave the
    // previous layout's frame active while payment/capture screens load.
    setSelectedFrame(availableStyles[0] || null);
    setProcessedFrame(null);
    setAreAssetsReady(false);
    setCapturedPhotos([]); 
    setIsAutoCapturing(false); 
    setCaptureDeadline(null);
    setRemainingCaptureSeconds(0);
    setRetakeIndex(null);
    setReviewPhotoIndex(null);
    setCaptureExpired(false);
    
    const kioskId = getAppConfig().kioskId || 'K-001';
    const selectedTemplate = availableStyles[0] as any;
    const templateId = Number(
      selectedTemplate?.template_id
      ?? selectedTemplate?.templateId
      ?? selectedTemplate?.id
    );

    try {
      const sessionData = await startSession(kioskId, templateId);
      setSessionCode(sessionData.id);
      setSessionAmount(sessionData.amount ?? null);
      setUniqueCode(sessionData.unique_code ?? null);
      setPaymentMethod(sessionData.payment_method || 'qris_visual_proof');
      setPaymentPollingState(sessionData.payment_method === 'gopay_merchant_polling' ? 'checking' : 'idle');
      setChallengeId(sessionData.challenge_id || '');
      // Pembayaran bisa dimatikan dari sisi server (payment_profiles.payment_required
      // = false) untuk keperluan uji. Sesi sudah ditandai 'verified' di database,
      // jadi melewati layar ini tidak melewati penjagaan apa pun — upload dan cetak
      // tetap memeriksa status pembayaran seperti biasa.
      if (sessionData.payment_required === false) {
        setVerificationStatus('verified');
        setStep('CAPTURE');
      } else {
        setStep('PAYMENT');
      }
    } catch (error) {
      setPaymentPollingState('idle');
      const message = error instanceof KioskApiError ? error.message : 'Sesi gagal dibuat di backend utama.';
      setFlowError(message);
    }
  };
  const handlePaymentConfirm = () => {
    setFlowError(null);
    setVerificationStatus('');
    setVerificationReasonCodes([]);
    setScanningProgress(0);
    setScanningHint('');
    setStep('PAYMENT_SCAN');
  };

  // Ukur ketajaman satu frame dengan variance Laplacian pada versi kecil gambar.
  // Kamera signage yang belum sempat autofokus menghasilkan frame rata (blur),
  // yang variance-nya rendah. Dipakai untuk membuang frame blur sebelum dikirim.
  const measureSharpness = (source: HTMLCanvasElement): number => {
    const w = 240;
    const h = Math.max(1, Math.round((source.height / source.width) * w));
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    if (!ctx) return 0;
    ctx.drawImage(source, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const lum = new Float32Array(w * h);
    for (let i = 0; i < w * h; i += 1) {
      lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let y = 1; y < h - 1; y += 1) {
      for (let x = 1; x < w - 1; x += 1) {
        const c = y * w + x;
        const lap = 4 * lum[c] - lum[c - 1] - lum[c + 1] - lum[c - w] - lum[c + w];
        sum += lap;
        sumSq += lap * lap;
        count += 1;
      }
    }
    if (!count) return 0;
    const mean = sum / count;
    return Math.max(0, sumSq / count - mean * mean);
  };

  // Ambil frame dari kamera untuk dikirim ke vision service.
  //
  // PENTING: crop buta di sisi kiosk sudah DIHAPUS.
  //
  // Sebelumnya frame dipotong ke tengah (rasio 0.78 + inset 4%), sehingga hanya
  // ~37% area kamera yang dikirim dan ~63% dibuang. Konsekuensinya fatal: posisi
  // HP tidak bisa diprediksi, jadi struk yang terlihat "sudah pas" di bingkai
  // tetap terpotong, dan OCR hanya menerima gambar tanpa teks (di produksi:
  // skor 0,0,0 dengan teks kosong).
  //
  // Menebak posisi dengan rasio apa pun tetap rapuh. Jadi frame dikirim UTUH,
  // diperkecil seperlunya agar unggahan tetap ringan. Pemotongan yang aman
  // dilakukan di vision service: di sana crop berbasis DETEKSI area terang,
  // bukan tebakan posisi, dan gambar asli tetap tersedia sebagai cadangan.

  const captureFrameCandidate = useCallback((): Promise<{ blob: Blob; sharpness: number } | null> => {
    return new Promise((resolve) => {
      const video = videoRef.current;
      if (!video) {
        resolve(null);
        return;
      }
      const sourceWidth = video.videoWidth || 1920;
      const sourceHeight = video.videoHeight || 1080;

      // Perkecil hanya kalau perlu: sisi terpanjang dijaga di sekitar 1400 px
      // supaya teks struk tetap tajam tanpa membuat berkas terlalu besar.
      const longSide = Math.max(sourceWidth, sourceHeight);
      const scale = longSide > 1400 ? 1400 / longSide : 1;
      const outputWidth = Math.max(1, Math.round(sourceWidth * scale));
      const outputHeight = Math.max(1, Math.round(sourceHeight * scale));

      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = outputWidth;
      tempCanvas.height = outputHeight;
      const ctx = tempCanvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        // Kontras dinaikkan supaya angka struk lebih tegas bagi OCR.
        ctx.filter = 'contrast(1.24) brightness(1.04) saturate(0.9)';
        ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
        ctx.filter = 'none';
        const sharpness = measureSharpness(tempCanvas);
        tempCanvas.toBlob(
          (blob) => resolve(blob ? { blob, sharpness } : null),
          'image/jpeg',
          0.96,
        );
      } else {
        resolve(null);
      }
    });
  }, []);

  const formatVerificationReason = (code: string): string => {
    switch (code) {
      case 'IMAGE_BLURRY':
        return 'Layar HP buram atau goyang. Dekatkan HP dan tahan dengan stabil.';
      case 'DETAIL_SCREEN_REQUIRED':
        return 'Tampilkan halaman Detail / Bukti Transaksi Berhasil (bukan riwayat/mutasi).';
      case 'PAYMENT_NOT_SUCCESS':
        return 'Status transaksi pada layar belum berstatus berhasil atau lunas.';
      case 'AMOUNT_MISMATCH':
        return 'Nominal pembayaran pada bukti transfer tidak sesuai tagihan.';
      case 'MERCHANT_MISMATCH':
        return 'Nama penerima / merchant tidak sesuai dengan tujuan QRIS.';
      case 'DUPLICATE_REFERENCE':
        return 'Bukti pembayaran ini sudah pernah digunakan sebelumnya.';
      case 'STALE_RECEIPT':
        return 'Bukti pembayaran sudah kedaluwarsa (lebih dari 1 jam).';
      case 'LOW_CONFIDENCE':
        return 'Teks bukti bayar kurang jelas. Naikkan kecerahan layar HP ke maksimal.';
      case 'INTERNAL_ERROR':
        return 'Layanan analisis bukti bayar sedang sibuk. Silakan coba lagi.';
      default:
        return code;
    }
  };

  const handleResetScan = () => {
    // Hentikan loop yang mungkin masih berjalan, kalau tidak hasilnya akan
    // menimpa layar yang baru direset.
    scanCancelRef.current = true;
    setVerificationStatus('');
    setVerificationReasonCodes([]);
    setFlowError(null);
    setScanningProgress(0);
    setScanningHint('');
    setScanActive(false);
    setSubmitRound(0);
    setScanningProgress(0);
    // Lepaskan bekuan preview supaya kamera kembali hidup di layar lain.
    scanFrozenRef.current = false;
    setScanFrozen(false);
  };

  // Kirim frame bukti bayar ke backend lalu pantau hasil verifikasinya.
  const processVerification = useCallback(async (frames: Blob[]) => {
    setVerificationStatus('processing');
    setScanningHint('Mengirim bukti pembayaran ke vision service...');

    try {
      const data = await submitPaymentEvidence(sessionCode, frames, challengeId);
      const attemptId = data.attempt_id;
      setVerificationAttemptId(attemptId);
      setScanningHint('Menganalisis teks bukti pembayaran...');
      pollVerificationStatus(attemptId);
    } catch (err: any) {
      setVerificationStatus('error');
      setScanningProgress(0);
      setStep('PAYMENT_SCAN');
      setFlowError(err.message || 'Gagal mengirim verifikasi pembayaran.');
    }
  }, [sessionCode, challengeId]);

  /**
   * Kirim satu batch, lalu tunggu penilaiannya.
   *
   * PENTING soal keputusan backend. Backend mengembalikan pasangan status+decision:
   *   verified      -> status 'verified', decision 'verified'
   *   belum terbaca -> status 'failed',   decision 'needs_retry'
   *   ditolak       -> status 'rejected', decision 'rejected'
   *   layanan gagal -> status 'error',    decision 'manual_review'   <-- mudah terlewat
   *
   * Versi sebelumnya hanya mengenali decision 'error', padahal backend menulis
   * 'manual_review'. Keputusan itu jadi tidak dikenali, loop menunggu sampai
   * penjaga waktu habis (20 detik) baru mengulang. Terukur di produksi: tiap
   * percobaan berjarak 24 detik, jadi 4 percobaan memakan ~96 detik tanpa
   * kemajuan — pengunjung melihat "scan lama sekali".
   */
  const submitAndAwaitDecision = useCallback(async (
    frames: Blob[],
    isStale: () => boolean,
  ): Promise<{ verified: boolean; reasonCodes: string[]; error?: string }> => {
    setVerificationStatus('processing');
    setScanActive(false);
    setScanningHint(CHECKING_TEXT);
    // Batch sudah tertangkap: bekukan preview supaya pengunjung boleh
    // menurunkan HP selagi backend memeriksanya. Dibuka lagi oleh pemanggil
    // kalau pemindaian harus berlanjut.
    scanFrozenRef.current = true;
    setScanFrozen(true);

    let attemptId: string;
    try {
      const data = await submitPaymentEvidence(sessionCode, frames, challengeId);
      attemptId = data.attempt_id;
      setVerificationAttemptId(attemptId);
    } catch (err: any) {
      return { verified: false, reasonCodes: [], error: err?.message || 'SUBMIT_FAILED' };
    }

    // Penjaga agar layar tidak menggantung kalau layanan OCR bermasalah. Ini
    // BUKAN batas waktu pengunjung.
    const deadline = Date.now() + SUBMIT_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SUBMIT_POLL_INTERVAL_MS));
      if (isStale()) return { verified: false, reasonCodes: [] };

      try {
        const data = await getPaymentVerificationStatus(sessionCode, attemptId);
        const decision = String(data.decision || '').toLowerCase();
        const status = String(data.status || '').toLowerCase();
        const reasonCodes: string[] = Array.isArray(data.reason_codes) ? data.reason_codes : [];

        // Belum ada keputusan: statusnya masih diproses. Lanjut menunggu.
        if (!isSettledDecision(decision, status)) continue;

        if (decision === 'verified' || status === 'verified') {
          return { verified: true, reasonCodes: [] };
        }

        // Layanan pemeriksaan gagal (status 'error' + decision 'manual_review'):
        // mengulang cepat tidak menolong, jadi hentikan dan jelaskan. Tanpa cabang
        // ini, keputusan manual_review tidak dikenali dan loop menunggu sia-sia.
        if (isServiceFailure(decision, status, reasonCodes)) {
          return { verified: false, reasonCodes: reasonCodes.length ? reasonCodes : ['INTERNAL_ERROR'], error: 'INTERNAL_ERROR' };
        }

        // Bukti ditolak sebagai tidak sah / sudah dipakai: final.
        if (decision === 'rejected') {
          return { verified: false, reasonCodes };
        }

        // needs_retry dan sisanya: pemanggil akan lanjut memindai.
        return { verified: false, reasonCodes };
      } catch (err) {
        console.error('Polling status error:', err);
      }
    }

    return { verified: false, reasonCodes: [], error: 'TIMEOUT' };
  }, [sessionCode, challengeId]);

  const pollVerificationStatus = (attemptId: string) => {
    let attemptsCount = 0;
    const interval = setInterval(async () => {
      attemptsCount++;
      if (attemptsCount > 25) {
        clearInterval(interval);
        setStep('PAYMENT_SCAN');
        setScanningProgress(0);
        setVerificationStatus('needs_retry');
        setFlowError('Pemeriksaan memakan waktu lebih lama dari biasanya. Tekan "Coba Scan Lagi".');
        return;
      }

      try {
        const data = await getPaymentVerificationStatus(sessionCode, attemptId);
        if (data.status === 'verified' || data.decision === 'verified') {
          clearInterval(interval);
          setVerificationStatus('verified');
          setScanningProgress(0);
          setScanningHint('Pembayaran terverifikasi! Memulai sesi foto...');
          setTimeout(() => {
            setStep('CAPTURE');
          }, 1000);
        } else if (data.decision === 'needs_retry') {
          clearInterval(interval);
          setStep('PAYMENT_SCAN');
          setScanningProgress(0);
          setVerificationStatus('needs_retry');
          setVerificationReasonCodes(data.reason_codes || []);
        } else if (data.decision === 'rejected') {
          clearInterval(interval);
          setStep('PAYMENT_SCAN');
          setScanningProgress(0);
          setVerificationStatus('rejected');
          setVerificationReasonCodes(data.reason_codes || []);
        } else if (data.status === 'error') {
          clearInterval(interval);
          setStep('PAYMENT_SCAN');
          setScanningProgress(0);
          setVerificationStatus('needs_retry');
          setVerificationReasonCodes(data.reason_codes || ['INTERNAL_ERROR']);
        }
      } catch (err) {
        console.error('Polling status error:', err);
      }
    }, 1000);
  };

  // Loop pemindaian otomatis.
  //
  // Berbeda dengan versi sebelumnya (hitung mundur 3-2-1 lalu 6 jepretan cepat
  // berurutan), loop ini berjalan TERUS-MENERUS sampai jendela waktu habis.
  // Alasannya: pengunjung perlu waktu mengangkat HP, memperbaiki posisi, dan
  // menahan bukti bayar di depan kamera. Burst 3,5 detik membuat mereka
  // kehilangan kesempatan sebelum sempat mengatur posisi.
  //
  // Selama jendela berjalan, frame diambil berulang kali dan hanya yang terbaik
  // yang disimpan. Pengiriman terjadi lebih awal kalau bukti bayar sudah terbaca
  // jelas beberapa kali, atau saat waktu benar-benar habis.
  const activeScanRunRef = useRef(0);

  const runScanWindow = useCallback(async () => {
    const runId = activeScanRunRef.current + 1;
    activeScanRunRef.current = runId;
    scanCancelRef.current = false;

    setVerificationStatus('');
    setVerificationReasonCodes([]);
    setFlowError(null);
    setScanActive(true);
    // Preview kembali hidup di awal setiap jendela pemindaian (masuk layar
    // atau menekan "Coba Scan Lagi").
    scanFrozenRef.current = false;
    setScanFrozen(false);
    setSubmitRound(0);
    setScanningHint(scanStatusText(0, MAX_SUBMIT_ROUNDS));
    setScanningProgress(0);

    // Kamera mungkin baru menyala; beri kesempatan agar tidak langsung memotret
    // frame hitam, dan pengunjung sempat mengangkat HP.
    await new Promise((r) => setTimeout(r, SCAN_READ_DELAY_MS));

    // Minta fokus ulang tepat saat pengunjung menahan bukti bayar. Fokus
    // kontinu saja tidak cukup: lensa bisa masih terpaku ke latar ruangan.
    try {
      const track = (videoRef.current?.srcObject as MediaStream)?.getVideoTracks?.()[0];
      const caps: any = track?.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as any] });
      }
    } catch (_) { /* kamera tanpa kontrol fokus: tetap lanjut */ }

    const isStale = () => scanCancelRef.current || activeScanRunRef.current !== runId;

    let rounds = 0;
    let lastReasonCodes: string[] = [];
    let kept: { blob: Blob; sharpness: number }[] = [];
    let lastSubmitAt = Date.now();

    // Tidak ada batas waktu. Jalan keluar: terverifikasi, bukti ditolak, layanan
    // bermasalah, jatah kiriman habis, atau pengunjung menekan tombol.
    while (true) {
      if (isStale()) return;

      const shot = await captureFrameCandidate();
      if (isStale()) return;

      if (shot && shot.blob.size > 0) {
        kept = keepBestFrames(kept, shot);
      }

      // Kirim berkala, TIDAK menunggu gambar "kelihatan bagus".
      //
      // Kita tidak punya cara yang bisa dipercaya untuk menilai dari gambar
      // apakah bukti bayar terbaca (dua metrik sebelumnya menipu: ketajaman dan
      // kecerahan). Satu-satunya penilai yang benar adalah OCR di backend, jadi
      // batch dikirim dengan tempo tetap.
      if (!shouldSubmitBatch(kept, Date.now() - lastSubmitAt)) {
        await new Promise((r) => setTimeout(r, SCAN_FRAME_GAP_MS));
        continue;
      }

      // Batas percobaan mati secara default (MAX_SUBMIT_ROUNDS = 0): pengunjung
      // bebas mencoba sampai buktinya terbaca. Tempo kirim + penjaga waktu tunggu
      // sudah cukup menjaga server.
      if (isRoundLimitReached(rounds)) {
        setScanActive(false);
        setVerificationStatus('needs_retry');
        setVerificationReasonCodes(lastReasonCodes);
        setFlowError('Belum berhasil membaca bukti bayar. Tekan "Coba Scan Lagi".');
        return;
      }

      setScanningHint(CHECKING_TEXT);
      const ordered = orderFramesForUpload(kept).map((c) => c.blob);
      const result = await submitAndAwaitDecision(ordered, isStale);
      if (isStale()) return;

      if (result.verified) {
        setVerificationStatus('verified');
        setScanningHint('Pembayaran terverifikasi! Memulai sesi foto...');
        setTimeout(() => {
          if (activeScanRunRef.current === runId) setStep('CAPTURE');
        }, 1000);
        return;
      }

      // Bukti ditolak sebagai tidak sah / sudah dipakai: mengulang tidak menolong
      // karena ini bukan soal posisi kamera.
      if (result.reasonCodes.includes('DUPLICATE_REFERENCE')) {
        setScanActive(false);
        setVerificationStatus('rejected');
        setVerificationReasonCodes(result.reasonCodes);
        setFlowError('Bukti pembayaran ini sudah pernah digunakan.');
        return;
      }

      if (result.error === 'INTERNAL_ERROR') {
        setScanActive(false);
        setVerificationStatus('needs_retry');
        setVerificationReasonCodes(result.reasonCodes);
        // Jelaskan apa adanya: ini bukan soal posisi bukti bayar, jadi jangan
        // menyuruh pengunjung mengatur posisi lagi.
        setFlowError('Layanan pemeriksaan bukti bayar sedang bermasalah di server. Tekan "Coba Scan Lagi" atau hubungi petugas.');
        return;
      }

      // Belum terbaca jelas: buang frame lama supaya tidak mengirim gambar yang
      // sama berulang kali, lalu lanjut memindai. Pengunjung cukup menahan HP.
      rounds += 1;
      lastReasonCodes = result.reasonCodes;
      kept = [];
      lastSubmitAt = Date.now();
      // Butuh frame baru: hidupkan lagi preview agar pengunjung bisa
      // memperbaiki posisi bukti bayar.
      scanFrozenRef.current = false;
      setScanFrozen(false);
      setScanActive(true);
      setSubmitRound(rounds);
      setVerificationStatus('');
      setScanningHint(scanStatusText(rounds, MAX_SUBMIT_ROUNDS));
      await new Promise((r) => setTimeout(r, SCAN_FRAME_GAP_MS));
    }
  }, [captureFrameCandidate, submitAndAwaitDecision]);

  const startScanningSequence = () => {
    if (scanActive) return;
    runScanWindow();
  };

  // Scanner aktif sendiri begitu masuk layar pemindaian: pengunjung tidak perlu
  // menekan tombol. Begitu halaman terbuka, kamera menyala dan jendela waktu
  // mulai berjalan sehingga mereka punya kesempatan mengatur posisi.
  //
  // Dependensi sengaja hanya [step]: kalau runScanWindow ikut masuk, referensinya
  // berubah tiap render dan loop akan restart terus-menerus. State yang dipegang
  // loop sudah berupa ref, jadi versi fungsi yang tertangkap tetap benar.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (step !== 'PAYMENT_SCAN') {
      // Tinggalkan layar pemindaian: hentikan loop agar tidak mengubah state
      // layar lain, dan lepaskan bekuan preview (CAPTURE butuh kamera hidup).
      scanCancelRef.current = true;
      scanFrozenRef.current = false;
      setScanFrozen(false);
      return;
    }
    scanCancelRef.current = false;
    runScanWindow();
  }, [step]);

  // Dev testing shortcut: Only active during local dev, disabled in production
  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const handleDevKey = (e: KeyboardEvent) => {
      if ((e.key === 'p' || e.key === 'P') && ['PAYMENT', 'PAYMENT_SCAN', 'PAYMENT_CHECKING'].includes(step)) {
        console.log('[Dev] Payment bypass shortcut triggered');
        setVerificationStatus('verified');
        setScanningHint('Bypass Developer: Pembayaran Disetujui!');
        setTimeout(() => {
          setStep('CAPTURE');
        }, 400);
      }
    };
    window.addEventListener('keydown', handleDevKey);
    return () => window.removeEventListener('keydown', handleDevKey);
  }, [step]);

  const handleFinish = () => { 
    setStep('RESULT'); 
    setIsResultPanelCollapsed(window.innerWidth < 1280); 
  };


  const startAutoCapture = () => {
    if (captureExpired) return;
    if (!captureDeadline && selectedLayoutId) {
      const slotCount = getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length;
      const durationSeconds = getCaptureDurationSeconds(slotCount);
      setCaptureDeadline(Date.now() + durationSeconds * 1000);
      setRemainingCaptureSeconds(durationSeconds);
    }
    setIsAutoCapturing(true);
  };
  const takePhoto = useCallback(() => {
    if (!processingCanvasRef.current) return;
    if (captureDeadline !== null && Date.now() >= captureDeadline) {
      setCountdown(null);
      setIsAutoCapturing(false);
      setCaptureExpired(true);
      return;
    }
    setFlash(true);
    if (shutterAudioRef.current) { shutterAudioRef.current.currentTime = 0; shutterAudioRef.current.play().catch(e=>{}); }
    setTimeout(() => setFlash(false), 150); 
    const canvas = processingCanvasRef.current;
    const photo = canvas.toDataURL('image/jpeg', 0.95);
    const photoIndex = retakeIndex === null ? capturedPhotos.length : retakeIndex;
    setCapturedPhotos(prev => retakeIndex === null
      ? [...prev, photo]
      : prev.map((existingPhoto, index) => index === retakeIndex ? photo : existingPhoto)
    );
    setCountdown(null);
    setRetakeIndex(null);
    setIsAutoCapturing(false);
    setReviewPhotoIndex(photoIndex);
  }, [captureDeadline, retakeIndex, capturedPhotos.length]);

  // Keep one session clock running while the user is taking or retaking photos.
  useEffect(() => {
    if (step !== 'CAPTURE' || captureDeadline === null) return;
    const updateTimer = () => {
      const seconds = Math.max(0, Math.ceil((captureDeadline - Date.now()) / 1000));
      setRemainingCaptureSeconds(seconds);
      if (seconds === 0) {
        setIsAutoCapturing(false);
        setCountdown(null);
        setCaptureExpired(true);
      }
    };
    updateTimer();
    const timer = window.setInterval(updateTimer, 1000);
    return () => window.clearInterval(timer);
  }, [step, captureDeadline]);

  useEffect(() => {
    if (!isAutoCapturing || step !== 'CAPTURE') return;
    if (reviewPhotoIndex !== null) return;
    const config = getEffectiveLayoutConfig(selectedFrame, selectedLayoutId!);
    if (retakeIndex !== null) {
        // JEDA PERSIAPAN: jangan langsung hitung mundur — beri waktu pengunjung
        // membentuk pose dulu. Timer hanya terpasang sekali per klik Retake;
        // re-render tiap frame (gesture) tidak mengubah deps efek ini, jadi
        // timer selamat sampai 2,5 detik terpenuhi.
        if (retakeReadyTimer.current === null && countdown === null && !flash) {
          retakeReadyTimer.current = window.setTimeout(() => {
            retakeReadyTimer.current = null;
            setCountdown(3);
          }, RETAKE_READY_DELAY_MS);
        }
        return;
    }
    if (capturedPhotos.length >= config.slots.length) {
        setIsAutoCapturing(false); setIsProcessing(true);
        setTimeout(() => { setStep('EDIT'); setIsProcessing(false); }, 1000);
        return;
    }
    if (countdown === null && !flash) setCountdown(3); 
  }, [isAutoCapturing, capturedPhotos.length, step, selectedLayoutId, countdown, flash, retakeIndex, reviewPhotoIndex]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown > 0) {
        if (countdownAudioRef.current) { countdownAudioRef.current.currentTime = 0; countdownAudioRef.current.play().catch(e=>{}); }
        const timer = setTimeout(() => setCountdown(prev => (prev !== null ? prev - 1 : null)), 1000);
        return () => clearTimeout(timer);
    } else if (countdown === 0) takePhoto();
  }, [countdown, takePhoto]);

  const handleRetake = () => {
    setCapturedPhotos([]); 
    setIsAutoCapturing(false); 
    setRetakeIndex(null);
    setReviewPhotoIndex(null);
    if (retakeReadyTimer.current !== null) { clearTimeout(retakeReadyTimer.current); retakeReadyTimer.current = null; }
    setCaptureDeadline(null);
    setRemainingCaptureSeconds(0);
    setCaptureExpired(false);
    setStep('CAPTURE'); 
    setUploadStatus('idle'); 
    setFinalUploadedUrl(null); 
    setDownloadUrl(null);
    setUploadError(null);
    setFlowError(null);
    setPrintState('idle');
    setPrintJobId(null);
    setPrintError(null);
    printActionInFlightRef.current = false;
    printPollTokenRef.current += 1;
    if (printPollTimerRef.current !== null) window.clearTimeout(printPollTimerRef.current);
    clearPersistedPrintJob();
    finalPhotoUploadPromiseRef.current = null;
    sessionCompletedRef.current = false;
    setIsSent(false); 
    setProcessedFrame(null);
    setEmail('');
    setEmailError(null);
    const emailForm = document.getElementById('email-form-container');
    if (emailForm) { emailForm.classList.add('hidden'); emailForm.classList.remove('flex'); }
  };

  const handleRetakePhoto = (index: number) => {
    if (captureExpired) return;
    if (retakeReadyTimer.current !== null) { clearTimeout(retakeReadyTimer.current); retakeReadyTimer.current = null; }
    setRetakeIndex(index);
    setReviewPhotoIndex(null);
    setCaptureExpired(false);
    setStep('CAPTURE');
    setIsAutoCapturing(true);
  };

  const handleContinueAfterReview = () => {
    setReviewPhotoIndex(null);
    const slotCount = selectedLayoutId
      ? getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length
      : 0;

    if (capturedPhotos.length >= slotCount) {
      setIsProcessing(true);
      setTimeout(() => { setStep('EDIT'); setIsProcessing(false); }, 700);
      return;
    }

    setIsAutoCapturing(true);
  };

  const handleHome = () => {
      // Halaman akhir: tombol Home mengembalikan ke layar signage. Ini mengganti
      // soft-reset sebelumnya yang hanya berpindah ke LANDING dan membiarkan
      // signage tidak pernah kembali tampil di TV.
      goToSignage();
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || email.trim() === '') {
      setEmailError('Email tidak boleh kosong');
      return;
    }
    if (!sessionCode) {
      setEmailError('Sesi foto belum siap. Silakan coba lagi.');
      return;
    }
    setIsSending(true);
    setEmailError(null);
    try {
      // Do not call the mail endpoint until every photo is persisted and the
      // backend has returned the session download URL.
      let photoUrl = finalUploadedUrl?.startsWith('http')
        ? finalUploadedUrl
        : await doAutoUpload();

      // A failed attempt is retryable from the same result screen.
      if (!photoUrl) {
        finalPhotoUploadPromiseRef.current = null;
        setFinalUploadedUrl(null);
        photoUrl = await doAutoUpload();
      }

      if (!photoUrl) {
        throw new Error('Foto belum berhasil diupload ke server. Silakan coba lagi.');
      }

      if (!sessionCompletedRef.current) {
        await ensureSessionCompleted();
      }

      const res = await sendPhotoByEmail(sessionCode, email.trim());

      if (res.success) {
        setIsSent(true);
      } else {
        throw new Error(res.message || 'Gagal mengirim email. Silakan periksa koneksi internet kiosk.');
      }
    } catch (err: any) {
      console.error('Email send error:', err);
      setEmailError(err.message || 'Terjadi kesalahan saat mengirim email. Coba lagi.');
    } finally {
      setIsSending(false);
    }
  };

  // --- Final Image Generation (Canvas API — pixel-perfect at output resolution) ---
  const generateCompositeImage = async (): Promise<string | null> => {
    if (!selectedLayoutId || capturedPhotos.length === 0) return null;
    const frameToUse = processedFrame || selectedFrame;
    const config = getEffectiveLayoutConfig(frameToUse, selectedLayoutId);

    // Satu salinan saja di level modul; dipakai juga oleh generatePrintImage.
    const loadImg = loadImageElement;
    const drawCover = drawCoverInto;

    try {
      const canvas = document.createElement('canvas');
      canvas.width  = config.width;
      canvas.height = config.height;
      const ctx = canvas.getContext('2d')!;

      // 1 — Background
      if (frameToUse) {
        const bg = frameToUse.backgroundConfig;
        if (bg.type === 'solid' && bg.color) {
          ctx.fillStyle = bg.color;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else if (bg.type === 'gradient' && bg.gradientStops?.length) {
          let grad: CanvasGradient;
          const cx = canvas.width / 2, cy = canvas.height / 2;
          if (bg.gradientType === 'radial') {
            grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(canvas.width, canvas.height) / 2);
          } else {
            // Export uses the Admin/canvas angle directly. The DOM preview
            // converts this same value only because CSS uses another axis.
            const a = ((bg.gradientAngle ?? 90) * Math.PI) / 180;
            const len = Math.sqrt(canvas.width ** 2 + canvas.height ** 2) / 2;
            grad = ctx.createLinearGradient(
              cx - Math.cos(a)*len, cy - Math.sin(a)*len,
              cx + Math.cos(a)*len, cy + Math.sin(a)*len
            );
          }
          bg.gradientStops.forEach(s => grad.addColorStop(s.offset / 100, s.color));
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
      } else {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }

      // 2 — Admin frame artwork is the BACK layer. Frame uploads may contain
      // the complete canvas artwork, so they must be drawn before photos;
      // otherwise an opaque PNG would hide every captured photo.
      if (frameToUse?.overlayUrl) {
        try {
          const overlay = await loadImg(frameToUse.overlayUrl);
          ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
        } catch (e) {
          console.warn('Admin frame artwork could not be rendered:', e);
        }
      }

      // 3 — Photos, positioned using the Admin slot coordinates.
      for (let i = 0; i < config.slots.length; i++) {
        const slot = config.slots[i];
        const photo = capturedPhotos[i];
        if (!photo) continue;
        try {
          const img = await loadImg(photo);
          ctx.save();
          // Dua hal berbeda digabung di sini, dan keduanya harus berlaku:
          //   1. Filter gaya pilihan pengguna (mis. "Vintage").
          //   2. Penyesuaian tampilan dari halaman Pengaturan Admin.
          // Dijumlahkan sebagai string `filter` CSS karena canvas hanya
          // menerima satu nilai — menimpa salah satunya akan menghilangkan
          // efek yang lain tanpa peringatan.
          const adminAdjust = `brightness(${photoAdjust.brightness}%) contrast(${photoAdjust.contrast}%) saturate(${photoAdjust.saturation}%)`;
          const userFilter = selectedFilter?.cssFilter && selectedFilter.cssFilter !== 'none'
            ? selectedFilter.cssFilter
            : '';
          ctx.filter = [userFilter, adminAdjust].filter(Boolean).join(' ');
          ctx.beginPath();
          ctx.rect(slot.x, slot.y, slot.width, slot.height);
          ctx.clip();
          drawCover(ctx, img, slot.x, slot.y, slot.width, slot.height);
          ctx.restore();
        } catch (e) { console.warn(`Slot ${i} draw failed`, e); }
      }

      // Slot borders belong to the Admin frame and must remain visible above
      // captured photos in both the preview and the exported image.
      const slotBorder = getSlotBorderConfig(frameToUse);
      ctx.save();
      ctx.strokeStyle = slotBorder.color;
      ctx.lineWidth = slotBorder.width;
      for (const slot of config.slots) {
        ctx.strokeRect(
          slot.x + slotBorder.width / 2,
          slot.y + slotBorder.width / 2,
          Math.max(0, slot.width - slotBorder.width),
          Math.max(0, slot.height - slotBorder.width)
        );
      }
      ctx.restore();

      // 4 — Frame elements such as Hello/text/stickers remain above photos.
      for (const el of (frameToUse?.elements ?? [])) {
        ctx.save();
        ctx.globalAlpha = el.opacity ?? 1;
        ctx.translate((el.x / 100) * canvas.width, (el.y / 100) * canvas.height);
        ctx.rotate(((el.rotation ?? 0) * Math.PI) / 180);
        if (el.type === 'text') {
          const fs = el.fontSize ?? 40;
          ctx.font = `${el.fontStyle ?? 'normal'} ${el.fontWeight ?? 'normal'} ${fs}px ${el.fontFamily ?? 'sans-serif'}`;
          ctx.fillStyle = el.color ?? '#000';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (el.effect === 'shadow') { ctx.shadowColor='rgba(0,0,0,.5)'; ctx.shadowBlur=6; ctx.shadowOffsetX=2; ctx.shadowOffsetY=2; }
          else if (el.effect === 'neon') { ctx.shadowColor=el.color??'#fff'; ctx.shadowBlur=20; }
          if (el.effect === 'outline') { ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.strokeText(el.content,0,0); }
          ctx.fillText(el.content, 0, 0);
        } else if (el.type === 'sticker') {
          try {
            const img = await loadImg(el.content);
            const w = ((el.width ?? 10) / 100) * canvas.width;
            // Preserve the Admin asset box. Older elements have no height;
            // for those, derive height from the image's natural aspect ratio.
            const h = el.height && el.height > 0
              ? (el.height / 100) * canvas.height
              : w * (img.naturalHeight / Math.max(1, img.naturalWidth));
            const offsetX = el.anchor === 'top-left' ? 0 : -w / 2;
            const offsetY = el.anchor === 'top-left' ? 0 : -h / 2;
            ctx.drawImage(img, offsetX, offsetY, w, h);
          } catch { /* skip */ }
        }
        ctx.restore();
      }

      return canvas.toDataURL('image/png');
    } catch (err) {
      console.error('Canvas image generation failed', err);
      return null;
    }
  };

  const doAutoUpload = async (): Promise<string | null> => {
      if (finalPhotoUploadPromiseRef.current) {
          return finalPhotoUploadPromiseRef.current;
      }

      const uploadPromise = (async (): Promise<string | null> => {
        try {
          if (!sessionCode) throw new KioskApiError('Sesi belum dibuat di backend.');
          if (capturedPhotos.length === 0) throw new KioskApiError('Tidak ada foto untuk diupload.');

          setUploadStatus('uploading');
          setUploadError(null);
          setFinalUploadedUrl(null);
          setDownloadUrl(null);

          // Raw photos must be stored before the final strip/frame.
          for (let i = 0; i < capturedPhotos.length; i += 1) {
              const rawResponse = await fetch(capturedPhotos[i]);
              const rawBlob = await rawResponse.blob();
              await uploadPhoto(rawBlob, sessionCode, `${sessionCode}_single_${i + 1}.png`);
          }

          const dataUrl = await generateCompositeImage();
          if (!dataUrl) throw new KioskApiError('Frame final gagal dibuat.');
          const finalResponse = await fetch(dataUrl);
          const finalBlob = await finalResponse.blob();
          const serverUrl = await uploadPhoto(finalBlob, sessionCode, `${sessionCode}_frame.png`);
          setFinalUploadedUrl(serverUrl);

          const completed = await ensureSessionCompleted();
          setDownloadUrl(completed.downloadUrl);
          setUploadStatus('success');
          return serverUrl;

        } catch (error) {
          console.error('doAutoUpload Error:', error);
          setUploadError(error instanceof KioskApiError ? error.message : 'Upload foto ke backend gagal.');
          setUploadStatus('error');
          return null;
        }
      })();

      finalPhotoUploadPromiseRef.current = uploadPromise;
      return uploadPromise;
  };

  useEffect(() => {
      if (step === 'RESULT' && areAssetsReady && !finalUploadedUrl && uploadStatus === 'idle') {
          doAutoUpload();
      }
  }, [step, areAssetsReady, finalUploadedUrl, uploadStatus]);

  // Re-fetch QRIS image every time user enters PAYMENT step
  useEffect(() => {
    if (step === 'PAYMENT') {
      setQrisUrl(null);
      setQrisLoading(true);
      fetchPaymentProfile()
        .then(url => { if (url) setQrisUrl(url); })
        .catch(error => {
          setFlowError(error instanceof KioskApiError ? error.message : 'QRIS gagal dimuat dari backend utama.');
        })
        .finally(() => setQrisLoading(false));
    }
  }, [step]);

  useEffect(() => {
    if (step !== 'PAYMENT' || paymentMethod !== 'gopay_merchant_polling' || !sessionCode) return;

    let cancelled = false;
    let timer: number | null = null;
    setPaymentPollingState('checking');
    const poll = async () => {
      try {
        const payment = await getSessionPaymentStatus(sessionCode);
        if (cancelled) return;
        if (payment.payment_status === 'verified') {
          setPaymentPollingState('idle');
          setFlowError(null);
          setVerificationStatus('verified');
          setStep('CAPTURE');
          return;
        }
        if (payment.payment_status === 'expired' || payment.payment_status === 'rejected') {
          setPaymentPollingState('expired');
          setFlowError(null);
          return;
        }
        setPaymentPollingState('waiting');
        setFlowError(null);
      } catch (_) {
        // Tetap mencoba lagi saat jaringan sementara terganggu; backend melakukan polling provider.
        if (!cancelled) setPaymentPollingState('retrying');
      }
      if (!cancelled) timer = window.setTimeout(poll, 4000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [step, paymentMethod, sessionCode]);

  const selectedLayout = frames.find(frame => frame.id === selectedLayoutId);
  const selectedFramePrice = positiveNumber(
    selectedFrame?.price,
    (selectedFrame as any)?._price,
    (selectedFrame as any)?._layoutConfig?.price,
    (selectedFrame as any)?._layoutConfig?.layout_price
  );
  const selectedLayoutPrice = positiveNumber(selectedLayout?.price);
  const payableAmount = sessionAmount ?? selectedFramePrice ?? selectedLayoutPrice;

  // Tombol Download dihapus (2026-09-30): pengunjung mengambil foto lewat QR;
  // tombol unduh lokal malah menambah langkah dan rawan salah tap di kiosk.

  const finishPrintAsFailed = (error: unknown): void => {
      printActionInFlightRef.current = false;
      clearPersistedPrintJob();
      setPrintState('failed');
      setPrintError(getPrintErrorMessage(error));
      // Keep session lifecycle independent from printer availability.
      void ensureSessionCompleted();
  };

  const startPrintPolling = useCallback((jobId: string) => {
      const token = ++printPollTokenRef.current;
      if (printPollTimerRef.current !== null) window.clearTimeout(printPollTimerRef.current);

      const poll = async () => {
          const startedAt = Date.now();
          while (printPollTokenRef.current === token && Date.now() - startedAt <= PRINT_POLL_TIMEOUT_MS) {
              try {
                  const job = await getPrintJobStatus(jobId);
                  if (printPollTokenRef.current !== token) return;

                  setPrintJobId(job.job_id);
                  setPrintState(job.status);
                  if (job.status === 'success') {
                      printActionInFlightRef.current = false;
                      clearPersistedPrintJob();
                      setPrintError(null);
                      return;
                  }
                  if (job.status === 'failed') {
                      finishPrintAsFailed(new Error('Printer menolak print job.'));
                      return;
                  }
              } catch (error) {
                  if (printPollTokenRef.current !== token) return;
                  finishPrintAsFailed(error);
                  return;
              }

              await new Promise<void>(resolve => {
                  printPollTimerRef.current = window.setTimeout(resolve, 1000);
              });
          }

          if (printPollTokenRef.current === token) {
              finishPrintAsFailed(new Error('Print timeout.'));
          }
      };

      void poll();
  }, []);

  const handleManualPrint = async () => {
      if (!areAssetsReady) {
          alert('Tunggu sampai hasil foto selesai diproses.');
          return;
      }

      try {
          // Manual fallback remains an explicit user action and uses the same
          // final composited image as automatic printing.
          const imageUrl = finalUploadedUrl || await generateCompositeImage();
          if (!imageUrl) throw new Error('Foto final belum tersedia.');

          const printConfig = getEffectiveLayoutConfig(processedFrame || selectedFrame, selectedLayoutId);
          const printHeight = 6;
          const printWidth = printHeight * (printConfig.width / printConfig.height);
          const win = window.open('', '_blank');
          if (!win) throw new Error('Jendela print diblokir browser.');
          win.document.title = 'UniSmile Photo Print';
          const style = win.document.createElement('style');
          style.textContent = `@page { size: ${printWidth}in ${printHeight}in; margin: 0; } * { margin: 0; padding: 0; box-sizing: border-box; } body { width: ${printWidth}in; height: ${printHeight}in; display: flex; align-items: center; justify-content: center; background: #fff; } img { width: ${printWidth}in; height: ${printHeight}in; object-fit: contain; display: block; }`;
          win.document.head.appendChild(style);
          const image = win.document.createElement('img');
          image.src = imageUrl;
          image.onload = () => { win.focus(); win.print(); };
          win.document.body.appendChild(image);
      } catch (error) {
          setPrintError('Print manual tidak dapat dibuka. Izinkan popup lalu coba lagi.');
          setPrintState('failed');
      }
  };

  const handleAutoPrint = async () => {
      if (printActionInFlightRef.current || isPrintActive || printState === 'success') return;
      if (!areAssetsReady || !sessionCode) {
          setPrintError(!sessionCode ? 'Sesi foto belum tersedia.' : 'Tunggu sampai hasil foto selesai diproses.');
          setPrintState('failed');
          return;
      }

      printActionInFlightRef.current = true;
      setPrintError(null);
      setPrintState('preparing');

      try {
          // Recover an already-created job after a refresh/re-render rather
          // than creating a second physical print.
          const existingJob = getPersistedPrintJob();
          if (existingJob && existingJob.sessionCode === sessionCode) {
              setPrintJobId(existingJob.jobId);
              setPrintState(existingJob.status);
              startPrintPolling(existingJob.jobId);
              return;
          }

          let imageUrl = finalUploadedUrl?.startsWith('http') ? finalUploadedUrl : null;
          if (!imageUrl) {
              // A previous upload failure is retryable. Do not reuse the
              // already-resolved rejected/null promise on the next click.
              if (uploadStatus === 'error') {
                  finalPhotoUploadPromiseRef.current = null;
                  setUploadStatus('idle');
              }
              setPrintState('uploading');
              imageUrl = await doAutoUpload();
          }
          if (!imageUrl || !/^https?:\/\//i.test(imageUrl)) {
              throw new Error('Image final belum tersedia di server.');
          }

          const printConfig = getEffectiveLayoutConfig(processedFrame || selectedFrame, selectedLayoutId);
          const idempotencyKey = makeIdempotencyKey();

          // Ukuran kertas mengikuti pengaturan Admin. Kalau Admin belum mengatur
          // (masih nilai bawaan), pakai pemetaan per layout supaya tidak selalu
          // meminta 4R untuk semua layout.
          const adminPaperSize = String(kioskPaperSize || '').trim();
          const paperSize = adminPaperSize && adminPaperSize.toUpperCase() !== '4X6'
              ? adminPaperSize
              : getPaperSizeForLayout(selectedLayoutId);

          // CETAK LANGSUNG DULU, bukan lewat server.
          //
          // Printer label NIIMBOT tersambung lewat Web Bluetooth di browser ini
          // dan TIDAK muncul sebagai printer sistem, jadi kiosk-agent tidak bisa
          // menjangkaunya. Kerja samanya: pekerjaan dititipkan ke server
          // (queuePrintJob) dan ditunggu agent menariknya — kalau agent tidak
          // jalan, cetak otomatis tidak pernah sampai ke printer. Jadi jalur
          // langsung dipakai lebih dulu, dan pekerjaan server tetap dicatat
          // sesudahnya supaya pelaporan serta riwayat tetap utuh.
          if (NiimbotPrinter.isSupported()) {
              try {
                  setPrintState('printing');
                  // TANPA izinkanPasang, dan itu disengaja.
                  //
                  // Jalur ini menunggu unggahan dulu sebelum mencetak, sehingga
                  // gestur klik operator bisa sudah kedaluwarsa saat mencapai
                  // titik ini — dan Web Bluetooth menolak pemilih di luar gestur
                  // yang masih berlaku. Jadi kalau izin belum ada, jalur ini
                  // berhenti dan jatuh ke jalur server seperti sebelumnya; untuk
                  // memasangkan sekali, operator memakai tombol "Cetak
                  // Bluetooth" yang gesturnya langsung.
                  await printViaBluetoothCore();
                  setPrintState('success');
                  // Pencatatan ke server bersifat pelaporan; kegagalannya tidak
                  // boleh mengubah hasil cetak yang sudah terjadi.
                  void recordPrintJob(imageUrl, paperSize, printConfig);
                  return;
              } catch (btError) {
                  // Jatuh ke jalur server HANYA kalau jalur langsung gagal —
                  // mis. belum ada perangkat terpasang dan pemilihnya dibatalkan.
                  console.warn('[PhotoBooth] Cetak langsung gagal, mencoba jalur server.',
                      btError instanceof Error ? btError.message : 'error');
              }
          }

          const job = await queuePrintJob(sessionCode, {
              image_url: imageUrl,
              copies: 1,
              paper_size: paperSize,
              orientation: printConfig.width > printConfig.height ? 'landscape' : 'portrait',
              idempotency_key: idempotencyKey
          });

          setPrintJobId(job.job_id);
          setPrintState(job.status);
          persistPrintJob({
              sessionCode,
              jobId: job.job_id,
              imageUrl,
              idempotencyKey,
              status: job.status === 'printing' ? 'printing' : 'queued',
              createdAt: Date.now()
          });
          startPrintPolling(job.job_id);
      } catch (error) {
          console.error('[PhotoBooth] Automatic print request failed:', error instanceof KioskApiError ? error.message : 'request error');
          finishPrintAsFailed(error);
      }
  };

  /**
   * Sambung ke printer sekali saat layar siap, TANPA dialog.
   *
   * Tujuannya supaya cetak pertama tidak perlu menunggu sambungan, dan supaya
   * sambungan yang terputus (printer tidur, kiosk baru dinyalakan) sudah
   * pulih sebelum pelanggan menekan cetak. Aman dipanggil otomatis:
   * `preconnectSilently()` berhenti lebih dulu kalau izin untuk alamat ini
   * belum ada, jadi pemilih perangkat tidak pernah terbuka dari sini.
   *
   * Sengaja TIDAK mengganggu apa pun kalau gagal: printer yang mati saat kiosk
   * hidup bukan alasan menghalangi pengambilan foto.
   */
  useEffect(() => {
      void (async () => {
          const printer = bluetoothPrinterRef.current || new NiimbotPrinter();
          bluetoothPrinterRef.current = printer;
          const nama = await printer.preconnectSilently();
          if (nama) setBtPrinterName(nama);
      })();
  }, []);

  /**
   * Catat pekerjaan cetak ke server sebagai RIWAYAT saja.
   *
   * Dipakai setelah cetak langsung berhasil. Server tidak mencetak apa pun di
   * sini — printer label tidak terjangkau agent — jadi kegagalan pencatatan
   * hanya dicatat di konsol. Label yang sudah keluar tidak boleh dianggap gagal
   * hanya karena riwayatnya tidak tersimpan.
   */
  const recordPrintJob = async (
      imageUrl: string,
      paperSize: string,
      printConfig: { width: number; height: number },
  ): Promise<void> => {
      try {
          const job = await queuePrintJob(sessionCode, {
              image_url: imageUrl,
              copies: 1,
              paper_size: paperSize,
              orientation: printConfig.width > printConfig.height ? 'landscape' : 'portrait',
              idempotency_key: makeIdempotencyKey(),
          });
          setPrintJobId(job.job_id);
          persistPrintJob({
              sessionCode,
              jobId: job.job_id,
              imageUrl,
              idempotencyKey: makeIdempotencyKey(),
              // 'printing' adalah nilai terdekat yang diterima penyimpanan;
              // state UI-nya sendiri sudah diset 'success' di pemanggil.
              status: 'printing',
              createdAt: Date.now(),
          });
      } catch (error) {
          console.warn('[PhotoBooth] Riwayat cetak tidak tersimpan:',
              error instanceof KioskApiError ? error.message : 'request error');
      }
  };

  const handlePrint = () => {
      if (isAutoPrintEnabled()) {
          void handleAutoPrint();
      } else {
          void handleManualPrint();
      }
  };

  useEffect(() => () => {
      printPollTokenRef.current += 1;
      if (printPollTimerRef.current !== null) window.clearTimeout(printPollTimerRef.current);
  }, []);

  useEffect(() => {
      const saved = getPersistedPrintJob();
      if (!saved || Date.now() - saved.createdAt > 24 * 60 * 60 * 1000) {
          if (saved) clearPersistedPrintJob();
          return;
      }

      // Restore only the trackable print record. No API key or credential is
      // persisted here; the existing kiosk auth path is used by polling.
      setSessionCode(saved.sessionCode);
      setFinalUploadedUrl(saved.imageUrl);
      setPrintJobId(saved.jobId);
      setPrintState(saved.status);
      setSelectedPackage('print');
      setStep('RESULT');
      printActionInFlightRef.current = true;
      startPrintPolling(saved.jobId);
  }, [startPrintPolling]);

  // --- Rendering Helpers ---
  const PreviewComponent = ({ shadow = true, maxHeightStr = '65vh', id }: { shadow?: boolean, maxHeightStr?: string, id?: string }) => {
    // The Customize screen must show the Admin slot placeholders before any
    // photo is captured. Only the layout selection is required to render the
    // frame preview; an empty photo array is a valid initial state.
    if (!selectedLayoutId) {
        if (finalUploadedUrl?.startsWith('http')) {
            return (
                <div className="flex items-center justify-center h-full w-full bg-white rounded-xl p-4">
                    <img src={finalUploadedUrl} alt="Final photo" className="max-h-full max-w-full object-contain" />
                </div>
            );
        }
        return (
            <div className="flex flex-col items-center justify-center h-full w-full bg-white/5 rounded-xl p-12 text-center text-white">
                <AlertCircle size={48} className="text-red-400 mb-4" />
                <p className="text-xl font-bold">No Photos Found!</p>
                <p className="text-white/60 text-sm mt-2">If you refreshed the page, please go back and take photos again.</p>
            </div>
        );
    }
    const frameToRenderForConfig = processedFrame || selectedFrame;
    const config = getEffectiveLayoutConfig(frameToRenderForConfig, selectedLayoutId);
    const ratio = config.width / config.height;
    
    // IMPORTANT: If we are in RESULT step, we MUST use processedFrame. 
    // If it's not ready, show loader to block the view from html2canvas
    if (step === 'RESULT' && (!processedFrame || !areAssetsReady)) {
        return (
            <div className="flex flex-col items-center justify-center h-full w-full bg-gray-100 rounded-xl p-12 text-center animate-fade-in">
                <Loader2 size={48} className="animate-spin text-indigo-600 mb-4" />
                <p className="text-gray-800 font-bold text-lg">Preparing High-Res Result...</p>
                <p className="text-sm text-gray-500 mb-4">Converting assets to secure format</p>
                
                {/* Fallback Button for Hanging States */}
                <button 
                  onClick={() => {
                    setProcessedFrame(current => current || selectedFrame);
                    setAreAssetsReady(true);
                    setUploadStatus('idle');
                  }}
                  className="mt-4 flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 rounded-full text-xs font-bold text-gray-600 hover:bg-gray-50 shadow-sm"
                >
                  <AlertCircle size={14} /> Skip / Force Render
                </button>
            </div>
        );
    }

    // Use processedFrame if available (safe base64), otherwise fallback to selectedFrame (only for editing steps)
    const frameToRender = processedFrame || selectedFrame;
    
    // -- WYSIWYG SCALING LOGIC --
    // Calculate the scale factor between the actual rendered DOM width and the config width.
    // This allows font sizes (px) to scale perfectly.
    const containerRef = useRef<HTMLDivElement>(null);
    const [scaleFactor, setScaleFactor] = useState(1);
    
    useEffect(() => {
        if (!containerRef.current || !selectedLayoutId) return;
        
        const updateScale = () => {
            const domWidth = containerRef.current?.getBoundingClientRect().width || 0;
            const cfg = getEffectiveLayoutConfig(processedFrame || selectedFrame, selectedLayoutId);
            if (cfg.width > 0 && domWidth > 0) {
                setScaleFactor(domWidth / cfg.width);
            }
        };

        const observer = new ResizeObserver(updateScale);
        observer.observe(containerRef.current);
        
        // Initial call
        updateScale();
        
        return () => observer.disconnect();
    }, [selectedLayoutId, step, isResultPanelCollapsed]);

    let bgStyle: React.CSSProperties = {};
    if (frameToRender) {
         const bg = frameToRender.backgroundConfig;
         if (bg.type === 'solid') bgStyle.backgroundColor = bg.color;
         else if (bg.type === 'gradient') {
             const stops = bg.gradientStops?.map(s => `${s.color} ${s.offset}%`).join(', ');
             bgStyle.background = bg.gradientType === 'radial' ? `radial-gradient(circle, ${stops})` : `linear-gradient(${adminAngleToCssAngle(bg.gradientAngle ?? 90)}deg, ${stops})`;
         }
    } else { bgStyle.backgroundColor = '#fff'; }

    return (
        <div id={id} ref={containerRef} className={`relative mx-auto bg-white ${shadow ? 'shadow-2xl' : ''}`} style={{ width: '100%', maxWidth: `calc(${maxHeightStr} * ${ratio})` }}>
            <div className="relative w-full" style={{ paddingBottom: `${(1/ratio) * 100}%` }}>
                <div className="absolute inset-0 overflow-hidden" style={bgStyle}>
                    {frameToRender?.overlayUrl && (
                        <img
                            src={frameToRender.overlayUrl}
                            alt=""
                            className="absolute inset-0 w-full h-full object-fill pointer-events-none"
                            style={{ zIndex: 0 }}
                        />
                    )}
                    {config.slots.map((slot, i) => {
                        const photo = capturedPhotos[i];
                        const slotBorder = getSlotBorderConfig(frameToRender);
                        return (
                            <div key={i} className="absolute overflow-hidden flex items-center justify-center" style={{ left: `${(slot.x / config.width) * 100}%`, top: `${(slot.y / config.height) * 100}%`, width: `${(slot.width / config.width) * 100}%`, height: `${(slot.height / config.height) * 100}%`, zIndex: 1, boxSizing: 'border-box', border: `${Math.max(1, slotBorder.width * scaleFactor)}px solid ${slotBorder.color}`, backgroundColor: photo ? 'transparent' : 'rgba(156, 163, 175, 0.48)' }}>
                                {photo ? (
                                    /* Captured photos are Data URIs, so no CORS is needed. */
                                    <img src={photo} className="w-full h-full object-cover" style={{ filter: selectedFilter?.cssFilter || 'none' }} />
                                ) : (
                                    <span className="font-bold text-white/75" style={{ fontSize: `${Math.max(12, 42 * scaleFactor)}px` }}>{i + 1}</span>
                                )}
                            </div>
                        );
                    })}
                    {frameToRender?.elements?.map(el => {
                        const widthVal = el.width && !isNaN(Number(el.width)) && Number(el.width) > 0 ? Number(el.width) : 20;
                        
                        // Scale text properties
                        const fontSize = (el.fontSize || 40) * scaleFactor;
                        // Scale stroke/shadows roughly as well
                        const strokeWidth = 2 * scaleFactor; 
                        
                        return (
                            <div key={el.id} style={{
                                    position: 'absolute', left: `${el.x}%`, top: `${el.y}%`, transform: `${el.anchor === 'top-left' ? '' : 'translate(-50%, -50%) '}rotate(${el.rotation || 0}deg)`,
                                    zIndex: (el.zIndex ?? 0) + 10, opacity: el.opacity ?? 1, color: el.color || '#000', fontFamily: el.fontFamily,
                                    fontSize: `${Math.max(1, fontSize)}px`, 
                                    fontWeight: el.fontWeight, fontStyle: el.fontStyle, textDecoration: el.textDecoration,
                                    textShadow: el.effect === 'shadow' ? '1px 1px 2px rgba(0,0,0,0.5)' : el.effect === 'neon' ? `0 0 5px ${el.color}, 0 0 10px ${el.color}` : 'none',
                                    WebkitTextStroke: el.effect === 'outline' ? `${strokeWidth}px black` : 'none', 
                                    whiteSpace: 'nowrap', 
                                    // Use max-content to prevent text stacking/wrapping during render
                                    width: el.type === 'text' ? 'max-content' : `${widthVal}%`,
                                    height: el.type === 'text' || !el.height ? 'auto' : `${el.height}%`,
                                    // Explicit letter spacing to prevent overlap calculation errors in html2canvas
                                    letterSpacing: '0px',
                                    lineHeight: '1',
                                }}>
                                {el.type === 'text' ? el.content : (
                                    <img 
                                      src={el.content} 
                                      style={{ width: '100%', height: 'auto', display: 'block' }} 
                                      // Added referrerPolicy="no-referrer" to prevent hotlink 403s when rendering failed/raw URLs
                                      referrerPolicy="no-referrer"
                                      // Removed crossOrigin="anonymous" to ensure visual loading in standard DOM when CORS is missing
                                    />
                                )}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
  };

  const isAirTouch = uiMode === 'air-touch';
  const isVertical = monitorOrientation === 'vertical'; // portrait monitor mode

  return (
    <>
      {/* ── Air Gesture Cursor ── */}
      <AirCursor />

      {/* --- Error Banner --- */}
      {cameraError && (
        <div id="camera-error-banner" className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] bg-red-50 border-l-4 border-red-500 p-4 rounded shadow-2xl max-w-lg w-[90%] flex items-center gap-4 animate-fade-in-up">
            <div className="bg-red-100 p-2 rounded-full"><AlertTriangle className="text-red-600" size={24} /></div>
            <div className="flex-1">
                <h3 className="font-bold text-red-800">Camera Access Error</h3>
                <p id="camera-error-message" className="text-sm text-red-700">{cameraError}</p>
            </div>
            <button 
                onClick={retryCamera} 
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded font-bold text-sm transition-colors"
            >
                Retry
            </button>
        </div>
      )}

      {(templateError || flowError) && (
        <div role="alert" className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] bg-red-950/95 border border-red-400/60 p-4 rounded-xl shadow-2xl max-w-xl w-[90%] flex items-center gap-3 text-white">
          <AlertCircle className="text-red-300 shrink-0" size={24} />
          <p className="flex-1 text-sm font-semibold">{flowError || templateError}</p>
          <button onClick={() => { setFlowError(null); void refreshFrames(); }} className="px-3 py-2 rounded-lg bg-white text-red-950 text-xs font-bold">Retry</button>
        </div>
      )}

      <video ref={videoRef} autoPlay playsInline muted className="hidden" />

      <div 
        id="calibration-overlay" 
        className="fixed inset-0 z-50 items-center justify-center bg-black/90 p-4 animate-fade-in"
        style={{ display: isCalibrating ? 'flex' : 'none' }}
      >
          <div className="w-full h-full max-w-6xl flex flex-col relative">
              <div className="flex justify-between items-center mb-4 text-white">
                  <h2 className="text-3xl font-bold flex items-center gap-3"><Scan size={32} className="text-green-400" /> Hand Calibration</h2>
                  <button id="btn-close-calibration" onClick={() => setIsCalibrating(false)} className="p-2 bg-white/10 hover:bg-white/20 rounded-full"><X size={32} /></button>
              </div>
              <div className="flex-1 relative border-4 border-white/20 rounded-3xl overflow-hidden bg-black pointer-events-none">
                   <canvas id="calibration-canvas" ref={processingCanvasRef} className="w-full h-full object-contain transform scale-x-[-1]" />
                   <div className="absolute top-4 left-4 bg-black/60 p-4 rounded-xl text-white max-w-sm pointer-events-none">
                       <p className="text-lg font-semibold text-green-400 mb-2">Instructions:</p>
                       <ul className="list-disc pl-5 space-y-2 text-sm opacity-90">
                           <li>Keep your hand inside the <span className="text-green-400 font-bold">GREEN BOX</span> to move the cursor.</li>
                           <li><b>Pinch</b> (jepit jari) untuk Klik button, pilih frame & filter, atau Geser.</li>
                       </ul>
                   </div>
              </div>
              <div className="mt-6 flex items-center justify-between gap-8 bg-white/10 p-6 rounded-2xl backdrop-blur-md">
                  <div className="flex-1">
                      <label className="text-white font-bold mb-2 block uppercase text-sm tracking-wider">Sensitivity</label>
                      <div className="flex gap-2">
                          {[1, 2, 3, 4, 5].map(level => (
                              <button id={`btn-sensitivity-level-${level}`} key={level} onClick={() => adjustSensitivity(level)} className={`flex-1 py-4 rounded-xl font-bold text-xl transition-all ${(Math.abs(calibrationBox.minX - (0.1 + ((level - 1) / 4) * 0.25)) < 0.01) ? 'bg-green-500 text-white shadow-lg' : 'bg-white/20 text-white'}`}>{level}</button>
                          ))}
                      </div>
                  </div>
                  <button id="btn-done-calibration" onClick={() => setIsCalibrating(false)} className="px-10 py-6 bg-white text-black font-extrabold text-2xl rounded-2xl hover:scale-105 transition-transform shadow-xl flex items-center gap-3"><Check size={32} className="text-green-600" /> Done</button>
              </div>
          </div>
      </div>

      {step === 'LANDING' && (
        <>
          <div className="h-full w-full bg-[#0c1633] flex flex-col items-center justify-center relative overflow-hidden text-white p-4 select-none">
            <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
                 <div className="absolute top-[10%] left-[10%] w-48 h-48 bg-orange-400/40 rounded-full blur-[60px] float-anim"></div>
                 <div className="absolute bottom-[10%] right-[10%] w-64 h-64 bg-slate-400/40 rounded-full blur-[60px] float-anim"></div>
            </div>
            <div className="z-10 text-center animate-fade-in-up flex flex-col items-center">
              <div className="relative mt-8 md:mt-12 pointer-events-none w-full flex justify-center">
                <img src="/assets/title.png" alt="UniSmile Photo Title" className="w-[85vw] max-w-[1200px] h-auto drop-shadow-2xl transform hover:scale-105 transition-transform duration-500" />
                {customSubtitle && <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 bg-white/20 backdrop-blur-md px-6 py-2 rounded-full border border-white/30 font-bold text-2xl md:text-3xl whitespace-nowrap shadow-xl">x {customSubtitle}</div>}
              </div>
              <div className="-mt-16 md:-mt-32 z-20 relative">
                <button onClick={handleStart} className="group relative active:scale-95 transition-all hover:scale-[1.03]">
                  <img src="/assets/start.png" alt="Start Photo" className={`h-auto drop-shadow-xl ${isAirTouch ? 'w-[450px] md:w-[550px]' : 'w-[350px] md:w-[450px]'}`} />
                </button>
              </div>
              
              {/* Branding Logos */}
              <div className="mt-8 pb-8 flex items-center justify-center gap-10 opacity-90 overflow-hidden px-4">
                  <img src="/assets/LOGO UNI INSIDE.png" alt="Uni Inside" className="h-12 md:h-16 object-contain" />
                  <img src="/assets/LOGO KOLAB.png" alt="Kolab" className="h-12 md:h-16 object-contain" />
                  <img src="/assets/LOGO UNI SMILE.png" alt="Uni Smile" className="h-12 md:h-16 rounded-xl object-contain" />
              </div>
            </div>
            <div className="absolute top-8 left-8 flex gap-4 z-50">
               {/* Tombol Back di halaman pertama: keluar ke signage, bukan mundur
                   ke layar lain. */}
               <button id="btn-back-landing" onClick={goToSignage} className={`flex items-center gap-2 rounded-full backdrop-blur-sm transition-colors bg-white/10 text-white/70 hover:bg-white/20 border-2 border-white/20 font-bold ${isAirTouch ? 'px-8 py-6 text-2xl' : 'px-6 py-4'}`}>
                 <ChevronLeft size={isAirTouch ? 40 : 28} /> Back
               </button>
            </div>
            <div className="absolute top-8 right-8 flex gap-4 z-50">
               <button id="btn-toggle-cursor-lock-landing" onClick={() => setIsCursorLocked(!isCursorLocked)} className={`rounded-full backdrop-blur-sm transition-colors border-2 ${isAirTouch ? 'p-6' : 'p-4'} ${isCursorLocked ? 'bg-red-500/20 border-red-400 text-white' : 'bg-white/10 border-white/20 text-white/70 hover:bg-white/20'}`} style={{ display: isAirTouch ? 'block' : 'none' }}>{isCursorLocked ? <Lock size={isAirTouch?40:32}/> : <Unlock size={isAirTouch?40:32}/>}</button>
               <button id="btn-calibrate-landing" onClick={() => setIsCalibrating(true)} className={`${isAirTouch ? 'p-6' : 'p-4'} rounded-full backdrop-blur-sm transition-colors bg-white/10 text-white/70 hover:bg-white/20 border-2 border-white/20`} style={{ display: isAirTouch ? 'block' : 'none' }}><Scan size={isAirTouch?40:40} /></button>
               <button id="btn-admin-settings-landing" onClick={onAdminClick} className={`text-white/70 hover:text-white transition-colors bg-white/10 ${isAirTouch ? 'p-6' : 'p-4'} rounded-full hover:bg-white/20 backdrop-blur-sm border-2 border-white/20`}><Settings size={isAirTouch?40:40} /></button>
            </div>
            <div id="gesture-status-banner" className="absolute top-8 left-1/2 -translate-x-1/2 text-white/80 bg-black/30 px-6 py-2 rounded-full backdrop-blur text-lg pointer-events-none text-center whitespace-nowrap" style={{ display: gestureEnabled ? 'block' : 'none' }}>
                {isCursorLocked
                  ? "🔒 Cursor Locked"
                  : "🤏 Pinch jari = Klik button / Pilih frame & filter / Geser"}
            </div>
          </div>
        </>
      )}

      {step === 'PACKAGE' && (
        <BoothWrapper title="Choose Package" subtitle="Select your preferred output" onAdminClick={onAdminClick} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} uiMode={uiMode} onBack={() => setStep('LANDING')} isVertical={isVertical}>
            <div className={`h-full flex flex-col items-center justify-center ${isVertical ? 'p-4 gap-6' : 'p-10 gap-10'}`}>
                <button 
                    onClick={() => handlePackageSelect('print')}
                    className="w-full max-w-md bg-[#f6cd46] hover:bg-[#e5bc35] text-black rounded-3xl p-8 flex flex-col items-center justify-center gap-4 transition-all active:scale-95 shadow-xl hover:shadow-2xl border-4 border-transparent hover:border-white/50"
                >
                    <Printer size={64} />
                    <h3 className="text-3xl font-black">Print + Digital</h3>
                    <p className="text-center font-medium opacity-80">Get a physical copy and digital download</p>
                </button>
                <button 
                    onClick={() => handlePackageSelect('digital')}
                    className="w-full max-w-md bg-white/10 hover:bg-white/20 text-white rounded-3xl p-8 flex flex-col items-center justify-center gap-4 transition-all active:scale-95 shadow-xl hover:shadow-2xl border border-white/20"
                >
                    <Download size={64} />
                    <h3 className="text-3xl font-black">Digital Only</h3>
                    <p className="text-center text-white/70">Softcopy only, sent to your email or phone</p>
                </button>
            </div>
        </BoothWrapper>
      )}

      {step === 'LAYOUT' && (
        <BoothWrapper title="Choose Layout" subtitle="Tap to select your format" onAdminClick={onAdminClick} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} uiMode={uiMode} onBack={() => setStep('PACKAGE')} isVertical={isVertical}>
            <div className={`h-full flex flex-col ${isVertical ? 'p-4' : isAirTouch ? 'p-10' : 'p-6 md:p-10'}`}>
                <div className={`flex-1 overflow-y-auto flex items-center justify-center`}>{/* Kontainer diperlebar (2026-09-30): kartu layout tadinya kecil — max-w-xs di vertikal hanya ~320px (kartu ~154px), max-w-4xl di horizontal. Semua mode naik satu-dua tingkat supaya pratinjau layout terbaca jelas dari jarak pengunjung. */}
                    <div className={`flex flex-wrap justify-center items-center w-full mx-auto ${isVertical ? 'gap-3 max-w-md pt-2 pb-4' : isAirTouch ? 'gap-10 md:gap-14 max-w-6xl' : 'gap-5 md:gap-8 max-w-5xl lg:max-w-6xl pb-6'}`}>
                        {[{id: '1x1', label: 'Polaroid', count: 1}, {id: '2x1', label: 'Strip (2)', count: 2}, {id: '3x1', label: 'Strip (3)', count: 3}, {id: '4x1', label: 'Strip (4)', count: 4}, {id: '2x2', label: 'Grid (4)', count: 4}, {id: '2x3', label: 'Grid (6)', count: 6}, {id: '3x3', label: 'Grid (9)', count: 9}]
                        .filter(layout => frames.find(f => f.id === layout.id)?.enabled)
                        .filter(layout => !allowedLayouts || allowedLayouts.length === 0 || allowedLayouts.includes(layout.id))
                        .map((layout) => (
                            <button 
                              key={layout.id} 
                              onClick={() => handleLayoutSelect(layout.id as GridLayoutId)} 
                              className={`group relative aspect-[4/5] bg-white/10 backdrop-blur-md rounded-2xl border-2 border-white/20 hover:bg-white/20 hover:border-pink-400 hover:scale-105 transition-all flex flex-col items-center justify-center shrink-0
                              ${isVertical 
                                ? 'w-[calc(50%-0.375rem)] gap-2 p-3 shadow-lg' 
                                : isAirTouch 
                                  ? 'w-[calc(50%-1.25rem)] md:w-[calc(25%-2.625rem)] gap-6 p-6 shadow-2xl rounded-3xl' 
                                  : 'w-[calc(50%-0.625rem)] md:w-[calc(25%-1.5rem)] gap-4 p-5 shadow-xl rounded-3xl'}`}
                            >
                                 <div className={`grid gap-1 w-full h-full rounded-xl ${isVertical ? 'p-2' : 'p-3 gap-2'} ${layout.id === '1x1' ? 'grid-cols-1 grid-rows-1' : layout.id === '2x1' ? 'grid-cols-1 grid-rows-2' : layout.id === '3x1' ? 'grid-cols-1 grid-rows-3' : layout.id === '4x1' ? 'grid-cols-1 grid-rows-4' : layout.id === '2x2' ? 'grid-cols-2 grid-rows-2' : layout.id === '2x3' ? 'grid-cols-2 grid-rows-3' : 'grid-cols-3 grid-rows-3'}`}>{Array.from({length: layout.count}).map((_, i) => (<div key={i} className="bg-white/40 rounded-sm group-hover:bg-pink-300/60 transition-colors"></div>))}</div>
                                <span className={`font-bold tracking-wide ${isVertical ? 'text-sm' : isAirTouch ? 'text-2xl md:text-3xl' : 'text-base md:text-xl'}`}>{layout.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </BoothWrapper>
      )}

      {step === 'PAYMENT' && (
        <BoothWrapper uiMode={uiMode} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} hideHeader customBg="bg-[#0c1633]" isVertical={isVertical}>
             <div className="h-full w-full bg-[#0c1633] flex flex-col items-center justify-center relative overflow-hidden p-6">
                
                <div className="z-10 w-full max-w-7xl flex flex-col items-center">
                    {/* Main Content Area */}
                    <div className="flex flex-row items-center justify-center gap-12 lg:gap-20 w-full mt-2 lg:-mt-24">
                        {/* E-Wallet Column */}
                        <div className="hidden lg:flex flex-col items-center animate-fade-in-left">
                            <img src="/assets/QRISEWALLET.png" alt="E-Wallet Partners" className="w-[400px] h-auto object-contain" />
                        </div>

                        {/* Main Payment Section */}
                        <div className="flex flex-col items-center shrink-0">
                            {/* Title Section */}
                            <div className="text-center mb-2 md:mb-4 lg:-mb-10 animate-fade-in flex flex-col items-center z-0 pointer-events-none">
                                <img src="/assets/PAYWITHQR.png" alt="Pay With QR" className="h-32 md:h-48 lg:h-64 object-contain drop-shadow-md" />
                            </div>

                            {/* Main Payment Card */}
                            <div className="flex flex-col items-center w-full max-w-[260px] md:max-w-[320px]">
                                <div className="w-full bg-white flex flex-col items-center justify-center p-4 md:p-5 shadow-2xl rounded-2xl animate-scale-in relative">
                                    <div className="flex justify-between items-center w-full mb-3 px-2">
                                        <span className="font-bold text-gray-800 text-lg md:text-xl tracking-wide">QRIS</span>
                                        <span className="text-[#00aead] font-black text-lg md:text-xl">
                                            {payableAmount === null
                                              ? 'Harga belum tersedia'
                                              : new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(payableAmount)}
                                        </span>
                                    </div>
                                    {uniqueCode !== null && (
                                      <div className="w-full mb-2 px-2 text-[11px] md:text-xs font-bold text-gray-500 text-center uppercase tracking-wider">
                                        Kode unik transaksi: <span className="text-[#00aead] font-black">+{uniqueCode}</span>
                                      </div>
                                    )}
                                    <div className="flex-1 flex items-center justify-center w-full">
                                        {qrisUrl ? (
                                            <img
                                              key={qrisUrl}
                                              src={`${qrisUrl}?t=${Date.now()}`}
                                              alt="QRIS Uni"
                                              className="w-full h-auto max-h-[45vh] lg:max-h-[50vh] object-contain rounded-xl"
                                            />
                                        ) : (
                                            <div className="w-full h-[40vh] flex flex-col items-center justify-center text-gray-400 gap-3">
                                              <div className="animate-spin border-4 border-white/20 border-t-yellow-400 rounded-full w-10 h-10" />
                                              <span className="text-sm">Memuat QRIS...</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                                
                                {paymentMethod === 'gopay_merchant_polling' ? (
                                  <div className="mt-4 md:mt-6 w-full rounded-xl border border-white/20 bg-white/10 p-4 text-center text-white">
                                    <div className="flex items-center justify-center gap-2 font-bold">
                                      {paymentPollingState === 'expired' ? (
                                        <AlertCircle size={18} className="text-amber-300" />
                                      ) : paymentPollingState === 'retrying' ? (
                                        <RefreshCw size={18} className="animate-spin text-amber-300" />
                                      ) : (
                                        <Loader2 size={18} className="animate-spin text-[#f6cd46]" />
                                      )}
                                      {paymentPollingState === 'expired'
                                        ? 'Sesi pembayaran berakhir'
                                        : paymentPollingState === 'retrying'
                                          ? 'Menyambungkan ulang'
                                          : paymentPollingState === 'checking'
                                            ? 'Memeriksa pembayaran'
                                            : 'Menunggu konfirmasi otomatis'}
                                    </div>
                                    <p className="mt-2 text-sm text-white/75">
                                      {paymentPollingState === 'expired'
                                          ? 'Silakan kembali dan mulai sesi baru.'
                                          : paymentPollingState === 'retrying'
                                            ? 'Koneksi ke server terputus sementara. Pemeriksaan akan dicoba lagi otomatis.'
                                          : 'Bayar dengan nominal persis seperti yang tertera. Sesi lanjut otomatis setelah pembayaran masuk ke GoPay Merchant.'}
                                    </p>
                                    {flowError && <p className="mt-2 text-sm font-semibold text-amber-300">{flowError}</p>}
                                    {paymentPollingState !== 'expired' && (
                                      <button onClick={handlePaymentConfirm} className="mt-3 rounded-lg px-3 py-2 text-xs font-bold text-white/80 underline underline-offset-2 hover:text-white">
                                        Periksa lewat kamera
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <button onClick={handlePaymentConfirm} className="mt-4 md:mt-6 w-full bg-[#f6cd46] hover:bg-[#e5bc35] text-black py-3 md:py-4 rounded-xl text-lg md:text-xl font-bold shadow-[0_10px_20px_rgba(246,205,70,0.3)] transition-all active:scale-95">
                                    I Have Paid
                                  </button>
                                )}
                            </div>
                        </div>

                        {/* Bank Column */}
                        <div className="hidden lg:flex flex-col items-center animate-fade-in-right">
                            <img src="/assets/QRISBANK.png" alt="Bank Partners" className="w-[460px] h-auto object-contain" />
                        </div>
                    </div>


                </div>

                {/* Back Button */}
                 <div className="absolute top-6 left-6 z-50">
                     <button onClick={() => setStep('LAYOUT')} className="active:scale-95 hover:scale-110 transition-all outline-none">
                         <img src="/assets/BACK.png" alt="Back" className="h-20 md:h-24 object-contain drop-shadow-md" />
                     </button>
                 </div>
             </div>
        </BoothWrapper>
      )}

      {step === 'PAYMENT_SCAN' && (
        <BoothWrapper uiMode={uiMode} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} hideHeader hideLogos customBg="bg-[#0c1633]" isVertical={isVertical}>
          <div className="h-full w-full bg-[#0c1633] flex flex-col items-center justify-center relative p-3 sm:p-5 select-none overflow-y-auto">
            <div className="z-10 w-full max-w-md flex flex-col items-center gap-3 sm:gap-4 my-auto">
              
              {/* Header */}
              <div className="text-center max-w-md">
                <h2 className="text-2xl sm:text-3xl font-black text-white tracking-tight uppercase">Pindai Bukti Pembayaran</h2>
                <p className="text-xs sm:text-sm font-semibold text-gray-400 mt-0.5">
                  Posisikan layar HP Anda (halaman detail transaksi sukses) tepat di dalam bingkai kamera.
                </p>
              </div>

              {/* Center Camera Preview.
                  Rasio kotaknya dibuat sama dengan rasio area panduan (widthRatio:
                  heightRatio) dan isinya memakai object-cover. Dengan begitu
                  bingkai yang dilihat pengunjung memetakan PERSIS ke area yang
                  difoto, sehingga "posisikan di dalam bingkai" benar-benar akurat. */}
              <div
                className={`w-[300px] sm:w-[330px] md:w-[350px] max-h-[52vh] bg-black/60 border-2 rounded-[2.2rem] relative overflow-hidden shadow-[0_15px_35px_rgba(0,0,0,0.6)] flex items-center justify-center transition-colors duration-300 ${scanFrozen ? 'border-emerald-400/80' : 'border-white/20'}`}
                style={{ aspectRatio: `${SCAN_GUIDE.widthRatio} / ${SCAN_GUIDE.heightRatio}` }}
              >
                <canvas ref={processingCanvasRef} className="w-full h-full object-cover transform scale-x-[-1]" />
                
                {/* Bingkai panduan: ukurannya dihitung dari SCAN_GUIDE yang sama
                    dengan area foto, jadi keduanya tidak mungkin lagi berbeda.
                    Warnanya TIDAK berubah menurut "mutu" — kita tidak bisa tahu
                    mutu dari gambar, jadi jangan mengklaim apa pun ke pengunjung. */}
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div
                    className={`border-4 rounded-[1.6rem] relative flex items-center justify-center ${
                      scanFrozen
                        ? 'border-emerald-400 shadow-[0_0_30px_rgba(52,211,153,0.45)]'
                        : scanActive
                        ? 'border-dashed border-[#f6cd46] shadow-[0_0_30px_rgba(246,205,70,0.3)] animate-pulse'
                        : 'border-dashed border-[#f6cd46] shadow-[0_0_30px_rgba(246,205,70,0.3)]'
                    }`}
                    style={guideFrameStyle()}
                  >
                    <span className="text-[11px] sm:text-xs text-center font-black uppercase text-white bg-black/80 px-3.5 py-1.5 rounded-full tracking-wider shadow-lg backdrop-blur-sm border border-white/20">
                      {scanFrozen ? 'Bukti tertangkap ✓' : scanActive ? 'Posisikan bukti bayar di area ini' : 'Area scan bukti bayar'}
                    </span>
                  </div>
                </div>

                {/* Indikator saat bukti bayar sedang diperiksa layanan OCR.
                    Tidak ada bar persen atau hitungan waktu: pemindaian berjalan
                    sampai tangkapannya bagus, jadi tidak ada "progres menuju
                    gagal" yang perlu ditampilkan. */}
                {verificationStatus === 'processing' && (
                  <div className="absolute bottom-3 left-3 right-3 bg-black/85 backdrop-blur-md p-3 rounded-2xl border border-white/15">
                    <div className="flex items-center justify-center gap-2 text-xs font-black text-white uppercase tracking-wider">
                      <Loader2 size={14} className="animate-spin text-[#f6cd46]" />
                      <span className="animate-pulse">{scanningHint}</span>
                    </div>
                  </div>
                )}

                {/* Preview dibekukan: frame terakhir tetap tampil sehingga
                    pengunjung boleh menurunkan HP selagi bukti diperiksa.
                    Setelah terverifikasi, tanda berubah hijau. */}
                {scanFrozen && (
                  <div className="absolute inset-0 z-10 pointer-events-none">
                    {verificationStatus === 'verified' ? (
                      <div className="absolute inset-0 bg-emerald-500/25 flex items-center justify-center">
                        <div className="bg-emerald-500 text-white rounded-full p-4 shadow-2xl">
                          <Check size={isVertical ? 30 : 44} strokeWidth={3.5} />
                        </div>
                      </div>
                    ) : (
                      <div className="absolute top-3 left-3 right-3 flex justify-center">
                        <span className="text-[10px] sm:text-[11px] font-black uppercase tracking-wider text-white bg-black/80 px-3 py-1.5 rounded-full backdrop-blur-sm border border-white/20">
                          {FROZEN_BADGE_TEXT}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Button & Feedback Area - ALWAYS Rendered */}
              <div className="w-[280px] sm:w-[320px] md:w-[340px] flex flex-col gap-2">
                {(verificationStatus === 'needs_retry' || verificationStatus === 'rejected' || verificationStatus === 'error') ? (
                  /* Unified Error & Retry Message Card */
                  <div className="bg-red-500/10 border border-red-500/30 p-3.5 rounded-2xl text-center space-y-2 shadow-lg backdrop-blur-md">
                    <div className="flex items-center justify-center gap-1.5 text-red-400 font-black text-xs sm:text-sm uppercase">
                      <span>⚠️</span>
                      <span>{verificationStatus === 'rejected' ? 'Bukti Bayar Ditolak' : 'Pindai Belum Berhasil'}</span>
                    </div>

                    <p className="text-[11px] sm:text-xs font-semibold text-gray-300 leading-relaxed">
                      {verificationStatus === 'rejected' 
                        ? 'Bukti transaksi tidak sah atau sudah pernah digunakan sebelumnya.'
                        : (flowError || 'Kamera belum dapat membaca bukti pembayaran dengan jelas.')}
                    </p>
                    
                    {verificationReasonCodes.length > 0 && (
                      <div className="bg-black/40 border border-white/5 rounded-xl p-2 text-left text-[11px] text-amber-300 space-y-1 font-medium">
                        {verificationReasonCodes.map(code => (
                          <div key={code} className="flex items-start gap-1">
                            <span className="text-amber-400 font-bold">•</span>
                            <span>{formatVerificationReason(code)}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {verificationStatus !== 'rejected' && (
                      <p className="text-[10px] text-gray-400 italic">
                        💡 Tips: Naikkan kecerahan layar HP ke maksimal, dekatkan ke kamera, dan hindari pantulan cahaya lampu.
                      </p>
                    )}

                    {verificationStatus !== 'rejected' && (
                      <button 
                        onClick={startScanningSequence}
                        className="w-full mt-1 bg-[#f6cd46] hover:bg-[#e5bc35] text-black py-2.5 sm:py-3 rounded-xl text-xs sm:text-sm font-black shadow-md transition-all active:scale-95 flex items-center justify-center gap-2 border-2 border-[#f6cd46]"
                      >
                        <span>🔄</span>
                        <span>Coba Scan Lagi</span>
                      </button>
                    )}
                  </div>
                ) : verificationStatus === 'processing' ? (
                  /* Sudah dikirim: jangan tawarkan scan kedua. */
                  <div className="w-full bg-white/5 border border-white/15 p-3.5 rounded-2xl text-center shadow-lg backdrop-blur-md">
                    <p className="text-[11px] sm:text-xs font-black text-white uppercase tracking-wider animate-pulse">
                      Memeriksa bukti pembayaran...
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">Bukti sudah tertangkap — Anda boleh menurunkan HP.</p>
                  </div>
                ) : verificationStatus === 'verified' ? (
                  /* Terverifikasi: pengunjung boleh menurunkan HP. */
                  <div className="w-full bg-emerald-500/10 border border-emerald-500/40 p-3.5 rounded-2xl text-center shadow-lg backdrop-blur-md">
                    <div className="flex items-center justify-center gap-2 text-emerald-400 font-black text-xs sm:text-sm uppercase tracking-wider">
                      <Check size={16} strokeWidth={3} />
                      <span>Pembayaran terverifikasi!</span>
                    </div>
                    <p className="text-[10px] sm:text-[11px] text-gray-300 mt-1 font-semibold">
                      Memulai sesi foto...
                    </p>
                  </div>
                ) : (
                  /* Pemindaian berjalan otomatis tanpa batas waktu: pengunjung
                     bebas mengatur posisi sampai tangkapannya bagus. Tidak ada
                     hitungan detik, jadi tidak ada kesan "hampir gagal". */
                  <div className="w-full bg-[#f6cd46]/10 border border-[#f6cd46]/40 p-3.5 rounded-2xl text-center space-y-2 shadow-lg backdrop-blur-md">
                    <div className="flex items-center justify-center gap-2 text-[#f6cd46] font-black text-xs sm:text-sm uppercase tracking-wider">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#f6cd46] animate-bounce" style={{ animationDelay: '0ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-[#f6cd46] animate-bounce" style={{ animationDelay: '150ms' }} />
                        <span className="w-1.5 h-1.5 rounded-full bg-[#f6cd46] animate-bounce" style={{ animationDelay: '300ms' }} />
                      </span>
                      <span>{scanActive ? 'Sedang membaca bukti bayar...' : 'Bersiap memindai...'}</span>
                    </div>

                    <p className="text-[11px] sm:text-xs font-semibold text-gray-200 leading-snug">{scanningHint}</p>

                    <div className="flex items-center justify-center gap-2 pt-0.5">
                      <span className="text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-full border border-[#f6cd46]/50 text-[#f6cd46] bg-[#f6cd46]/10">
                        {submitRound > 0 ? `Percobaan ke-${submitRound + 1} · tanpa batas` : 'Siap memindai'}
                      </span>
                    </div>

                    <p className="text-[10px] text-gray-400 leading-snug">
                      Ambil waktu Anda — sistem akan terus membaca sampai berhasil.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Back Button */}
            <div className="absolute top-4 left-4 sm:top-6 sm:left-6 z-50">
              <button 
                onClick={() => {
                  setStep('PAYMENT');
                  handleResetScan();
                }} 
                className="active:scale-95 hover:scale-110 transition-all outline-none"
              >
                <img src="/assets/BACK.png" alt="Back" className="h-16 sm:h-20 md:h-24 object-contain drop-shadow-md" />
              </button>
            </div>
          </div>
        </BoothWrapper>
      )}

      {step === 'PAYMENT_CHECKING' && (
        <BoothWrapper uiMode={uiMode} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} hideHeader customBg="bg-[#0c1633]" isVertical={isVertical}>
          <div className="h-full w-full bg-[#0c1633] flex flex-col items-center justify-center p-6">
            <div className="flex flex-col items-center gap-6 max-w-sm text-center">
              <div className="relative w-20 h-20">
                <div className="absolute inset-0 rounded-full border-4 border-white/10" />
                <div className="absolute inset-0 rounded-full border-4 border-t-primary animate-spin" />
              </div>
              <div className="space-y-2">
                <h3 className="text-2xl font-black text-white tracking-tight uppercase">Memproses Verifikasi</h3>
                <p className="text-sm font-bold text-gray-400 animate-pulse">{scanningHint}</p>
              </div>
            </div>
          </div>
        </BoothWrapper>
      )}

      {step === 'CAPTURE' && (
        <div className="h-full w-full bg-black relative overflow-hidden flex flex-col">
            <div className={`fixed inset-0 bg-white z-[100] pointer-events-none transition-opacity duration-[150ms] ${flash ? 'opacity-100' : 'opacity-0'}`} />
                <div className="relative flex-1 w-full bg-black overflow-hidden">
                    <canvas id="camera-preview" ref={processingCanvasRef} className="w-full h-full object-cover transform scale-x-[-1]" />
                    {/* Camera Guide Overlay — panduan posisi SAJA (tanpa frame).
                        Permintaan operator (2026-09-30): saat pemotretan jangan
                        tampilkan overlay frame; frame baru muncul di layar
                        konfirmasi. Yang tersisa hanya kotak putus-putus dengan
                        rasio slot berikutnya agar pengunjung tahu ke mana berdiri. */}
                    {step === 'CAPTURE' && selectedLayoutId && (() => {
                        const config = getEffectiveLayoutConfig(processedFrame || selectedFrame, selectedLayoutId);
                        const idx = retakeIndex !== null ? retakeIndex : Math.min(capturedPhotos.length, config.slots.length - 1);
                        const slot = config.slots[idx];
                        if (!slot) return null;
                        const isPortrait = slot.width < slot.height;
                        return (
                          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none overflow-hidden">
                            <div 
                              className="border-2 border-white/50 border-dashed rounded-lg transition-all duration-500 relative"
                              style={{ 
                                aspectRatio: `${slot.width} / ${slot.height}`,
                                height: isPortrait ? '100%' : 'auto',
                                width: isPortrait ? 'auto' : '100%',
                                maxWidth: '100%',
                                maxHeight: '100%',
                                boxShadow: '0 0 0 9999px rgba(0,0,0,0.65)'
                              }}
                            >
                                <div className="absolute inset-0 flex items-center justify-center">
                                    <span className="bg-black/60 text-white/80 text-[10px] md:text-xs px-3 py-1 rounded-full font-bold uppercase tracking-widest backdrop-blur-md opacity-50">
                                        Frame {idx + 1}
                                    </span>
                                </div>
                            </div>
                          </div>
                        );
                    })()}
                    {countdown !== null && <div id="countdown-display" className="absolute inset-0 flex items-center justify-center z-30"><span className="text-[20rem] font-bold text-white drop-shadow-[0_10px_20px_rgba(0,0,0,0.8)] animate-bounce font-display">{countdown}</span></div>}
                    {captureDeadline !== null ? (
                      <div className={`absolute left-8 z-20 rounded-xl border px-4 py-2 backdrop-blur-md font-mono font-bold ${remainingCaptureSeconds <= 30 ? 'border-red-400 bg-red-500/40 text-red-100' : 'border-white/20 bg-black/40 text-white'}`} style={{ top: isAirTouch ? '3rem' : '2rem' }}>
                        Waktu: {formatCaptureTime(remainingCaptureSeconds)}
                      </div>
                    ) : selectedLayoutId ? (
                      <div className="absolute left-8 top-8 z-20 rounded-xl border border-white/20 bg-black/40 px-4 py-2 text-sm font-bold text-white/80 backdrop-blur-md">
                        Batas sesi: {formatCaptureTime(getCaptureDurationSeconds(getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length))}
                      </div>
                    ) : null}
                    {captureExpired && (
                      <div className="absolute inset-x-0 bottom-6 z-30 flex justify-center pointer-events-none">
                        <span className="rounded-xl bg-red-600/90 px-5 py-3 text-sm font-bold text-white shadow-xl">Waktu pemotretan habis</span>
                      </div>
                    )}
                    {reviewPhotoIndex !== null && capturedPhotos[reviewPhotoIndex] && (
                      <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
                        <div className="flex max-h-full w-full max-w-md flex-col items-center gap-4 rounded-2xl border border-white/20 bg-[#0c1633]/95 p-4 shadow-2xl md:p-6">
                          <p className="text-center text-lg font-bold text-white md:text-2xl">
                            Foto {reviewPhotoIndex + 1} berhasil diambil
                          </p>
                          {/* Konfirmasi kini menampilkan komposisi BERFRAME yang
                              sama dengan hasil cetak (PreviewComponent), bukan foto
                              mentah tanpa frame. Foto yang baru diambil sudah masuk
                              di slotnya; slot lain tampil sebagai placeholder. */}
                          <div className="flex w-full justify-center">
                            <PreviewComponent shadow maxHeightStr={isVertical ? '40vh' : '55vh'} id="photo-review-frame" />
                          </div>
                          <div className="flex w-full gap-3">
                            <button
                              onClick={() => handleRetakePhoto(reviewPhotoIndex)}
                              className="flex-1 rounded-xl border border-white/25 bg-white/10 px-4 py-6 text-lg font-bold text-white transition-colors hover:bg-white/20 active:scale-95"
                            >
                              Retake Foto
                            </button>
                            <button
                              onClick={handleContinueAfterReview}
                              className="flex-1 rounded-xl bg-white px-4 py-6 text-lg font-bold text-[#0c1633] transition-colors hover:bg-gray-100 active:scale-95"
                            >
                              {capturedPhotos.length >= (selectedLayoutId ? getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length : 0) ? 'Lanjut' : 'Foto Berikutnya'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                {isProcessing && <div className="absolute inset-0 flex items-center justify-center bg-black/80 backdrop-blur-md z-40"><div className="text-center"><RefreshCw size={80} className="animate-spin text-white mb-6 mx-auto" /><h2 className="text-4xl font-bold text-white">Processing...</h2></div></div>}
                <div className={`absolute right-8 z-20 flex flex-col gap-4 ${isAirTouch ? 'top-12' : 'top-8'}`}>
                        <button id="btn-switch-camera" onClick={toggleCamera} className={`${isAirTouch ? 'w-24 h-24' : 'w-20 h-20'} rounded-full bg-black/40 backdrop-blur-md border-2 border-white/20 flex items-center justify-center text-white hover:bg-white/20 transition-all active:scale-95`}><SwitchCamera size={isAirTouch?48:40} /></button>
                        <button id="btn-toggle-cursor-lock-capture" onClick={() => setIsCursorLocked(!isCursorLocked)} className={`${isAirTouch ? 'w-24 h-24' : 'w-20 h-20'} rounded-full backdrop-blur-md border-2 flex items-center justify-center transition-all active:scale-95 ${isCursorLocked ? 'bg-red-500/80 border-red-400 text-white' : 'bg-black/40 border-white/20 text-white/70 hover:bg-white/20'}`} style={{ display: isAirTouch ? 'block' : 'none' }}>{isCursorLocked ? <Lock size={isAirTouch?40:32}/> : <Unlock size={isAirTouch?40:32}/>}</button>
                </div>
            </div>
            {/* Bottom controls bar — compact in vertical */}
            <div className={`bg-[#0c1633]/90 backdrop-blur-xl border-t border-white/10 flex flex-col justify-center relative z-50 px-3 md:px-8 ${isVertical ? 'h-[14vh] min-h-[100px]' : 'h-[18vh] md:h-[20vh]'}`}>
                <div className="flex justify-between items-center h-full gap-2">
                    {/* Thumbnails */}
                    <div className={`flex gap-1.5 overflow-x-auto items-center h-full ${isVertical ? 'py-1.5' : 'py-2 gap-2'}`}>
                        {Array.from({length: (selectedLayoutId ? getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length : 0)}).map((_, i) => (
                            <div key={i} className={`flex-shrink-0 rounded-lg border-2 flex items-center justify-center overflow-hidden bg-white/5 ${capturedPhotos[i] ? 'border-green-400' : 'border-white/20'} ${isVertical ? 'w-10 h-14' : 'w-16 h-24 md:w-24 md:h-32'}`}>
                                {capturedPhotos[i] ? <img src={capturedPhotos[i]} className="w-full h-full object-cover" /> : <span className={`text-white/30 font-bold ${isVertical ? 'text-sm' : 'text-lg'}`}>{i + 1}</span>}
                            </div>
                        ))}
                    </div>
                    {/* Center: Start button */}
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1">
                        {!isAutoCapturing && capturedPhotos.length === 0 && (
                          <>
                            <button id="btn-start-capture" onClick={startAutoCapture} disabled={captureExpired} className={`active:scale-95 transition-transform hover:scale-105 disabled:opacity-40 ${isAirTouch ? 'w-[200px] md:w-[250px]' : isVertical ? 'w-[90px]' : 'w-[150px] md:w-[200px]'}`}>
                              <img src="/assets/start photo.png" alt="Start Photo" className="w-full h-auto drop-shadow-xl animate-pulse" />
                            </button>
                            <div 
                              id="gesture-capture-hold-container" 
                              className="flex flex-col items-center pointer-events-none"
                              style={{ display: (gestureEnabled && (gestureState.gesture === 'open_hand' || gestureState.gesture === 'peace' || gestureState.gesture === 'thumb_up') && captureHoldProgress > 0) ? 'flex' : 'none' }}
                            >
                              <svg id="gesture-capture-hold-svg" width="48" height="48" viewBox="0 0 64 64">
                                <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(246,205,70,0.2)" strokeWidth="5" />
                                <circle cx="32" cy="32" r="28" fill="none" stroke={captureHoldProgress >= 1 ? '#fff' : '#f6cd46'} strokeWidth="5" strokeLinecap="round" strokeDasharray={2 * Math.PI * 28} strokeDashoffset={2 * Math.PI * 28 * (1 - captureHoldProgress)} style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', transition: 'stroke-dashoffset 0.1s linear' }} />
                              </svg>
                              <span id="gesture-capture-hold-text" className="text-xs text-yellow-300 font-bold">Tahan {captureHoldPoseLabel.current || '✋'} untuk mulai</span>
                            </div>
                          </>
                        )}
                        {isAutoCapturing && <div id="rec-indicator" className={`rounded-full border-4 border-red-500/50 bg-black/50 backdrop-blur flex items-center justify-center animate-pulse ${isVertical ? 'w-12 h-12' : 'w-16 h-16'}`}><span className={`text-red-500 font-bold ${isVertical ? 'text-xs' : 'text-sm'}`}>REC</span></div>}
                    </div>
                    {/* Right: count + retake */}
                    <div className="flex flex-col items-end gap-1.5 shrink-0">
                        <div id="photo-counter" className={`text-white/70 font-mono ${isVertical ? 'text-xs' : 'text-sm'}`}>{capturedPhotos.length}/{selectedLayoutId ? getEffectiveLayoutConfig(selectedFrame, selectedLayoutId).slots.length : 0}</div>
                    </div>
                </div>
            </div>
        </div>
      )}
      {step === 'EDIT' && (
        <BoothWrapper title="Customize Your Photo" subtitle="Pick a frame and filter" hideAdmin isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} uiMode={uiMode} hideLogos isVertical={isVertical}>
            {/* VERTICAL: stack preview top + controls bottom. HORIZONTAL: side by side */}
            <div className={`h-full flex ${isVertical ? 'flex-col' : 'flex-row'} overflow-hidden bg-[#0a1128] relative text-white`}>
                {/* Preview area – top in vertical, left in horizontal.
                    Perbaikan (2026-09-30): preview di vertikal terpotong bar atas
                    karena maxHeight (45vh) melebihi tinggi wadahnya (38%) —
                    bagian atas kegunting tepat di bawah bar. Wadah diberi ruang
                    atas lebih (pt-5) dan tinggi preview disetel di bawah wadah
                    (34vh) supaya utuh dan sedikit tersibak ke bawah. */}
                <div className={`flex flex-col items-center justify-center overflow-hidden relative ${isVertical ? 'h-[40%] shrink-0 px-2 pb-2 pt-5' : 'flex-1 p-12'}`}>
                    <div className="w-full h-full flex items-center justify-center drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)]">
                        <PreviewComponent maxHeightStr={isVertical ? '34vh' : '75vh'} />
                    </div>
                    {!isVertical && (
                      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-max flex items-center justify-center gap-12 opacity-100 pointer-events-none">
                          <img src="/assets/LOGO UNI INSIDE.png" alt="Uni Inside" className="h-12 md:h-16 object-contain" />
                          <img src="/assets/LOGO KOLAB.png" alt="Kolab" className="h-12 md:h-16 object-contain" />
                          <img src="/assets/LOGO UNI SMILE.png" alt="Uni Smile" className="h-12 md:h-16 rounded-xl object-contain" />
                      </div>
                    )}
                </div>

                {/* Controls – bottom in vertical, right in horizontal */}
                <div className={`bg-[#0c1633] border-white/10 flex flex-col z-20 shadow-[-10px_0_40px_rgba(0,0,0,0.3)] overflow-hidden ${isVertical ? 'flex-1 border-t min-h-0' : 'w-[450px] border-l'}`}>
                    {/* Tabs */}
                    <div className={`grid grid-cols-2 shrink-0 border-b border-white/5 ${isVertical ? 'gap-1.5 p-2' : 'gap-2 p-3'}`}>
                        <button 
                            onClick={() => setEditTab('FRAMES')} 
                            className={`rounded-lg font-bold uppercase tracking-tight transition-all ${isVertical ? 'py-6 text-lg' : 'py-5 text-xl'} ${editTab === 'FRAMES' ? 'bg-[#f6cd46] text-black shadow-[0_0_15px_rgba(246,205,70,0.3)]' : 'bg-[#1b2b5a] text-white/60 hover:text-white'}`}
                        >
                            1. Pilih Frame
                        </button>
                        <button 
                            onClick={() => setEditTab('FILTERS')} 
                            className={`rounded-lg font-bold uppercase tracking-tight transition-all ${isVertical ? 'py-6 text-lg' : 'py-5 text-xl'} ${editTab === 'FILTERS' ? 'bg-[#f6cd46] text-black shadow-[0_0_15px_rgba(246,205,70,0.3)]' : 'bg-[#1b2b5a] text-white/60 hover:text-white'}`}
                        >
                            2. Pilih Filter
                        </button>
                    </div>

                    {/* Content Area */}
                    <div className={`flex-1 overflow-y-auto min-h-0 custom-scrollbar ${isVertical ? 'p-1.5' : 'p-4'}`}>
                        {editTab === 'FRAMES' ? (
                            <div className={`grid px-1 ${isVertical ? 'grid-cols-4 gap-1.5' : 'grid-cols-2 gap-3'}`}>
                                {(!selectedLayoutId || frames.filter(f => f.id === selectedLayoutId).flatMap(f => f.styles).length === 0) && (
                                    <p className="col-span-4 text-white/40 italic p-4 text-center text-sm">No frames available for this layout.</p>
                                )}
                                {frames.filter(f => f.id === selectedLayoutId).flatMap(f => f.styles).map(style => {
                                    const cfg = getEffectiveLayoutConfig(style, selectedLayoutId);
                                    return (
                                        <button 
                                            key={style.id} 
                                            onClick={() => setSelectedFrame(style)} 
                                            className={`group relative rounded-lg overflow-hidden transition-all transform active:scale-95 ${selectedFrame?.id === style.id ? 'ring-2 ring-[#f6cd46] ring-offset-2 ring-offset-[#0c1633] scale-[0.98]' : 'hover:scale-[1.02] opacity-80 hover:opacity-100 ring-1 ring-white/10'}`}
                                            style={{ aspectRatio: `${cfg.width} / ${cfg.height}` }}
                                        >
                                            <div className="absolute inset-0 bg-white"><FrameThumbnail style={style} layoutId={selectedLayoutId || '1x1'} /></div>
                                            {selectedFrame?.id === style.id && (
                                                <div className="absolute top-1 right-1 bg-[#f6cd46] text-black p-0.5 rounded-full shadow-lg z-10">
                                                    <Check size={10} strokeWidth={4} />
                                                </div>
                                            )}
                                            <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/80 to-transparent z-10">
                                                <span className="text-white text-[9px] font-bold truncate block">{style.name}</span>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        ) : (
                            <div className={`grid px-1 ${isVertical ? 'grid-cols-4 gap-1.5' : 'grid-cols-2 gap-3'}`}>
                                {filters.map(f => (
                                    <button 
                                        key={f.id} 
                                        onClick={() => setSelectedFilter(f)} 
                                        className={`group relative aspect-video rounded-lg overflow-hidden transition-all transform active:scale-95 ${selectedFilter?.id === f.id ? 'ring-2 ring-[#f6cd46] ring-offset-2 ring-offset-[#0c1633] scale-[0.98]' : 'hover:scale-[1.02] opacity-80 hover:opacity-100 ring-1 ring-white/10'}`}
                                    >
                                        <img src={capturedPhotos[0]} className="w-full h-full object-cover" style={{ filter: f.cssFilter }} />
                                        {selectedFilter?.id === f.id && (
                                            <div className="absolute top-1 right-1 bg-[#f6cd46] text-black p-0.5 rounded-full shadow-lg">
                                                <Check size={10} strokeWidth={4} />
                                            </div>
                                        )}
                                        <div className="absolute bottom-0 left-0 right-0 p-1 bg-gradient-to-t from-black/80 to-transparent text-center">
                                            <span className="text-white text-[9px] font-black uppercase tracking-widest">{f.name}</span>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Bottom Actions */}
                    <div className={`shrink-0 border-t border-white/5 ${isVertical ? 'p-2 space-y-1.5' : 'p-3 space-y-2'}`}>
                        <button 
                            onClick={handleFinish} 
                            className={`w-full bg-white hover:bg-gray-100 text-[#0c1633] rounded-xl font-bold uppercase tracking-wide transition-all active:scale-95 flex items-center justify-center gap-2 shadow-lg ${isVertical ? 'py-8 text-2xl' : 'py-6 text-2xl'}`}
                        >
                            CETAK & SELESAI
                        </button>
                    </div>
                </div>
            </div>
        </BoothWrapper>
      )}

      {step === 'RESULT' && (
        <BoothWrapper title="Your Photos" subtitle="Ready to share!" onAdminClick={onAdminClick} isLocked={isCursorLocked} onToggleLock={() => setIsCursorLocked(!isCursorLocked)} uiMode={uiMode} hideLogos isVertical={isVertical}>
            {/* VERTICAL: stack QR top + preview bottom. HORIZONTAL: panel left + preview right */}
            <div className={`h-full flex ${isVertical ? 'flex-col' : 'flex-row'} overflow-hidden bg-[#0a1128] relative text-white`}>
                 {/* QR / info panel – left in horizontal, top in vertical */}
                 <div className={`flex bg-[#0c1633] border-white/10 z-20 shrink-0 ${
                   isVertical
                     ? 'w-full border-b flex-row items-center gap-3 px-3 py-2.5' 
                     : 'w-full lg:w-[450px] xl:w-[500px] h-full border-r flex-col items-center justify-center p-8 lg:p-12 overflow-y-auto custom-scrollbar'
                 }`} style={isVertical ? { height: '36%' } : {}}>
                     {/* QR Code block */}
                     <div className={`bg-[#1b2b5a] rounded-3xl flex flex-col items-center justify-center border-4 transition-colors shrink-0 ${
                       downloadUrl ? 'border-green-400' : 'border-dashed border-white/20'
                     } ${isVertical ? 'h-full aspect-square p-1.5' : 'w-full max-w-[360px] p-8 mb-6 shadow-[0_10px_40px_rgba(0,0,0,0.5)]'}`}>
                         {downloadUrl ? (
                             <>
                                 {/* QR memenuhi kotak bordernya (2026-09-30) — dulu
                                     gambar 80px menyisakan ruang kosong besar di
                                     dalam border. Setelah sempat flex-1 penuh dan
                                     terasa kebesaran, kini tinggi tetap yang lebih
                                     moderat: mengisi border tanpa mendominasi layar. */}
                                 {/* Bingkai PAS mengelilingi QR (persegi, bukan
                                     selebar panel): di vertikal tinggi 24vh dengan
                                     aspect-square; di horizontal lebar mengikuti isi
                                     (w-fit) — keduanya di-tengah agar rapi. */}
                                 <div className={`bg-white rounded-2xl shadow-xl animate-fade-in overflow-hidden ${isVertical ? 'h-[24vh] aspect-square mx-auto p-1.5 mb-1 flex items-center justify-center' : 'w-fit mx-auto p-3 mb-5'}`}>
                                      {(() => {
                                        const qrTarget = encodeURIComponent(downloadUrl);
                                        return (
                                          <img
                                            src={`https://api.qrserver.com/v1/create-qr-code/?size=500x500&margin=2&data=${qrTarget}`}
                                            alt="QR Code"
                                            className={isVertical ? 'h-full w-full object-contain' : 'w-[220px] h-[220px]'}
                                          />
                                        );
                                      })()}
                                 </div>
                                 <span className={`font-black text-green-400 ${isVertical ? 'text-base' : 'text-3xl mb-1 tracking-tight'}`}>Scan to Download</span>
                                 {!isVertical && <span className="text-base font-medium text-white/50">Valid for 24 hours</span>}
                                 {!isVertical && (
                                   <span className="mt-3 px-4 py-2 text-center text-sm font-bold text-[#f6cd46] bg-[#f6cd46]/10 border border-[#f6cd46]/40 rounded-xl">
                                     ⚠ Jangan tutup halaman ini sebelum QR berhasil discan!
                                   </span>
                                 )}
                             </>
                         ) : (
                             <div className="flex flex-col items-center text-white/40 text-center">
                                 {uploadStatus === 'error' ? (
                                     <>
                                         <AlertCircle size={isVertical ? 32 : 80} className="text-red-400" />
                                         <span className={`font-bold text-red-300 text-center ${isVertical ? 'text-xs mt-1' : 'text-lg mt-4 mb-4'}`}>{uploadError || 'Upload ke backend gagal.'}</span>
                                     </>
                                 ) : uploadStatus === 'uploading' ? (
                                     <>
                                         <Loader2 size={isVertical ? 32 : 80} className="opacity-50 animate-spin" />
                                         <span className={`font-bold ${isVertical ? 'text-xs mt-1' : 'text-lg mt-4 mb-4'}`}>Generating QR...</span>
                                     </>
                                 ) : (
                                     <>
                                         <QrCode size={isVertical ? 32 : 80} className="opacity-50" />
                                         <span className={`px-2 leading-relaxed ${isVertical ? 'text-[9px] mt-1' : 'text-sm mt-4 px-4'}`}>Please wait while we{isVertical ? ' ' : <br/>}generate your QR Code.</span>
                                     </>
                                 )}
                             </div>
                         )}
                     </div>
                     {/* Info + Buttons — right column in vertical, below QR in horizontal */}
                     <div className={`flex flex-col ${isVertical ? 'flex-1 justify-center gap-1.5 min-w-0' : 'w-full max-w-[360px] mt-2 gap-3'}`}>
                         {!isVertical && (
                           <>
                             <h2 className="text-2xl font-black text-center">Thank you!</h2>
                             <p className="text-white/60 text-center text-xs mb-2">Scan QR to download your photo</p>
                           </>
                         )}
                         {isVertical && downloadUrl && (
                           <p className="text-green-400 font-black text-base text-center">Scan to Download</p>
                         )}
                         {downloadUrl && (
                           <p className={`w-full text-center font-black text-[#f6cd46] bg-[#f6cd46]/10 border border-[#f6cd46]/40 rounded-xl ${isVertical ? 'px-3 py-2.5 text-sm leading-snug' : 'px-5 py-3 text-base'}`}>
                             ⚠ Jangan tutup halaman ini sebelum QR berhasil discan!
                           </p>
                         )}
                         {tombol.retake && (
                         <button onClick={handleRetake} className={`w-full px-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-bold transition-all flex items-center justify-center gap-1.5 border border-white/20 active:scale-95 ${isVertical ? 'py-2 text-xs' : 'py-3'}`}>
                             <RefreshCw size={14} /> New Photo
                         </button>
                         )}
                         <button onClick={handleHome} className={`w-full px-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-bold uppercase tracking-wide transition-all flex items-center justify-center border border-white/20 active:scale-95 ${isVertical ? 'py-6 text-lg' : 'py-5 text-xl'}`}>
                             Home
                         </button>
                     </div>
                 </div>

                 {/* Preview & actions panel – right in horizontal, bottom in vertical */}
                 <div className={`flex-1 flex flex-col items-center overflow-hidden relative ${isVertical ? 'justify-between py-3 px-4' : 'justify-center p-6 pb-28 h-full'}`}>
                    {/* Preview Image */}
                    <div className={`w-full flex items-center justify-center drop-shadow-[0_20px_50px_rgba(0,0,0,0.5)] ${isVertical ? 'flex-1 min-h-0' : 'h-full max-h-[70vh] mt-4'}`}>
                        <PreviewComponent maxHeightStr={isVertical ? '40vh' : '70vh'} shadow={true} id="final-preview-container" />
                    </div>

                    {/* Action Buttons */}
                    <div className={`flex flex-wrap items-center justify-center gap-3 z-20 relative shrink-0 ${isVertical ? 'mt-2 pb-1' : 'absolute bottom-6 right-6'}`}>
                    {/* ------------------------------------------------------
                        TOMBOL CETAK — HANYA SATU YANG TAMPIL.

                        Dulu ada tiga tombol cetak berdampingan ("Print" putih,
                        "Print manual", "Cetak Bluetooth") dan pembeli harus
                        menebak mana yang benar. Sekarang yang tampil hanya
                        "Cetak Bluetooth".

                        Tombol "Print" putih TIDAK dihapus dari kode: ia dipakai
                        sebagai JARING PENGAMAN, dan hanya muncul kalau cetak
                        Bluetooth memang tidak bisa dipakai di perangkat ini
                        (`isBluetoothPrintAvailable()`). Kalau ia dihapus
                        seluruhnya, kiosk di perangkat tanpa Bluetooth tidak
                        punya tombol cetak sama sekali — dan itu kegagalan yang
                        baru ditemukan saat pembeli sudah berdiri di depan mesin.

                        Urutannya penting: yang diperiksa lebih dulu adalah
                        apakah Bluetooth bisa dipakai, bukan sebaliknya.
                        ------------------------------------------------------ */}
                    {selectedPackage === 'print' && tombol.print && (
                        <>
                          {/* Jaring pengaman: hanya saat cetak Bluetooth tidak
                              tersedia di perangkat ini. */}
                          {!isBluetoothPrintAvailable() && (
                            <>
                              <button 
                                  id="btn-print"
                                  onClick={handlePrint}
                                  disabled={!areAssetsReady || isPrintActive || printState === 'success'}
                                  className={`flex items-center gap-2 bg-[#ffffff] hover:bg-[#f0f0f0] text-black rounded-full shadow-[0_10px_20px_rgba(255,255,255,0.3)] transition-all active:scale-95 italic font-serif disabled:opacity-50 disabled:cursor-not-allowed ${isVertical ? 'px-10 py-6 text-2xl' : 'px-14 py-6 text-2xl'}`}
                              >
                                  <Printer size={isVertical ? 20 : 24} className={isPrintActive ? 'animate-pulse' : ''} />
                                  {isAutoPrintEnabled()
                                    ? (printState === 'failed' ? 'Retry Print' : printState === 'success' ? 'Printed' : isPrintActive ? 'Printing...' : 'Print')
                                    : 'Print'}
                              </button>
                              {isAutoPrintEnabled() && printState === 'failed' && isManualPrintFallbackEnabled() && (
                                <button
                                  id="btn-manual-print-fallback"
                                  onClick={() => void handleManualPrint()}
                                  disabled={!areAssetsReady}
                                  className={`flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white border border-white/20 rounded-full transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${isVertical ? 'px-7 py-5 text-lg' : 'px-8 py-5 text-lg'}`}
                                >
                                  <Printer size={isVertical ? 18 : 20} /> Print manual
                                </button>
                              )}
                            </>
                          )}

                          {/*
                            Cetak lewat Bluetooth langsung: photobooth menyambung
                            printer label sendiri, tanpa kiosk-agent dan tanpa
                            server. Tombol ini harus DIKLIK — Web Bluetooth
                            menolak membuka pemilih perangkat di luar gestur
                            pengguna.
                          */}
                          {isBluetoothPrintAvailable() && (
                            <button
                              id="btn-bluetooth-print"
                              onClick={() => void handleBluetoothPrint()}
                              disabled={!areAssetsReady || btPrintState === 'done' || btPrintState === 'connecting' || btPrintState === 'printing'}
                              className={`flex items-center gap-3 bg-[#2563eb] hover:bg-[#1d4ed8] text-white rounded-full shadow-[0_10px_20px_rgba(37,99,235,0.35)] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed ${isVertical ? 'px-12 py-7 text-3xl' : 'px-12 py-7 text-3xl'}`}
                            >
                              <Printer size={isVertical ? 40 : 40} className={btPrintState === 'connecting' || btPrintState === 'printing' ? 'animate-pulse' : ''} />
                              {btPrintState === 'connecting' && 'Menyambungkan…'}
                              {btPrintState === 'printing' && 'Mencetak…'}
                              {btPrintState === 'done' && 'Cetak Bluetooth ✓'}
                              {(btPrintState === 'idle' || btPrintState === 'failed') && 'Cetak Bluetooth'}
                            </button>
                          )}
                        </>
                    )}
                         {tombol.email && (
                         <button 
                            id="btn-email"
                            onClick={() => {
                                const emailForm = document.getElementById('email-form-container');
                                if (emailForm) {
                                    emailForm.classList.toggle('hidden');
                                    emailForm.classList.toggle('flex');
                                }
                            }}
                            disabled={!areAssetsReady || isSending || uploadStatus === 'uploading' || uploadStatus === 'preparing'}
                            className={`flex items-center gap-2 bg-[#f6cd46] hover:bg-[#e5bc35] text-black rounded-full shadow-[0_10px_20px_rgba(246,205,70,0.3)] transition-all active:scale-95 italic font-serif disabled:opacity-50 disabled:cursor-not-allowed ${isVertical ? 'px-8 py-2.5 text-base' : 'px-12 py-4 text-xl'}`}
                        >
                            Send Email
                        </button>
                         )}
                    </div>

                    {btPrintState !== 'idle' && (
                      <div
                        id="bluetooth-print-status"
                        role="status"
                        className={`absolute z-20 rounded-xl px-4 py-2 text-center text-sm font-bold ${isVertical ? 'bottom-24 left-1/2 -translate-x-1/2 max-w-[92%]' : 'bottom-40 right-6 max-w-[430px]'} ${btPrintState === 'done' ? 'bg-green-500/20 text-green-300 border border-green-400/40' : btPrintState === 'failed' ? 'bg-red-500/20 text-red-300 border border-red-400/40' : 'bg-white/10 text-white border border-white/20'}`}
                      >
                        {btPrintState === 'connecting' && (btPrinterName ? `Menyambungkan ke ${btPrinterName}…` : 'Menyambungkan ke printer…')}
                        {btPrintState === 'printing' && 'Mengirim foto ke printer label…'}
                        {btPrintState === 'done' && 'Foto tercetak lewat Bluetooth'}
                        {btPrintState === 'failed' && (btPrintError || 'Cetak Bluetooth gagal.')}

                        {/* Tidak ada lagi tombol pemasangan terpisah.
                            Pemasangan terjadi di dalam klik "Cetak": kalau
                            printer belum pernah dipasangkan di alamat ini,
                            pemilihnya terbuka dari klik itu, lalu langsung
                            mencetak. Tombol "Siapkan Printer" dihapus karena
                            dengan alur itu ia hanya menambah satu langkah dan
                            satu banner galat di antaranya — dan tombol yang
                            tidak lagi diperlukan lebih baik tidak ada daripada
                            menuntun operator ke jalan yang panjang. */}
                      </div>
                    )}

                    {isAutoPrintEnabled() && printState !== 'idle' && (
                      <div
                        id="print-status"
                        role="status"
                        className={`absolute z-20 rounded-xl px-4 py-2 text-center text-sm font-bold ${isVertical ? 'bottom-14 left-1/2 -translate-x-1/2 max-w-[92%]' : 'bottom-24 right-6 max-w-[430px]'} ${printState === 'success' ? 'bg-green-500/20 text-green-300 border border-green-400/40' : printState === 'failed' ? 'bg-red-500/20 text-red-300 border border-red-400/40' : 'bg-white/10 text-white border border-white/20'}`}
                      >
                        {printState === 'preparing' && 'Menyiapkan foto final untuk dicetak...'}
                        {printState === 'uploading' && 'Mengupload foto final...'}
                        {printState === 'queued' && `Print queued${printJobId ? ` (${printJobId.slice(0, 8)}…)` : ''}`}
                        {printState === 'printing' && 'Printer sedang mencetak...'}
                        {printState === 'success' && 'Foto berhasil dicetak'}
                        {printState === 'failed' && (printError || 'Print gagal. Silakan coba lagi.')}
                      </div>
                    )}

                    {/* Email Form Popover */}
                    <div id="email-form-container" className={`hidden absolute bg-[#1b2b5a] rounded-2xl border border-white/10 shadow-2xl animate-fade-in z-30 flex-col gap-3 ${isVertical ? 'left-1/2 -translate-x-1/2 bottom-16 p-4 w-[300px]' : 'right-6 bottom-24 p-6 w-[400px]'}`}>
                        {/* Form — selalu ada di DOM, disembunyikan saat sudah terkirim */}
                        <form onSubmit={handleSendEmail} className="flex flex-col gap-3" style={{ display: isSent ? 'none' : 'flex' }}>
                            <h3 className={`text-white font-bold ${isVertical ? 'text-sm' : 'text-lg'}`}>Send via Email</h3>
                            <input 
                              id="input-email"
                              type="email" 
                              placeholder="Enter your email address" 
                              value={email} 
                              onChange={(e) => { setEmail(e.target.value); setEmailError(null); }} 
                              className={`w-full bg-[#0a1128] border rounded-xl px-4 text-white focus:outline-none transition-colors ${emailError ? 'border-red-400 focus:border-red-400' : 'border-white/20 focus:border-[#f6cd46]'} ${isVertical ? 'py-2 text-sm' : 'py-3'}`} 
                            />
                            <div 
                              id="notif-error"
                              className="flex items-start gap-2 bg-red-500/15 border border-red-500/30 rounded-xl px-3 py-2"
                              style={{ display: emailError ? 'flex' : 'none' }}
                            >
                              <span className="text-red-400 text-xs leading-relaxed">{emailError || ''}</span>
                            </div>
                            <button id="btn-send-email" type="submit" disabled={isSending} className={`w-full bg-[#f6cd46] text-black rounded-xl font-bold hover:bg-[#e5bc35] transition-colors disabled:opacity-50 flex items-center justify-center gap-2 ${isVertical ? 'py-2 text-sm' : 'py-3'}`}>
                                {isSending ? (
                                  <><Loader2 size={16} className="animate-spin" /> Mengirim...</>
                                ) : (
                                  <>Send <Send size={16} /></>
                                )}
                            </button>
                        </form>
                        {/* Notif Success — selalu ada di DOM, ditampilkan saat berhasil terkirim */}
                        <div 
                          id="notif-success" 
                          className="bg-green-500/20 border border-green-500/50 text-green-400 rounded-xl p-4 text-center font-bold flex items-center justify-center gap-2"
                          style={{ display: isSent ? 'flex' : 'none' }}
                        >
                            <Check size={24} /> Email Terkirim!
                        </div>
                    </div>

                    {/* Branding Logos */}
                    {!isVertical && (
                      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 w-max flex items-center justify-center gap-12 opacity-80 pointer-events-none">
                          <img src="/assets/LOGO UNI INSIDE.png" alt="Uni Inside" className="h-12 md:h-16 object-contain" />
                          <img src="/assets/LOGO KOLAB.png" alt="Kolab" className="h-12 md:h-16 object-contain" />
                          <img src="/assets/LOGO UNI SMILE.png" alt="Uni Smile" className="h-12 md:h-16 rounded-xl object-contain" />
                      </div>
                    )}
                 </div>
            </div>
        </BoothWrapper>
      )}
    </>
  );
}
