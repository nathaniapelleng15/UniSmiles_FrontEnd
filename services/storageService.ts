import { StickerIcon, AppConfig, STORAGE_KEYS, DEFAULT_PASSWORD, FrameLayout, PhotoFilter, VirtualBackground, GridLayoutId, FrameStyle, FrameBackground } from '../types';
import { isUsableKioskApiKey } from './apiService';

// --- CONFIGURATION ---
// Mendapatkan URL Backend API secara dinamis dari config localStorage (agar langsung terupdate jika diubah di UI Settings)
export const getApiBaseUrl = (): string => {
  const stored = localStorage.getItem(STORAGE_KEYS.CONFIG);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.backendUrl) return parsed.backendUrl;
    } catch (_) {}
  }
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
};

// --- Config / Password ---

export const getAppConfig = (): AppConfig => {
  const stored = localStorage.getItem(STORAGE_KEYS.CONFIG);
  const registeredKioskApiKey = localStorage.getItem('unismiles_kiosk_api_key')?.trim() || '';
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      const apiKey = [registeredKioskApiKey, parsed.apiKey, import.meta.env.VITE_KIOSK_API_KEY]
        .find(isUsableKioskApiKey) || '';
      return {
          password: parsed.password || DEFAULT_PASSWORD,
          customSubtitle: parsed.customSubtitle || '',
          customLogoUrl: parsed.customLogoUrl || '',
          uiMode: parsed.uiMode || 'normal',
          monitorOrientation: parsed.monitorOrientation || 'horizontal',
          backendUrl: parsed.backendUrl || import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
          apiKey,
          kioskId: parsed.kioskId || import.meta.env.VITE_KIOSK_ID || 'K-001'
      };
    } catch (e) {
      console.error('Error parsing config', e);
    }
  }
  const apiKey = [registeredKioskApiKey, import.meta.env.VITE_KIOSK_API_KEY]
    .find(isUsableKioskApiKey) || '';
  const defaultConfig: AppConfig = {
      password: DEFAULT_PASSWORD,
      customSubtitle: '',
      customLogoUrl: '',
      uiMode: 'normal',
      monitorOrientation: 'horizontal',
      backendUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
      apiKey,
      kioskId: import.meta.env.VITE_KIOSK_ID || 'K-001'
  };
  saveAppConfig(defaultConfig);
  return defaultConfig;
};

export const saveAppConfig = (config: AppConfig): void => {
  // Config kiosk (password, subtitle, logo, UI mode, backend api settings) disimpan di localStorage
  localStorage.setItem(STORAGE_KEYS.CONFIG, JSON.stringify(config));
};

// --- Icons ---

export const getStoredIcons = (): StickerIcon[] => {
  const stored = localStorage.getItem(STORAGE_KEYS.ICONS);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.error('Error parsing stored icons, resetting to defaults', e);
      localStorage.removeItem(STORAGE_KEYS.ICONS);
    }
  }
  return seedOpenMojiIcons();
};

export const saveStoredIcons = (icons: StickerIcon[]): void => {
  try {
    localStorage.setItem(STORAGE_KEYS.ICONS, JSON.stringify(icons));
  } catch (error) {
    console.error('Storage limit reached', error);
    alert('Storage limit reached! Please delete some assets.');
  }
};

