/**
 * Perf profiling module — gated behind `?perf=1` query param.
 * Zero overhead when disabled: isPerfMode is a module-level constant,
 * so bundlers can tree-shake or branches dead-code-eliminate.
 */

export const isPerfMode =
  typeof window !== 'undefined' && window.location.search.includes('perf=1');

export { PerfStore } from './profiler';
export { PerfProfiler } from './useRenderProfile';
export { PerfOverlay } from './PerfOverlay';
