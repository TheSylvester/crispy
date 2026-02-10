/**
 * File Path — monospace file path display with optional line range
 *
 * @module webview/renderers/tools/shared/FilePath
 */

interface FilePathProps {
  path: string;
  lineRange?: string;
}

export function FilePath({ path, lineRange }: FilePathProps): React.JSX.Element {
  return (
    <span className="crispy-tool-filepath">
      {path}
      {lineRange && <span style={{ opacity: 0.6 }}>{lineRange}</span>}
    </span>
  );
}
