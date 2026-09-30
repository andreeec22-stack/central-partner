# ADR-002: Cálculo de productividad ("Module 1")

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Archivos:** `apps/api/src/modules/performance/performance.service.ts`,
  `apps/api/src/modules/surveys/scoring.ts` (`calculateProductivityIndex`),
  `apps/api/src/modules/surveys/surveys.service.ts` (`captureProductivity`, `withTimeout`)

## Contexto

La especificación asumía un "Module 1 — Performance Analytics" ya existente, con un endpoint
`GET /workspaces/:id/team/:userId/performance`. **No existía en el repositorio.** El usuario
decidió construirlo **solo con datos de tareas**.

El índice pedido pesa 30 % completitud, 30 % puntualidad, 20 % colaboración y 20 % KPIs.
El riesgo 2 de la auditoría exigía que un fallo de Module 1 **nunca** impidiera crear una
encuesta.

## Decisión

1. **Cálculo en proceso**, en la misma API, contra la misma base de datos. Una función,
   `getPerformanceMetrics(userId, workspaceId, tz, weeks = 4)`, se expone por HTTP y la
   llama directamente el servicio de encuestas.
2. **Ventana de 4 semanas** hasta hoy, en la zona del workspace.
   - **Completitud:** de las tareas asignadas a la persona cuyo día ya llegó, cuántas están al 100 %.
   - **Puntualidad:** de las completadas con `actualCompletionDate` conocida, cuántas se
     terminaron el día previsto o antes. Las que no tienen fecha de cierre (importadas o del
     seed) quedan fuera y se cuentan aparte en `completionDateUnknown`.
   - **KPIs:** el ② del índice semanal del **área** de la persona, promediado en la ventana
     y con cada KPI tope al 100 %.
   - **Colaboración:** `null` siempre, porque no hay fuente fiable (ver *Alternativas*).
   - "El día de una tarea" es la misma regla que el semáforo (`taskDay`): su `dueDate`, o el
     sábado de su semana si no tiene fecha.
3. **Pesos redistribuidos:** una métrica sin datos sale del cálculo y las demás se
   re-ponderan. Con colaboración en `null` quedan completitud 37,5 %, puntualidad 37,5 % y
   KPIs 25 %. Si todas son `null`, el índice es `null`, nunca 0.
4. **Foto al crear:** el índice y el detalle (`productivityData`) se guardan en la encuesta
   al crearla. No se recalculan después.
5. **Fallback** (`captureProductivity`):

   ```ts
   try {
     report = await withTimeout(perf.getPerformanceMetrics(...), 3000)   // surveyConfig.productivityTimeoutMs
   } catch (e) {
     logger.warn('productivity unavailable for survey', ...)
     → productivityIndex = null   // la encuesta se crea igual
   }
   ```

   Si el índice es `null` (por error, timeout **o** falta de datos), se registra además
   `SURVEY_CREATED_WITHOUT_PRODUCTIVITY` en `ActivityLog`, con el motivo.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| **Servicio externo** (analytics aparte, HTTP) | Suma una red, un despliegue y un modo de fallo más, para datos que ya están en la misma base. El timeout y el fallback lo cubrirían, pero sin beneficio hoy. Si Module 1 se separa, basta con cambiar `getPerformanceMetrics` por un cliente HTTP; el contrato ya existe. |
| **Job precalculado** (poblar la tabla `UserPerformanceSnapshot`, que existe sin uso) | Datos más viejos, más infraestructura (cron, backfill). Con los índices actuales, la consulta en vivo son 2 queries acotadas por persona. Queda como opción de escala ([scalability](../scalability-phase1.md)). |
| **Recalcular el índice al enviar, no al crear** | Da un número más fresco, pero la persona podría "mejorar" su índice entre crear y enviar, y la foto dejaría de ser reproducible. Se prefirió congelarlo. |
| **Colaboración desde comentarios y @menciones** (`Task.totalCommentsCount`, `collaborationParticipantIds`) | Esos contadores no se mantienen de forma consistente, y "comentar mucho" no equivale a colaborar bien. Se prefirió no inventar la métrica. |
| **Faltantes contados como 0** | Castigaría a quien no tiene KPIs en su área o no tuvo tareas vencidas en la ventana. |
| **Sin timeout** (confiar en que es local) | Es local hoy, pero un bloqueo de la BD o una tabla grande no deben colgar la creación. El timeout también deja listo el camino hacia un servicio externo. |

## Consecuencias

**Positivas**
- No hay componentes nuevos que desplegar.
- Crear una encuesta nunca falla por culpa de Module 1: los tests de integración cubren el
  error y el cuelgue.
- El número es explicable: `productivityData.tasks` muestra *cuántas vencieron, cuántas se
  completaron y cuántas a tiempo*.

**Negativas y riesgos**
- **El timeout no cancela la consulta:** `Promise.race` abandona la promesa, pero las queries
  siguen corriendo hasta terminar. Con timeouts frecuentes, esa carga se acumula.
- **KPIs de área:** todos en un área comparten `kpi_achievement`. Un colaborador brillante en
  un área con KPIs bajos queda penalizado.
- **Asignación actual:** una tarea reasignada cuenta solo para su asignado actual; el anterior
  pierde el crédito.
- **Puntualidad incompleta:** para tareas importadas desde Excel, o completadas antes de que
  existiera `actualCompletionDate`, la puntualidad queda en `null`.
- **`kpi_achievement` no tiene test de integración** (ver
  [testing-strategy](../testing-strategy.md)).
