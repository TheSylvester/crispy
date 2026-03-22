/**
 * Tests for URL path ↔ filesystem path conversion.
 */
import { describe, it, expect } from 'vitest';
import { urlPathToFsPath } from '../src/core/url-path-resolver-server.js';
import { fsPathToUrlPath, normalizePath } from '../src/core/url-path-resolver.js';
import { homedir } from 'os';

describe('urlPathToFsPath', () => {
  it('expands tilde-relative paths', () => {
    const result = urlPathToFsPath('/~/dev/crispy');
    expect(result).toBe(homedir() + '/dev/crispy');
  });

  it('handles bare tilde', () => {
    const result = urlPathToFsPath('/~');
    expect(result).toBe(homedir());
  });

  it('handles Unix absolute paths', () => {
    const result = urlPathToFsPath('/home/silver/dev/crispy');
    expect(result).toBe('/home/silver/dev/crispy');
  });

  it('handles Windows drive letter paths', () => {
    const result = urlPathToFsPath('/C:/Users/silver/dev/crispy');
    expect(result).toBe('C:\\Users\\silver\\dev\\crispy');
  });

  it('decodes percent-encoded spaces', () => {
    const result = urlPathToFsPath('/~/my%20project');
    expect(result).toBe(homedir() + '/my project');
  });
});

describe('fsPathToUrlPath', () => {
  const home = '/home/silver';

  it('converts home-relative paths to tilde shorthand', () => {
    expect(fsPathToUrlPath('/home/silver/dev/crispy', home)).toBe('/~/dev/crispy');
  });

  it('handles exact home directory', () => {
    expect(fsPathToUrlPath('/home/silver', home)).toBe('/~');
  });

  it('passes through non-home Unix paths', () => {
    expect(fsPathToUrlPath('/opt/data', home)).toBe('/opt/data');
  });

  it('converts Windows backslash paths', () => {
    const winHome = 'C:\\Users\\silver';
    expect(fsPathToUrlPath('C:\\Users\\silver\\dev\\crispy', winHome)).toBe('/~/dev/crispy');
  });

  it('handles Windows paths outside home', () => {
    const winHome = 'C:\\Users\\silver';
    expect(fsPathToUrlPath('D:\\Projects\\test', winHome)).toBe('/D:/Projects/test');
  });
});

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\silver')).toBe('c:/Users/silver');
  });

  it('lowercases Windows drive letter', () => {
    expect(normalizePath('C:/Users')).toBe('c:/Users');
    expect(normalizePath('D:/Projects')).toBe('d:/Projects');
  });

  it('removes trailing slash', () => {
    expect(normalizePath('/home/silver/')).toBe('/home/silver');
  });

  it('preserves root slash', () => {
    expect(normalizePath('/')).toBe('/');
  });

  it('normalizes mixed separators', () => {
    expect(normalizePath('C:\\Users/silver\\dev')).toBe('c:/Users/silver/dev');
  });
});

describe('round-trip conversion', () => {
  const home = homedir();

  it('tilde path round-trips correctly', () => {
    const url = '/~/dev/crispy';
    const fs = urlPathToFsPath(url);
    const back = fsPathToUrlPath(fs, home);
    expect(back).toBe(url);
  });

  it('Unix absolute path round-trips correctly', () => {
    const url = '/opt/data/project';
    const fs = urlPathToFsPath(url);
    const back = fsPathToUrlPath(fs, home);
    expect(back).toBe(url);
  });
});
