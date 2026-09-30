# Guía de desarrollo — Módulo de Desempeño

## Setup local

Requisitos: Node 20+ (probado con 24.19) y Docker Desktop.

```bash
npm install
npm run infra:up                                   # Postgres 16, Redis 7, Meilisearch
cp apps/api/.env.example apps/api/.env             # pon un JWT_SECRET aleatorio (≥ 32 caracteres)
npm run db:migrate -w @central-partner/api         # incluye 20260930214620_performance_surveys
npm run db:seed -w @central-partner/api            # ⚠ BORRA y recrea el workspace demo
npm run dev:api                                    # http://localhost:3000
npm run dev -w @central-partner/web                # http://localhost:5173
```

**Cuentas demo:** contraseña `demo-12345`, dominio `@central.local`. El README principal
todavía dice `@demo.local`; eso está desactualizado.

| Cuenta | Qué ver en Desempeño |
|---|---|
| `director@` | Tablero de la empresa, plantillas (`/admin/surveys`) y todos los resultados |
| `jefe.community@` | Resultado **publicado** de Luis (dos evaluaciones enviadas) |
| `jefe.marketing@` | La evaluación del jefe sobre Ana, pendiente de llenar |
| `ana.gomez@` | Autoevaluación abierta, con 2 respuestas en borrador |
| `luis.perez@` | Su resultado publicado y la evaluación de su jefe |
| `carla.ruiz@` | Autoevaluación programada (se abre en 2 días) |

**Probar sin tocar tus datos:** `.claude/launch.json` tiene `api-demo-db` (puerto 3001, BD
`central_partner_test`) y `web-demo-db` (puerto 5175). Siembra la BD de test así:

```bash
cd apps/api
DATABASE_URL=postgresql://central:central@localhost:5432/central_partner_test npx tsx prisma/seed.ts
```

(Los tests de integración vacían esa BD con `TRUNCATE` al correr.)

## Correr los tests

```bash
npm run typecheck                                       # API + web
npm run test:unit -w @central-partner/api               # rápidos, sin BD
npm run test:integration -w @central-partner/api        # necesita Docker; usa central_partner_test
npm run test -w @central-partner/web                    # Vitest + jsdom

# Solo el módulo
cd apps/api && npx jest tests/unit/surveys.test.ts tests/integration/surveys.test.ts --runInBand
cd apps/web && npx vitest run src/__tests__/performance

# Cobertura del módulo (API)
cd apps/api && npx jest tests/unit/surveys.test.ts tests/integration/surveys.test.ts --runInBand --coverage \
  --collectCoverageFrom='src/modules/surveys/**' --collectCoverageFrom='src/modules/performance/**'
```

La BD de test necesita las migraciones al día:

```bash
cd apps/api
DATABASE_URL=postgresql://central:central@localhost:5432/central_partner_test npx prisma migrate deploy
```

## Mapa del código

| Quiero cambiar… | Archivo |
|---|---|
| Quién ve o gestiona qué | `api/src/modules/surveys/surveys.access.ts` (y su test en `tests/unit/surveys.test.ts`) |
| Fórmulas, umbrales o rating | `api/src/modules/surveys/scoring.ts` |
| Reglas de negocio (mínimo de preguntas, fechas, valores) | `api/src/modules/surveys/surveys.validators.ts` y su espejo en la web, `templateProblems` en `SurveyTemplatesPage.tsx` |
| Forma de los bodies | `api/src/modules/surveys/surveys.schemas.ts` |
| Métricas de productividad | `api/src/modules/performance/performance.service.ts` |
| Intervalo de autoguardado | `AUTO_SAVE_INTERVAL_MS` en `web/src/lib/useAutoSave.ts` |
| Etiquetas en español | `web/src/components/performance/PerfBits.tsx`; las acciones de auditoría en `api/src/modules/audit/audit.routes.ts` y `web/src/pages/admin/AuditLogsPage.tsx` |

## Agregar un tipo de encuesta

Ejemplo: `PEER_REVIEW` (evaluación de un compañero, primer paso hacia 360°).

1. **Schema:** agrega `PEER_REVIEW` a `enum SurveyType` y genera la migración:
   ```bash
   cd apps/api
   DATABASE_URL=…_test npx prisma migrate dev --create-only --name survey_type_peer_review
   ```
   Revisa el SQL (`ALTER TYPE "SurveyType" ADD VALUE 'PEER_REVIEW'`) y aplícalo con
   `migrate deploy`.
