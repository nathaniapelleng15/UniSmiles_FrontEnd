/**
 * All QR codes use the same download endpoint, while the session code keeps
 * each download page tied to the correct photobooth session.
 */
const configuredDownloadBaseUrl = (import.meta.env.VITE_QR_DOWNLOAD_PAGE_BASE_URL || '').trim();
export const QR_DOWNLOAD_PAGE_BASE_URL = /example\.com|\/download(?:\/|$)/i.test(configuredDownloadBaseUrl)
  ? ''
  : configuredDownloadBaseUrl.replace(/\/+$/, '');

export const getQrDownloadPageUrl = (sessionCode: string): string | null => {
  const code = sessionCode.trim();
  return code && QR_DOWNLOAD_PAGE_BASE_URL
    ? `${QR_DOWNLOAD_PAGE_BASE_URL}/${encodeURIComponent(code)}`
    : null;
};
