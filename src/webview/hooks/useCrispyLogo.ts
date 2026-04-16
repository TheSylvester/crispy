/**
 * useCrispyLogo — resolve the Crispy logo URL for the current host environment.
 *
 * In VS Code webviews, the logo URI is injected via a <meta name="crispy-logo">
 * tag because relative paths don't resolve against vscode-webview:// origins.
 * In the dev server / standalone app, falls back to the relative "crispy-logo.png".
 */

const logoSrc =
  document.querySelector<HTMLMetaElement>('meta[name="crispy-logo"]')?.content
  ?? 'crispy-logo.png';

export function useCrispyLogo(): string {
  return logoSrc;
}
