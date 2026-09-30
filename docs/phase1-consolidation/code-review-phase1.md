# Code Review — Phase 1 (Performance Surveys)

- **Fecha:** 2026-09-30
- **Alcance:** `apps/api/src/modules/surveys/` (9 archivos), `apps/api/src/modules/performance/`
  (2), `apps/web/src/pages/performance/` (4) y el código web que las sostiene: `lib/performance.ts`,
  `lib/useAutoSave.ts`, `components/performance/` y `pages/admin/SurveyTemplatesPage.tsx`.
  Unas 3.400 líneas.
- **Método:** lectura completa, cobertura medida con Jest, y comprobaciones empíricas donde
  había dudas (por ejemplo, contar los lookups de sesión por request con un test temporal).
- **Base:** typecheck limpio; API 95/95 unit y 142/142 integración; web 69/69.

## Resumen de hallazgos

| ID | Severidad | Hallazgo | Dónde |
|---|---|---|---|
| **CR-01** | ✅ Resuelto ~~🔴 Alta~~ | Un JEFE_AREA ve las evaluaciones de **otro jefe de su misma área** | `surveys.access.ts:23`, `surveys.dashboard.ts:43`, `surveys.access.ts` (`reviewVisibilityFilter`) |
| **CR-02** | ✅ Resuelto ~~🟠 Media~~ | Enviar y cancelar hacen `update` no condicional: una carrera puede cancelar una encuesta recién enviada | `surveys.service.ts:380`, `:416` |
| **CR-03** | ✅ Resuelto ~~🟠 Media~~ | La detección de duplicados no es atómica: dos requests simultáneos crean dos encuestas iguales | `surveys.service.ts:209` |
| **CR-04** | 🟠 Media (producto) | Un resultado **publicado** se recalcula en silencio si llega otra encuesta del trimestre | `reviews.service.ts:44` |
| **CR-05** | 🟡 Baja | Crear "autoevaluación + jefe" hace 2 POST secuenciales; si el segundo falla queda una creada a medias | `CreateSurveyModal.tsx` (`submit`) |
| **CR-06** | 🟡 Baja | Doble autenticación en `/workspaces/*` (**confirmado**: 2 lookups de sesión frente a 1) | `app.ts:72-73` |
| **CR-07** | 🟡 Baja | Las encuestas vencidas nunca se cierran; quedan ACTIVE para siempre | `surveys.service.ts` (sin transición) |
| **CR-08** | 🟡 Baja | El scheduler lee todas las encuestas vencidas sin límite y corre en cada instancia | `surveys.service.ts:438` |
| **CR-09** | 🟡 Baja | El timeout de Module 1 no cancela las queries: siguen corriendo en segundo plano | `surveys.service.ts:40` |
| **CR-10** | 🟡 Baja | Fechas en la zona del navegador, no del workspace (periodo actual, "hoy", fin del día) | `lib/performance.ts:144`, `CreateSurveyModal.tsx:15,53` |
| **CR-11** | 🟡 Baja | `nextReviewDate` acepta `2026-02-31` (se desborda a 3 de marzo) | `surveys.schemas.ts:82` |
| **CR-12** | 🟡 Baja | Guardado al desmontar: si falla (encuesta vencida), se pierde sin aviso; `beforeunload` sin `returnValue` | `useAutoSave.ts:80-90` |
| **CR-13** | ⚪ Info | Snapshot de `departmentId`: tras un cambio de área, el jefe anterior sigue viendo | `reviews.service.ts:43`, `Survey.departmentId` |
| **CR-14** | ⚪ Info | Editar el feedback del jefe no emite evento de tiempo real (publicar sí) | `reviews.service.ts` (`updateReview`) |
| **CR-15** | ⚪ Cosmético | `<Select className="w-48">` no achica el control: `w-full` de la base gana en Tailwind 4 | `components/ui/Field.tsx`, usado en el editor de plantillas y en los filtros |
| **CR-16** | ⚪ Info | La lista de preguntas del editor usa `key={i}` con reordenamiento: el foco puede saltar al mover | `SurveyTemplatesPage.tsx` |

