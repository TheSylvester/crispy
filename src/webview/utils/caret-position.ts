/**
 * Caret Position — pixel coordinates of a caret within a textarea
 *
 * Creates an off-screen mirror div that replicates the textarea's styling,
 * inserts text up to the caret position, and measures the offset of a
 * marker span. Caches the mirror div across calls.
 *
 * @module caret-position
 */

export interface CaretCoordinates {
  top: number;
  left: number;
  height: number;
}

/** CSS properties to copy from the textarea to the mirror div. */
const MIRROR_PROPS = [
  'direction', 'boxSizing',
  'width', 'height',
  'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
  'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration',
  'letterSpacing', 'wordSpacing', 'tabSize',
  'whiteSpace', 'wordWrap', 'wordBreak',
] as const;

let mirrorDiv: HTMLDivElement | null = null;

export function getCaretCoordinates(
  el: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  if (!mirrorDiv) {
    mirrorDiv = document.createElement('div');
    mirrorDiv.id = 'crispy-caret-mirror';
    document.body.appendChild(mirrorDiv);
  }

  const style = mirrorDiv.style;
  const computed = window.getComputedStyle(el);

  // Position off-screen
  style.position = 'absolute';
  style.visibility = 'hidden';
  style.overflow = 'hidden';
  style.top = '0';
  style.left = '-9999px';
  style.whiteSpace = 'pre-wrap';
  style.wordWrap = 'break-word';

  // Copy relevant styles
  for (const prop of MIRROR_PROPS) {
    style[prop as any] = computed[prop as any];
  }

  mirrorDiv.textContent = el.value.substring(0, position);

  const marker = document.createElement('span');
  // Use zero-width space so the span has measurable height
  marker.textContent = '\u200b';
  mirrorDiv.appendChild(marker);

  const coords: CaretCoordinates = {
    top: marker.offsetTop - el.scrollTop,
    left: marker.offsetLeft,
    height: marker.offsetHeight,
  };

  // Clean up marker (mirror div is reused)
  mirrorDiv.textContent = '';

  return coords;
}
