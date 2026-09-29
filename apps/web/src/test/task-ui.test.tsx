import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProgressPicker, StatusControl } from '../components/task/TaskBits';
import { isOverdue } from '../lib/format';
import { canCreateTasks, canEditTask } from '../lib/permissions';
import type { User } from '../lib/types';

const base: User = {
  id: 'u1',
  workspaceId: 'w',
  email: 'a@b.co',
  displayName: 'Ana',
  role: 'USER',
  canCreateTasks: false,
  departmentId: 'mkt',
  timezone: 'America/Bogota',
};

describe('ProgressPicker', () => {
  it('offers the five daily steps and reports the chosen one', async () => {
    const onChange = vi.fn();
    render(<ProgressPicker value={25} onChange={onChange} />);
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['0%', '25%', '50%', '75%', '100%']);
    expect(screen.getByRole('button', { name: '25%' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: '75%' }));
    expect(onChange).toHaveBeenCalledWith(75);
  });

  it('is read-only when disabled', async () => {
    const onChange = vi.fn();
    render(<ProgressPicker value={50} onChange={onChange} disabled />);
    await userEvent.click(screen.getByRole('button', { name: '100%' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('StatusControl', () => {
  it('asks for a reason before blocking, and requires one', async () => {
    const onChange = vi.fn();
    render(<StatusControl status="IN_PROGRESS" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'BLOCKED');

    const confirm = screen.getByRole('button', { name: /marcar como bloqueada/i });
    expect(confirm).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('Motivo del bloqueo'), '  Esperando finanzas ');
    await userEvent.click(confirm);
    expect(onChange).toHaveBeenCalledWith('BLOCKED', 'Esperando finanzas');
  });

  it('changes other statuses directly', async () => {
    const onChange = vi.fn();
    render(<StatusControl status="TODO" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'DONE');
    expect(onChange).toHaveBeenCalledWith('DONE');
  });
});

describe('client-side permission mirror', () => {
  const task = { departmentId: 'mkt', assignedToId: 'u1', createdById: 'jefe' };

  it('matches the API task-creation rules', () => {
    expect(canCreateTasks({ ...base, role: 'ADMIN' })).toBe(true);
    expect(canCreateTasks({ ...base, role: 'JEFE_AREA', canCreateTasks: true })).toBe(true);
    expect(canCreateTasks({ ...base, role: 'JEFE_AREA', canCreateTasks: false })).toBe(false);
    expect(canCreateTasks({ ...base, role: 'USER', canCreateTasks: true })).toBe(false);
    expect(canCreateTasks({ ...base, role: 'VIEWER' })).toBe(false);
  });

  it('lets assignees and area heads edit, not viewers or bystanders', () => {
    expect(canEditTask(base, task)).toBe(true);
    expect(canEditTask({ ...base, id: 'u2' }, task)).toBe(false);
    expect(canEditTask({ ...base, role: 'VIEWER' }, task)).toBe(false);
    expect(canEditTask({ ...base, id: 'j2', role: 'JEFE_AREA' }, task)).toBe(true);
    expect(canEditTask({ ...base, id: 'j3', role: 'JEFE_AREA', departmentId: 'fin' }, task)).toBe(false);
  });
});

describe('isOverdue', () => {
  it('compares calendar days in the user timezone', () => {
    const now = new Date('2026-09-30T03:00:00Z'); // still Sep 29 in Bogotá
    expect(isOverdue('2026-09-29T17:00:00Z', 'America/Bogota', now)).toBe(false);
    expect(isOverdue('2026-09-28T17:00:00Z', 'America/Bogota', now)).toBe(true);
    expect(isOverdue(null, 'UTC', now)).toBe(false);
  });
});
