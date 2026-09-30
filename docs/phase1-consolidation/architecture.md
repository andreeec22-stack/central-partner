# Arquitectura — Módulo de Desempeño

## C4 · Nivel 1: contexto

```
 ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
 │   Director    │   │ Jefe de área  │   │  Colaborador  │
 │    (ADMIN)    │   │  (JEFE_AREA)  │   │    (USER)     │
 └──────┬────────┘   └──────┬────────┘   └──────┬────────┘
        │ plantillas,       │ evalúa a su equipo,│ se autoevalúa,
        │ tablero empresa   │ publica resultados │ lee su resultado
        ▼                   ▼                    ▼
 ┌────────────────────────────────────────────────────────┐
 │                    Central Partner                     │
 │  Tareas · Semana ①②③ · Back office · DESEMPEÑO (Ph. 1) │
 └────────────────────────────────────────────────────────┘
        (sin sistemas externos nuevos: Module 1 es interno)
```

## C4 · Nivel 2: contenedores

```
 Navegador ── SPA React 19 (Vite) ──────────────────────────────┐
   /performance, /performance/surveys/:id,                      │ REST /api/v1 (Bearer)
   /performance/reviews[/:id], /admin/surveys                   │ WebSocket /socket.io
                                                                ▼
 ┌──────────────────────── API Hono (Node 20+) ─────────────────────────┐
 │ rateLimit (IP) → requireAuth → rutas → servicios → Prisma             │
 │ schedulers en proceso: semanas (1 min) · encuestas SCHEDULED→ACTIVE   │
 │ Socket.IO (adaptador Redis): survey:changed · review:changed          │
 └───────┬───────────────────────────────┬──────────────────────────────┘
         │                               │
         ▼                               ▼
 ┌──────────────────┐           ┌──────────────────┐
 │ PostgreSQL 16    │           │ Redis 7          │
 │ + 5 tablas nuevas│           │ caché tablero 5m │
 │ + 6 enums        │           │ rate limit       │
 └──────────────────┘           │ pub/sub sockets  │
                                └──────────────────┘
 (Meilisearch del docker-compose: no lo usa este módulo)
```

## C4 · Nivel 3: componentes de la API

```
 modules/surveys/
 ┌─────────────────┐   ┌───────────────────────┐   ┌──────────────────────┐
 │ surveys.routes  │──▶│ templates.service     │──▶│ surveys.validators   │ reglas de negocio
 │ (surveyRoutes,  │──▶│ surveys.service       │──▶│ surveys.access       │ RBAC puro
 │  reviewRoutes)  │──▶│ reviews.service       │──▶│ scoring              │ puntajes puros
 │ Zod: schemas    │──▶│ surveys.dashboard ────┼──▶│ lib/cache (Redis)    │
 └─────────────────┘   └───────┬───────────────┘   └──────────────────────┘
                               │ captureProductivity (timeout 3 s)
 modules/performance/          ▼
 ┌───────────────────┐   ┌──────────────────────┐
 │ performance.routes│──▶│ performance.service  │── tareas + KPIs (Prisma)
 └───────────────────┘   │ getPerformanceMetrics│
                         └──────────────────────┘
 Transversales: audit/activity-log · notifications/notify.service · lib/realtime
```

## Flujos principales

### 1. Crear una evaluación
```
Jefe ─POST /surveys {templateId,type,evaluatedUserId,start,end,reviewPeriod?}─▶ API
  1. Zod (forma) → validators: fechas, plantilla ACTIVE, usuario activo con área
  2. access: canManageEvaluationsOf(jefe, evaluado)       ── 403 si no
  3. evaluador: SELF → el evaluado · MANAGER → quien crea o evaluatorId (director/jefe del área)
  4. ¿ya hay una igual abierta? ── 409 SURVEY_EXISTS
  5. captureProductivity: withTimeout(getPerformanceMetrics, 3 s)
        ok → productivityIndex + productivityData      fallo/timeout/sin datos → null
  6. TX: INSERT survey · ActivityLog SURVEY_CREATED (+ SURVEY_CREATED_WITHOUT_PRODUCTIVITY)
  7. afterStatusChange: upsertPerformanceReview · invalidar tableros · emit survey:changed
  8. notify SURVEY_ASSIGNED → evaluador (campana + socket)
◀─ 201 { survey }
```

### 2. Responder con autoguardado
```
Evaluador edita ─▶ useAutoSave.queue(questionId, value)   estado "Cambios sin guardar"
   ... 30 s desde el primer cambio (o "Guardar borrador", o al salir) ...
   ─POST /surveys/:id/responses {answers:[…]}─▶ API
       answerBlock: cancelada/no evaluador/enviada/no iniciada/vencida → 403 (ADMIN exento salvo cancelada)
       validateAnswerValue por tipo → 422 si alguna falla (no escribe nada)
       TX: UPSERT (surveyId,questionId) · DELETE si value=null · recuenta avance
◀─ 200 { survey }                                           estado "Borrador guardado · hh:mm"
```

