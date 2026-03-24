/**
 * Message Buffer — Virtual DOM for messaging platform projection
 *
 * Structured markdown document divided into sections. Each section maps 1:1
 * to a platform message. The projection layer syncs dirty sections on heartbeat.
 *
 * @module message-view/buffer
 */

export interface Section {
  id: string;
  content: string;
  dirty: boolean;
}

export interface MessageBuffer {
  sections: Section[];
}

export function createBuffer(): MessageBuffer {
  return { sections: [] };
}

export function appendSection(buf: MessageBuffer, id: string, content: string): Section {
  const section: Section = { id, content, dirty: true };
  buf.sections.push(section);
  return section;
}

export function updateSection(section: Section, content: string): void {
  if (section.content === content) return;
  section.content = content;
  section.dirty = true;
}

export function findSection(buf: MessageBuffer, id: string): Section | undefined {
  return buf.sections.find((s) => s.id === id);
}

export function getOrCreateSection(buf: MessageBuffer, id: string, initialContent?: string): Section {
  const existing = findSection(buf, id);
  if (existing) return existing;
  return appendSection(buf, id, initialContent ?? '');
}

export function getLastSection(buf: MessageBuffer): Section | undefined {
  return buf.sections.length > 0 ? buf.sections[buf.sections.length - 1] : undefined;
}

export function clearBuffer(buf: MessageBuffer): void {
  buf.sections.length = 0;
}
