/**
 * Read Tool Views — custom renderers for Read tool
 *
 * - Compact: dot-line with colored "read" + file path + status
 * - Expanded: file path + line range + file content
 *
 * @module webview/blocks/views/read-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { FilePath } from '../../renderers/tools/shared/FilePath.js';
import { extractResultText, extractImageBlocks, formatCount, inferLanguage } from '../../renderers/tools/shared/tool-utils.js';
import { CodePreview } from '../../renderers/tools/shared/CodePreview.js';
import { ToolCard } from './ToolCard.js';
import { ImageLightbox } from '../../components/ImageLightbox.js';
import { useLightbox } from '../../hooks/useLightbox.js';
import { CompactBlock } from './default-views.js';

const meta = getToolData('Read');

/** Strip cat -n style line number prefixes: "     1\tcontent" → "content" */
function stripLineNumbers(text: string): string {
  return text.replace(/^ *\d+\t/gm, '');
}

interface ReadInput {
  file_path?: string;
  offset?: number;
  limit?: number;
}

// ============================================================================
// Compact View
// ============================================================================

export function ReadCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as ReadInput;
  const filePath = input.file_path ?? extractSubject(block);

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="Read"
      subject={<FilePath path={filePath} />}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function ReadExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as ReadInput;
  const filePath = input.file_path ?? '(unknown)';
  const { lightboxSrc, openLightbox, closeLightbox } = useLightbox();

  // Compute line range string
  let lineRange: string | undefined;
  if (input.offset != null || input.limit != null) {
    const start = (input.offset ?? 0) + 1;
    if (input.limit != null) {
      lineRange = `:${start}-${start + input.limit - 1}`;
    } else {
      lineRange = `:${start}+`;
    }
  }

  const images = extractImageBlocks(result?.content);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Not found'
      : images.length > 0
        ? `${images.length} image${images.length !== 1 ? 's' : ''}`
        : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Read" />
        <FilePath path={filePath} lineRange={lineRange} />
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          {images.length > 0 ? (
            <div className="crispy-blocks-tool-images">
              {images.map((img, i) => {
                const src = `data:${img.source.media_type ?? 'image/jpeg'};base64,${img.source.data}`;
                return (
                  <img
                    key={i}
                    className="crispy-blocks-tool-image"
                    src={src}
                    alt={`Image ${i + 1}`}
                    onClick={() => openLightbox(src)}
                  />
                );
              })}
            </div>
          ) : result.is_error ? (
            <pre className="crispy-tool-result__text crispy-tool-result__text--error">
              {resultText ?? JSON.stringify(result.content, null, 2)}
            </pre>
          ) : resultText ? (
            <CodePreview code={stripLineNumbers(resultText)} language={inferLanguage(filePath)} lineNumbers={false} />
          ) : (
            <pre className="crispy-tool-result__text">
              {JSON.stringify(result.content, null, 2)}
            </pre>
          )}
        </div>
      )}
      {lightboxSrc && (
        <ImageLightbox src={lightboxSrc} alt="Image preview" onClose={closeLightbox} />
      )}
    </ToolCard>
  );
}