2. **Zod:** en `surveys.schemas.ts`, agrega el valor a `createSurveySchema.type`.
3. **Reglas de evaluador** (`surveys.service.ts → createSurvey`): define quién puede ser
   evaluador. Por ejemplo, un USER activo del mismo `departmentId`, distinto del evaluado.
   Agrega el validador en `surveys.validators.ts`, no en línea.
4. **Acceso** (`surveys.access.ts`): decide si el evaluado ve las evaluaciones de pares al
   publicarse, y si deben ser **anónimas**. Si lo son, `presentSummary` y `presentDetail` no
   deben incluir `evaluator` para el evaluado. Actualiza `checkSurveyAccess` **y**
   `surveyVisibilityFilter` a la vez, porque deben ser equivalentes.
5. **Agregado** (`scoring.ts → aggregateReview`): decide cómo entra al resultado. Por
   ejemplo, un `peerReviewScore` separado, lo que exige una columna nueva en
   `PerformanceReview`.
6. **Web:** agrega la etiqueta a `SURVEY_TYPE_LABEL` y la opción en `CreateSurveyModal`, y
   una tarjeta en `ReviewDetailPage` si hay un puntaje nuevo.
7. **Tests:**
   - unit para las reglas de acceso del nuevo tipo;
   - integración para crear, responder y enviar, y para lo que el evaluado ve antes y
     después de publicar;
   - actualizar los tests que listan tipos.

## Agregar un tipo de pregunta

Ejemplo: `SINGLE_CHOICE` con puntaje por opción.

1. Agrega el valor a `enum SurveyQuestionType` (migración) y a `questionSchema.questionType`.
2. `surveys.validators.ts`:
   - en `validateTemplateQuestions`, las reglas de las opciones;
   - en `validateAnswerValue`, el valor válido.
3. `scoring.ts`:
   - si puntúa, agrégalo a `SCORED_TYPES` y a `normalizeAnswer`;
   - si necesita datos extra (puntaje por opción), guárdalos en `SurveyQuestion` (hoy solo
     existe `options: String[]`).
4. Web:
   - `QUESTION_TYPE_LABEL`;
   - el editor en `SurveyTemplatesPage` (opciones);
   - la entrada en `QuestionInput` (`SurveyResponsePage.tsx`);
   - `templateProblems`.
5. Tests: los casos de `validateAnswerValue` y `normalizeAnswer`, y un envío de integración.

## Consejos de depuración

| Síntoma | Dónde mirar |
|---|---|
| `productivityIndex` sale `null` | `ActivityLog` con action `SURVEY_CREATED_WITHOUT_PRODUCTIVITY` → `metadata.reason`: `NO_DATA` (sin tareas vencidas ni KPIs en 4 semanas), `Timed out after 3000 ms` o el mensaje de error. En el log del servidor: `productivity unavailable for survey`. |
| El número de productividad no cuadra | `GET /api/v1/workspaces/:ws/team/:user/performance`: el objeto `tasks` muestra `due`, `completed`, `onTime`, `late` y `completionDateUnknown`. El detalle guardado al crear está en `surveys.productivityData`. |
| El tablero no refleja un cambio | Caché de Redis: `redis-cli KEYS 'surveys:dash:*'` y luego `DEL`. Sin Redis no hay caché. Verifica que el cambio pase por `afterStatusChange`. |
| Una encuesta sigue "Programada" | El scheduler corre cada 60 s (log `surveys activated`). Si no, busca `survey scheduler crashed`. Guardar una respuesta tras `startDate` también la activa. |
| 403 inesperado | Revisa `permissions` del ítem en la respuesta de la lista. Para reproducir, llama a `checkSurveyAccess` en un unit test con el caso. Recuerda que el acceso depende de `survey.departmentId` al **crear** la encuesta, no del área actual de la persona. |
| 409 `SURVEY_EXISTS` | Ya hay una abierta (SCHEDULED o ACTIVE) con el mismo evaluado, evaluador y tipo. Cancélala primero. |
| El autoguardado no dispara | En la pestaña Network, un `POST /surveys/:id/responses` debe aparecer 30 s después del primer cambio. En tests, usa `vi.useFakeTimers()` **después** de que cargue la encuesta (ver `__tests__/performance/surveys.test.tsx`). |
| Simular un Module 1 lento | En tests: `surveyConfig.productivityTimeoutMs = 50` y `jest.spyOn(perf, 'getPerformanceMetrics').mockReturnValue(new Promise(() => {}))`. |
| Ver la BD | `npm run db:studio -w @central-partner/api` → tablas `surveys`, `survey_responses` y `performance_reviews`. |
