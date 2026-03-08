/**
 * Ensure a stub `sharp` package exists in node_modules.
 *
 * @huggingface/transformers unconditionally imports `sharp` for image
 * processing. Voice only uses audio pipelines — sharp is never called.
 * The stub provides a truthy default export so the `if (sharp)` guard
 * in transformers/src/utils/image.js takes the sharp branch (avoiding
 * the `throw new Error('Unable to load image processing library')`)
 * without actually loading the real 30 MB native sharp module.
 *
 * Runs as a postinstall hook so the stub survives `npm ci`.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sharpDir = join(process.cwd(), 'node_modules', 'sharp');

// Don't overwrite a real sharp installation
if (existsSync(join(sharpDir, 'lib'))) {
  process.exit(0);
}

mkdirSync(sharpDir, { recursive: true });

writeFileSync(
  join(sharpDir, 'package.json'),
  JSON.stringify(
    {
      name: 'sharp',
      version: '0.0.1',
      description:
        'Stub — voice uses onnxruntime-node for audio, not sharp for images',
      main: 'index.js',
    },
    null,
    2,
  ) + '\n',
);

writeFileSync(
  join(sharpDir, 'index.js'),
  `// Stub: @huggingface/transformers imports sharp for image processing.
// Voice only uses audio pipelines — this satisfies the import with a
// no-op function so the \`if (sharp)\` guard takes the sharp branch.
function sharpStub() {
  const chain = {
    metadata: async () => ({ channels: 0 }),
    rotate: () => chain,
    raw: () => chain,
    toBuffer: async () => ({
      data: new Uint8Array(0),
      info: { width: 0, height: 0, channels: 0 },
    }),
  };
  return chain;
}
module.exports = sharpStub;
module.exports.default = sharpStub;
`,
);

console.log('  sharp stub created (voice uses onnxruntime-node, not sharp)');