### 3. Enviar y recalcular el resultado
```
"Enviar" ─▶ flush() ─▶ POST /surveys/:id/submit
   validateSurveyCompletion (obligatorias) ── 422 SURVEY_INCOMPLETE {missingQuestionIds}
   performanceScore = media ponderada de respuestas con puntaje (null si ninguna)
   dualScore = {productivity, performance, overall = media de las presentes, status}
   TX: status COMPLETED · SURVEY_SUBMITTED
   upsertPerformanceReview(persona, periodo): medias de las COMPLETED → rating, riesgo
   invalidar tableros · emit survey:changed
```

### 4. Publicar el resultado
```
Jefe ─PATCH /performance-reviews/:id {managerComments, strengths, …}─▶ auditado con diff
Jefe ─POST /performance-reviews/:id/publish─▶ publishedAt · PERFORMANCE_REVIEW_PUBLISHED
      · invalidar tableros · emit review:changed → la persona
Persona ─GET /performance-reviews/:id─▶ ahora 200 (antes 403); ve también la evaluación del jefe
Persona ─PATCH {employeeComments}─▶ solo tras publicar
```

### 5. Scheduler
```
cada 60 s (cada instancia): activateDueSurveys()
  SELECT surveys WHERE status=SCHEDULED AND startDate<=now
  UPDATE … SET status=ACTIVE WHERE id IN (…) AND status=SCHEDULED   (idempotente)
  invalidar tableros por (workspace, periodo, área) · emit survey:changed
```

## Integraciones con el resto del sistema

| Con | Cómo | Dirección |
|---|---|---|
| **Tareas** | Module 1 lee `tasks` (asignado, `dueDate`, `progress`, `actualCompletionDate`) con la regla `taskDay` del semáforo | lectura |
| **Ciclo semanal** | Module 1 lee `kpis` registrados del área (② del índice), con la misma fórmula `kpiCompletion` | lectura |
| **Usuarios y áreas** | `role` y `departmentId` definen el acceso; `/users?departmentId=` alimenta el modal de creación | lectura |
| **Notificaciones** | `notifySafely({ type: 'SURVEY_ASSIGNED' })`: campana y socket, sin WhatsApp | escritura |
| **Auditoría** | `logActivity` en transacción; 10 acciones con etiquetas en `audit.routes.ts` y filtro "Desempeño" en la web | escritura |
| **Caché** | `lib/cache` (Redis opcional): `surveys:dash:{ws}:{period}:{all \| jefe:id}`, TTL 300 s | lectura y escritura |
| **Socket** | `emitTo` a las salas `admins`, `user` y `dept`; la web invalida las claves `['surveys']` y `['reviews']` | push |

## Endpoints

Todos bajo `/api/v1`, con `Authorization: Bearer`.

| Método y ruta | Rol mínimo (`requireRole`) | Regla fina en el servicio |
|---|---|---|
| `GET /surveys/templates?status=` | autenticado | ADMIN ve todas; JEFE solo ACTIVE; resto 403 |
| `POST /surveys/templates` | ADMIN | 3 o más preguntas, 1 o más con puntaje |
| `GET /surveys/templates/:id` | autenticado | JEFE solo ACTIVE |
| `PATCH /surveys/templates/:id` | ADMIN | solo DRAFT (409 `TEMPLATE_LOCKED`) |
| `PATCH /surveys/templates/:id/status` | ADMIN | DRAFT→ACTIVE, ACTIVE→ARCHIVED, ARCHIVED→ACTIVE |
| `DELETE /surveys/templates/:id` | ADMIN | DRAFT sin encuestas |
| `GET /surveys/dashboard?period=` | ADMIN, JEFE | JEFE: su área, sin sus propias evaluaciones |
| `GET /surveys?scope&status&departmentId&evaluatedUserId&period&page&limit` | autenticado | `surveyVisibilityFilter`; VIEWER 403 |
| `POST /surveys` | ADMIN, JEFE | `canManageEvaluationsOf` y validadores |
| `GET /surveys/:id` | autenticado | `checkSurveyAccess` (403) |
| `POST /surveys/:id/responses` | autenticado | evaluador (o ADMIN) y `answerBlock` |
| `POST /surveys/:id/submit` | autenticado | evaluador (o ADMIN), completa |
| `POST /surveys/:id/cancel` | ADMIN, JEFE | gestiona al evaluado; solo abiertas |
| `GET /performance-reviews?period&departmentId` | autenticado | `reviewVisibilityFilter` |
| `GET /performance-reviews/:id` | autenticado | `checkReviewAccess` |
| `PATCH /performance-reviews/:id` | autenticado | feedback: gestor · `employeeComments`: la persona, tras publicar |
| `POST /performance-reviews/:id/publish` | ADMIN, JEFE | gestor; 1 o más encuestas completadas |
| `GET /workspaces/:id/team/:userId/performance?weeks=` | autenticado | `canSeePerformanceOf` |

Códigos de error propios del módulo: `SURVEY_EXISTS`, `SURVEY_INCOMPLETE`, `SURVEY_LOCKED`,
`SURVEY_CANCELLED`, `SURVEY_NOT_STARTED`, `SURVEY_DEADLINE_PASSED`,
`SURVEY_ALREADY_SUBMITTED`, `SURVEY_CLOSED`, `TEMPLATE_LOCKED`, `INVALID_TRANSITION`,
`REVIEW_NOT_PUBLISHED` y `REVIEW_ALREADY_PUBLISHED`.