> **Actualización:** CR-01, CR-02 y CR-03 (y S6 de la auditoría) están resueltos, cada uno
> con tests que fallan contra el código anterior. Detalle al final: *Resolución*.

**Recomendación original:** corregir CR-01 a CR-04 antes de Phase 2; son cambios pequeños (ver
*Correcciones propuestas*). El resto puede quedar como backlog.

---

## API — `apps/api/src/modules/surveys/`

### `scoring.ts`: reglas de puntaje (funciones puras)
- **Qué hace:** normaliza respuestas, calcula `performanceScore`, `dualScore`, rating, riesgo,
  el agregado del resultado y el periodo trimestral. También calcula el índice de
  productividad de Module 1. Documenta la relación entre `Survey.dualScore` y
  `PerformanceReview.overallDualScore` ([ADR-004](adr/004-survey-scoring-system.md)).
- **Bugs y casos borde:**
  - Ninguno encontrado.
  - `mean()` descarta `NaN` e `Infinity`.
  - Un `weight ≤ 0` se trata como 1 (defensivo; Zod ya exige `> 0`).
  - `normalizeAnswer` acota a 0–100 aunque le llegue un Likert fuera de rango.
- **Validaciones:** no le corresponden; recibe datos ya validados.
- **Tests:** 98,4 % de líneas. Hay tests de bordes de rating (90, 69,9), de 0 frente a
  `null`, del ejemplo 84/86/82 → 84 y de periodos. ✅ Adecuados.

### `surveys.access.ts`: RBAC
- **Qué hace:** reglas puras de ver y gestionar encuestas y resultados, y sus filtros Prisma
  equivalentes ([ADR-003](adr/003-rbac-permission-model.md)).
- **Bugs y casos borde:**
  - **CR-01.** `return user.role === 'JEFE_AREA' && survey.departmentId === user.departmentId`
    no distingue si el evaluado es otro jefe. Escenario: Marketing tiene dos JEFE_AREA
    (A y B, como en los fixtures `mkt.jefe` y `mkt.jefeNoGrant`). El director evalúa a A.
    B abre `GET /surveys/:id` y recibe 200, ve los puntajes de A y además los ve en su
    tablero. Lo mismo ocurre con `reviewVisibilityFilter` y `checkReviewAccess`: B ve el
    resultado de A.
  - Un jefe sin `departmentId` queda limitado a lo que evalúa. Correcto.
- **Validaciones:** N/A.
- **Tests:** 100 % de líneas (unit). Falta un test del caso CR-01.

### `surveys.validators.ts`: reglas de negocio centralizadas
- **Qué hace:** valida plantillas (3 o más preguntas, 1 o más con puntaje, opciones de
  ranking), fechas, estado de la plantilla, existencia de usuario, completitud y valor de
  respuesta por tipo.
- **Bugs y casos borde:**
  - `validateCreateSurveyData` permite `startDate` en el pasado. Es intencional: la encuesta
    se abre de inmediato.
  - Las opciones de ranking se comparan sin distinguir mayúsculas al detectar duplicados,
    pero la respuesta exige la cadena exacta. Coherente, porque las opciones se guardan
    exactas.
- **Validaciones:** ✅ completas para lo que cubren. TEXT limita a 4000 caracteres aquí,
  mientras que Zod acepta cualquier string; el validador es el que manda.
- **Tests:** 100 % de líneas. ✅

### `surveys.schemas.ts`: Zod
- **Qué hace:** define la forma de cada body y query. Los campos desconocidos se descartan,
  así que no hay asignación masiva de campos.
