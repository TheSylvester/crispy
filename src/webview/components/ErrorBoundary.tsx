/**
 * ErrorBoundary — React error boundaries for crash resilience
 *
 * Provides two wrappers around a generic class-based ErrorBoundary:
 *
 * - AppErrorBoundary: wraps the entire app; full-page fallback with reload.
 * - ContentErrorBoundary: wraps the main content area; sidebar stays alive.
 *
 * Both fallbacks use inline styles with var(--vscode-*) CSS variables (dark
 * fallbacks) so they render even if stylesheets fail to load.
 *
 * Does NOT provide telemetry, error reporting services, or recovery beyond
 * a full page reload.
 *
 * @module ErrorBoundary
 */

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

// ============================================================================
// Generic ErrorBoundary
// ============================================================================

interface ErrorBoundaryProps {
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] Uncaught error:', error);
    console.error('[ErrorBoundary] Component stack:', info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return this.props.fallback(this.state.error);
    }
    return this.props.children;
  }
}

// ============================================================================
// Shared styles
// ============================================================================

const containerBase: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif)',
  color: 'var(--vscode-foreground, #ccc)',
  background: 'var(--vscode-editor-background, #1e1e1e)',
};

const headingStyle: React.CSSProperties = {
  margin: '0 0 8px',
  fontSize: '16px',
  fontWeight: 600,
};

const errorTextStyle: React.CSSProperties = {
  margin: '0 0 16px',
  fontSize: '12px',
  color: 'var(--text-tertiary)',
  maxWidth: '480px',
  textAlign: 'center',
  wordBreak: 'break-word',
};

const buttonStyle: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: '13px',
  border: '1px solid var(--vscode-button-border, transparent)',
  borderRadius: '2px',
  cursor: 'pointer',
  color: 'var(--vscode-button-foreground, #fff)',
  background: 'var(--vscode-button-background, #0e639c)',
};

function reload(): void {
  window.location.reload();
}

// ============================================================================
// AppErrorBoundary — wraps the entire app
// ============================================================================

function AppFallback({ error }: { error: Error }): React.JSX.Element {
  return (
    <div style={{ ...containerBase, width: '100vw', height: '100vh' }}>
      <h1 style={headingStyle}>Something went wrong</h1>
      <p style={errorTextStyle}>{error.message}</p>
      <button type="button" style={buttonStyle} onClick={reload}>
        Reload
      </button>
    </div>
  );
}

export function AppErrorBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <ErrorBoundary fallback={(error) => <AppFallback error={error} />}>
      {children}
    </ErrorBoundary>
  );
}

// ============================================================================
// ContentErrorBoundary — wraps main content, keeps sidebar alive
// ============================================================================

function ContentFallback({ error }: { error: Error }): React.JSX.Element {
  return (
    <div style={{ ...containerBase, width: '100%', height: '100%', padding: '24px' }}>
      <h2 style={headingStyle}>Something went wrong</h2>
      <p style={errorTextStyle}>{error.message}</p>
      <button type="button" style={buttonStyle} onClick={reload}>
        Reload
      </button>
    </div>
  );
}

export function ContentErrorBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <ErrorBoundary fallback={(error) => <ContentFallback error={error} />}>
      {children}
    </ErrorBoundary>
  );
}
