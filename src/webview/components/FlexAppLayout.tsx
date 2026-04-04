/**
 * FlexAppLayout — FlexLayout shell wrapping TranscriptViewer
 *
 * Single-tab mode with all chrome hidden. FlexLayout is purely structural
 * scaffolding for future multi-tab support. Visually invisible.
 *
 * @module FlexAppLayout
 */

import { Layout, Model, TabNode, type IJsonModel } from 'flexlayout-react';
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

function factory(node: TabNode): React.JSX.Element | null {
  if (node.getComponent() === 'transcript') {
    return <TranscriptViewer />;
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
