/**
 * Attachments Row — image chips for drag/drop and paste attachments
 *
 * Renders a row of thumbnail chips above the textarea. Each chip shows
 * a small image preview, filename, and remove button. Returns null when
 * the array is empty. Cleans up blob URLs on unmount/removal.
 *
 * @module control-panel/AttachmentsRow
 */

import { useEffect, useRef } from 'react';
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

  if (images.length === 0) return null;

  return (
    <div className="crispy-cp-attachments" role="list" aria-label="Attached images">
      {images.map((img) => (
        <div key={img.id} className="crispy-cp-image-chip" role="listitem">
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
        </div>
      ))}
    </div>
  );
}
