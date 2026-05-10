/**
 * TrackerToast — tracker variant of the generic Toast.
 *
 * Subscribes to tracker notification events (project created/matched/
 * stage-change/trivial) via `useTrackerNotifications` and renders them
 * through the shared Toast primitive. Rendering, animation, and dismiss
 * timing live in `Toast.tsx`; this module only translates tracker
 * events into ToastItems and routes the variant.
 *
 * @module notifications/TrackerToast
 */

import { useTrackerNotifications } from '../../hooks/useTrackerNotifications.js';
import type { TrackerNotification } from '../../../core/rosie/tracker/tracker-notifications.js';
import { ToastContainer, type ToastItem } from './Toast.js';

function toToastItem(n: TrackerNotification): ToastItem {
  switch (n.kind) {
    case 'project_created':
      return {
        id: n.id,
        icon: n.icon || '\u{2728}',
        text: `Created "${n.projectTitle}"`,
        modifier: 'project_created',
      };
    case 'project_matched':
      return {
        id: n.id,
        icon: n.icon || '\u{1F4CC}',
        text: `Tracked "${n.projectTitle}"`,
      };
    case 'stage_change':
      return {
        id: n.id,
        icon: n.icon || '\u{1F504}',
        text: `${n.projectTitle}: ${n.oldStage || '?'} → ${n.newStage || '?'}`,
        modifier: 'stage_change',
      };
    case 'trivial':
      return {
        id: n.id,
        icon: '\u{1F4AD}',
        text: n.status || 'Trivial session',
      };
    default:
      return { id: n.id, icon: '\u{1F514}', text: 'Tracker update' };
  }
}

export function TrackerToast(): React.JSX.Element | null {
  const { notifications, dismiss } = useTrackerNotifications();
  const items = notifications.map(toToastItem);
  return (
    <ToastContainer
      items={items}
      variant="tracker"
      position="right"
      onDismiss={(id) => dismiss(id as number)}
    />
  );
}
