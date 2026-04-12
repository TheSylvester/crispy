/**
 * Type declarations for flexlayout-react
 *
 * Needed because the package only exports under the "import" condition,
 * and our tsconfig uses NodeNext with CJS resolution for webview files.
 */

declare module 'flexlayout-react' {
  export { Layout } from 'flexlayout-react/types/view/Layout';
  export { Model } from 'flexlayout-react/types/model/Model';
  export { TabNode } from 'flexlayout-react/types/model/TabNode';
  export type { IJsonModel } from 'flexlayout-react/types/model/IJsonModel';
}

declare module 'flexlayout-react/style/dark.css' {
  const content: string;
  export default content;
}
