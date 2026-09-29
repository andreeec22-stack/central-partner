import { describe, expect, it } from 'vitest';
import { validateFile } from '../components/task/detail/FilesSection';
import { filterMentionables, mentionQueryAt, splitMentions } from '../lib/mentions';

const ana = { id: '1', displayName: 'Ana Gómez', handle: 'ana.gomez' };
const luis = { id: '2', displayName: 'Luis Pérez', handle: 'luis' };

describe('mentions', () => {
  it('splits a comment into text and resolved mentions only', () => {
    const parts = splitMentions('Listo @ana.gomez, avisa a @nadie y a luis@x.com', [ana]);
    expect(parts).toEqual([
      { kind: 'text', text: 'Listo ' },
      { kind: 'mention', text: '@ana.gomez', user: ana },
      { kind: 'text', text: ', avisa a @nadie y a luis@x.com' },
    ]);
  });

  it('finds the @query being typed at the caret', () => {
    expect(mentionQueryAt('hola @an', 8)).toEqual({ start: 5, query: 'an' });
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQueryAt('correo ana@x', 12)).toBeNull();
    expect(mentionQueryAt('hola @ana ya', 12)).toBeNull();
  });

  it('filters by handle or any name word, accent-insensitive, prefix matches first', () => {
    expect(filterMentionables([luis, ana], 'gom')).toEqual([ana]);
    expect(filterMentionables([ana, luis], 'pere')).toEqual([luis]);
    expect(filterMentionables([ana, luis], 'u')).toEqual([luis]);
  });
});

describe('file validation', () => {
  const file = (name: string, size: number) => new File([new Uint8Array(size)], name);
  it('mirrors the API limits', () => {
    expect(validateFile(file('a.pdf', 10), 0)).toBeNull();
    expect(validateFile(file('a.exe', 10), 0)).toMatch(/tipo no permitido/);
    expect(validateFile(file('a.pdf', 0), 0)).toMatch(/vacío/);
    expect(validateFile(file('a.pdf', 10), 10)).toMatch(/máximo 10/);
  });
});
