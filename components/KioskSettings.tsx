import React, { useState, useEffect } from 'react';
import { getAppConfig, saveAppConfig } from '../services/storageService';
import { checkBackendHealth } from '../services/apiService';
import { AppConfig } from '../types';
import { 
  Settings, Save, Key, Wifi, WifiOff, RefreshCw, CheckCircle2, 
  AlertCircle, ShieldAlert, MousePointer2, Hand, Monitor, Type, Printer 
} from 'lucide-react';
import { NiimbotPrinter, type PrinterPairingState } from '../services/niimbotPrinter';

export const KioskSettings: React.FC = () => {
  // Config state
  const [backendUrl, setBackendUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [kioskId, setKioskId] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [uiMode, setUiMode] = useState<'normal' | 'air-touch'>('normal');
  const [monitorOrientation, setMonitorOrientation] = useState<'horizontal' | 'vertical'>('horizontal');
  
  // Local password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // Status messages
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // API Connection test state
  const [connectionTest, setConnectionTest] = useState<'idle' | 'testing' | 'connected' | 'disconnected'>('idle');

  // --- Printer label (NIIMBOT) ---
  //
  // Pemasangan perangkat dilakukan di sini, SATU KALI, dan bukan saat mencetak.
  // Alasannya bukan selera: Web Bluetooth hanya mengizinkan pemilih perangkat
  // dibuka dari interaksi pengguna. Kalau pemasangan dilakukan di tengah proses
  // cetak, dialognya muncul di saat yang paling buruk — dan kalau tidak dipicu
  // gestur pengguna, ia gagal. Setelah dipasangkan dari alamat ini, izin
  // tersimpan di browser dan cetak berjalan tanpa dialog.
  const [pairing, setPairing] = useState<PrinterPairingState | 'checking' | 'pairing'>('checking');
  const [printerNames, setPrinterNames] = useState<string[]>([]);
  const [printerMsg, setPrinterMsg] = useState('');
  const [printerErr, setPrinterErr] = useState('');

  const refreshPrinterState = async () => {
    const p = new NiimbotPrinter();
    const state = await p.pairingState();
    setPairing(state);
    setPrinterNames(state === 'ready' ? await p.storedDeviceNames() : []);
  };

  useEffect(() => { void refreshPrinterState(); }, []);

  /**
   * Pasangkan printer — HARUS dari klik tombol.
   *
   * Fungsi ini sengaja hanya dipanggil dari onClick: itulah satu-satunya cara
   * sah membuka pemilih perangkat, dan karena itu pula pemasangan tidak bisa
   * dijadikan otomatis.
   */
  const handlePairPrinter = async () => {
    setPrinterErr('');
    setPrinterMsg('');
    if (!NiimbotPrinter.isSupported()) {
      setPrinterErr('Browser ini tidak mendukung Web Bluetooth. Pakai Chrome atau Edge, dan buka lewat HTTPS.');
      return;
    }
    setPairing('pairing');
    const printer = new NiimbotPrinter();
    try {
      const info = await printer.pairNow();
      // Dua hasil berbeda, dan bedanya penting bagi operator: tersambung sekarang,
      // versus izinnya bertahan untuk seterusnya.
      setPrinterMsg(info.pairingPersisted
        ? `Printer siap: ${info.deviceName} (${info.model}). Cetak berikutnya tidak akan menampilkan dialog.`
        : `Printer ${info.deviceName} tersambung, TETAPI browser tidak menyimpan izinnya untuk alamat ini. `
          + 'Cetak berikutnya akan meminta izin lagi. Periksa: mode penyamaran/incognito, izin '
          + 'Bluetooth situs ini, atau pengaturan "hapus data situs saat keluar".');
      await refreshPrinterState();
    } catch (error: any) {
      const msg = String(error?.message || error);
      setPrinterErr(/cancel|user|chooser|No device/i.test(msg)
        ? 'Pemilihan perangkat ditutup. Tekan lagi kalau mau memasangkan printer.'
        : msg);
      await refreshPrinterState();
    }
  };

  useEffect(() => {
    const config = getAppConfig();
    setBackendUrl(config.backendUrl || 'http://localhost:8000');
    setApiKey(config.apiKey || '');
    setKioskId(config.kioskId || 'K-001');
    setSubtitle(config.customSubtitle || '');
    setUiMode(config.uiMode || 'normal');
    setMonitorOrientation(config.monitorOrientation || 'horizontal');
  }, []);

  const handleTestConnection = async () => {
    setConnectionTest('testing');
    const cleanApiKey = apiKey.trim();
    const isActive = await checkBackendHealth(backendUrl, cleanApiKey);
    setConnectionTest(isActive ? 'connected' : 'disconnected');
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const config = getAppConfig();

    // 1. Password change validation if password fields are filled
    let updatedPassword = config.password;
    if (currentPassword || newPassword || confirmPassword) {
      if (currentPassword !== config.password) {
        setStatus('error');
        setMessage('Password saat ini salah.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setStatus('error');
        setMessage('Password baru dan konfirmasi tidak cocok.');
        return;
      }
      if (newPassword.length < 4) {
        setStatus('error');
        setMessage('Password baru minimal harus 4 karakter.');
        return;
      }
      updatedPassword = newPassword;
    }

    // 2. Save complete configuration
    const updatedConfig: AppConfig = {
      password: updatedPassword,
      customSubtitle: subtitle,
      customLogoUrl: config.customLogoUrl, // Keep existing selected logo
      uiMode,
      monitorOrientation,
      backendUrl: backendUrl.trim(),
      apiKey: apiKey.trim(),
      kioskId: kioskId.trim()
    };

    saveAppConfig(updatedConfig);
    
    // Sync credentials with the optional local Kiosk Agent only when explicitly enabled.
    if (String(import.meta.env.VITE_ENABLE_LOCAL_KIOSK_BRIDGE || 'false').toLowerCase() === 'true') {
      const bridgePort = Number(import.meta.env.VITE_LOCAL_BRIDGE_PORT) || 3011;
      fetch(`http://localhost:${bridgePort}/api/update-credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          backendUrl: updatedConfig.backendUrl,
          deviceId: updatedConfig.kioskId,
          deviceToken: updatedConfig.apiKey
        })
      }).catch(err => {
        console.warn('Gagal sinkronisasi dengan Kiosk Agent (mungkin agen sedang offline):', err);
      });
    }

    setStatus('success');
    setMessage('Konfigurasi Kiosk berhasil disimpan secara lokal dan disinkronkan ke Agen!');
    
    // Clear password fields on success
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');

    // Trigger test connection on save
    handleTestConnection();

    setTimeout(() => {
      setStatus('idle');
      setMessage('');
    }, 4000);
  };

  const optionClass = (active: boolean) =>
    `flex flex-col items-center justify-center gap-3 p-5 rounded-2xl border-2 transition-all cursor-pointer text-left ${
      active 
        ? 'border-indigo-600 bg-indigo-50/50 text-indigo-700 font-bold shadow-md shadow-indigo-100/50' 
        : 'border-gray-200 hover:border-gray-300 bg-white text-gray-600'
    }`;

  return (
    <div className="max-w-4xl mx-auto pb-16">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight flex items-center gap-3">
          <Settings className="text-indigo-600 animate-spin-slow" size={32} />
          Kiosk Local Setup
        </h1>
        <p className="text-sm text-gray-500 mt-1.5 leading-relaxed">
          Atur koneksi ke database pusat Backend API Server serta kustomisasi UI / layout fisik monitor kiosk.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        
        {/* ── SECTION 1: API CONNECTION ── */}
        <div className="bg-white p-8 rounded-3xl border border-gray-200 shadow-sm space-y-6">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Wifi size={20} className="text-indigo-600" />
              API Server &amp; Kiosk Integration
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">Sambungkan unit kiosk ini ke single source of truth Backend API Server.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Backend API URL</label>
              <input
                type="url"
                required
                value={backendUrl}
                onChange={(e) => {
                  setBackendUrl(e.target.value);
                  setConnectionTest('idle');
                }}
                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm"
                placeholder="http://localhost:8000"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Kiosk ID</label>
              <input
                type="text"
                required
                value={kioskId}
                onChange={(e) => setKioskId(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm"
                placeholder="KSK-TLKM-01"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Kiosk API Key (x-api-key)</label>
            <div className="relative">
              <input
                type="password"
                required
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setConnectionTest('idle');
                }}
                className="w-full pl-11 pr-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm font-mono tracking-wider"
                placeholder="Paste API Key hasil generate Super Admin di sini"
              />
              <Key className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            </div>
            <p className="text-xs text-gray-400 mt-2 leading-relaxed">
              API Key digunakan untuk Machine-to-Machine Auth dalam jangka panjang. Minta Super Admin mendaftarkan Kiosk ID ini di admin dashboard Dian untuk mendapatkan API Key.
            </p>
          </div>

          <div className="pt-2 flex flex-col sm:flex-row gap-4 items-center border-t border-gray-100 pt-6">
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={connectionTest === 'testing'}
              className="flex items-center justify-center gap-2 px-5 py-3 text-sm font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-xl transition-all active:scale-95 disabled:opacity-50"
            >
              {connectionTest === 'testing' ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                <Wifi size={16} />
              )}
              Cek Koneksi Server
            </button>

            {connectionTest === 'connected' && (
              <span className="flex items-center gap-1.5 text-sm text-green-600 font-bold bg-green-50 px-4 py-2 rounded-xl border border-green-200">
                <CheckCircle2 size={16} /> Terhubung ke Backend Server
              </span>
            )}
            {connectionTest === 'disconnected' && (
              <span className="flex items-center gap-1.5 text-sm text-red-600 font-bold bg-red-50 px-4 py-2 rounded-xl border border-red-200">
                <WifiOff size={16} /> Gagal Terhubung. Cek URL / API Key.
              </span>
            )}
          </div>
        </div>

        {/* ── SECTION 2: UI & HARDWARE LAYOUT ── */}
        <div className="bg-white p-8 rounded-3xl border border-gray-200 shadow-sm space-y-8">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Monitor size={20} className="text-indigo-600" />
              UI &amp; Monitor Layout
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">Sesuaikan tampilan antarmuka dan orientasi monitor fisik photobooth.</p>
          </div>

          {/* Navigation Style */}
          <div className="space-y-3">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">Navigation Style</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button type="button" onClick={() => setUiMode('normal')} className={optionClass(uiMode === 'normal')}>
                <div className="flex items-center gap-3">
                  <MousePointer2 size={24} className={uiMode === 'normal' ? 'text-indigo-600' : 'text-gray-400'} />
                  <div>
                    <p className="text-sm font-bold text-gray-800">Normal UI</p>
                    <p className="text-xs text-gray-400 mt-0.5">Touch &amp; mouse control standar. Desain kompak.</p>
                  </div>
                </div>
              </button>
              <button type="button" onClick={() => setUiMode('air-touch')} className={optionClass(uiMode === 'air-touch')}>
                <div className="flex items-center gap-3">
                  <Hand size={24} className={uiMode === 'air-touch' ? 'text-indigo-600' : 'text-gray-400'} />
                  <div>
                    <p className="text-sm font-bold text-gray-800">Air Touch UI</p>
                    <p className="text-xs text-gray-400 mt-0.5">Tombol extra besar, dirancang untuk AI Hand Gesture.</p>
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Monitor Orientation */}
          <div className="space-y-3">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">Monitor Orientation</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button type="button" onClick={() => setMonitorOrientation('horizontal')} className={optionClass(monitorOrientation === 'horizontal')}>
                <div className="w-full flex items-center gap-4">
                  <div className={`w-14 h-9 rounded-md border-2 flex items-center justify-center shrink-0 ${monitorOrientation === 'horizontal' ? 'border-indigo-600 bg-indigo-50' : 'border-gray-300'}`}>
                    <div className={`w-10 h-6 rounded-sm ${monitorOrientation === 'horizontal' ? 'bg-indigo-300' : 'bg-gray-200'}`} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-gray-800">Horizontal (Landscape)</p>
                    <p className="text-xs text-gray-400 mt-0.5">Monitor melebar. Preview di tengah, panel di samping.</p>
                  </div>
                </div>
              </button>
              <button type="button" onClick={() => setMonitorOrientation('vertical')} className={optionClass(monitorOrientation === 'vertical')}>
                <div className="w-full flex items-center gap-4">
                  <div className={`w-9 h-14 rounded-md border-2 flex items-center justify-center shrink-0 ${monitorOrientation === 'vertical' ? 'border-indigo-600 bg-indigo-50' : 'border-gray-300'}`}>
                    <div className={`w-6 h-10 rounded-sm ${monitorOrientation === 'vertical' ? 'bg-indigo-300' : 'bg-gray-200'}`} />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold text-gray-800">Vertical (Portrait)</p>
                    <p className="text-xs text-gray-400 mt-0.5">Monitor tinggi. Layout stack atas-bawah yang optimal.</p>
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Brand/Subtitle */}
          <div className="space-y-2 pt-4 border-t border-gray-100">
            <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider flex items-center gap-1.5">
              <Type size={14} className="text-gray-400" /> Brand / Event Name Subtitle
            </label>
            <input
              type="text"
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm"
              placeholder="e.g. Wedding 2024"
            />
            <p className="text-xs text-gray-400">Teks ini akan muncul sebagai label sekunder pada header photobooth.</p>
          </div>
        </div>

        {/* ── SECTION 3: ACCESS & SECURITY ── */}
        <div className="bg-white p-8 rounded-3xl border border-gray-200 shadow-sm space-y-6">
          <div>
            <h3 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <ShieldAlert size={20} className="text-indigo-600" />
              Security Settings
            </h3>
            <p className="text-xs text-gray-400 mt-0.5">Atur password lokal untuk masuk ke halaman setelan kiosk ini di kemudian hari.</p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Password Saat Ini</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm text-center font-mono"
                placeholder="••••"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Password Baru</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm text-center font-mono"
                placeholder="••••"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Konfirmasi Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border-2 border-gray-200 rounded-xl focus:border-indigo-500 focus:bg-white focus:outline-none transition-all text-sm text-center font-mono"
                placeholder="••••"
              />
            </div>
          </div>
        </div>

        {/* Printer label (NIIMBOT) — dipasangkan DI SINI, sekali, bukan saat mencetak */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6 sm:p-8 space-y-5">
          <div className="flex items-start gap-4">
            <div className="p-3 bg-indigo-50 rounded-xl border border-indigo-100">
              <Printer className="text-indigo-600" size={22} />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-slate-800">Printer Label (NIIMBOT)</h2>
              <p className="text-xs font-semibold text-slate-500 mt-1">
                Dipasangkan sekali di sini. Setelah itu setiap cetak tersambung otomatis tanpa dialog.
              </p>
            </div>
          </div>

          <div id="printer-pairing-state" className={`flex items-center gap-3 p-4 rounded-xl text-sm font-semibold ${
            pairing === 'ready'
              ? 'bg-green-50 text-green-700 border border-green-200'
              : pairing === 'checking'
                ? 'bg-slate-50 text-slate-600 border border-slate-200'
                : 'bg-amber-50 text-amber-700 border border-amber-200'
          }`}>
            {pairing === 'ready' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
            <span>
              {pairing === 'checking' && 'Memeriksa izin Bluetooth untuk alamat ini...'}
              {pairing === 'pairing' && 'Menunggu pilihan printer...'}
              {pairing === 'unsupported' && 'Browser ini tidak mendukung Web Bluetooth.'}
              {pairing === 'no-stored-device' && 'Belum ada printer diizinkan untuk alamat ini.'}
              {pairing === 'ready' && `Siap: ${printerNames.join(', ')}`}
            </span>
          </div>

          {pairing === 'no-stored-device' && (
            <p className="text-xs font-semibold text-slate-500 leading-relaxed">
              Izin Bluetooth tersimpan <strong>per alamat</strong>. Kalau printer dulu dipasangkan
              dari alamat lain (misalnya dari <code>localhost</code>) atau izinnya dicabut, printer itu
              tidak dikenal di alamat ini. Tekan tombol di bawah satu kali.
            </p>
          )}

          {printerMsg && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-green-50 text-green-700 border border-green-200 text-sm font-semibold">
              <CheckCircle2 size={18} className="shrink-0" />
              <span>{printerMsg}</span>
            </div>
          )}
          {printerErr && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-red-50 text-red-700 border border-red-200 text-sm font-semibold">
              <AlertCircle size={18} className="shrink-0" />
              <span>{printerErr}</span>
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              id="btn-pair-printer"
              onClick={() => void handlePairPrinter()}
              disabled={pairing === 'pairing' || pairing === 'unsupported'}
              className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-bold rounded-xl shadow-lg shadow-indigo-100 transition-all cursor-pointer"
            >
              <Printer size={18} />
              {pairing === 'pairing' ? 'Memilih printer...' : 'Siapkan Printer'}
            </button>
            <button
              type="button"
              onClick={() => void refreshPrinterState()}
              className="flex items-center gap-2 px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold rounded-xl transition-all cursor-pointer"
            >
              <RefreshCw size={18} />
              Periksa ulang
            </button>
          </div>
        </div>

        {/* Status notification */}
        {status !== 'idle' && (
          <div className={`flex items-center gap-3 p-4 rounded-2xl text-sm font-semibold animate-fade-in ${
            status === 'success' ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            {status === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
            <span>{message}</span>
          </div>
        )}

        {/* Action Button */}
        <div className="pt-4 flex justify-end">
          <button
            type="submit"
            className="w-full sm:w-auto flex items-center justify-center gap-2 px-8 py-4 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-2xl shadow-xl shadow-indigo-100 hover:shadow-indigo-200 transition-all hover:scale-102 active:scale-98 cursor-pointer"
          >
            <Save size={20} />
            Simpan Konfigurasi Kiosk
          </button>
        </div>

      </form>
    </div>
  );
};
