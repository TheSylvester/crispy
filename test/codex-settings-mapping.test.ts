import { describe, expect, it } from 'vitest';
import {
  hasExplicitCodexSkillReference,
  mapMessageContent,
} from '../src/core/adapters/codex/codex-settings-mapping.js';

describe('codex-settings-mapping skill injection', () => {
  /** Resolver without content — tests skill input only. */
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

  /** Resolver with content — tests full injection with frontmatter stripping. */
  const resolveSkillWithContent = (name: string) => {
    if (name === 'recall') {
      return {
        name: 'recall',
        path: '/bundle/skills/recall/SKILL.md',
        content: '---\nname: recall\ndescription: Search past sessions\n---\n\nSearch and read past session transcripts.',
      };
    }
    return undefined;
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

  it('injects full skill content with frontmatter stripped on explicit $skill', () => {
    expect(mapMessageContent('$recall', resolveSkillWithContent)).toEqual([
      { type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' },
      { type: 'text', text: 'Search and read past session transcripts.', text_elements: [] },
    ]);
  });

  it('maps resolved $skill with surrounding text', () => {
    const result = mapMessageContent('Use $recall before coding.', resolveSkillWithContent);
    expect(result[0]).toEqual({ type: 'text', text: 'Use ', text_elements: [] });
    expect(result[1]).toEqual({ type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' });
    expect(result[2]).toEqual({ type: 'text', text: 'Search and read past session transcripts.', text_elements: [] });
    expect(result[3]).toEqual({ type: 'text', text: ' before coding.', text_elements: [] });
  });

  it('sends only skill input when content is not pre-read', () => {
    expect(mapMessageContent('$recall', resolveSkill)).toEqual([
      { type: 'skill', name: 'recall', path: '/bundle/skills/recall/SKILL.md' },
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
