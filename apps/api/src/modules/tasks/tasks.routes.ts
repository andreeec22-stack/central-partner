import { Hono } from 'hono';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import { TASK_FILE_TYPES } from '../../lib/file-types';
import { readUpload, uploadLimit } from '../../lib/upload';
import * as comments from './comments.service';
import * as files from './files.service';
import {
  addDependencySchema,
  bulkUpdateSchema,
  commentSchema,
  createTaskSchema,
  downloadQuerySchema,
  listTasksSchema,
  observationSchema,
  progressSchema,
  updateTaskSchema,
} from './tasks.schemas';
import { paginationSchema } from '../../lib/pagination';
import * as tasks from './tasks.service';

const writers = requireRole('ADMIN', 'JEFE_AREA', 'USER');
const taskId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Task');

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

  // The daily ritual: pick 0/25/50/75/100 (same rules as PATCH /:id).
  .patch('/:id/progress', writers, async (c) => {
    const id = taskId(c);
    const input = await parseJson(c, progressSchema);
    return c.json(await tasks.updateTask(c.get('user'), id, input, clientContext(c)));
  })
  .patch('/:id/observation', writers, async (c) => {
    const id = taskId(c);
    const { observation } = await parseJson(c, observationSchema);
    return c.json(await tasks.setTaskObservation(c.get('user'), id, observation, clientContext(c)));
  })
  .get('/:id/history', async (c) => c.json(await tasks.taskHistory(c.get('user'), taskId(c), parseQuery(c, paginationSchema))))

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
  })

  // ─── Comments ───
  .get('/:id/comments', async (c) => c.json(await comments.listComments(c.get('user'), taskId(c))))
  .get('/:id/mentionable', async (c) => c.json(await comments.listMentionable(c.get('user'), taskId(c))))
  .post('/:id/comments', writers, async (c) => {
    const { content } = await parseJson(c, commentSchema);
    return c.json(await comments.createComment(c.get('user'), taskId(c), content, clientContext(c)), 201);
  })
  .patch('/:id/comments/:commentId', writers, async (c) => {
    const { content } = await parseJson(c, commentSchema);
    const commentId = idParam(c, 'commentId', 'Comment');
    return c.json(await comments.updateComment(c.get('user'), taskId(c), commentId, content, clientContext(c)));
  })
  .delete('/:id/comments/:commentId', writers, async (c) => {
    await comments.deleteComment(c.get('user'), taskId(c), idParam(c, 'commentId', 'Comment'), clientContext(c));
    return c.json({ success: true });
  })

  // ─── Files ───
  .get('/:id/files', async (c) => c.json(await files.listFiles(c.get('user'), taskId(c))))
  .post('/:id/files', writers, uploadLimit(files.MAX_FILE_BYTES), async (c) => {
    const id = taskId(c);
    const upload = await readUpload(c, {
      maxBytes: files.MAX_FILE_BYTES,
      allowed: TASK_FILE_TYPES,
      allowedLabel: 'pdf, doc, docx, xls, xlsx, png, jpg, gif, mp4, zip',
    });
    return c.json(await files.uploadFile(c.get('user'), id, upload, clientContext(c)), 201);
  })
  // Default: 302 to a short-lived signed URL. ?format=json returns it instead,
  // for clients that authenticate with a header and can't follow a plain link.
  .get('/:id/files/:fileId/download', async (c) => {
    const { format } = parseQuery(c, downloadQuerySchema);
    const result = await files.fileDownloadUrl(c.get('user'), taskId(c), idParam(c, 'fileId', 'File'));
    c.header('Cache-Control', 'no-store');
    return format === 'json' ? c.json(result) : c.redirect(result.url, 302);
  })
  .delete('/:id/files/:fileId', writers, async (c) => {
    await files.deleteFile(c.get('user'), taskId(c), idParam(c, 'fileId', 'File'), clientContext(c));
    return c.json({ success: true });
  });