const OPENMOJI_BASE_URL = 'https://openmoji.org/data/color/svg';
const EMOJI_HEX_CODES = [
  '1F600', '1F603', '1F604', '1F601', '1F606', '1F605', '1F923', '1F602', '1F642', '1F643',
  '1F609', '1F60A', '1F607', '1F970', '1F60D', '1F929', '1F618', '1F617', '1F60B', '1F61B',
  '1F61C', '1F92A', '1F61D', '1F911', '1F917', '1F92D', '1F92B', '1F914', '1F910', '1F928',
  '1F610', '1F611', '1F636', '1F60F', '1F612', '1F644', '1F62C', '1F925', '1F60C', '1F614',
  '1F62A', '1F924', '1F634', '1F637', '1F912', '1F915', '1F922', '1F92E', '1F927', '1F975',
  '1F976', '1F974', '1F635', '1F92F', '1F920', '1F973', '1F60E', '1F913', '1F9D0', '1F615',
  '1F61F', '1F641', '1F62E', '1F62F', '1F632', '1F633', '1F97A', '1F626', '1F627', '1F628',
  '1F625', '1F622', '1F62D', '1F631', '1F616', '1F623', '1F61E', '1F613', '1F629', '1F62B',
  '1F971', '1F624', '1F621', '1F620', '1F92C', '1F608', '1F47F', '1F480', '2620', '1F479',
  '1F47A', '1F47B', '1F47D', '1F47E', '1F916', '1F435', '1F412', '1F436', '1F431', '1F981'
];

export const seedOpenMojiIcons = (): StickerIcon[] => {
  try {
     const stored = localStorage.getItem(STORAGE_KEYS.ICONS);
     if (stored) {
         const parsed = JSON.parse(stored);
         if (Array.isArray(parsed) && parsed.length >= 100) return parsed;
     }
  } catch (e) {
      // ignore
  }

  const initialIcons: StickerIcon[] = EMOJI_HEX_CODES.map((hex) => ({
    id: crypto.randomUUID(),
    name: `OpenMoji ${hex}`,
    url: `${OPENMOJI_BASE_URL}/${hex.toUpperCase()}.svg`,
    source: 'openmoji'
  }));
  saveStoredIcons(initialIcons);
  return initialIcons;
};

// --- Frames ---

export const getLayoutConfig = (id: string) => {
    let width, height, slots;
    switch(id) {
        case '1x1': width = 708; height = 1062; break; // 2R with Instax Mini proportions
        case '2x1': width = 591; height = 1772; break; // Strip
        case '3x1': width = 591; height = 1772; break; // Strip
        case '4x1': width = 591; height = 1772; break; // Strip
        case '2x2': width = 1205; height = 1795; break; // 4R
        case '2x3': width = 1205; height = 1795; break; // 4R
        case '3x3': width = 1795; height = 2398; break; // 6R
        default: return { width: 1051, height: 1500, slots: [] };
    }

    if (id === '1x1') {
        slots = [{ x: 40, y: 40, width: 628, height: 782 }];
    } else if (id === '2x1' || id === '3x1' || id === '4x1') {
        const slotCount = id === '2x1' ? 2 : id === '3x1' ? 3 : 4;
        const SLOT_X = 30;
        const SLOT_Y = 30;
        const SLOT_WIDTH = width - 60;
        const GAP = 20;
        const FOOTER_HEIGHT = 250;
        const SLOT_HEIGHT = Math.floor((height - SLOT_Y - FOOTER_HEIGHT - (slotCount - 1) * GAP) / slotCount);
        slots = Array.from({ length: slotCount }, (_, index) => ({
            x: SLOT_X,
            y: SLOT_Y + index * (SLOT_HEIGHT + GAP),
            width: SLOT_WIDTH,
            height: SLOT_HEIGHT
        }));
    } else {
        const rows = id === '2x2' ? 2 : id === '2x3' ? 3 : 3;
        const cols = id === '2x2' ? 2 : id === '2x3' ? 2 : 3;
        const PAD_X = 60, PAD_Y = 70, GAP = 18;
        const availW = width - PAD_X * 2 - (cols - 1) * GAP;
        const availH = height - PAD_Y * 2 - (rows - 1) * GAP;
        const slotW = Math.floor(availW / cols);
        const slotH = Math.floor(availH / rows);
        slots = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                slots.push({
                    x: PAD_X + c * (slotW + GAP),
                    y: PAD_Y + r * (slotH + GAP),
                    width: slotW,
                    height: slotH
                });
            }
        }
    }
    return { width, height, slots };
}

