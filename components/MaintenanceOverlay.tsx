import React, { useEffect, useRef } from 'react';
import { Wrench, ShieldAlert, RefreshCw } from 'lucide-react';

interface MaintenanceOverlayProps {
  onAdminUnlock?: () => void;
}

export const MaintenanceOverlay: React.FC<MaintenanceOverlayProps> = ({ onAdminUnlock }) => {
  const overlayRef = useRef<HTMLDivElement>(null);

  // ── SECURITY: Full keyboard event trap ──
  // Prevents Tab, Enter, Space, and all other keyboard shortcuts from
  // reaching elements behind the overlay while maintenance mode is active.
  useEffect(() => {
    const trapKeyboard = (e: KeyboardEvent) => {
      // Allow admin unlock button to be activated via keyboard
      const target = e.target as HTMLElement;
      if (target?.id === 'btn-admin-unlock-maintenance') return;

      e.stopPropagation();
      e.preventDefault();
    };

    // Capture phase ensures we intercept before any other handler
    document.addEventListener('keydown', trapKeyboard, true);
    document.addEventListener('keypress', trapKeyboard, true);
    document.addEventListener('keyup', trapKeyboard, true);

    // Focus the overlay container to pull focus away from background elements
    if (overlayRef.current) {
      overlayRef.current.focus();
    }

    return () => {
      document.removeEventListener('keydown', trapKeyboard, true);
      document.removeEventListener('keypress', trapKeyboard, true);
      document.removeEventListener('keyup', trapKeyboard, true);
    };
  }, []);

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-[#070b19]/95 backdrop-blur-xl text-white p-6 select-none animate-fade-in pointer-events-auto"
      style={{ outline: 'none' }}
    >
      {/* Dynamic Animated Pulse Background Accent */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[500px] h-[500px] bg-amber-500/10 rounded-full blur-[120px] pointer-events-none" />

      {/* Main Card Container */}
      <div className="relative z-10 max-w-lg w-full bg-white/5 border border-white/10 p-8 md:p-12 rounded-3xl text-center shadow-2xl backdrop-blur-2xl flex flex-col items-center gap-6">
        
        {/* Animated Icon Header */}
        <div className="relative">
          <div className="w-20 h-20 md:w-24 md:h-24 rounded-3xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shadow-inner">
            <Wrench className="w-10 h-10 md:w-12 md:h-12 animate-pulse" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center text-black font-bold shadow-lg">
            <ShieldAlert className="w-5 h-5" />
          </div>
        </div>

        {/* Title & Description */}
        <div>
          <span className="inline-block px-4 py-1.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase tracking-widest mb-4">
            SYSTEM MAINTENANCE
          </span>
          <h1 className="text-2xl md:text-4xl font-extrabold text-white tracking-tight mb-3">
            Kiosk Dalam Perawatan
          </h1>
          <p className="text-sm md:text-base text-gray-300 font-medium leading-relaxed">
            Perangkat photobooth sedang dalam pemeliharaan rutin oleh tim teknisi. Interaksi pelanggan ditutup sementara.
          </p>
        </div>

        {/* Live Status indicator */}
        <div className="w-full pt-4 border-t border-white/10 flex items-center justify-between text-xs text-gray-400">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-amber-400 rounded-full animate-ping" />
            <span>Kiosk Agent: Online</span>
          </div>
          <div className="flex items-center gap-1.5 text-gray-500">
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
            <span>Auto-refreshing</span>
          </div>
        </div>

        {/* Hidden / Subtle Admin Override Button */}
        {onAdminUnlock && (
          <button
            id="btn-admin-unlock-maintenance"
            onClick={onAdminUnlock}
            className="mt-2 text-xs text-gray-500 hover:text-gray-300 underline cursor-pointer transition-colors"
          >
            Akses Admin Kiosk
          </button>
        )}
      </div>

      {/* Footer Branding */}
      <div className="absolute bottom-8 flex items-center gap-4 opacity-50">
        <img src="/assets/title.png" alt="UniSmile" className="h-8 object-contain" />
      </div>
    </div>
  );
};
