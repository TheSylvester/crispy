/**
 * Stop Button — floating interrupt button above the control panel
 *
 * Visible when the session is streaming or awaiting approval.
 * Calls transport.interrupt() to stop the active agent.
 *
 * @module control-panel/StopButton
 */

import { forwardRef } from 'react';
import { useTransport } from '../../context/TransportContext.js';
import { useTabSession } from '../../context/TabSessionContext.js';
import { useSessionStatus } from '../../hooks/useSessionStatus.js';

export const StopButton = forwardRef<HTMLDivElement>(
  function StopButton(_props, ref) {
    const transport = useTransport();
    const { effectiveSessionId: selectedSessionId } = useTabSession();
    const { channelState, setOptimistic } = useSessionStatus(selectedSessionId);

    const visible =
      channelState === 'streaming' || channelState === 'awaiting_approval';

    const handleClick = () => {
      if (!selectedSessionId) return;
      setOptimistic('idle');
      transport.interrupt(selectedSessionId).catch((err) => {
        console.error('[StopButton] interrupt failed:', err);
        // Revert optimistic — let real channel state show through
        setOptimistic('streaming');
      });
    };

    return (
      <div ref={ref} className={`crispy-stop ${visible ? 'crispy-stop--visible' : ''}`}>
        <button className="crispy-stop__btn" onClick={handleClick}>
          stop
        </button>
      </div>
    );
  },
);
