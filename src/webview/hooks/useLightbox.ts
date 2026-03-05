/**
 * useLightbox — manages open/close state for a full-viewport image lightbox
 *
 * Returns the active image src (or null), an open handler for onClick, and
 * a close handler. Pair with <ImageLightbox> for rendering.
 *
 * @module webview/hooks/useLightbox
 */

import { useState, useCallback } from 'react';

interface LightboxState {
  /** Currently active image src, or null when closed */
  lightboxSrc: string | null;
  /** Set as onClick handler on clickable images */
  openLightbox: (src: string) => void;
  /** Pass as onClose to ImageLightbox */
  closeLightbox: () => void;
}

export function useLightbox(): LightboxState {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const openLightbox = useCallback((src: string) => setLightboxSrc(src), []);
  const closeLightbox = useCallback(() => setLightboxSrc(null), []);

  return { lightboxSrc, openLightbox, closeLightbox };
}
