import { useQueryClient } from '@tanstack/react-query';
import { useConflict } from '../../stores/conflict';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

// Someone else saved the task first (first write wins): the user's change was
// not applied. Reloading brings their version back into every open view.
export function ConflictDialog() {
  const { taskId, message, dismiss } = useConflict();
  const qc = useQueryClient();

  const reload = () => {
    void qc.invalidateQueries({ queryKey: ['tasks'] });
    if (taskId) void qc.invalidateQueries({ queryKey: ['task', taskId] });
    dismiss();
  };

  return (
    <Dialog
      open={!!taskId}
      onClose={reload}
      title="Cambios en conflicto"
      description="Otra persona guardó esta tarea antes que tú."
      footer={<Button onClick={reload}>Recargar</Button>}
    >
      <p role="alert" className="text-sm text-ink-soft">
        {message ?? 'La tarea cambió mientras la editabas.'} Tu cambio no se aplicó: recarga para ver la versión actual y vuelve a intentarlo si
        aún hace falta.
      </p>
    </Dialog>
  );
}