const createDefaultStyles = (gridId: string): FrameStyle[] => {
    const defaults: Partial<FrameStyle>[] = [
        {
            name: 'Classic White',
            backgroundConfig: { type: 'solid', color: '#ffffff' },
            elements: []
        },
        {
            name: 'Neon Night',
            backgroundConfig: {
                type: 'gradient',
                gradientType: 'linear',
                gradientAngle: 45,
                gradientStops: [{color: '#ff00cc', offset: 0}, {color: '#333399', offset: 100}]
            },
            elements: [{
                id: '1', type: 'text', content: 'Party Time', x: 50, y: 92, width: 0, height: 0, rotation: 0, opacity: 1, zIndex: 1,
                fontFamily: 'Neon', fontSize: 60, color: '#ff00ff', effect: 'neon', fontWeight: 'bold'
            }]
        },
        {
            name: 'Sunny Day',
            backgroundConfig: {
                type: 'gradient',
                gradientType: 'radial',
                gradientStops: [{color: '#ffffcc', offset: 0}, {color: '#ff9966', offset: 100}]
            },
            elements: []
        }
    ];

    return defaults.map(d => ({
        id: crypto.randomUUID(),
        name: d.name!,
        backgroundConfig: d.backgroundConfig!,
        elements: d.elements || [],
        overlayUrl: '',
        previewUrl: ''
    }));
};

export const getStoredFrames = (): FrameLayout[] => {
  const defaultFrames: FrameLayout[] = [
    { id: '1x1', label: 'Instax Mini (708x1062)', enabled: true, price: 10000, styles: createDefaultStyles('1x1') },
    { id: '2x1', label: 'Strip 2 (600x1700)', enabled: true, price: 15000, styles: createDefaultStyles('2x1') },
    { id: '3x1', label: 'Strip 3 (600x1700)', enabled: true, price: 17000, styles: createDefaultStyles('3x1') },
    { id: '4x1', label: 'Strip 4 (600x1700)', enabled: true, price: 20000, styles: createDefaultStyles('4x1') },
    { id: '2x2', label: 'Grid 2x2 (900x1200)', enabled: true, price: 20000, styles: createDefaultStyles('2x2') },
    { id: '2x3', label: 'Grid 2x3 (900x1500)', enabled: true, price: 25000, styles: createDefaultStyles('2x3') },
    { id: '3x3', label: 'Grid 3x3 (1285x1900)', enabled: true, price: 30000, styles: createDefaultStyles('3x3') },
  ];

  const stored = localStorage.getItem(STORAGE_KEYS.FRAMES);
  if (stored) {
    try {
        let parsed = JSON.parse(stored) as FrameLayout[];
        if (Array.isArray(parsed) && parsed.length > 0) {
            // Force update if it has the old polaroid label
            const oldPolaroid = parsed.find(p => p.id === '1x1' && (p.label.includes('Polaroid (638x1016)') || p.label.includes('708x1062')));
            if (oldPolaroid) {
                parsed = parsed.map(p => p.id === '1x1' ? defaultFrames[0] : p);
                saveStoredFrames(parsed);
            }
            return parsed;
        }
    } catch (e) {
        console.error('Error parsing stored frames', e);
        localStorage.removeItem(STORAGE_KEYS.FRAMES);
    }
  }
  saveStoredFrames(defaultFrames);
  return defaultFrames;
};

export const saveStoredFrames = (frames: FrameLayout[]): void => {
  localStorage.setItem(STORAGE_KEYS.FRAMES, JSON.stringify(frames));
  // Sync ke backend secara background (non-blocking)
  syncFramesToDatabase(frames).catch(e => console.warn('Background frame sync gagal:', e));
};

// --- Filters ---

export const getStoredFilters = (): PhotoFilter[] => {
  const stored = localStorage.getItem(STORAGE_KEYS.FILTERS);
  if (stored) {
    try {
        return JSON.parse(stored);
    } catch(e) {
        console.error('Error parsing filters', e);
    }
  }
  return seedDefaultFilters();
};

