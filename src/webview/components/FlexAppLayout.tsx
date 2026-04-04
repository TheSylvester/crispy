/**
 * FlexAppLayout — FlexLayout shell wrapping TranscriptViewer
 *
 * Single-tab mode with all chrome hidden. FlexLayout is purely structural
 * scaffolding for future multi-tab support. Visually invisible.
 *
 * @module FlexAppLayout
 */

import { Layout, Model, TabNode, type IJsonModel } from 'flexlayout-react';
import 'flexlayout-react/style/dark.css';
import { TabSessionProvider, useTabSession } from '../context/TabSessionContext.js';
import { ControlPanelProvider } from '../context/ControlPanelContext.js';
import { TabPanelProvider } from '../context/TabPanelContext.js';
import { FileIndexProvider } from '../context/FileIndexContext.js';
import { FilePanelProvider } from '../context/FilePanelContext.js';
import { TranscriptViewer } from './TranscriptViewer.js';
import './flexlayout-overrides.css';

const DEFAULT_MODEL: IJsonModel = {
  global: {
    splitterSize: 4,
    tabEnableClose: false,
    tabEnableRename: false,
  },
  layout: {
    type: 'row',
    children: [
      {
        type: 'tabset',
        enableTabStrip: false,
        children: [
          {
            type: 'tab',
            name: 'transcript',
            component: 'transcript',
          },
        ],
      },
    ],
  },
};

const model = Model.fromJson(DEFAULT_MODEL);

/** Inner wrapper — reads effectiveSessionId from TabSession to pass to ControlPanelProvider. */
function TabContent(): React.JSX.Element {
  const { effectiveSessionId } = useTabSession();
  return (
    <TabPanelProvider>
      <FileIndexProvider>
        <FilePanelProvider>
          <ControlPanelProvider selectedSessionId={effectiveSessionId}>
            <TranscriptViewer />
          </ControlPanelProvider>
        </FilePanelProvider>
      </FileIndexProvider>
    </TabPanelProvider>
  );
}

function factory(node: TabNode): React.JSX.Element | null {
  if (node.getComponent() === 'transcript') {
    return (
      <TabSessionProvider>
        <TabContent />
      </TabSessionProvider>
    );
  }
  return null;
}

export function FlexAppLayout(): React.JSX.Element {
  return (
    <Layout
      model={model}
      factory={factory}
    />
  );
}
