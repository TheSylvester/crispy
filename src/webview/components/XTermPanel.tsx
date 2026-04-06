/**
 * XTermPanel — xterm.js terminal embedded in a FlexLayout border tab
 *
 * Reads `terminalId` from FlexLayout node config. If absent, creates a
 * new PTY via transport and persists the ID back to node config. The PTY
 * survives border collapse — only killed on server shutdown.
 *
 * @module XTermPanel
 */

import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TabNode } from 'flexlayout-react';
import { useTransport } from '../context/TransportContext.js';
import { useTabController } from '../context/TabControllerContext.js';
import { useCwd } from '../hooks/useSessionCwd.js';

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: any[]) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

export function XTermPanel({ node }: { node: TabNode }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const transport = useTransport();
  const { updateTabConfig } = useTabController();
  const cwd = useCwd();

  const existingId = (node.getConfig() as Record<string, unknown> | undefined)?.terminalId as string | undefined;
  const [terminalId, setTerminalId] = useState<string | null>(existingId ?? null);
  const [error, setError] = useState<string | null>(null);

  // Create PTY on first mount if no existing ID
  useEffect(() => {
    if (terminalId) return;
    let cancelled = false;
    transport.createTerminal({ cwd: cwd?.fullPath ?? undefined, cols: 80, rows: 30 })
      .then(({ terminalId: id }) => {
        if (cancelled) return;
        setTerminalId(id);
        updateTabConfig(node.getId(), { terminalId: id });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire xterm.js when we have a terminalId and container
  useEffect(() => {
    if (!containerRef.current || !terminalId) return;

    const term = new Terminal({
      fontSize: 13,
      fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Menlo, Monaco, 'Courier New', monospace",
      scrollback: 10_000,
      cursorBlink: true,
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#aeafad',
        selectionBackground: '#264f78',
      },
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    // Reattach in case this is a reconnect
    transport.attachTerminal(terminalId).catch(() => { /* first mount — no reattach needed */ });

    // User input → server
    const inputDispose = term.onData(data => {
      transport.writeTerminal(terminalId, data);
    });

    // Server output → terminal
    const unsub = transport.onTerminalData(terminalId, data => {
      term.write(data);
    });

    // Resize sync — ResizeObserver handles both the initial fit (once the
    // border panel finishes layout) and subsequent resizes. The first
    // observation fires immediately without debounce so the PTY gets correct
    // dimensions before any output arrives.
    let firstFit = true;
    const debouncedFit = debounce(() => {
      fitAddon.fit();
      transport.resizeTerminal(terminalId, term.cols, term.rows);
    }, 100);
    const ro = new ResizeObserver(() => {
      if (firstFit) {
        firstFit = false;
        fitAddon.fit();
        transport.resizeTerminal(terminalId, term.cols, term.rows);
      } else {
        debouncedFit();
      }
    });
    ro.observe(containerRef.current);

    return () => {
      unsub();
      inputDispose.dispose();
      ro.disconnect();
      term.dispose();
      // NOTE: does NOT call closeTerminal — PTY survives border collapse
    };
  }, [terminalId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="crispy-terminal-loading">{error}</div>;
  if (!terminalId) return <div className="crispy-terminal-loading">Starting terminal…</div>;
  return <div ref={containerRef} className="crispy-terminal" />;
}
