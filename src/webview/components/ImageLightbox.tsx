/**
 * Image Lightbox — full-viewport overlay for viewing images at full resolution
 *
 * Renders a dark backdrop with a centered, viewport-constrained image.
 * Dismisses on backdrop click or Escape key. Uses a portal to render at
 * document.body, avoiding stacking-context traps from parent containers.
 *
 * @module webview/components/ImageLightbox
 */

import { useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useIsActiveTab } from '../context/TabContainerContext.js';

interface ImageLightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
}

export function ImageLightbox({ src, alt, onClose }: ImageLightboxProps): React.JSX.Element {
  const isActiveTab = useIsActiveTab();

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    },
    [onClose],
  );

  // Close lightbox when tab becomes inactive — prevents portal from surviving tab switch
  useEffect(() => {
    if (!isActiveTab) onClose();
  }, [isActiveTab, onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return createPortal(
    <div
      className="crispy-lightbox"
      onClick={onClose}
      role="dialog"
      aria-label={alt ?? 'Image preview'}
      aria-modal="true"
    >
      <img
        className="crispy-lightbox__image"
        src={src}
        alt={alt ?? 'Full-size image'}
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
