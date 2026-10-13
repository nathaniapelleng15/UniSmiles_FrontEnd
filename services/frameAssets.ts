type FramePayload = Record<string, any> | null | undefined;

/** Resolve frame artwork saved by Admin to a URL the kiosk can actually fetch. */
export const resolveFrameArtworkUrl = (
  style: FramePayload,
  config: FramePayload,
  apiBaseUrl: string,
): string | undefined => {
  const background = style?.backgroundConfig ?? style?.background_config ?? style?.background
    ?? config?.backgroundConfig ?? config?.background_config ?? config?.background;
  const candidates = [
    style?.overlayUrl,
    style?.overlay_url,
    style?.backgroundImageUrl,
    style?.background_image_url,
    background?.imageUrl,
    background?.image_url,
    background?.fileUrl,
    background?.file_url,
    background?.url,
    background?.src,
    style?.assetUrl,
    style?.asset_url,
    style?.asset_file_url,
    style?.imageUrl,
    style?.image_url,
    config?.overlayUrl,
    config?.overlay_url,
    config?.backgroundImageUrl,
    config?.background_image_url,
    config?.assetUrl,
    config?.asset_url,
    config?.asset_file_url,
    config?.imageUrl,
    config?.image_url,
    style?.previewUrl,
    style?.preview_url,
    config?.previewUrl,
    config?.preview_url,
  ];
  const value = candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && candidate.trim().length > 0
  )?.trim();
  if (!value) return undefined;
  if (/^(?:https?:|data:|blob:)/i.test(value)) return value;

  const root = String(apiBaseUrl || '')
    .trim()
    .replace(/\/api\/v1(?:\/kiosk)?$/i, '')
    .replace(/\/+$/, '');
  return root ? `${root}/${value.replace(/^\/+/, '')}` : value;
};

/** Keep Admin polling out of capture/payment while refreshing the live frame picker. */
export const shouldRefreshFrameCatalog = (step: string, visibilityState: string): boolean =>
  visibilityState === 'visible' && (step === 'LANDING' || step === 'EDIT');

/** Preserve the current print selection when refreshed data still contains it. */
export const isSelectedFrameAvailable = (
  availableStyles: FramePayload[] | null | undefined,
  selectedFrame: FramePayload,
): boolean => Boolean(selectedFrame?.id != null && availableStyles?.some(
  (style) => style?.id != null && String(style.id) === String(selectedFrame.id)
));

export const staleFrameSyncWarning = (): string =>
  'Sinkronisasi frame Admin gagal. Kiosk menampilkan data tersimpan; tekan Retry atau periksa koneksi.';
