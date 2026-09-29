import { Hono } from 'hono';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { addDependencySchema, bulkUpdateSchema, createTaskSchema, listTasksSchema, updateTaskSchema } from './tasks.schemas';
import * as tasks from './tasks.service';

export const taskRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => c.json(await tasks.listTasks(c.get('user'), parseQuery(c, listTasksSchema))))

  // Role gate here; the canCreateTasks grant for JEFE_AREA is checked in the service.
  .post('/', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const input = await parseJson(c, createTaskSchema);
    return c.json(await tasks.createTask(c.get('user'), input, clientContext(c)), 201);
  })

  // Registered before '/:id' so "bulk-update" is never read as a task id.
  .post('/bulk-update', requireRole('ADMIN', 'JEFE_AREA'), async (c) => {
    const input = await parseJson(c, bulkUpdateSchema);
    return c.json(await tasks.bulkUpdateTasks(c.get('user'), input, clientContext(c)));
  })

  .get('/:id', async (c) => c.json(await tasks.getTaskDetail(c.get('user'), idParam(c, 'id', 'Task'))))

  .patch('/:id', requireRole('ADMIN', 'JEFE_AREA', 'USER'), async (c) => {
    const id = idParam(c, 'id', 'Task');
    const input = await parseJson(c, updateTaskSchema);
    return c.json(await tasks.updateTask(c.get('user'), id, input, clientContext(c)));
  })

  .delete('/:id', requireRole('ADMIN', 'JEFE_AREA', 'USER'), async (c) => {
    await tasks.deleteTask(c.get('user'), idParam(c, 'id', 'Task'), clientContext(c));
    return c.json({ success: true });
  })

  .post('/:id/dependencies', requireRole('ADMIN', 'JEFE_AREA', 'USER'), async (c) => {
    const id = idParam(c, 'id', 'Task');
    const { dependsOnTaskId } = await parseJson(c, addDependencySchema);
    await tasks.addDependency(c.get('user'), id, dependsOnTaskId, clientContext(c));
    return c.json({ success: true }, 201);
  })

  .delete('/:id/dependencies/:dependsOnId', requireRole('ADMIN', 'JEFE_AREA', 'USER'), async (c) => {
    await tasks.removeDependency(
      c.get('user'),
      idParam(c, 'id', 'Task'),
      idParam(c, 'dependsOnId', 'Dependency'),
      clientContext(c),
    );
    return c.json({ success: true });
  });
