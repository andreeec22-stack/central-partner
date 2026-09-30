# Security Audit — Phase 1 (Performance Surveys)

- **Fecha:** 2026-09-30
- **Alcance:** los endpoints nuevos (`/surveys/*`, `/performance-reviews/*`,
  `/workspaces/:id/team/:userId/performance`), el scheduler, los eventos de socket y las
  páginas web del módulo.
- **Fuera de alcance:** autenticación, sesiones y cookies (se revisaron en fases anteriores;
  aquí solo se verifica que el módulo las usa).
- **Método:** revisión de código, búsqueda de patrones peligrosos (`$queryRaw`,
  `dangerouslySetInnerHTML`), lectura del middleware y tests de integración de RBAC.
- **Clasificación de datos:** las evaluaciones y los resultados son **datos personales de
  RRHH**: juicios sobre el desempeño de una persona identificable.

## Resumen

| ID | Área | Resultado | Severidad |
|---|---|---|---|
| S1 | Inyección SQL | ✅ Sin vectores | — |
| S2 | XSS | ✅ Sin vectores | — |
| S3 | RBAC y control de acceso | ✅ Resuelto: jefes pares aislados (CR-01) | ~~🔴 Alta~~ |
| S4 | Enumeración (403 frente a 404) | ⚠️ Aceptado por diseño | ⚪ Info |
| S5 | Validación de entrada | ✅ Completa, con un detalle menor | 🟡 Baja |
| S6 | Rate limiting | ✅ Resuelto: la clave es el usuario del JWT; IP solo para anónimos | ~~🟠 Media~~ |
| S7 | Exposición de datos sensibles | ⚠️ S3, más datos de Module 1 embebidos | 🟡 Baja |
| S8 | Integridad y concurrencia | ✅ Resuelto para CR-02/CR-03; queda CR-04 | 🟡 Baja |
| S9 | Auditoría | ✅ Cubre todas las acciones, con un hueco en recálculos | 🟡 Baja |
| S10 | Tiempo real (socket) | ✅ Eventos sin datos sensibles | — |
| S11 | Retención y privacidad | ⚠️ Sin política de retención ni exportación | 🟡 Baja (proceso) |
| S12 | CSRF y mass assignment | ✅ | — |

## S1 · Inyección SQL — ✅

- **0 usos** de `$queryRaw`, `$executeRaw` ni `*Unsafe` en `modules/surveys` y
  `modules/performance` (verificado por búsqueda en el código).
- Todo el acceso pasa por Prisma, con consultas parametrizadas.
- Los filtros de listas (`status`, `period`, `departmentId`, `evaluatedUserId`) se validan
  con Zod (enum, regex `^\d{4}-Q[1-4]$` y `uuid`) antes de llegar a Prisma.
- Los campos JSON (`value`, `dualScore`, `productivityData`) se guardan como `jsonb`
  parametrizado.

## S2 · XSS — ✅

- **0 usos** de `dangerouslySetInnerHTML` en `apps/web/src`.
- Las respuestas de texto, los comentarios y los nombres se renderizan como texto de React
  (`whitespace-pre-line` solo afecta a los saltos de línea).
- Las opciones de ranking y los textos de pregunta también se renderizan como texto.
- Las cabeceras de seguridad de `secureHeaders()` (nosniff, frame-options, etc.) ya estaban
  en `app.ts`. **No hay Content-Security-Policy configurada**: `secureHeaders` no la activa
  por defecto. Sería una defensa adicional útil para toda la app, no solo para este módulo.

## S3 · RBAC — ⚠️ un hueco

**Qué está bien** (probado en integración):
- Todo acceso se decide en el servidor (`surveys.access.ts`); la UI solo lee `permissions`.
- Cada consulta filtra por `workspaceId` (no hay IDOR entre workspaces).
- Un jefe de otra área recibe 403, **incluso con un permiso de visibilidad** sobre el área.
- Un colaborador no ve la evaluación de su jefe hasta que se publica.
- VIEWER recibe 403 en todo.
- Solo el evaluador responde.
- El evaluador de una evaluación del jefe se valida en el servidor: debe ser el director o
  un jefe del área del evaluado.
- `respondentId` lo fija el servidor.
- Module 1: solo el director, la propia persona o el jefe de su área.

**Hallazgo (Alta), CR-01:** cuando un área tiene **más de un JEFE_AREA**, cada jefe ve las
evaluaciones, los resultados y los promedios del otro. Pasa porque la regla "el jefe ve su
área" no excluye a los evaluados con rol de jefe (`surveys.access.ts:23`,
`surveys.dashboard.ts:43`).
- **Impacto:** fuga lateral de datos de RRHH entre pares.
- **Probabilidad:** baja-media; los fixtures de test tienen exactamente este caso
  (`mkt.jefe` y `mkt.jefeNoGrant`).
