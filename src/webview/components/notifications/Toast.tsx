/**
 * Toast — generic in-app notification primitive.
 *
 * Shared rendering + animation for both TrackerToast (transport-driven
 * info events) and ErrorToast (module-level error pub/sub). The two
 * variants own their own *event source* — only the visual layer is
 * shared here so the dismiss timing, keyframes, and DOM shape can't
 * drift between them.
 *
 * Variant differences are surface-level (border accent, icon source,
 * left vs right edge). Lifecycle (queue-up, click-dismiss, animate-out)
 * is identical and lives in this module.
 *
 * @module notifications/Toast
 */
import './toast.css';

/** Single dismiss-duration constant. CSS reads it via the inline style var. */
export const TOAST_DISMISS_MS = 4000;

export type ToastVariant = 'tracker' | 'error';
export type ToastPosition = 'left' | 'right';

export interface ToastItem {
  id: number | string;
  icon: string;
  text: string;
  /** Variant-specific modifier appended as `crispy-toast--<modifier>` (e.g. tracker stage colors). */
  modifier?: string;
}

export interface ToastContainerProps {
  items: readonly ToastItem[];
  variant: ToastVariant;
  position: ToastPosition;
  onDismiss: (id: ToastItem['id']) => void;
}

export function ToastContainer({ items, variant, position, onDismiss }: ToastContainerProps): React.JSX.Element | null {
  if (items.length === 0) return null;

  return (
    <div className={`crispy-toast-container crispy-toast-container--${position}`}>
      {items.map((t) => {
        const modifier = t.modifier ? ` crispy-toast--${t.modifier}` : '';
        return (
          <div
            key={t.id}
            className={`crispy-toast crispy-toast--${variant}${modifier}`}
            // Drive the CSS fade-out timing from the same constant the JS
            // dismiss timer uses, so they can't drift.
            style={{ ['--crispy-toast-life' as string]: `${TOAST_DISMISS_MS}ms` }}
            onClick={() => onDismiss(t.id)}
          >
            <span className="crispy-toast__icon">{t.icon}</span>
            <span className="crispy-toast__text">{t.text}</span>
          </div>
        );
      })}
    </div>
  );
}
