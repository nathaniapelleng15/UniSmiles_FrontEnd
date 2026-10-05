import React from 'react';

export interface StickerIcon {
  id: string;
  name: string;
  url: string;
  source: 'openmoji' | 'custom';
}

export interface AppConfig {
  password: string;
  customSubtitle?: string;
  customLogoUrl?: string;
  uiMode: 'normal' | 'air-touch';        // Navigation/gesture mode
  monitorOrientation: 'horizontal' | 'vertical'; // Screen orientation mode
  backendUrl?: string;
  apiKey?: string;
  kioskId?: string;
}

export type GridLayoutId = '1x1' | '2x1' | '3x1' | '4x1' | '2x2' | '2x3' | '3x3';

// --- Frame Editor Types ---

export interface FrameGradientStop {
  color: string;
  offset: number; // 0 to 100
}

export interface FrameBackground {
  type: 'transparent' | 'solid' | 'gradient';
  color?: string; // For solid
  gradientType?: 'linear' | 'radial';
  gradientAngle?: number; // 0-360
  gradientStops?: FrameGradientStop[];
}

export interface FrameElement {
  id: string;
  type: 'text' | 'sticker';
  content: string; // Text content or Image URL
  x: number; // Percentage 0-100
  y: number; // Percentage 0-100
  width: number; // Percentage or px depending on implementation (using px for editor usually better, lets use arbitrary units relative to frame width)
  height: number;
  rotation: number;
  opacity: number; // 0-1
  zIndex: number;
  
  // Text Specific
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string; // 'bold' | 'normal'
  fontStyle?: string; // 'italic' | 'normal'
  textDecoration?: string; // 'underline' | 'none'
  color?: string;
  effect?: 'none' | 'shadow' | 'outline' | 'neon';
  /** Admin image assets use x/y as the top-left corner. */
  anchor?: 'center' | 'top-left';
}

export interface FrameStyle {
  id: string;
  name: string;
  /** Optional per-template price; layout.price remains the fallback. */
  price?: number;
  // Deprecated usage of simple URL, but kept for backward compat if needed, 
  // though we will favor the config below:
  overlayUrl?: string; 
  previewUrl?: string; // Data URI for the preview thumbnail
  
  // New Complex Config
  backgroundConfig: FrameBackground;
  elements: FrameElement[];
}

export interface FrameLayout {
  id: GridLayoutId;
  label: string;
  enabled: boolean;
  price?: number;
  styles: FrameStyle[];
}

export interface PhotoFilter {
  id: string;
  name: string;
  cssFilter: string; // e.g., 'grayscale(100%)' or 'sepia(0.5)'
  enabled: boolean;
}

export interface VirtualBackground {
  id: string;
  name: string;
  url: string;
}

export const DEFAULT_PASSWORD = '1234';
export const STORAGE_KEYS = {
  CONFIG: 'pb_config',
  ICONS: 'pb_icons',
  FRAMES: 'pb_frames',
  FILTERS: 'pb_filters',
  BACKGROUNDS: 'pb_backgrounds_v2'
};

export interface Transaction {
  id: number;
  transaction_code: string;
  session_id: string;
  layout_id: string;
  amount: number;
  payment_method: string;
  status: 'pending' | 'success' | 'failed';
  created_at: string;
}

// Global declaration for custom elements
declare global {
  // Augment Window for MediaPipe libraries loaded via CDN
  interface Window {
    SelfieSegmentation: any;
    Hands: any;
    camera_utils: any;
    draw_utils: any;
    html2canvas: any;
  }
}
