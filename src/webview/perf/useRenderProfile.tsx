/**
 * React profiling wrapper — zero overhead when perf mode is off.
 *
 * - PerfProfiler: wraps children in React's <Profiler> when isPerfMode,
 *   passes children through directly when off.
 * - useProfilerCallback: stable onRender callback feeding PerfStore.
 */

import { Profiler, useCallback, type PropsWithChildren, type ProfilerOnRenderCallback } from 'react';
import { isPerfMode } from './index';
import { PerfStore } from './profiler';

/**
 * Stable onRender callback for React's <Profiler>.
 * Only the actualDuration matters for our metrics.
 */
function useProfilerCallback(): ProfilerOnRenderCallback {
  return useCallback<ProfilerOnRenderCallback>(
    (id, _phase, actualDuration) => {
      PerfStore.recordRender(id, actualDuration);
    },
    [],
  );
}

/**
 * Wrap any subtree to record render metrics.
 * When isPerfMode is false, renders children directly (zero overhead).
 *
 * Usage:
 *   <PerfProfiler id="MyComponent">
 *     <MyComponent />
 *   </PerfProfiler>
 */
export function PerfProfiler({
  id,
  children,
}: PropsWithChildren<{ id: string }>): React.JSX.Element {
  const onRender = useProfilerCallback();

  if (!isPerfMode) {
    return children as React.JSX.Element;
  }

  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}
