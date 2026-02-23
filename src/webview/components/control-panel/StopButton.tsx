/**
 * Stop Button — interrupt button above the control panel
 *
 * Lives inside each transcript tab, positioned absolutely above ControlPanel.
 * Visible when the session is streaming or awaiting approval.
 * Calls transport.interrupt() to stop the active agent.
 *
 * @module control-panel/StopButton
 */

import { useTransport } from '../../context/TransportContext.js';
import { useChannelState } from '../../hooks/useSessionStatus.js';

interface StopButtonProps {
  /** Per-tab session ID. When provided, uses this instead of the global context. */
  sessionId?: string | null;
}

export function StopButton({ sessionId = null }: StopButtonProps): React.JSX.Element {
  const transport = useTransport();
  const { channelState } = useChannelState(sessionId);

  const visible =
    channelState === 'streaming' || channelState === 'awaiting_approval';

  const handleClick = () => {
    if (!sessionId) return;
    transport.interrupt(sessionId).catch((err) => {
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
