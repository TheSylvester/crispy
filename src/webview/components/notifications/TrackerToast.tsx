/**
 * TrackerToast — Fixed bottom-right toast for tracker notifications
 *
 * Shows project created/matched/stage-change/trivial notifications.
 * Auto-dismisses after 4 seconds with fade-out animation.
 *
 * @module notifications/TrackerToast
 */

import { useTrackerNotifications } from '../../hooks/useTrackerNotifications.js';
import type { TrackerNotification } from '../../../core/rosie/tracker/tracker-notifications.js';
import './tracker-toast.css';

function formatNotification(n: TrackerNotification): { icon: string; text: string } {
  switch (n.kind) {
    case 'project_created':
      return {
        icon: n.icon || '\u{2728}',
        text: `Created "${n.projectTitle}"`,
      };
    case 'project_matched':
      return {
        icon: n.icon || '\u{1F4CC}',
        text: `Tracked "${n.projectTitle}"`,
      };
    case 'stage_change':
      return {
        icon: n.icon || '\u{1F504}',
        text: `${n.projectTitle}: ${n.oldStage || '?'} \u2192 ${n.newStage || '?'}`,
      };
    case 'trivial':
      return {
        icon: '\u{1F4AD}',
        text: n.status || 'Trivial session',
      };
    default:
      return { icon: '\u{1F514}', text: 'Tracker update' };
  }
}

export function TrackerToast(): React.JSX.Element | null {
  const { notifications, dismiss } = useTrackerNotifications();

  if (notifications.length === 0) return null;

  return (
    <div className="crispy-tracker-toast-container">
      {notifications.map(n => {
        const { icon, text } = formatNotification(n);
        return (
          <div
            key={n.id}
            className={`crispy-tracker-toast crispy-tracker-toast--${n.kind}`}
            onClick={() => dismiss(n.id)}
          >
            <span className="crispy-tracker-toast__icon">{icon}</span>
            <span className="crispy-tracker-toast__text">{text}</span>
          </div>
        );
      })}
    </div>
  );
}
