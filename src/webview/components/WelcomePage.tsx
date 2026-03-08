/**
 * WelcomePage — Branded splash screen shown when no session is selected.
 *
 * Displays the Crispy logo, title, and either a version subtitle or a
 * "Loading Conversation..." shimmer animation.
 *
 * @module WelcomePage
 */

// esbuild --loader:.svg=text imports the raw SVG markup as a string
// @ts-expect-error — no type declarations for raw SVG import
import crispyLogoSvg from "../../../media/crispy-icon.svg";

interface WelcomePageProps {
  loading?: boolean;
}

export function WelcomePage({ loading }: WelcomePageProps): React.JSX.Element {
  return (
    <div className="crispy-welcome">
      <div className="crispy-welcome__content">
        <div
          className="crispy-welcome__icon"
          dangerouslySetInnerHTML={{ __html: crispyLogoSvg }}
        />
        <h1 className="crispy-welcome__title">Crispy</h1>
        {loading ? (
          <p className="crispy-welcome__subtitle crispy-welcome__loading">
            Loading Conversation...
          </p>
        ) : (
          <p className="crispy-welcome__subtitle">v0.1.4-dev.35</p>
        )}
      </div>
    </div>
  );
}
