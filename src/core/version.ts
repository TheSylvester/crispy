/**
 * App version — re-exported from package.json so it stays in sync
 * automatically. esbuild inlines the JSON import at build time.
 *
 * @module version
 */

import pkg from '../../package.json';

export const CRISPY_VERSION: string = pkg.version;
