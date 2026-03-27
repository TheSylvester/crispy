import { describe, expect, it } from 'vitest';
import {
  hasExplicitCodexSkillReference,
  mapMessageContent,
} from '../src/core/adapters/codex/codex-settings-mapping.js';

describe('codex-settings-mapping skill injection', () => {
  const resolveSkill = (name: string) => {
    switch (name) {
      case 'recall':
        return { name: 'recall', path: '/bundle/skills/recall/SKILL.md' };
      case 'handoff-prompt-to':
        return { name: 'handoff-prompt-to', path: '/bundle/skills/handoff-prompt-to/SKILL.md' };
      default:
        return undefined;
    }
  };

  it('detects explicit Codex skill syntax in plain text', () => {
    expect(hasExplicitCodexSkillReference('Use $recall before coding.')).toBe(true);
    expect(hasExplicitCodexSkillReference('Use `$recall` literally.')).toBe(false);
    expect(hasExplicitCodexSkillReference('Use ``$recall`` literally.')).toBe(false);
    expect(hasExplicitCodexSkillReference('```sh\n$recall\n```')).toBe(false);
    expect(hasExplicitCodexSkillReference('````md\n$recall\n````')).toBe(false);
    expect(hasExplicitCodexSkillReference('~~~sh\n$recall\n~~~')).toBe(false);
    expect(hasExplicitCodexSkillReference('Escaped \\$recall text')).toBe(false);
    expect(hasExplicitCodexSkillReference('$RECALL_CLI "query"')).toBe(false);
  });

  it('maps resolved $skill references into Codex skill inputs', () => {
    expect(mapMessageContent('Use $recall before coding.', resolveSkill)).toEqual([
      { type: 'text', text: 'Use ', text_elements: [] },
      { type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' },
      { type: 'text', text: ' before coding.', text_elements: [] },
    ]);
  });

  it('leaves unresolved $skill references untouched in the text', () => {
    expect(mapMessageContent('Use $unknown-skill before coding.', resolveSkill)).toEqual([
      { type: 'text', text: 'Use $unknown-skill before coding.', text_elements: [] },
    ]);
  });

  it('keeps unresolved references inline while attaching resolved ones', () => {
    expect(mapMessageContent('Use $recall and $unknown-skill.', resolveSkill)).toEqual([
      { type: 'text', text: 'Use ', text_elements: [] },
      { type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' },
      { type: 'text', text: ' and $unknown-skill.', text_elements: [] },
    ]);
  });

  it('supports multiple skill attachments across multimodal content', () => {
    expect(mapMessageContent([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      },
      {
        type: 'text',
        text: '$recall then $handoff-prompt-to',
      },
    ], resolveSkill)).toEqual([
      { type: 'image', url: 'data:image/png;base64,abc123' },
      { type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' },
      { type: 'text', text: ' then ', text_elements: [] },
      { type: 'skill', name: 'handoff-prompt-to', path: '/bundle/skills/handoff-prompt-to/SKILL.md' },
    ]);
  });
});