- **Bugs y casos borde:**
  - **CR-11.** `nextReviewDate` se valida con una regex, no como fecha real.
  - `listSurveysSchema.limit` hereda el máximo de 100 de `paginationSchema`. ✅
- **Tests:** 100 %. Falta un test de fecha imposible.

### `templates.service.ts`: plantillas
- **Qué hace:** CRUD de plantillas con la máquina de estados `DRAFT → ACTIVE ⇄ ARCHIVED`.
  Solo se editan los DRAFT y solo se borran los DRAFT sin encuestas. Los JEFE_AREA ven solo
  las ACTIVE.
- **Bugs y casos borde:**
  - Archivar una plantilla **no** afecta a las encuestas abiertas que ya la usan. Es
    correcto, pero no está documentado en la UI.
  - Reemplazar preguntas en `updateTemplate` es `deleteMany` + `createMany`. Es seguro
    porque un DRAFT no puede tener encuestas (se crean solo con plantillas ACTIVE).
- **Validaciones:** ✅ Se re-valida al activar (por si las reglas cambiaron).
- **Tests:** 🟠 84 % de líneas y **39 % de ramas**, el archivo más débil. Sin cubrir:
  - la transición inválida DRAFT → ARCHIVED (409);
  - el borrado exitoso de un DRAFT;
  - `getTemplate` de un JEFE sobre un DRAFT (404);
  - el cambio de estado sin cambio real.

### `surveys.dashboard.ts`: tablero con caché
- **Qué hace:** resumen por área de un trimestre (conteos por estado, vencidas, promedios,
  ratings y resultados publicados). Caché de 5 minutos por director o por jefe, invalidada en
  cada cambio de estado y al publicar.
- **Bugs y casos borde:**
  - **CR-01** también aplica aquí (`:43` excluye solo al propio jefe).
  - El número de vencidas se calcula al construir la entrada, así que puede atrasarse hasta
    5 minutos. Aceptable.
  - Carga todas las encuestas del periodo en memoria (6 columnas). Ver
    [scalability](scalability-phase1.md).
- **Tests:** 97,5 % de líneas. La invalidación está probada espiando `cache.invalidate`
  (Redis está apagado en los tests). ✅

### `reviews.service.ts`: resultados trimestrales
- **Qué hace:** `upsertPerformanceReview` reconstruye el agregado. También lista, detalla,
  edita (el feedback del jefe o el comentario del empleado) y publica.
- **Bugs y casos borde:**
  - **CR-04.** `update: { performanceData, ...scores }` se aplica también a resultados ya
    publicados, sin aviso ni auditoría del cambio.
  - **CR-13.** `departmentId` se fija solo al crear.
  - **CR-14.** `updateReview` no emite evento de tiempo real.
  - Publicar exige `surveysCompleted > 0` y no se puede deshacer.
- **Validaciones:** ✅
  - Los campos del jefe y del empleado tienen permisos separados.
  - El empleado solo comenta tras la publicación.
  - Si un request mezcla campos de ambos, se valida cada parte.
- **Tests:** 98 % de líneas y 65 % de ramas. Faltan: acceso entre workspaces (404),
  `nextReviewDate: null` y el caso CR-04.

### `surveys.service.ts`: encuestas (núcleo)
- **Qué hace:** crea (con validaciones centralizadas, foto de Module 1 con timeout y
  auditoría), lista con filtro RBAC, detalla, guarda respuestas (upsert en transacción),
  envía (puntajes y recálculo del resultado), cancela, y ejecuta el scheduler que pasa de
  SCHEDULED a ACTIVE.
