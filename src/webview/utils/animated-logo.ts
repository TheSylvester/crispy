/**
 * animated-logo — Warm Ember gradient treatment for the Crispy logo SVG
 *
 * Injects an animated SVG linearGradient that drifts gold-to-bronze across
 * the logo paths, matching the Warm Ember text treatment on landing screens.
 * Uses SMIL animateTransform (well-supported, no JS needed).
 *
 * @module animated-logo
 */

// esbuild --loader:.svg=text imports the raw SVG markup as a string
// @ts-expect-error — no type declarations for raw SVG import
import crispyLogoSvg from '../../../media/crispy-icon.svg';

const animatedGradients = `<defs>
  <linearGradient id="crispy-warm-ember" gradientUnits="objectBoundingBox"
    x1="0" y1="0" x2="2" y2="0">
    <stop offset="0%" stop-color="#c87818"/>
    <stop offset="12.5%" stop-color="#e8a020"/>
    <stop offset="25%" stop-color="#f0c860"/>
    <stop offset="37.5%" stop-color="#e8a020"/>
    <stop offset="50%" stop-color="#c87818"/>
    <stop offset="62.5%" stop-color="#e8a020"/>
    <stop offset="75%" stop-color="#f0c860"/>
    <stop offset="87.5%" stop-color="#e8a020"/>
    <stop offset="100%" stop-color="#c87818"/>
    <animateTransform attributeName="gradientTransform" type="translate"
      values="0 0; -1 0; 0 0" dur="8s" repeatCount="indefinite"
      calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1"/>
  </linearGradient>
  <linearGradient id="crispy-cool-drift" gradientUnits="objectBoundingBox"
    x1="0" y1="0" x2="2" y2="0">
    <stop offset="0%" stop-color="#155d98"/>
    <stop offset="12.5%" stop-color="#1a6baa"/>
    <stop offset="25%" stop-color="#2080c0"/>
    <stop offset="37.5%" stop-color="#1a6baa"/>
    <stop offset="50%" stop-color="#155d98"/>
    <stop offset="62.5%" stop-color="#1a6baa"/>
    <stop offset="75%" stop-color="#2080c0"/>
    <stop offset="87.5%" stop-color="#1a6baa"/>
    <stop offset="100%" stop-color="#155d98"/>
    <animateTransform attributeName="gradientTransform" type="translate"
      values="0 0; -1 0; 0 0" dur="12s" repeatCount="indefinite"
      calcMode="spline" keySplines="0.42 0 0.58 1; 0.42 0 0.58 1"/>
  </linearGradient>
</defs>`;

/** Raw logo SVG with animated gradient fills for both gold and blue */
export const animatedLogoSvg: string = (crispyLogoSvg as string)
  .replace('</metadata>', '</metadata>' + animatedGradients)
  .replace('fill="#e8a020"', 'fill="url(#crispy-warm-ember)"')
  .replace('fill="#1a6baa"', 'fill="url(#crispy-cool-drift)"');
