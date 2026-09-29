import { diffFields } from '../../src/modules/audit/activity-log';

describe('diffFields', () => {
  it('records only fields that changed, with old and new values', () => {
    const before = { title: 'A', progress: 25, status: 'TODO', dueDate: new Date('2026-10-01') };
    const changes = diffFields(before, {
      title: 'A',
      progress: 75,
      dueDate: new Date('2026-10-01'),
      status: undefined,
    });
    expect(changes).toEqual({ progress: { old: 25, new: 75 } });
  });

  it('treats null → value as a change', () => {
    expect(diffFields({ blockReason: null as string | null }, { blockReason: 'Esperando finanzas' })).toEqual({
      blockReason: { old: null, new: 'Esperando finanzas' },
    });
  });
});