export const seedDefaultFilters = (): PhotoFilter[] => {
  const defaultFilters: PhotoFilter[] = [
    { id: 'normal', name: 'Normal', cssFilter: 'none', enabled: true },
    { id: 'grayscale', name: 'B&W', cssFilter: 'grayscale(100%)', enabled: true },
    { id: 'sepia', name: 'Sepia', cssFilter: 'sepia(100%)', enabled: true },
    { id: 'contrast', name: 'High Contrast', cssFilter: 'contrast(160%)', enabled: true },
    { id: 'brightness', name: 'Bright', cssFilter: 'brightness(130%)', enabled: true },
    { id: 'vintage', name: 'Vintage', cssFilter: 'sepia(50%) contrast(120%) saturate(80%)', enabled: true },
    { id: 'cool', name: 'Cool', cssFilter: 'hue-rotate(180deg) saturate(80%)', enabled: true },
    { id: 'warm', name: 'Warm', cssFilter: 'sepia(30%) saturate(140%)', enabled: true },
    { id: 'fade', name: 'Fade', cssFilter: 'opacity(80%) contrast(90%)', enabled: true },
    { id: 'blur', name: 'Dreamy', cssFilter: 'blur(1px) brightness(110%)', enabled: true },
    { id: 'clarendon', name: 'Vivid', cssFilter: 'contrast(120%) saturate(125%)', enabled: true },
    { id: 'gingham', name: 'Soft', cssFilter: 'brightness(105%) hue-rotate(-10deg)', enabled: true },
    { id: 'moon', name: 'Moon', cssFilter: 'grayscale(100%) brightness(110%) contrast(110%)', enabled: true },
    { id: 'lark', name: 'Lark', cssFilter: 'contrast(90%) brightness(110%) saturate(110%)', enabled: true },
    { id: 'reyes', name: 'Reyes', cssFilter: 'sepia(20%) brightness(110%) contrast(85%)', enabled: true },
    { id: 'slumber', name: 'Slumber', cssFilter: 'saturate(66%) brightness(105%)', enabled: true },
    { id: 'crema', name: 'Crema', cssFilter: 'contrast(90%) saturate(90%)', enabled: true },
    { id: 'aden', name: 'Aden', cssFilter: 'hue-rotate(-20deg) contrast(90%) saturate(85%) brightness(120%)', enabled: true },
    { id: 'perpetua', name: 'Perpetua', cssFilter: 'contrast(110%) brightness(110%) saturate(110%)', enabled: true },
    { id: 'amaro', name: 'Amaro', cssFilter: 'hue-rotate(-10deg) contrast(90%) brightness(110%) saturate(150%)', enabled: true },
    { id: 'mayfair', name: 'Mayfair', cssFilter: 'contrast(110%) saturate(110%)', enabled: true }
  ];
  saveStoredFilters(defaultFilters);
  return defaultFilters;
};

export const saveStoredFilters = (filters: PhotoFilter[]): void => {
  localStorage.setItem(STORAGE_KEYS.FILTERS, JSON.stringify(filters));
  // Sync ke backend secara background (non-blocking)
  syncFiltersToDatabase(filters).catch(e => console.warn('Background filter sync gagal:', e));
};

// --- Backgrounds ---

export const getStoredBackgrounds = (): VirtualBackground[] => {
  const stored = localStorage.getItem(STORAGE_KEYS.BACKGROUNDS);
  if (stored) {
    try {
        return JSON.parse(stored);
    } catch(e) {
        console.error('Error parsing backgrounds', e);
    }
  }
  return seedDefaultBackgrounds();
};

export const seedDefaultBackgrounds = (): VirtualBackground[] => {
  return [];
};

export const saveStoredBackgrounds = (bgs: VirtualBackground[]): void => {
  localStorage.setItem(STORAGE_KEYS.BACKGROUNDS, JSON.stringify(bgs));
};

// --- Backend Syncing Helpers ---

/**
 * Sync frame layouts ke backend sebagai frame_templates.
 * Setiap style dalam setiap layout dikirim sebagai satu frame template.
 */
