/**
 * Image Renderer — renders image content blocks as <img> elements
 *
 * Handles both user and assistant image blocks. Constructs a data URI from
 * the base64 source data. The visual layout (right-alignment for user images)
 * is handled by the parent `.message.user` container, not this component.
 *
 * @module webview/renderers/ImageRenderer
 */

import type { ContentBlock, ImageBlock } from '../../core/transcript.js';
import { ImageLightbox } from '../components/ImageLightbox.js';
import { useLightbox } from '../hooks/useLightbox.js';

export function ImageRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  const { source } = block as ImageBlock;
  const { lightboxSrc, openLightbox, closeLightbox } = useLightbox();

  if (!source?.data) {
    return (
      <div className="transcript-image">
        <span style={{ color: 'var(--vscode-descriptionForeground, #888)', fontStyle: 'italic' }}>
          [image]
        </span>
      </div>
    );
  }

  const mediaType = source.media_type || 'image/png';
  const dataUri = `data:${mediaType};base64,${source.data}`;

  return (
    <div className="transcript-image">
      <img
        src={dataUri}
        alt="Attached image"
        onClick={() => openLightbox(dataUri)}
      />
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} alt="Attached image" onClose={closeLightbox} />
      )}
    </div>
  );
}