- **Corrección:** en [code-review-phase1.md](code-review-phase1.md#correcciones-propuestas-cr-01-a-cr-04).

**Observación:** gestionar un área se basa en `departmentId`, no en `headId` (coherente con
todo el sistema; [ADR-003](adr/003-rbac-permission-model.md)). Si el negocio espera que
"Jefe Finanzas" gestione las 9 áreas donde figura como `headId`, hoy **no** puede. Es un
riesgo de expectativa, no de seguridad.

## S4 · 403 frente a 404 — ⚪ aceptado

- Si la encuesta existe en el workspace pero no hay permiso, la respuesta es 403 (pedido
  explícito del prompt de riesgos). Fuera del workspace, o con un ID mal formado, es 404.
- Esto revela que un UUID corresponde a una encuesta **del mismo workspace**. Los IDs son
  UUID v4 (122 bits aleatorios), así que enumerarlos no es viable.
- **Riesgo residual despreciable.** Si se quiere cerrar, devolver 404 en `loadVisible`.

## S5 · Validación de entrada — ✅ (detalle menor)

| Entrada | Validación |
|---|---|
| Plantilla | nombre ≤ 120, descripción ≤ 1000, ≤ 50 preguntas, texto ≤ 500, peso de 0 a 10, ranking con 2 a 10 opciones únicas de ≤ 120; 3 o más preguntas y 1 o más con puntaje |
| Encuesta | UUIDs, fechas coercionadas, `start < end`, `end ≥ ahora`, periodo `YYYY-Qn`, plantilla ACTIVE, usuario activo del workspace con área, reglas de evaluador |
| Respuestas | 1 a 50 por lote; valor según tipo (Likert entero en rango, numérico 0–100, texto no vacío ≤ 4000, ranking como permutación exacta); pregunta de la encuesta; lote atómico |
| Feedback | comentarios ≤ 4000, listas ≤ 20 × 300, fecha `YYYY-MM-DD` |

- **Detalle (CR-11):** `nextReviewDate` acepta fechas imposibles como `2026-02-31`, que se
  guardan como 3 de marzo. No es explotable, pero es un dato incorrecto.
- **Tamaño del body:** no hay límite explícito de bytes en la API. El peor caso válido es un
  lote de 50 respuestas de texto de 4000 caracteres, unos 200 KB, que el servidor acepta.
  Conviene un límite global de body (por ejemplo, `hono/body-limit` a 1 MB) para todo `/api`.

## S6 · Rate limiting — ⚠️ Media

- **Qué hay:** `rateLimit({ prefix: 'api', max: 300, windowSeconds: 60 })` sobre todo
  `/api/v1` (`app.ts:58`), con Redis (o memoria si no hay Redis). Todos los endpoints nuevos
  heredan este límite.
- **Hallazgo:** el middleware corre **antes** de `requireAuth`, así que `c.get('user')` está
  vacío y la clave es **la IP**. Detrás del NAT de una oficina, toda la empresa comparte 300
  requests por minuto. El autoguardado está diseñado para ≤ 2/min por persona
  ([ADR-005](adr/005-autosave-strategy.md)), pero el uso normal de la app (listas, tablero,
  tareas, refetch por socket) con 30 personas o más puede agotar el cupo y dar 429 a todos.
- **Recomendación:** limitar por usuario cuando haya token. Por ejemplo, decodificar el JWT
  en el limiter sin tocar la BD, o mover el limiter después de `requireAuth` en las rutas
  autenticadas, y conservar el límite por IP para `/auth`. Revisar que 300 es razonable por
  **persona**.
- **Sin límite propio para operaciones caras:** crear una encuesta dispara Module 1 (2
  queries acotadas). Con el límite global basta.

## S7 · Exposición de datos sensibles — ⚠️ Baja

- **Payloads:** el detalle de una encuesta incluye `productivityData` (conteos de tareas y
  métricas). Lo ven el evaluador (en una autoevaluación son sus propios datos; en una
  evaluación del jefe, su jefe), el director y los jefes del área. La persona evaluada lo ve
  en la evaluación de su jefe al publicarse. Es coherente con quién puede ver Module 1,
  **salvo CR-01**.
- **Notificaciones:** `SURVEY_ASSIGNED` lleva solo el título y la fecha límite, sin puntajes.
  No se envía por WhatsApp.
- **Auditoría:** los metadatos de `SURVEY_SUBMITTED`, `SURVEY_RESPONSES_CORRECTED` y
  `PERFORMANCE_REVIEW_PUBLISHED` incluyen **puntajes**. `ActivityLog` solo lo lee el ADMIN
  (`audit.routes.ts`), así que es aceptable, pero significa que los puntajes también viven
  en la tabla de auditoría y en su exportación a Excel.
- **Logs del servidor:** `logger.warn('productivity unavailable…')` registra `userId` y el
  error, sin puntajes. ✅
- **Errores:** `SURVEY_INCOMPLETE` devuelve los IDs de las preguntas faltantes, solo al
  evaluador. ✅

## S8 · Integridad y concurrencia — ⚠️ Media

- **CR-02:** las transiciones de enviar y cancelar no son condicionales. Una carrera puede
  dejar una encuesta enviada como CANCELLED y sacarla del resultado. No es explotable por un
  atacante externo, pero sí por un jefe que cancela en el momento justo (y la acción queda
  en auditoría).
- **CR-03:** se pueden crear duplicados con dos requests simultáneos.
- **CR-04:** un resultado publicado cambia sin rastro de auditoría del recálculo.
- **Correcto:** el guardado de respuestas es transaccional y atómico, y las auditorías se
  escriben en la misma transacción que el cambio.

## S9 · Auditoría — ✅ (hueco menor)

Hay 10 acciones nuevas (`SURVEY_TEMPLATE_CREATED`, `SURVEY_TEMPLATE_UPDATED`,
`SURVEY_TEMPLATE_DELETED`, `SURVEY_CREATED`, `SURVEY_CREATED_WITHOUT_PRODUCTIVITY`,
`SURVEY_SUBMITTED`, `SURVEY_RESPONSES_CORRECTED`, `SURVEY_CANCELLED`,
`PERFORMANCE_REVIEW_UPDATED` y `PERFORMANCE_REVIEW_PUBLISHED`), con etiquetas en español y
filtros en la página de Auditoría.

- **Hueco:** `SURVEY_RESPONSES_CORRECTED` guarda qué preguntas cambiaron y el nuevo puntaje,
  **no el valor anterior** de cada respuesta. Para disputas ("¿qué había respondido
  antes?") no hay rastro. Recomendación: incluir `{ questionId, old, new }`.
- **Hueco:** el recálculo automático de un resultado publicado no se audita (CR-04).

## S10 · Tiempo real — ✅

- `survey:changed` se emite a `admins:{ws}`, `user:{evaluador}` y `dept:{área}` con
  `{ surveyId, status }` únicamente.
- `review:changed` se emite a la persona y a los admins con
  `{ reviewId, userId, period }`.
- Los clientes solo **invalidan** consultas y vuelven a pedir los datos por REST, que aplica
  el RBAC. Saber que "una encuesta de mi área cambió de estado" no expone contenido.

## S11 · Retención y privacidad — ⚠️ proceso

- No hay política de retención, borrado ni exportación de evaluaciones por persona. La
  eliminación de usuarios es un *soft delete*, así que las evaluaciones permanecen.
- Si la empresa opera en Perú, la Ley 29733 de protección de datos personales puede exigir
  atender solicitudes de acceso, rectificación y cancelación. Conviene que el área legal
  confirme el alcance. Esto no es asesoría legal.
- **Recomendación:** definir el plazo de conservación y un procedimiento de exportación y
  borrado por persona antes de usar el módulo con datos reales a escala.

## S12 · CSRF y mass assignment — ✅

- La API usa `Authorization: Bearer` (token en memoria), no cookies, en estos endpoints. No
  hay CSRF.
- Zod descarta los campos desconocidos. `workspaceId`, `respondentId`, `createdById`,
  `departmentId`, `status` y los puntajes los fija siempre el servidor.

## Plan de remediación

| Prioridad | Acción | Hallazgo |
|---|---|---|
| 1 | Excluir a los jefes de la rama "jefe ve su área" | S3 / CR-01 |
| 2 | Transiciones condicionales e índice único parcial | S8 / CR-02, CR-03 |
| 3 | ~~Rate limit por usuario autenticado~~ ✅ `userOrIpKey` en `middleware/rate-limit.ts` | S6 |
| 4 | Auditar los recálculos de resultados publicados y los valores anteriores en correcciones | S9 / CR-04 |
| 5 | Límite global de tamaño de body | S5 |
| 6 | Política de retención y exportación | S11 |
