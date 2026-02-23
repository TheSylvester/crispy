/**
 * Type declarations for flexlayout-react
 *
 * The package's exports map doesn't resolve correctly with
 * moduleResolution: "NodeNext". This shim re-exports the
 * package's own type declarations.
 */
declare module 'flexlayout-react' {
  export { Layout } from 'flexlayout-react/types/view/Layout';
  export { Model } from 'flexlayout-react/types/model/Model';
  export { TabNode } from 'flexlayout-react/types/model/TabNode';
  export { TabSetNode } from 'flexlayout-react/types/model/TabSetNode';
  export { BorderNode } from 'flexlayout-react/types/model/BorderNode';
  export { RowNode } from 'flexlayout-react/types/model/RowNode';
  export { Node } from 'flexlayout-react/types/model/Node';
  export { Action } from 'flexlayout-react/types/model/Action';
  export { Actions } from 'flexlayout-react/types/model/Actions';
  export { DockLocation } from 'flexlayout-react/types/DockLocation';
  export { Rect } from 'flexlayout-react/types/Rect';
  export type {
    IJsonModel,
    IJsonBorderNode,
    IJsonRowNode,
    IJsonTabSetNode,
    IJsonTabNode,
    IGlobalAttributes,
    ITabAttributes,
    ITabSetAttributes,
    IBorderAttributes,
  } from 'flexlayout-react/types/model/IJsonModel';
  export type {
    ILayoutProps,
    ITabRenderValues,
    ITabSetRenderValues,
  } from 'flexlayout-react/types/view/Layout';
}