- **Bugs y casos borde:**
  - **CR-02.** `submitSurvey` comprueba el estado leído y luego hace
    `tx.survey.update({ where: { id } })` sin condición de estado. `cancelSurvey` hace lo
    mismo. Escenario: la persona envía mientras el jefe cancela; ambos pasan su verificación
    y el último en escribir gana. Si gana `CANCELLED`, la encuesta enviada queda cancelada y
    `upsertPerformanceReview` la excluye del resultado. Dos envíos simultáneos también
    duplican el log `SURVEY_SUBMITTED`.
  - **CR-03.** El chequeo `duplicate` y el `create` no son atómicos. En la UI el botón queda
    deshabilitado mientras se envía (lo mitiga), pero un cliente de la API no tiene esa
    protección.
  - **CR-07.** Ninguna transición cierra una encuesta vencida.
  - **CR-08.** `activateDueSurveys` no pagina y corre en cada réplica. El `updateMany`
    condicional es idempotente, pero los `broadcast` se duplican.
  - **CR-09.** `withTimeout` no cancela la promesa perdedora.
  - En `saveResponses`, cuando un ADMIN corrige una encuesta enviada, se exige que siga
    completa (`validateSurveyCompletion`). No se puede borrar una respuesta obligatoria de
    una encuesta enviada. ✅ Correcto.
- **Validaciones:** ✅ Todo pasa por `surveys.validators.ts`. El evaluador y el departamento
  los resuelve el servidor, nunca se confía en el cliente.
- **Tests:** 94,7 % de líneas y 75 % de ramas. Sin cubrir: el `DELETE` al mandar
  `value: null`, el mensaje de "evaluado sin departamento", el `logger.info` del scheduler y
  las carreras.

### `surveys.routes.ts`
- **Qué hace:** monta `/surveys/*` y `/performance-reviews/*`. Las rutas literales
  (`/templates`, `/dashboard`) se registran antes de `/:id`. `requireRole` actúa como primera
  barrera y el servicio aplica la regla fina.
- **Bugs:** ninguno. Todos los `:id` pasan por `idParam`: un UUID mal formado da 404 sin
  llegar a la BD.
- **Tests:** 94,6 %. Solo faltan `GET /templates/:id` y `DELETE` exitoso.

## API — `apps/api/src/modules/performance/`

### `performance.service.ts`: Module 1
- **Qué hace:** métricas de productividad de una persona en N semanas y su control de
  acceso ([ADR-002](adr/002-module1-performance-calculation.md)).
- **Bugs y casos borde:**
  - Con una tarea `progress = 100` sin `actualCompletionDate` (importada), la puntualidad
    queda en `null` si no hay otras tareas medibles. Es correcto, pero puede sorprender.
  - Las tareas de semanas archivadas cuentan (se filtra por fecha, no por estado de la
    semana). Correcto.
  - `mondayOfDay(from)` amplía el rango de KPIs a la semana completa. Intencional.
- **Validaciones:** `weeks` entre 1 y 26 (Zod). ✅
- **Tests:** 90,7 % de líneas. **Sin cubrir:** el cálculo de `kpi_achievement`
  (líneas 95-97, 103). 🟠 Falta un test con KPIs registrados.

### `performance.routes.ts`
- **Bugs:** **CR-06.** Montado en `/workspaces` junto a `brandingRoutes`. El
  `.use('*', requireAuth)` de cada sub-app se aplica a todo `/workspaces/*`, así que cada
  request autentica **dos veces**. Se comprobó con un test temporal: 2 llamadas a
  `session.findUnique` en `/workspaces/.../performance` frente a 1 en `/surveys`. También
  afecta a las rutas de branding.
  **Corrección:** montar `performanceRoutes` en `/workspaces` sin su propio `requireAuth`, o
  mejor, agrupar ambas en una sola sub-app.
- **Tests:** 100 %.

## Web — `apps/web/src/pages/performance/` y soporte

### `surveys/SurveyResponsePage.tsx`: responder
- **Qué hace:** el formulario por tipo de pregunta (radio Likert, número, texto, ranking con
  botones subir y bajar), el autoguardado, el envío con marcado de faltantes, la vista de
  solo lectura con los puntajes y el motivo del bloqueo.