export const syncFramesToDatabase = async (frames: FrameLayout[]): Promise<boolean> => {
  const baseUrl = getApiBaseUrl();
  try {
    // Kirim setiap style sebagai individual frame template
    const promises = frames.flatMap(layout =>
      layout.styles.map(style =>
        fetch(`${baseUrl}/api/frame_templates`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // The Admin editor is the source of truth. Older code rebuilt
            // these values from the kiosk preset and silently dropped the
            // editor's custom canvas and slots during sync.
            ...( (() => {
              let editorConfig: any = (style as any)._layoutConfig ?? (style as any).layout_config;
              if (typeof editorConfig === 'string') {
                try { editorConfig = JSON.parse(editorConfig); } catch (_) { editorConfig = null; }
              }
              if (Array.isArray(editorConfig)) {
                editorConfig = { slots: editorConfig };
              }
              const preset = getLayoutConfig(layout.id);
              const width = Number(editorConfig?.width ?? editorConfig?.canvasWidth ?? (style as any).width ?? preset.width);
              const height = Number(editorConfig?.height ?? editorConfig?.canvasHeight ?? (style as any).height ?? preset.height);
              const slots = editorConfig?.slots ?? (style as any).slots ?? preset.slots;
              return {
                width,
                height,
                slots,
                units: editorConfig?.units ?? editorConfig?.slotUnits ?? 'pixel',
                slotBorder: editorConfig?.slotBorder ?? (style as any).slotBorder,
                slotBorderColor: editorConfig?.slotBorderColor ?? (style as any).slotBorderColor,
                slotBorderWidth: editorConfig?.slotBorderWidth ?? (style as any).slotBorderWidth
              };
            })() ),
            name: `${layout.label} — ${style.name}`,
            category: layout.id,
            image_url: style.overlayUrl || style.previewUrl || '',
            slot_count: layout.styles.length,
            width: Number((style as any)._layoutConfig?.width ?? (style as any).width ?? getLayoutConfig(layout.id).width),
            height: Number((style as any)._layoutConfig?.height ?? (style as any).height ?? getLayoutConfig(layout.id).height),
            layout_config: {
              layout_id: layout.id,
              layout_label: layout.label,
              ...(() => {
                let editorConfig: any = (style as any)._layoutConfig ?? (style as any).layout_config;
                if (typeof editorConfig === 'string') {
                  try { editorConfig = JSON.parse(editorConfig); } catch (_) { editorConfig = null; }
                }
                if (Array.isArray(editorConfig)) editorConfig = { slots: editorConfig };
                const preset = getLayoutConfig(layout.id);
                return {
                  width: Number(editorConfig?.width ?? editorConfig?.canvasWidth ?? (style as any).width ?? preset.width),
                  height: Number(editorConfig?.height ?? editorConfig?.canvasHeight ?? (style as any).height ?? preset.height),
                  slots: editorConfig?.slots ?? (style as any).slots ?? preset.slots,
                  units: editorConfig?.units ?? editorConfig?.slotUnits ?? 'pixel',
                  slotBorder: editorConfig?.slotBorder ?? (style as any).slotBorder,
                  slotBorderColor: editorConfig?.slotBorderColor ?? (style as any).slotBorderColor,
                  slotBorderWidth: editorConfig?.slotBorderWidth ?? (style as any).slotBorderWidth
                };
              })(),
              layout_price: layout.price,
              layout_enabled: layout.enabled,
              style_id: style.id,
              backgroundConfig: style.backgroundConfig,
              elements: style.elements,
              // Newer Admin saves uploaded logos/stickers separately from
              // text elements. Preserve that field for the kiosk API.
              assetElements: (style as any).assetElements ?? (style as any).asset_elements ?? [],
              previewUrl: style.previewUrl,
              overlayUrl: style.overlayUrl
            }
          })
        }).catch(() => null) // Jangan crash jika satu gagal
      )
    );
    await Promise.allSettled(promises);
    return true;
  } catch (e) {
    console.error('Gagal sync frames ke backend:', e);
    return false;
  }
};

