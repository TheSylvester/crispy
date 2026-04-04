/**
 * Re-exports from flexlayout-react that TypeScript's NodeNext module
 * resolution can't resolve (extensionless .d.ts re-exports in the library).
 *
 * Works because esbuild resolves the runtime import at bundle time.
 * @ts-expect-error — TS can't see these exports but they exist at runtime.
 */
// @ts-expect-error — see above
export { Actions, DockLocation } from 'flexlayout-react';
