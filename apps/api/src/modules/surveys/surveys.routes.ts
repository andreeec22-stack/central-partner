import { Hono } from 'hono';
import { idParam, parseJson, parseQuery } from '../../lib/validation';
import { requireAuth, requireRole } from '../../middleware/auth';
import type { AppEnv } from '../../types';
import { clientContext } from '../auth/auth.routes';
import * as reviews from './reviews.service';
import { surveyDashboard } from './surveys.dashboard';
import {
  createSurveySchema,
  createTemplateSchema,
  listReviewsSchema,
  listSurveysSchema,
  listTemplatesSchema,
  periodQuerySchema,
  saveResponsesSchema,
  templateStatusSchema,
  updateReviewSchema,
  updateTemplateSchema,
} from './surveys.schemas';
import * as surveys from './surveys.service';
import * as templates from './templates.service';

const surveyId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Survey');
const templateId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Template');

// Mounted under /surveys. Literal paths are registered before '/:id'.
export const surveyRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/templates', async (c) => c.json(await templates.listTemplates(c.get('user'), parseQuery(c, listTemplatesSchema).status)))
  .post('/templates', requireRole('ADMIN'), async (c) =>
    c.json(await templates.createTemplate(c.get('user'), await parseJson(c, createTemplateSchema), clientContext(c)), 201),
  )
  .get('/templates/:id', async (c) => c.json(await templates.getTemplate(c.get('user'), templateId(c))))
  .patch('/templates/:id', requireRole('ADMIN'), async (c) => {
    const id = templateId(c);
    return c.json(await templates.updateTemplate(c.get('user'), id, await parseJson(c, updateTemplateSchema), clientContext(c)));
  })
  .patch('/templates/:id/status', requireRole('ADMIN'), async (c) => {
    const id = templateId(c);
    const { status } = await parseJson(c, templateStatusSchema);
    return c.json(await templates.setTemplateStatus(c.get('user'), id, status, clientContext(c)));
  })
  .delete('/templates/:id', requireRole('ADMIN'), async (c) => {
    await templates.deleteTemplate(c.get('user'), templateId(c), clientContext(c));
    return c.json({ success: true });
  })
  .get('/dashboard', requireRole('ADMIN', 'JEFE_AREA'), async (c) => c.json(await surveyDashboard(c.get('user'), parseQuery(c, periodQuerySchema).period)))
  .get('/', async (c) => c.json(await surveys.listSurveys(c.get('user'), parseQuery(c, listSurveysSchema))))
  .post('/', requireRole('ADMIN', 'JEFE_AREA'), async (c) =>
    c.json(await surveys.createSurvey(c.get('user'), await parseJson(c, createSurveySchema), clientContext(c)), 201),
  )
  .get('/:id', async (c) => c.json(await surveys.getSurvey(c.get('user'), surveyId(c))))
  .post('/:id/responses', async (c) => {
    const id = surveyId(c);
    return c.json(await surveys.saveResponses(c.get('user'), id, await parseJson(c, saveResponsesSchema), clientContext(c)));
  })
  .post('/:id/submit', async (c) => c.json(await surveys.submitSurvey(c.get('user'), surveyId(c), clientContext(c))))
  .post('/:id/cancel', requireRole('ADMIN', 'JEFE_AREA'), async (c) => c.json(await surveys.cancelSurvey(c.get('user'), surveyId(c), clientContext(c))));

const reviewId = (c: Parameters<typeof idParam>[0]) => idParam(c, 'id', 'Review');

// Mounted under /performance-reviews.
export const reviewRoutes = new Hono<AppEnv>()
  .use('*', requireAuth)
  .get('/', async (c) => c.json(await reviews.listReviews(c.get('user'), parseQuery(c, listReviewsSchema))))
  .get('/:id', async (c) => c.json(await reviews.getReview(c.get('user'), reviewId(c))))
  .patch('/:id', async (c) => {
    const id = reviewId(c);
    return c.json(await reviews.updateReview(c.get('user'), id, await parseJson(c, updateReviewSchema), clientContext(c)));
  })
  .post('/:id/publish', requireRole('ADMIN', 'JEFE_AREA'), async (c) => c.json(await reviews.publishReview(c.get('user'), reviewId(c), clientContext(c))));
