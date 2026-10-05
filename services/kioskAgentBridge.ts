export interface KioskAgentState {
  maintenanceMode: boolean;
  brightness: number;
  volume: number;
  resolution: string;
  paperSize: string;
  allowedLayouts?: string[];
  /**
   * Penyesuaian tampilan foto hasil cetak + kalibrasi termal, diatur dari
   * halaman Pengaturan Admin. Photobooth-lah yang menggambar hasil akhir, jadi
   * nilai ini dipakai di sini — bukan di agent.
   *
   * CATATAN: ini untuk FOTO HASIL, bukan frame yang dikirim ke OCR verifikasi
   * pembayaran. Jalur OCR punya filter sendiri yang sudah dikalibrasi supaya
   * nominal struk terbaca; mengubahnya akan merusak verifikasi pembayaran.
   */
  photoBrightness?: number;
  photoContrast?: number;
  photoSaturation?: number;
  thermalDensity?: number;
  thermalOffsetYPx?: number;
  photoFitMode?: 'fit' | 'stretch';
  /** Penajaman 0..100 dari Admin; 0 = tidak menajamkan. */
  printSharpen?: number;
  /** Nama algoritma abu-abu; bobotnya dihitung di services/oneBitImage.ts. */
  grayscaleAlgorithm?: string;
  /** Tombol layar akhir dari Admin; undefined = belum dilaporkan. */
  showEmailButton?: boolean;
  showRetakeButton?: boolean;
  showPrintButton?: boolean;
}

/*
 * Jembatan ke kiosk-agent lokal (opsional).
 *
 * KENAPA PROBE DULU, BUKAN LANGSUNG SAMBUNG
 *
 * kiosk-agent sering tidak berjalan — saat menguji cetak langsung lewat
 * Bluetooth, agent memang tidak diperlukan. Sebelum ini bridge langsung membuka
 * WebSocket DAN memasang poll `GET /api/kiosk-status` tiap 10 detik ke port yang
 * mati. Yang muncul di konsol kiosk bukan pesan kita, melainkan pesan browser
 * sendiri, dan itu tidak bisa ditekan oleh flag apa pun:
 *
 *   WebSocket connection to 'ws://localhost:3011/' failed
 *   GET http://localhost:3011/api/kiosk-status net::ERR_CONNECTION_REFUSED
 *
 * Pesan itu berulang terus, menutupi error cetak yang sebenarnya.
 *
 * Sekarang alamatnya diperiksa lebih dulu dengan satu probe HTTP ringan. Kalau
 * tidak ada yang menjawab, WebSocket maupun poll TIDAK PERNAH dipasang — jadi
 * tidak ada error browser sama sekali. Pemeriksaan diulang tiap 30 detik, jadi
 * agent yang baru dinyalakan tetap terdeteksi tanpa perlu muat ulang halaman.
 */

type StateCallback = (state: KioskAgentState) => void;

class KioskAgentBridge {
  private socket: WebSocket | null = null;
  private listeners: Set<StateCallback> = new Set();
  private reconnectTimer: any = null;
  private pollTimer: any = null;
  /** Supaya pesan "agent tidak aktif" tidak membanjiri konsol. */
  private warnedOffline = false;
  private enabled = String(import.meta.env.VITE_ENABLE_LOCAL_KIOSK_BRIDGE || 'false').toLowerCase() === 'true';
  private currentPort = Number(import.meta.env.VITE_LOCAL_BRIDGE_PORT) || 3011;

  public currentState: KioskAgentState = {
    maintenanceMode: false,
    brightness: 80,
    volume: 100,
    resolution: '1080x1920',
    paperSize: '4R',
    // Netral sampai agent melaporkan nilai dari Admin.
    photoBrightness: 100,
    photoContrast: 100,
    photoSaturation: 100,
    thermalDensity: 3,
    thermalOffsetYPx: 0,
    photoFitMode: 'fit',
  };

