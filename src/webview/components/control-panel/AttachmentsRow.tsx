/**
 * Attachments Row — image chips for drag/drop and paste attachments
 *
 * Renders a row of thumbnail chips above the textarea. Each chip shows
 * a small image preview, filename, and remove button. Returns null when
 * the array is empty. Cleans up blob URLs on unmount/removal.
 *
 * @module control-panel/AttachmentsRow
 */

import { useEffect, useRef, useCallback } from 'react';
import type { AttachedImage } from './types.js';

interface AttachmentsRowProps {
  images: AttachedImage[];
  onRemove: (id: string) => void;
}

export function AttachmentsRow({ images, onRemove }: AttachmentsRowProps): React.JSX.Element | null {
  const prevUrlsRef = useRef<Set<string>>(new Set());

  // Track and revoke blob URLs for removed images
  useEffect(() => {
    const currentUrls = new Set(images.map((img) => img.thumbnailUrl));
    for (const url of prevUrlsRef.current) {
      if (!currentUrls.has(url) && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    }
    prevUrlsRef.current = currentUrls;

    // Cleanup all remaining blob URLs on unmount
    return () => {
      for (const url of currentUrls) {
        if (url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      }
    };
  }, [images]);

  /** Compute horizontal nudge so the preview stays within the viewport */
  const applyPreviewOffset = useCallback((chip: HTMLElement, preview: HTMLImageElement) => {
    const chipRect = chip.getBoundingClientRect();
    const vw = window.innerWidth;
    const previewWidth = Math.min(preview.naturalWidth || 400, vw * 0.9, 800);
    const previewLeft = chipRect.left + chipRect.width / 2 - previewWidth / 2;

    let offset = 0;
    if (previewLeft < 8) {
      offset = 8 - previewLeft;
    } else if (previewLeft + previewWidth > vw - 8) {
      offset = vw - 8 - (previewLeft + previewWidth);
    }

    chip.style.setProperty('--preview-offset', `${offset}px`);
  }, []);

  /** Nudge preview horizontally when near viewport edges */
  const handleChipMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const chip = e.currentTarget;
    const preview = chip.querySelector<HTMLImageElement>('.crispy-cp-image-chip__preview');
    if (!preview) return;

    // If the image hasn't loaded yet, calculate now with the fallback width
    // and recalculate once dimensions are known
    applyPreviewOffset(chip, preview);

    if (!preview.naturalWidth) {
      preview.addEventListener('load', () => applyPreviewOffset(chip, preview), { once: true });
    }
  }, [applyPreviewOffset]);

  if (images.length === 0) return null;

  return (
    <div className="crispy-cp-attachments" role="list" aria-label="Attached images">
      {images.map((img) => (
        <div
          key={img.id}
          className="crispy-cp-image-chip"
          role="listitem"
          onMouseEnter={handleChipMouseEnter}
        >
          <img
            className="crispy-cp-image-chip__thumb"
            src={img.thumbnailUrl}
            alt={img.fileName}
            width={24}
            height={24}
          />
          <span className="crispy-cp-image-chip__name">{img.fileName}</span>
          <button
            className="crispy-cp-image-chip__remove"
            title={`Remove ${img.fileName}`}
            onClick={() => onRemove(img.id)}
            aria-label={`Remove ${img.fileName}`}
          >
            ×
          </button>
          <img
            className="crispy-cp-image-chip__preview"
            src={img.thumbnailUrl}
            alt={`Preview of ${img.fileName}`}
            loading="lazy"
          />
        </div>
      ))}
    </div>
  );
}