- **Bugs y casos borde:**
  - La semilla del formulario se toma una vez (bien, no pisa lo que se escribe). Si un ADMIN
    corrige la encuesta mientras la persona la tiene abierta en solo lectura, no ve el
    cambio hasta recargar.
  - NUMERIC acota al teclear: escribir 150 muestra 100. Aceptable.
  - Los radios Likert son `sr-only` con etiqueta visible y foco visible (`has-[:focus-visible]`). ✅ Accesible.
- **Validaciones:** en el cliente solo las mínimas; el servidor es la fuente de verdad y los
  422 se muestran.
- **Tests:** 4 tests (autoguardado a 30 s, guardado antes de enviar con faltantes marcados,
  solo lectura con puntajes y 403). ✅

### `PerformancePage.tsx`: pendientes y equipo
- **Qué hace:**
  - "Por completar" (`scope=assigned`) para todos.
  - Para jefes y director: tablero del periodo, tabla de evaluaciones con filtro de estado y
    cancelación con confirmación, y el botón "Nueva evaluación".
- **Bugs y casos borde:**
  - **CR-10.** El periodo por defecto (`currentPeriod`) usa la fecha del navegador.
  - La tabla por área solo aparece con más de un área (en el caso del jefe, nunca). Es
    intencional.
- **Tests:** ❌ Sin tests de componente.

### `ReviewsPage.tsx` y `ReviewDetailPage.tsx`: resultados
- **Qué hacen:**
  - La lista filtrable por periodo.
  - El detalle: 5 tarjetas de puntaje, las evaluaciones del periodo, el formulario del jefe
    (listas "una por línea"), la confirmación de publicación y el comentario del empleado.
- **Bugs y casos borde:**
  - `ManagerForm` se remonta cuando cambia `updatedAt` (vía `key`). Si el empleado comenta
    mientras el jefe escribe, el jefe perdería su texto al refrescar. Hoy no pasa porque
    `updateReview` no emite evento (CR-14); si se agrega el evento, hay que cuidar esto.
  - Las listas "una por línea" descartan líneas vacías y no deduplican.
- **Tests:** ❌ Sin tests de componente.

### Soporte web
| Archivo | Qué hace | Hallazgos | Tests |
|---|---|---|---|
| `lib/performance.ts` | Tipos y hooks de TanStack Query; claves `['surveys', …]` y `['reviews', …]` invalidadas por los eventos de socket | CR-10 (`currentPeriod`) | Indirectos |
| `lib/useAutoSave.ts` | Cola deduplicada, temporizador de 30 s, reintento y `flush` ([ADR-005](adr/005-autosave-strategy.md)) | CR-12 | ✅ 3 tests con timers falsos |
| `components/performance/CreateSurveyModal.tsx` | Crea autoevaluación y/o evaluación del jefe | CR-05, CR-10. Lista candidatos desde `/users` con filtro por área para el jefe; el servidor re-valida | ❌ |
| `components/performance/PerfBits.tsx` | Etiquetas, insignias y `Score` con color del semáforo | — | Indirectos |
| `pages/admin/SurveyTemplatesPage.tsx` | Tarjetas de plantillas y editor de preguntas | CR-15, CR-16. `templateProblems` replica las reglas del servidor | ✅ Reglas; ❌ UI |

---

## Correcciones propuestas (CR-01 a CR-04)

