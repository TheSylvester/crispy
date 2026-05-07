/**
 * Channel idle watcher — channel-agnostic idle/debounce/timeout/grace
 * primitive shared by `awaitChannelIdle` (in session-manager.ts) and the
 * CLI front-ends (`crispy-dispatch.ts`, `crispy-agent.ts`).
 *
 * `awaitChannelIdle` is the channel-driven wrapper. CLI sites use the
 * lower-level `startIdleWatch` directly, feeding messages from the
 * JSON-RPC event stream.
 *
 * @module core/channel-idle
 */

import type { ChannelMessage } from './agent-adapter.js';
import type { SubscriberMessage } from './session-channel.js';
import { log } from './log.js';

/** Idle debounce window (ms). After an idle event, wait this long before
 *  resolving. If 'active' fires within the window, the timer resets.
 *  Prevents spurious early resolution in multi-step agent work. */
export const IDLE_SETTLE_MS = 2000;

/** Grace window (ms) for `awaitChannelIdle` when entering on an
 *  already-idle channel. Closes the postMessage→waitForIdle race where
 *  the channel is briefly idle between the post and the adapter
 *  re-emitting `status:active`. Short enough to feel synchronous when
 *  there really is no work pending; long enough to absorb adapter-event
 *  latency on slow subprocesses. */
export const IDLE_ENTRY_GRACE_MS = 500;

/** Public reason surfaced by the `waitForIdle` RPC. */
export type IdleReason = 'turnComplete' | 'settled' | 'timeout';

/** Helper-internal reason. The extra `'interrupted'` variant is for
 *  callers that supply an `onMessage` interrupt callback (CLI
 *  approval-mode 'fail'). The public `waitForIdle` RPC never passes
 *  `onMessage`, so callers mapping helper output to the RPC will never
 *  see `'interrupted'`. */
export type ChannelIdleResult = IdleReason | 'interrupted';

export interface AwaitChannelIdleOptions {
  /** 0 or omitted = no timeout. */
  timeoutMs?: number;
  /** Called for every `ChannelMessage` received while waiting. Return
   *  `'interrupt'` to short-circuit with reason `'interrupted'` (used
   *  by CLI sites for approval-mode 'fail'). Catchup messages are
   *  filtered before this callback fires. */
  onMessage?: (msg: ChannelMessage) => 'interrupt' | void;
  /** Optional promise that, when settled, must resolve before the
   *  helper resolves an idle reason. Used by `dispatchChildSession` to
   *  defer finalization until the pending→real rekey lands. */
  deferUntil?: Promise<unknown>;
}

export interface IdleWatcher {
  /** Resolves when the watcher reaches a terminal state. */
  readonly promise: Promise<ChannelIdleResult>;
  /** Push a `ChannelMessage` (or catchup) into the watcher. Catchup is
   *  filtered out internally. */
  feed(msg: SubscriberMessage): void;
}

/**
 * Channel-agnostic idle watcher. Drives the same idle-debounce + grace
 * window + deferUntil + onMessage interrupt logic as `awaitChannelIdle`,
 * but lets callers feed events from any source. Used by the host's
 * `awaitChannelIdle` (channel-driven) and by the CLI front-ends
 * (RPC-event-driven), so all four wait sites share one implementation.
 *
 * `alreadyIdle` should be true when the caller knows the source is in
 * an idle state on construction and wants to apply the 500ms grace
 * window. Channel-driven callers compute this from `channel.state` and
 * `channel.pendingApprovals.size`. RPC-driven callers (CLI) leave it
 * false — they always send a turn first, so the source is active by
 * the time they start watching.
 */
export function startIdleWatch(
  options: AwaitChannelIdleOptions = {},
  alreadyIdle = false,
): IdleWatcher {
  const { timeoutMs, onMessage, deferUntil } = options;
  const startedAt = Date.now();

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let deferUntilSettled = !deferUntil;
  let pendingReason: 'turnComplete' | 'settled' | null = null;
  let settled = false;
  let resolveFn!: (reason: ChannelIdleResult) => void;

  const promise = new Promise<ChannelIdleResult>((res) => { resolveFn = res; });

  const clearTimers = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  };

  const finish = (reason: ChannelIdleResult) => {
    if (settled) return;
    settled = true;
    clearTimers();
    log({ level: 'debug', source: 'session', summary: `awaitChannelIdle: resolve (reason: ${reason}, elapsedMs: ${Date.now() - startedAt})` });
    resolveFn(reason);
  };

  const finalizeIdle = (reason: 'turnComplete' | 'settled') => {
    if (settled || pendingReason) return;
    pendingReason = reason;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (deferUntilSettled) finish(reason);
  };

  const feed = (msg: SubscriberMessage): void => {
    if (settled || pendingReason) return;
    if (msg.type === 'catchup') return;

    if (onMessage) {
      const result = onMessage(msg);
      if (result === 'interrupt') {
        finish('interrupted');
        return;
      }
    }

    if (msg.type !== 'event') return;
    const event = msg.event;
    if (event.type !== 'status') return;

    switch (event.status) {
      case 'active':
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        break;
      case 'awaiting_approval':
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        break;
      case 'idle': {
        if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
        if ('turnComplete' in event && event.turnComplete) {
          finalizeIdle('turnComplete');
          return;
        }
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          finalizeIdle('settled');
        }, IDLE_SETTLE_MS);
        break;
      }
    }
  };

  if (deferUntil) {
    const onDeferDone = () => {
      deferUntilSettled = true;
      if (pendingReason && !settled) finish(pendingReason);
    };
    deferUntil.then(onDeferDone, onDeferDone);
  }

  if (timeoutMs && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => finish('timeout'), timeoutMs);
  }

  if (alreadyIdle && deferUntilSettled) {
    graceTimer = setTimeout(() => {
      graceTimer = null;
      finalizeIdle('settled');
    }, IDLE_ENTRY_GRACE_MS);
  }

  return { promise, feed };
}
