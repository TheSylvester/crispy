/**
 * WelcomePage — Branded splash screen shown when no session is selected.
 *
 * Displays the Crispy logo, title, and either a version subtitle or a
 * "Loading Conversation..." shimmer animation.
 *
 * @module WelcomePage
 */

import { animatedLogoSvg } from '../utils/animated-logo.js';
import { CRISPY_VERSION } from "../../core/version.js";

interface WelcomePageProps {
  loading?: boolean;
  skinClass?: string;
}

export function WelcomePage({ loading, skinClass }: WelcomePageProps): React.JSX.Element {
  return (
    <div className={`crispy-welcome${skinClass ? ` ${skinClass}` : ''}`}>
      <div className="crispy-welcome__content">
        <div
          className="crispy-welcome__icon"
          dangerouslySetInnerHTML={{ __html: animatedLogoSvg }}
        />
        <h1 className="crispy-welcome__title">Crispy</h1>
        {loading ? (
          <p className="crispy-welcome__subtitle crispy-welcome__loading">
            Loading Conversation...
          </p>
        ) : (
          <p className="crispy-welcome__subtitle">v{CRISPY_VERSION}</p>
        )}
      </div>
    </div>
  );
}