```ts
// CR-01 — surveys.access.ts: la rama del jefe solo cubre a colaboradores.
// Survey necesita el rol del evaluado: guardarlo como snapshot (evaluatedRole) o incluirlo en el select.
return user.role === 'JEFE_AREA' && survey.departmentId === user.departmentId
    && survey.evaluatedRole !== 'JEFE_AREA';          // idem en surveyVisibilityFilter,
                                                      // reviewVisibilityFilter, checkReviewAccess, dashboard

// CR-02 — surveys.service.ts: transición condicional.
const { count } = await tx.survey.updateMany({
  where: { id: s.id, status: { in: ['SCHEDULED', 'ACTIVE'] } }, data: { status: 'COMPLETED', … },
});
if (count === 0) throw new AppError(409, 'SURVEY_CLOSED', 'La encuesta cambió de estado; recarga');

// CR-03 — migración SQL (Prisma no expresa índices parciales):
CREATE UNIQUE INDEX surveys_one_open_per_pair
  ON surveys ("evaluatedUserId", "evaluatorId", type) WHERE status IN ('SCHEDULED','ACTIVE');
// y traducir el error P2002 a 409 SURVEY_EXISTS.

// CR-04 — reviews.service.ts: si publishedAt != null y cambian los puntajes,
// registrar PERFORMANCE_REVIEW_RECALCULATED con {old,new} y notificar a la persona.
// Alternativa de producto: impedir crear encuestas del periodo tras publicar.
```

## Conclusión

El código es consistente con las convenciones del proyecto:
- errores `AppError` con códigos estables;
- Zod en el borde y validadores de negocio aparte;
- auditoría en transacción con el cambio;
- permisos calculados en el servidor y expuestos a la UI;
- funciones puras testeadas por separado.

No hay SQL crudo ni `dangerouslySetInnerHTML`.

Los defectos reales son de **concurrencia** (CR-02, CR-03), un **hueco de privacidad entre
jefes pares** (CR-01) y una **decisión de producto pendiente** (CR-04). Ninguno requiere
rediseño.

---

## Resolución (CR-01, CR-02, CR-03)

| ID | Qué se hizo | Diferencia con la propuesta | Tests |
|---|---|---|---|
| CR-01 | Un JEFE_AREA solo ve y gestiona a su **equipo**: evaluados cuyo rol **actual** no es JEFE_AREA ni ADMIN. Se aplica en `checkSurveyAccess`, `surveyVisibilityFilter`, `canManageEvaluationsOf`, `checkReviewAccess`, `reviewVisibilityFilter`, el tablero (`teamSurveyFilter`, `teamReviewFilter`) y **Module 1** (`canSeePerformanceOf`, que tenía el mismo hueco). Además, un jefe ya no puede ser evaluador de un par, y el modal de creación ya no ofrece a jefes pares. | Se usa el rol actual por relación (`evaluatedUser.role`) en vez de guardar un snapshot `evaluatedRole`: no hace falta migración, y quien pasa a ser jefe deja de ser visible para sus nuevos pares. | 1 unit + 1 integración (lista, detalle, resultado, tablero, Module 1 y creación) |
| CR-02 | `claim(tx, id, estados)`: un `updateMany` condicional al estado, **dentro** de la transacción, antes de enviar, cancelar o guardar respuestas. Bloquea la fila hasta el commit; el perdedor recibe `409 SURVEY_STATE_CHANGED`. El envío relee las respuestas bajo el lock, así que el puntaje no queda desactualizado por un autoguardado concurrente. | Igual a la propuesta, extendida a `saveResponses`. | Envío frente a cancelación (5 rondas) y 3 envíos simultáneos: siempre un solo ganador y un solo log |
| CR-03 | `pg_advisory_xact_lock` por (evaluado, evaluador, tipo) dentro de la transacción de creación, y la re-verificación de duplicado bajo el lock. Se conserva una verificación previa, sin lock, para responder 409 antes de gastar en Module 1. | Se usó un advisory lock en vez del **índice único parcial** propuesto: Prisma 6 no representa índices parciales en el schema, y un `migrate dev` futuro propondría borrarlo. La regla de unicidad sigue siendo (evaluado, evaluador, tipo) mientras esté abierta; la variante "plantilla + evaluado + fecha de inicio" bloquearía el par autoevaluación + evaluación del jefe que crea el modal. | 4 creaciones simultáneas dan 1; el par autoevaluación + jefe simultáneo sí se crea |
