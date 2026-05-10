import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    root: '.',
    // Disable file-level parallelism — vitest 4's fork pool deadlocks
    // flakily (~2/3 of runs) under any worker count when test files leak
    // HTTP/SSE handles (mock-opencode-server, etc.) and workers can't
    // drain cleanly. Sequential is slower (~41s vs ~19s) but reliable.
    fileParallelism: false,
  },
});
