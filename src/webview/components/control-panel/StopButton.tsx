/**
 * Stop Button — floating interrupt button above the control panel
 *
 * Visible when the session is streaming or awaiting approval.
 * Calls transport.interrupt() to stop the active agent.
 *
 * @module control-panel/StopButton
 */

import { useTransport } from '../../context/TransportContext.js';
import { useSession } from '../../context/SessionContext.js';
import { useSessionStatus } from '../../hooks/useSessionStatus.js';

export function StopButton(): React.JSX.Element {
  const transport = useTransport();
  const { selectedSessionId } = useSession();
  const { channelState } = useSessionStatus(selectedSessionId);

  const visible =
    channelState === 'streaming' || channelState === 'awaiting_approval';

  const handleClick = () => {
    if (!selectedSessionId) return;
    transport.interrupt(selectedSessionId).catch((err) => {
      console.error('[StopButton] interrupt failed:', err);
    });
  };

  return (
    <div className={`crispy-stop ${visible ? 'crispy-stop--visible' : ''}`}>
      <button className="crispy-stop__btn" onClick={handleClick}>
        Stop
      </button>
    </div>
  );
}