  constructor() {
    if (!this.enabled) return;
    this.start();
  }

  public subscribe(callback: StateCallback): () => void {
    this.listeners.add(callback);
    callback(this.currentState); // Immediate state emit
    return () => {
      this.listeners.delete(callback);
    };
  }

  private notify() {
    this.listeners.forEach(cb => cb(this.currentState));
  }

  /**
   * Periksa apakah agent benar-benar ada, baru sambung.
   *
   * `AbortSignal.timeout` membuat fetch menyerah cepat; tanpanya probe menggantung
   * lama di port yang hanya menerima koneksi tapi tidak menjawab.
   */
  private async start(): Promise<void> {
    let ada = false;
    try {
      const res = await fetch(`http://localhost:${this.currentPort}/api/kiosk-status`,
        { signal: AbortSignal.timeout(1500) });
      ada = res.ok;
      if (ada) {
        const json = await res.json();
        if (json?.data) this.currentState = { ...this.currentState, ...json.data };
        this.notify();
      }
    } catch {
      // Tidak ada yang menjawab: normal kalau agent memang tidak dipakai.
    }

    if (ada) {
      this.warnedOffline = false;
      this.connect();
      this.pollFallback();
      return;
    }

    if (!this.warnedOffline) {
      this.warnedOffline = true;
      console.info('[KioskAgentBridge] kiosk-agent tidak aktif di port ' + this.currentPort
        + ' — pengaturan dari Admin tidak masuk lewat jalur ini. Cetak Bluetooth langsung '
        + 'tidak terpengaruh. Diperiksa ulang tiap 30 detik; pesan ini tidak diulang.');
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { void this.start(); }, 30000);
  }

  private connect() {
    try {
      this.socket = new WebSocket(`ws://localhost:${this.currentPort}`);

      this.socket.onopen = () => {
        this.warnedOffline = false;
        console.log('[KioskAgentBridge] Connected to Local Kiosk Agent service.');
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'INITIAL_STATE' || data.type === 'STATE_UPDATE') {
            this.currentState = { ...this.currentState, ...data.payload };
            this.notify();
          }
        } catch (e) {
          // ignore non-json messages
        }
      };

      // Agent mati di tengah jalan: hentikan poll, lalu kembali memeriksa alamat
      // alih-alih mencoba WebSocket berulang ke port yang sudah mati.
      this.socket.onclose = () => {
        this.stopPolling();
        this.scheduleRecheck();
      };

      this.socket.onerror = () => {
        if (!this.warnedOffline) {
          this.warnedOffline = true;
          console.info('[KioskAgentBridge] sambungan ke kiosk-agent terputus di port '
            + this.currentPort + '. Pengaturan dari Admin tidak masuk lewat jalur ini.');
        }
        if (this.socket) this.socket.close();
      };
    } catch (e) {
      this.scheduleRecheck();
    }
  }

  /** Setelah sempat tersambung, kembali ke pemeriksaan berkala. */
  private scheduleRecheck() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { void this.start(); }, 30000);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private pollFallback() {
    this.stopPolling();
    this.pollTimer = setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:${this.currentPort}/api/kiosk-status`);
        if (res.ok) {
          const json = await res.json();
          if (json.data) {
            // Check if any relevant field changed, especially paperSize
            if (
              json.data.maintenanceMode !== this.currentState.maintenanceMode ||
              json.data.paperSize !== this.currentState.paperSize
            ) {
              this.currentState = { ...this.currentState, ...json.data };
              this.notify();
            }
          }
        }
      } catch (e) {
        // Agent offline atau sedang memuat. Sengaja ditelan: ini jalur
        // pengaturan tambahan, bukan jalur cetak, dan kegagalannya sudah
        // diwakili satu pesan di onerror di atas.
      }
    }, 10000);
  }
}

export const kioskAgentBridge = new KioskAgentBridge();