/**
 * Sync filters ke backend.
 * Format backend: { name, css_filter, is_active }
 */
export const syncFiltersToDatabase = async (filters: PhotoFilter[]): Promise<boolean> => {
  const baseUrl = getApiBaseUrl();
  try {
    const promises = filters.map(filter =>
      fetch(`${baseUrl}/api/filters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: filter.name,
          css_filter: filter.cssFilter,
          is_active: filter.enabled ? 1 : 0
        })
      }).catch(() => null)
    );
    await Promise.allSettled(promises);
    return true;
  } catch (e) {
    console.error('Gagal sync filters ke backend:', e);
    return false;
  }
};

export const syncToDatabase = async (): Promise<boolean> => {
  const frames = getStoredFrames();
  const filters = getStoredFilters();
  const framesSuccess = await syncFramesToDatabase(frames);
  const filtersSuccess = await syncFiltersToDatabase(filters);
  return framesSuccess && filtersSuccess;
};

/**
 * Sync data dari Backend API Server ke localStorage kiosk.
 * Filters: diambil penuh dari backend (format baru: css_filter field).
 * Frames: hanya diambil jika localStorage kosong (format backend lebih sederhana).
 */
export const syncFromDatabase = async (): Promise<boolean> => {
  const baseUrl = getApiBaseUrl();
  try {
    // 1. Fetch filters dari backend
    // Format response baru: { success, count, data: [{ id, name, css_filter, is_active }] }
    const filtersRes = await fetch(`${baseUrl}/api/filters`);
    let hasFiltersData = false;
    if (filtersRes.ok) {
      const data = await filtersRes.json();
      if (data.success && data.data && data.data.length > 0) {
        hasFiltersData = true;
        const dbFilters: PhotoFilter[] = data.data.map((row: any) => ({
          id: String(row.id),
          name: row.name,
          cssFilter: row.css_filter,
          enabled: !!row.is_active
        }));
        localStorage.setItem(STORAGE_KEYS.FILTERS, JSON.stringify(dbFilters));
        console.log(`✅ ${dbFilters.length} filter berhasil diambil dari backend`);
      }
    }

    // 2. Fetch frame templates dari backend (/api/kiosk/templates jika ada API Key/Kiosk context, atau fallback ke /api/frame_templates)
    let framesRes = await fetch(`${baseUrl}/api/kiosk/templates`, {
      headers: { 'x-api-key': getAppConfig().apiKey || '' }
    }).catch(() => null);

    if (!framesRes || !framesRes.ok) {
      framesRes = await fetch(`${baseUrl}/api/frame_templates`);
    }

    let hasFramesData = false;
    if (framesRes && framesRes.ok) {
      const data = await framesRes.json();
      if (data.success && data.data && data.data.length > 0) {
        hasFramesData = true;

        // Cek format data: jika mengembalikan array FrameLayout (format /api/kiosk/templates)
        if (data.data[0] && Array.isArray(data.data[0].styles)) {
          const frameLayouts: FrameLayout[] = data.data;
          localStorage.setItem(STORAGE_KEYS.FRAMES, JSON.stringify(frameLayouts));
          console.log(`✅ ${frameLayouts.length} layout frame berhasil diambil dari /api/kiosk/templates`);
        } else {
          // Rekonstruksi FrameLayout dari raw data frame_templates
          const LAYOUT_LABELS: Record<string, string> = {
            '1x1': 'Polaroid',
            '2x1': 'Duo Strip',
            '3x1': 'Trio Strip',
            '4x1': 'Film Strip',
            '2x2': 'Classic 2x2',
            '2x3': 'Collage 6'
          };
          const layoutsMap = new Map<string, FrameLayout>();

          for (const row of data.data) {
            const parsedConfig = typeof row.layout_config === 'string'
              ? JSON.parse(row.layout_config || '[]')
              : (row.layout_config || []);
            const config = parsedConfig && typeof parsedConfig === 'object' && !Array.isArray(parsedConfig)
              ? {
                  ...parsedConfig,
                  width: parsedConfig.width ?? parsedConfig.canvasWidth ?? row.width ?? row.canvas_width,
                  height: parsedConfig.height ?? parsedConfig.canvasHeight ?? row.height ?? row.canvas_height
                }
              : parsedConfig;

            const layoutId = row.layout_id || (config && config.layout_id) || row.category || '1x1';

            if (!layoutsMap.has(layoutId)) {
              layoutsMap.set(layoutId, {
                id: layoutId,
                label: LAYOUT_LABELS[layoutId] || `${layoutId} Layout`,
                enabled: true,
                price: 20000,
                styles: []
              });
            }

            const frameType = row.frame_type || 'color';
            const gradStopsRaw = typeof row.gradient_stops === 'string'
              ? JSON.parse(row.gradient_stops || '[]')
              : (row.gradient_stops || []);
            const textElemsRaw = typeof row.text_elements === 'string'
              ? JSON.parse(row.text_elements || '[]')
              : (row.text_elements || []);

            let backgroundConfig: any = { type: 'solid', color: row.bg_color || '#ffffff' };
            if (frameType === 'gradient' && gradStopsRaw.length > 0) {
              backgroundConfig = {
                type: 'gradient',
                gradientType: row.gradient_style || 'linear',
                gradientAngle: row.gradient_angle ?? 45,
                gradientStops: gradStopsRaw.map((s: any) => ({
                  color: s.color,
                  offset: s.position !== undefined ? s.position : (s.offset ?? 0)
                }))
              };
            } else if (frameType === 'color') {
              backgroundConfig = { type: 'solid', color: row.bg_color || '#ffffff' };
            }

            const elements = textElemsRaw.map((t: any, idx: number) => ({
              id: t.id || `text-${idx}`,
              type: 'text',
              content: t.text || '',
              x: Number(t.x ?? 50),
              y: Number(t.y ?? 50),
              fontSize: Number(t.fontSize || 40),
              fontFamily: t.fontFamily || 'Inter, sans-serif',
              color: t.color || '#FFFFFF',
              fontWeight: t.fontWeight || 'bold',
              opacity: 1,
              rotation: 0
            }));

            const rawUrl = row.image_url ? row.image_url.trim() : '';
            const imageUrl = rawUrl
              ? (rawUrl.startsWith('http') ? rawUrl : `${baseUrl}${rawUrl}`)
              : '';

            layoutsMap.get(layoutId)!.styles.push({
              id: String(row.id),
              name: row.name,
              backgroundConfig: config.backgroundConfig || config.background_config || config.background || backgroundConfig,
              elements: config.elements || elements,
              previewUrl: config.previewUrl || '',
              overlayUrl: imageUrl || config.overlayUrl || '',
              slotBorder: config.slotBorder || config.slot_border,
              slotBorderColor: config.slotBorderColor || config.slot_border_color,
              slotBorderWidth: config.slotBorderWidth || config.slot_border_width,
              _accentColor: row.accent_color || '#FFFFFF',
              _layoutConfig: config
            } as any);
          }

          const frameLayouts = Array.from(layoutsMap.values());
          localStorage.setItem(STORAGE_KEYS.FRAMES, JSON.stringify(frameLayouts));
          console.log(`✅ ${frameLayouts.length} layout frame berhasil diambil dari backend`);
        }
      }
    }

    // Auto-seed default data ke backend jika masih kosong (pertama kali setup)
    if (!hasFiltersData) {
      console.log('📦 Backend kosong, seeding default filters...');
      await syncFiltersToDatabase(getStoredFilters());
    }
    if (!hasFramesData) {
      console.log('📦 Backend kosong, seeding default frames...');
      await syncFramesToDatabase(getStoredFrames());
    }

    return true;
  } catch (error) {
    console.error('Gagal sync dari backend:', error);
    return false;
  }
};
