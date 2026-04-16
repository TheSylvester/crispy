import { describe, it, expect } from 'vitest';
import { parseRule } from '../../../src/core/arbiter/parse-rule.js';

describe('parseRule', () => {
  it('parses ToolName(glob) pattern', () => {
    expect(parseRule('Bash(git *)')).toEqual({ toolName: 'Bash', inputGlob: 'git *' });
  });

  it('parses bare ToolName as glob *', () => {
    expect(parseRule('Bash')).toEqual({ toolName: 'Bash', inputGlob: '*' });
  });

  it('parses pattern with file path glob', () => {
    expect(parseRule('Read(src/**)')).toEqual({ toolName: 'Read', inputGlob: 'src/**' });
  });

  it('parses pattern with dotfile glob', () => {
    expect(parseRule('Write(*.env*)')).toEqual({ toolName: 'Write', inputGlob: '*.env*' });
  });

  it('parses pattern with special chars in glob', () => {
    expect(parseRule('Bash(rm -rf *)')).toEqual({ toolName: 'Bash', inputGlob: 'rm -rf *' });
  });

  it('parses pattern with $ in glob (literal, not shell)', () => {
    expect(parseRule('Bash($CRISPY_TRACKER *)')).toEqual({
      toolName: 'Bash',
      inputGlob: '$CRISPY_TRACKER *',
    });
  });

  it('trims whitespace from tool name', () => {
    expect(parseRule('  Bash  ')).toEqual({ toolName: 'Bash', inputGlob: '*' });
  });

  it('trims whitespace from pattern', () => {
    expect(parseRule('  Bash(git *)  ')).toEqual({ toolName: 'Bash', inputGlob: 'git *' });
  });

  it('throws on empty string', () => {
    expect(() => parseRule('')).toThrow('Invalid arbiter rule pattern');
  });

  it('throws on whitespace-only string', () => {
    expect(() => parseRule('   ')).toThrow('Invalid arbiter rule pattern');
  });

  it('throws on empty parens', () => {
    expect(() => parseRule('Bash()')).toThrow('Invalid arbiter rule pattern');
  });

  it('handles nested parens in glob', () => {
    // Nested parens: `Bash(echo $(date))` — matches the outer parens group
    const result = parseRule('Bash(echo $(date))');
    // The regex matches up to the last ), so the glob is 'echo $(date)'
    expect(result.toolName).toBe('Bash');
    expect(result.inputGlob).toBe('echo $(date)');
  });

  it('parses WebFetch with URL glob', () => {
    expect(parseRule('WebFetch(https://*.example.com/*)')).toEqual({
      toolName: 'WebFetch',
      inputGlob: 'https://*.example.com/*',
    });
  });

  it('parses Agent bare (no input matching in v1)', () => {
    expect(parseRule('Agent')).toEqual({ toolName: 'Agent', inputGlob: '*' });
  });
});
