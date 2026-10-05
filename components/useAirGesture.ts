import { useRef, useState, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────
export type GestureType = 'none' | 'pinch' | 'open_hand' | 'peace' | 'thumb_up';

export interface CursorState { x: number; y: number; }

export interface AirGestureState {
  cursorPos: CursorState | null;
  gesture: GestureType;
  holdProgress: number;
  holdFired: boolean;
  isPinching: boolean;
  isScrolling: boolean;
}

export interface AirGestureCallbacks {
  onHoldClick?: (element: Element) => void;
  /**
   * Pose terbuka ditahan (✋ open_hand, ✌️ peace, 👍 thumb_up).
   * Permintaan operator (2026-09-30): memulai pemotretan bisa dengan jempol
   * ATAU peace, bukan hanya telapak terbuka — jadi ketiga pose dilaporkan
   * lewat SATU callback dengan durasi tahanannya (ms).
   */
  onHoldPose?: (durationMs: number, element: Element | null) => void;
}

interface CalibrationBox {
  minX: number; maxX: number; minY: number; maxY: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SMOOTHING         = 0.65;  // cursor EMA when hand open (0=raw, 1=frozen)

const PINCH_ENTER_RATIO = 0.22;  // gap < 22% handSize  → pinch starts
const PINCH_EXIT_RATIO  = 0.32;  // gap > 32% handSize  → pinch ends (hysteresis)

// --- Click vs Scroll discrimination ---
// Scroll mode ONLY activates when BOTH conditions are met:
//   1. Pinch has been held for at least DRAG_MIN_HOLD_MS
//   2. Hand has moved more than DRAG_THRESHOLD_PX from pinch-start
// This prevents natural hand tremor during a click from accidentally starting scroll.
const DRAG_THRESHOLD_PX = 55;    // px of movement required to enter scroll mode
const DRAG_MIN_HOLD_MS  = 350;   // ms pinch must be held before scroll can activate

// Max pinch duration to still fire a click
const CLICK_MAX_MS      = 2500;

// Min time between two clicks (prevent double-fire)
const CLICK_DEBOUNCE_MS = 500;

// Scroll amplification
const SCROLL_SPEED      = 3.2;

/**
 * Jarak minimal (px) gerakan tangan antar laporan aktivitas idle.
 *
 * Tangan yang dibiarkan terangkat bergetar terus (tremor); tanpa ambang ini
 * cursor diam pun tetap melaporkan "aktivitas" dan hitung mundur tidak pernah
 * jalan walau pengunjung sudah pergi. Dengan ambang ini, hanya gerakan NYATA
 * (atau perubahan gesture seperti pinch/open-hand) yang menghitung sebagai
 * aktivitas — sejalan dengan ambang serupa di desktop-idle-watcher kiosk.
 */
const ACTIVITY_MIN_DELTA_PX = 18;

/** Jeda minimal antar laporan aktivitas idle (ms) — IPC-nya murah tapi bukan gratis. */
const ACTIVITY_THROTTLE_MS = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const dist2D = (a: any, b: any) =>
  Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);

const mapRange = (v: number, lo: number, hi: number): number => {
  const c = (v - lo) / (hi - lo);
  return Math.max(0, Math.min(1, (c - 0.5) * 1.3 + 0.5));
};

const findClickable = (el: Element | null): HTMLElement | null => {
  if (!el) return null;
  const found = el.closest('button, a, [role="button"], .clickable, input, label, select');
  return found instanceof HTMLElement ? found
       : el instanceof HTMLElement    ? el
       : null;
};

const findScrollable = (el: Element | null): Element | null => {
  if (!el || el === document.body) return null;
  const s = window.getComputedStyle(el);
  if (
    (['auto', 'scroll'].includes(s.overflowY) || ['auto', 'scroll'].includes(s.overflow)) &&
    el.scrollHeight > el.clientHeight
  ) return el;
  return findScrollable(el.parentElement);
};

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useAirGesture(
  enabled: boolean,
  calibrationBox: CalibrationBox,
  callbacks: AirGestureCallbacks = {}
) {
  const enabledRef   = useRef(enabled);
  const calibBoxRef  = useRef(calibrationBox);
  const callbacksRef = useRef(callbacks);
  enabledRef.current   = enabled;
  calibBoxRef.current  = calibrationBox;
  callbacksRef.current = callbacks;

  // ── Smoothed cursor for display (NOT updated during pinch) ───────────────
  const smoothedPos   = useRef<{ x: number; y: number } | null>(null);

  // ── Raw/fast tracker – updated every frame including during pinch ─────────
  // This is intentionally NOT heavily smoothed so drag deltas are responsive
  const rawPos        = useRef<{ x: number; y: number } | null>(null);
  const prevRawPos    = useRef<{ x: number; y: number } | null>(null);

  // ── Pinch state ───────────────────────────────────────────────────────────
  const pinchingRef   = useRef(false);
  const isDragging    = useRef(false);         // have we committed to drag mode?
  const pinchStartMs  = useRef(0);
  const pinchStartRaw = useRef<{ x: number; y: number } | null>(null); // raw pos at pinch start
  const frozenCursor  = useRef<{ x: number; y: number } | null>(null); // display freeze pos
  const clickTarget   = useRef<HTMLElement | null>(null);
  const scrollTarget  = useRef<Element | null>(null);
  const lastClickMs   = useRef(0);

  // ── Open-hand (CAPTURE trigger) ──────────────────────────────────────────
  const holdStartRef  = useRef<number | null>(null);

  // ── Pelaporan aktivitas idle ke app desktop ─────────────────────────────
  // Posisi tangan terakhir yang dilaporkan + waktu laporan terakhir.
  const lastActivityPos = useRef<{ x: number; y: number } | null>(null);
  const lastActivityMs  = useRef(0);

  /**
   * Laporkan aktivitas ke shell desktop (window.kioskEmbed.notifyActivity).
   *
   * KENAPA DARI SINI — pelajaran lapangan (2026-09-30)
   *
   * Gesture udara diproses MediaPipe langsung dari frame kamera dan TIDAK
   * menghasilkan event pointer/keyboard/wheel — satu-satunya sumber reset
   * di preload sama sekali tidak melihatnya. Akibatnya pengunjung yang rajin
   * melambai tetap dibawa kembali ke kiosk padahal jelas sedang berinteraksi.
   * Kursor bergerak ATAU gesture terdeteksi (pinch/open_hand) = aktivitas.
   */
  const laporkanAktivitas = useCallback((pos: { x: number; y: number } | null, gestur: GestureType) => {
    const bridge = (window as any).kioskEmbed;
    if (!bridge || typeof bridge.notifyActivity !== 'function') return;

    const now = Date.now();
    const prev = lastActivityPos.current;
    const bergerakJauh = !prev || !pos
      || Math.abs(pos.x - prev.x) > ACTIVITY_MIN_DELTA_PX
      || Math.abs(pos.y - prev.y) > ACTIVITY_MIN_DELTA_PX;
    const adaGesture = gestur !== 'none';

    if (!bergerakJauh && !adaGesture) return;
    if (now - lastActivityMs.current < ACTIVITY_THROTTLE_MS) return;

    lastActivityMs.current  = now;
    lastActivityPos.current = pos ? { ...pos } : null;
    try { bridge.notifyActivity(); } catch { /* bridge sedang tidak bisa dikirim */ }
  }, []);

  const [state, setState] = useState<AirGestureState>({
    cursorPos: null, gesture: 'none', holdProgress: 0,
    holdFired: false, isPinching: false, isScrolling: false,
  });

  const processLandmarks = useCallback((landmarks: any[]) => {
    if (!enabledRef.current) {
      smoothedPos.current = null;
      rawPos.current      = null;
      lastActivityPos.current = null;
      setState(s => ({ ...s, cursorPos: null, gesture: 'none' }));
      return;
    }
    const box = calibBoxRef.current;

    // ── Landmarks ──────────────────────────────────────────────────────────
    const wrist     = landmarks[0];
    const thumbTip  = landmarks[4];
    const indexTip  = landmarks[8];
    const middleTip = landmarks[12];
    const ringTip   = landmarks[16];
    const pinkyTip  = landmarks[20];
    const middleMcp = landmarks[9];

    // ── Gesture classification ────────────────────────────────────────────
    const handSize = dist2D(wrist, middleMcp);
    const pinchGap = dist2D(thumbTip, indexTip);

    const isPinchNow = pinchingRef.current
      ? pinchGap < handSize * PINCH_EXIT_RATIO
      : pinchGap < handSize * PINCH_ENTER_RATIO;

    const fingerUp = (tip: any, mcp: any) => tip.y < mcp.y - handSize * 0.05;
    const isOpenHand =
      !isPinchNow &&
      fingerUp(indexTip,  landmarks[5]) &&
      fingerUp(middleTip, landmarks[9]) &&
      fingerUp(ringTip,   landmarks[13]) &&
      fingerUp(pinkyTip,  landmarks[17]);

    /**
     * PEACE (✌️): telunjuk + tengah tegak, manis + kelingking terlipat.
     * Permintaan operator (2026-09-30): pose ini memulai capture.
     */
    const isPeaceNow =
      !isPinchNow && !isOpenHand &&
      fingerUp(indexTip,  landmarks[5]) &&
      fingerUp(middleTip, landmarks[9]) &&
      !fingerUp(ringTip,  landmarks[13]) &&
      !fingerUp(pinkyTip, landmarks[17]);

    /**
     * JEMPOL (👍): ujung jempol jauh dari telapak DAN jelas DI ATAS pergelangan
     * (y gambar lebih kecil), empat jari lain terlipat. Ambang 0.9×handSize
     * menjauh dari jempol menyamping; 0.55×handSize di atas wrist membedakan
     * dari jempol setengah terangkat saat tangan rileks.
     */
    const isThumbUpNow =
      !isPinchNow && !isOpenHand && !isPeaceNow &&
      dist2D(thumbTip, landmarks[5]) > handSize * 0.9 &&
      thumbTip.y < wrist.y - handSize * 0.55 &&
      !fingerUp(indexTip,  landmarks[5]) &&
      !fingerUp(middleTip, landmarks[9]) &&
      !fingerUp(ringTip,   landmarks[13]) &&
      !fingerUp(pinkyTip,  landmarks[17]);

    const gesture: GestureType =
      isPinchNow    ? 'pinch' :
      isOpenHand    ? 'open_hand' :
      isPeaceNow    ? 'peace' :
      isThumbUpNow  ? 'thumb_up' : 'none';

    // ── Raw position (lightly smoothed, always updated) ──────────────────
    // Used for drag delta – must update every frame for accurate scrolling
    const rawX    = 1 - indexTip.x;
    const rawY    = indexTip.y;
    const targetX = mapRange(rawX, box.minX, box.maxX) * window.innerWidth;
    const targetY = mapRange(rawY, box.minY, box.maxY) * window.innerHeight;

    prevRawPos.current = rawPos.current ? { ...rawPos.current } : null;
    const RAW_SMOOTH = 0.40; // light smoothing on raw tracker
    rawPos.current = rawPos.current
      ? { x: rawPos.current.x * RAW_SMOOTH + targetX * (1 - RAW_SMOOTH),
          y: rawPos.current.y * RAW_SMOOTH + targetY * (1 - RAW_SMOOTH) }
      : { x: targetX, y: targetY };

    // ── Smooth display cursor (only updated when NOT pinching) ───────────
    if (!isPinchNow) {
      smoothedPos.current = smoothedPos.current
        ? { x: smoothedPos.current.x * SMOOTHING + targetX * (1 - SMOOTHING),
            y: smoothedPos.current.y * SMOOTHING + targetY * (1 - SMOOTHING) }
        : { x: targetX, y: targetY };
    }

    // ── Pinch state machine ──────────────────────────────────────────────
    let holdFired = false;

    if (isPinchNow && !pinchingRef.current) {
      // ─── PINCH START ────────────────────────────────────────────────────
      pinchingRef.current  = true;
      isDragging.current   = false;
      pinchStartMs.current = Date.now();

      // Freeze display cursor at current smooth position
      frozenCursor.current  = smoothedPos.current ? { ...smoothedPos.current } : null;

      // Record raw position at pinch start (for drag detection)
      pinchStartRaw.current = rawPos.current ? { ...rawPos.current } : null;

      // Record targets from frozen cursor position
      if (frozenCursor.current) {
        const el = document.elementFromPoint(frozenCursor.current.x, frozenCursor.current.y);
        clickTarget.current  = findClickable(el);
        scrollTarget.current = findScrollable(el);
      }

    } else if (isPinchNow && pinchingRef.current) {
      // ─── STILL PINCHING ─────────────────────────────────────────────────

      // Check if user has dragged enough to commit to scroll.
      // Requires BOTH: enough time held AND enough distance moved.
      // This prevents natural tremor during a click from triggering scroll.
      if (!isDragging.current && rawPos.current && pinchStartRaw.current) {
        const heldMs    = Date.now() - pinchStartMs.current;
        const totalDrag = Math.sqrt(
          (rawPos.current.x - pinchStartRaw.current.x) ** 2 +
          (rawPos.current.y - pinchStartRaw.current.y) ** 2
        );
        if (heldMs >= DRAG_MIN_HOLD_MS && totalDrag > DRAG_THRESHOLD_PX) {
          isDragging.current = true;
        }
      }

      // If dragging: apply scroll based on raw frame-to-frame delta
      if (isDragging.current && rawPos.current && prevRawPos.current) {
        const dx = prevRawPos.current.x - rawPos.current.x;
        const dy = prevRawPos.current.y - rawPos.current.y;
        if (scrollTarget.current) {
          scrollTarget.current.scrollBy(dx * SCROLL_SPEED, dy * SCROLL_SPEED);
        } else {
          window.scrollBy(dx * SCROLL_SPEED, dy * SCROLL_SPEED);
        }
      }

    } else if (!isPinchNow && pinchingRef.current) {
      // ─── PINCH RELEASE ──────────────────────────────────────────────────
      pinchingRef.current = false;
      const wasDragging   = isDragging.current;
      isDragging.current  = false;

      if (!wasDragging) {
        // Short pinch, no drag → fire click
        const now = Date.now();
        const dur = now - pinchStartMs.current;
        if (dur < CLICK_MAX_MS && (now - lastClickMs.current) > CLICK_DEBOUNCE_MS) {
          const el = clickTarget.current;
          if (el) {
            el.click();
            lastClickMs.current = now;
            holdFired = true;
          }
        }
      }
      // If was dragging → no click, scroll already applied

      // Unfreeze display cursor
      frozenCursor.current  = null;
      pinchStartRaw.current = null;
      clickTarget.current   = null;
      scrollTarget.current  = null;
    }

    // ── Hold pose (✋ / ✌️ / 👍) — pemicu mulai capture ───────────────────
    // Satu mekanisme untuk ketiga pose: selama pose terbuka bertahan, durasi
    // dilaporkan tiap frame lewat onHoldPose. Kursor beku (pinch) tetap
    // dipakai sebagai titik elemen supaya target konsisten.
    const displayPos = frozenCursor.current ?? smoothedPos.current;
    const poseTahan: GestureType | null =
      isOpenHand ? 'open_hand'
        : (gesture === 'peace' || gesture === 'thumb_up') ? gesture
        : null;
    if (poseTahan && displayPos) {
      if (!holdStartRef.current) {
        holdStartRef.current = Date.now();
      } else {
        const elapsed = Date.now() - holdStartRef.current;
        callbacksRef.current.onHoldPose?.(
          elapsed,
          document.elementFromPoint(displayPos.x, displayPos.y)
        );
      }
    } else if (!poseTahan) {
      holdStartRef.current = null;
    }

    // ── Commit state ─────────────────────────────────────────────────────
    const cursorPos = frozenCursor.current ?? smoothedPos.current ?? null;

    // Aktivitas idle: tangan terdeteksi & bergerak nyata / gesture aktif.
    laporkanAktivitas(cursorPos, gesture);

    setState({
      cursorPos,
      gesture,
      holdProgress: 0,
      holdFired,
      isPinching: isPinchNow,
      isScrolling: isPinchNow && isDragging.current,
    });

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const processNoHand = useCallback(() => {
    smoothedPos.current   = null;
    rawPos.current        = null;
    prevRawPos.current    = null;
    holdStartRef.current  = null;
    frozenCursor.current  = null;
    pinchStartRaw.current = null;
    lastActivityPos.current = null;
    if (pinchingRef.current) {
      pinchingRef.current  = false;
      isDragging.current   = false;
      clickTarget.current  = null;
      scrollTarget.current = null;
    }
    setState({
      cursorPos: null, gesture: 'none', holdProgress: 0,
      holdFired: false, isPinching: false, isScrolling: false,
    });
  }, []);

  return { state, processLandmarks, processNoHand };
}
