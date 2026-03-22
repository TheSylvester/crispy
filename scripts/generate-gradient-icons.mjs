#!/usr/bin/env node
/**
 * Generate gradient logo PNGs from crispy-icon.svg
 * Applies the Warm Ember + Cool Drift gradients as static fills,
 * then exports at multiple sizes for favicon and Discord use.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const mediaDir = join(root, 'media');
const outDir = join(mediaDir, 'icons');

mkdirSync(outDir, { recursive: true });

// Read original SVG
let svg = readFileSync(join(mediaDir, 'crispy-icon.svg'), 'utf8');

// Static gradient defs (no animation — just a nice diagonal sweep)
const gradientDefs = `<defs>
  <linearGradient id="warm-ember" gradientUnits="objectBoundingBox"
    x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#c87818"/>
    <stop offset="30%" stop-color="#e8a020"/>
    <stop offset="60%" stop-color="#f0c860"/>
    <stop offset="100%" stop-color="#e8a020"/>
  </linearGradient>
  <linearGradient id="cool-drift" gradientUnits="objectBoundingBox"
    x1="0" y1="1" x2="1" y2="0">
    <stop offset="0%" stop-color="#155d98"/>
    <stop offset="30%" stop-color="#1a6baa"/>
    <stop offset="60%" stop-color="#2080c0"/>
    <stop offset="100%" stop-color="#1a6baa"/>
  </linearGradient>
</defs>`;

// Inject gradients after </metadata>
svg = svg.replace('</metadata>', '</metadata>\n' + gradientDefs);

// Apply gradient fills
svg = svg.replace('fill="#e8a020"', 'fill="url(#warm-ember)"');
svg = svg.replace('fill="#1a6baa"', 'fill="url(#cool-drift)"');

// Save the gradient SVG
const gradientSvgPath = join(outDir, 'crispy-gradient.svg');
writeFileSync(gradientSvgPath, svg);
console.log('✓ crispy-gradient.svg');

// Export sizes
const sizes = [
  { name: 'favicon-16', size: 16 },
  { name: 'favicon-32', size: 32 },
  { name: 'favicon-48', size: 48 },
  { name: 'apple-touch-icon', size: 180 },
  { name: 'icon-192', size: 192 },
  { name: 'icon-512', size: 512 },
  { name: 'discord-icon', size: 512 },
];

// Use a high-res render then downscale for quality
const hiResSvg = svg.replace('width="400"', 'width="1024"').replace('height="400"', 'height="1024"');
const svgBuffer = Buffer.from(hiResSvg);

for (const { name, size } of sizes) {
  const outPath = join(outDir, `${name}.png`);
  await sharp(svgBuffer)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(outPath);
  console.log(`✓ ${name}.png (${size}x${size})`);
}

// Generate favicon from the original flat SVG (no gradients) — the gradient
// subtlety is lost at 32px, so the solid fills read cleaner at favicon scale.
const faviconSize = 32;
const padding = 2;
const iconSize = faviconSize - padding * 2;
const discRadius = 13; // smaller than full (16) — logo edges peek past the disc

const origSvg = readFileSync(join(mediaDir, 'crispy-icon.svg'), 'utf8');
const hiResOrig = origSvg.replace('width="400"', 'width="1024"').replace('height="400"', 'height="1024"');
const origBuffer = Buffer.from(hiResOrig);

// Trim whitespace borders from the SVG, then resize to fill the icon area
const trimmed = await sharp(origBuffer).trim().png().toBuffer();
const iconRendered = await sharp(trimmed)
  .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .png()
  .toBuffer();

const bgCircle = Buffer.from(`<svg width="${faviconSize}" height="${faviconSize}" xmlns="http://www.w3.org/2000/svg">
  <circle cx="${faviconSize / 2}" cy="${faviconSize / 2}" r="${discRadius}" fill="#626266"/>
</svg>`);

const faviconDest = join(mediaDir, 'favicon.png');
await sharp(bgCircle)
  .composite([{ input: iconRendered, left: padding, top: padding }])
  .png()
  .toFile(faviconDest);
console.log(`✓ favicon.png (${faviconSize}x${faviconSize} with dark background)`);

console.log(`\nAll icons written to ${outDir}/`);
