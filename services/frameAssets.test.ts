import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isSelectedFrameAvailable, resolveFrameArtworkUrl, shouldRefreshFrameCatalog, staleFrameSyncWarning } from './frameAssets.ts';

test('normalizes the Admin background image across API payload shapes', () => {
  assert.equal(
    resolveFrameArtworkUrl({ overlayUrl: '/uploads/assets/frame.png' }, {}, 'https://api.example.test'),
    'https://api.example.test/uploads/assets/frame.png'
  );
  assert.equal(
    resolveFrameArtworkUrl({ background_config: { image_url: 'uploads/bg.webp' } }, {}, 'https://api.example.test'),
    'https://api.example.test/uploads/bg.webp'
  );
  assert.equal(
    resolveFrameArtworkUrl({ asset_file_url: '/uploads/assets/admin.png' }, {}, 'https://api.example.test'),
    'https://api.example.test/uploads/assets/admin.png'
  );
  assert.equal(
    resolveFrameArtworkUrl({}, { backgroundConfig: { imageUrl: 'https://cdn.example.test/current.png' } }, 'https://api.example.test'),
    'https://cdn.example.test/current.png'
  );
});

test('keeps data and blob preview URLs intact', () => {
  assert.equal(resolveFrameArtworkUrl({ image_url: 'data:image/png;base64,abc' }, {}, 'https://api.example.test'), 'data:image/png;base64,abc');
  assert.equal(resolveFrameArtworkUrl({ overlay_url: 'blob:preview' }, {}, 'https://api.example.test'), 'blob:preview');
});

test('refreshes Admin frame data on the frame-edit screen but not during capture/payment', () => {
  assert.equal(shouldRefreshFrameCatalog('LANDING', 'visible'), true);
  assert.equal(shouldRefreshFrameCatalog('EDIT', 'visible'), true);
  assert.equal(shouldRefreshFrameCatalog('CAPTURE', 'visible'), false);
  assert.equal(shouldRefreshFrameCatalog('PAYMENT', 'visible'), false);
  assert.equal(shouldRefreshFrameCatalog('EDIT', 'hidden'), false);
});

test('preserves the active selection when a refreshed Admin catalog still contains it', () => {
  const selected = { id: 'frame-1', overlayUrl: 'old.png' };
  const refreshed = [{ id: 'frame-1', overlayUrl: 'new.png' }];
  assert.equal(isSelectedFrameAvailable(refreshed, selected), true);
  assert.equal(isSelectedFrameAvailable(refreshed, { id: 'frame-2' }), false);
  assert.equal(isSelectedFrameAvailable(refreshed, null), false);
});

test('does not silently present stale cached frames as current Admin data', () => {
  assert.equal(
    staleFrameSyncWarning(),
    'Sinkronisasi frame Admin gagal. Kiosk menampilkan data tersimpan; tekan Retry atau periksa koneksi.'
  );
});

test('wires artwork normalization and safe edit-screen refresh into Photobooth', () => {
  const source = readFileSync(new URL('../components/PhotoBooth.tsx', import.meta.url), 'utf8');
  assert.ok(source.includes('resolveFrameArtworkUrl(style, canonical, getApiConfig().baseUrl)'));
  assert.ok(source.includes('overlayUrl: bustFrameAssetCache(artworkUrl)'));
  assert.ok(source.includes('shouldRefreshFrameCatalog(step, document.visibilityState)'));
  assert.ok(source.includes('isSelectedFrameAvailable(availableStyles, selectedFrame)'));
  assert.ok(source.includes('setTemplateError(staleFrameSyncWarning())'));
});
