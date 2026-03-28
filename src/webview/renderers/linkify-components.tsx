/**
 * Linkified Markdown Components — react-markdown custom component overrides
 *
 * Intercept string children in <p>, <li>, and <td> elements, run them
 * through the linkification engine, and replace file references with
 * <FileLink> components. Non-string children (JSX, code blocks, etc.)
 * pass through unchanged.
 *
 * @module linkify-components
 */

import React, { type ComponentPropsWithoutRef } from 'react';
import { useFileIndex } from '../context/FileIndexContext.js';
import { FileLink } from '../components/FileLink.js';
import { linkifyText, type Segment } from '../utils/linkify.js';
import { CodeBlock, extractLanguage } from './markdown-components.js';
import type { FileIndex } from '../utils/file-index.js';

/** Inline element types safe to recurse into (won't break semantics). */
const INLINE_RECURSE_TAGS = new Set(['strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'span', 'a']);

/** Check if an element's className contains a KaTeX class — skip linkification inside math. */
function hasKatexClass(className: unknown): boolean {
  return typeof className === 'string' && className.includes('katex');
}

/**
 * Process React children: linkify string children, recurse into inline
 * elements (strong, em, etc.), pass code blocks and other elements through.
 */
function linkifyChildren(children: React.ReactNode, index: FileIndex | null): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (typeof child === 'string') {
      return linkifyString(child, index);
    }

    // Recurse into inline wrapper elements (strong, em, span, etc.)
    // but NOT into code, pre, or other block-level elements.
    if (React.isValidElement(child)) {
      const el = child as React.ReactElement<{ children?: React.ReactNode; className?: unknown }>;
      const tag = typeof el.type === 'string' ? el.type : null;
      if (tag && INLINE_RECURSE_TAGS.has(tag) && el.props.children != null && !hasKatexClass(el.props.className)) {
        return React.cloneElement(el, {}, linkifyChildren(el.props.children, index));
      }
    }

    return child;
  });
}

/** Linkify a single string, returning original string or mixed Fragment array. */
function linkifyString(text: string, index: FileIndex | null): React.ReactNode {
  const segments = linkifyText(text, index);

  // Fast path: no links found, return original string
  if (segments.length === 1 && segments[0].type === 'text') {
    return text;
  }

  return segments.map((seg: Segment, i: number) => {
    if (seg.type === 'text') {
      return <React.Fragment key={i}>{seg.value}</React.Fragment>;
    }

    return (
      <FileLink
        key={i}
        token={seg.token}
        matches={seg.matches}
        line={seg.line}
        col={seg.col}
      >
        {seg.display}
      </FileLink>
    );
  });
}

/**
 * Linkified <p> — replaces react-markdown's default paragraph renderer.
 */
export function LinkifiedP(props: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  const index = useFileIndex();
  return <p {...props}>{linkifyChildren(props.children, index)}</p>;
}

/**
 * Linkified <li> — replaces react-markdown's default list item renderer.
 */
export function LinkifiedLi(props: React.HTMLAttributes<HTMLLIElement>): React.JSX.Element {
  const index = useFileIndex();
  return <li {...props}>{linkifyChildren(props.children, index)}</li>;
}

/**
 * Linkified <td> — replaces react-markdown's default table cell renderer.
 */
export function LinkifiedTd(props: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element {
  const index = useFileIndex();
  return <td {...props}>{linkifyChildren(props.children, index)}</td>;
}

/**
 * Linkified <code> — replaces react-markdown's default code renderer.
 *
 * Fenced code blocks (with `language-*` class) delegate to the original
 * CodeBlock for syntax highlighting — no linkification.
 * Inline code gets linkified string children.
 */
export function LinkifiedCode(props: ComponentPropsWithoutRef<'code'>): React.JSX.Element {
  const { children, className, ...rest } = props;
  const language = extractLanguage(className);
  const index = useFileIndex();

  // Fenced code block — full prism syntax highlighting, no linkification
  if (language) {
    return <CodeBlock {...props} />;
  }

  // Inline code — linkify string children
  return (
    <code className={className} {...rest}>
      {linkifyChildren(children, index)}
    </code>
  );
}
