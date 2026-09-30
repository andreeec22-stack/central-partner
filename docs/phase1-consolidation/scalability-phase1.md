# Escalabilidad y rendimiento — Phase 1

## Supuestos de volumen

La empresa actual tiene 13 áreas y unas decenas de personas. Para ver dónde se rompe el
diseño, se analiza un escenario **100 veces mayor**:

| Dimensión | Hoy (seed) | Escenario de análisis |
|---|---|---|
| Personas | 10 | 2.500 |
| Encuestas por trimestre | 5 | 5.000 (2 por persona) |
| Encuestas acumuladas (2 años) | — | **~40.000** (más de las 10.000 pedidas) |
| Respuestas | ~15 | 40.000 × 10 preguntas = **400.000** |
| Resultados | 1 | 2.500 × 8 trimestres = 20.000 |

Una fila `surveys` ocupa unos 1–2 KB (con `productivityData` en jsonb) y una
`survey_responses` unos 200 B. **40.000 encuestas son unos 80 MB y 400.000 respuestas unos
80 MB**: tamaños triviales para Postgres.

## Consulta por consulta

| Operación | Frecuencia | Consulta | Índice usado | Con 10.000–40.000 encuestas |
|---|---|---|---|---|
| Mis pendientes (`scope=assigned`) | cada visita | `evaluatorId = ? AND (OR visibilidad)` + `count` | `(evaluatorId, status)` | ✅ decenas de filas por persona |
| Lista de un jefe | cada visita | `OR [evaluatorId, departmentId, evaluado+periodo]` | BitmapOr sobre 3 índices | ✅ acotado al área |
| Lista del director sin filtro | ocasional | `workspaceId = ?` ORDER BY `createdAt` LIMIT 25 + `count(*)` | `(workspaceId, status, createdAt)` (prefijo) | 🟡 el `count(*)` recorre todas las filas del workspace (~40k): pocos ms, pero crece linealmente |
| Lista filtrada por **periodo** | cada visita a Desempeño | `workspaceId = ? AND reviewPeriod = ?` | solo el prefijo `workspaceId`; el periodo se filtra después | 🟠 **falta índice** `(workspaceId, reviewPeriod)` |
| Tablero (sin caché) | 1 cada 5 min por jefe o director | `findMany` de 6 columnas de todas las encuestas del periodo + resultados + áreas | prefijo `workspaceId` | 🟡 5.000 filas en memoria (~1 MB) y agregado en JS: ~20–50 ms. Con caché, despreciable. |
| Detalle | cada apertura | por PK + preguntas + respuestas | PK, unique `(surveyId, questionId)` | ✅ |
| Autoguardado | ≤ 2/min por persona | upserts en TX por PK compuesta + `count` | unique `(surveyId, questionId)` | ✅ |
| Enviar | 1 por encuesta | update + `upsertPerformanceReview` (encuestas de persona + periodo) | `(evaluatedUserId, reviewPeriod, status)` | ✅ |
| Module 1 | 1 por encuesta creada | tareas del asignado en la ventana + KPIs del área | `tasks(workspaceId, assignedToId)`, `kpis(weekId, departmentId)` | ✅ decenas o cientos de tareas por persona |
| Scheduler | cada 60 s × réplicas | `status = SCHEDULED AND startDate <= now` | `(status, startDate)` | ✅ sin paginar: si se programan 5.000 a la vez, un solo `updateMany` y 5.000 eventos de socket |

## ¿Índices suficientes?

**Sí, salvo uno.** La migración crea 20 índices (incluidas las restricciones únicas),
diseñados para las consultas reales:

- `surveys`: `(workspaceId, status, createdAt)`, `(templateId)`, `(evaluatorId, status)`,
  `(evaluatedUserId, createdAt)`, `(evaluatedUserId, reviewPeriod, status)`,
  `(departmentId, status)`, `(status, startDate)`, `(status, endDate)` y `(createdById)`.
- `survey_responses`: unique `(surveyId, questionId)`, `(questionId)` y `(respondentId)`.
- `performance_reviews`: unique `(userId, reviewPeriod)`,
  `(workspaceId, reviewPeriod, departmentId)`, `(workspaceId, performanceRating)`,
  `(departmentId)` y `(publishedById)`.
- `survey_templates` y `survey_questions`: por workspace y estado, y unique por número de
  pregunta.

**Recomendado:**
```prisma
@@index([workspaceId, reviewPeriod, departmentId])   // en Survey: tablero y filtros por periodo
```
Con él, el tablero y la lista por periodo pasan de filtrar todo el workspace a leer solo el
trimestre.

**Posiblemente sobrantes** (costo de escritura bajo, sin urgencia): `(status, endDate)` solo
lo usaría un futuro job de vencidas, y `(createdById)` solo sirve para borrar usuarios, que
hoy es un *soft delete*.

## ¿Queries N+1?

**No en las lecturas.** Las listas usan `include` (un JOIN por relación, no una query por
fila). Detalle y resultado: 2–3 queries fijas.

**Puntos con varias queries secuenciales** (acotadas, no N+1 por fila):

| Dónde | Queries | Comentario |
|---|---|---|
| `createSurvey` | ~9 (plantilla, evaluado, evaluador, duplicado, 2 de Module 1, TX, resultado, jefes para invalidar) más la notificación | Aceptable para una escritura poco frecuente. |
| `afterStatusChange` | 3 (encuestas de la persona, resultado existente, área) + 1 (jefes del área) | Por cambio de estado. |
| `activateDueSurveys` | 1 + 1 + **1 por combinación (workspace, periodo, área)** para buscar jefes | Si se programan 5.000 encuestas en 13 áreas, son unas 13 queries. Correcto. |
| `listSurveys` (no ADMIN) | 1 extra para los periodos publicados del usuario | Fija. |

## ¿Caché necesario?

| Dato | ¿Caché? | Motivo |
|---|---|---|
| Tablero del trimestre | **Sí, ya implementado** (Redis, 5 min, invalidación explícita) | Es la única lectura agregada. Sin caché, 5.000 filas por cada visita de cada jefe. |
| Listas y detalle | No | Consultas indexadas y paginadas; además cambian con cada autoguardado. |
| Module 1 | No (foto guardada en la encuesta) | Se calcula una vez por encuesta. |
| Plantillas activas | Opcional | Pocas filas, cambian muy poco. |

**Riesgo de la caché:** sin Redis no hay caché y todo sigue funcionando. Con varias réplicas y
sin Redis, cada réplica recalcula (más carga, sin inconsistencia).

## Cuellos de botella por orden de aparición

1. ~~**Rate limit por IP**~~ ✅ **Resuelto (S6):** el límite ahora es por usuario autenticado.
   Una oficina detrás de un NAT ya no comparte un único cupo.
2. **`count(*)` y filtro por periodo sin índice** en el workspace: se nota por encima de
   ~100.000 encuestas. Se resuelve con el índice recomendado.
3. **Tablero en memoria:** por encima de ~50.000 encuestas por trimestre conviene moverlo a
   SQL (`GROUP BY departmentId, status` con `AVG`) o precalcularlo al cambiar de estado.
4. **Scheduler en cada réplica y sin paginar:** mover a un worker único y activar en lotes de
   1.000.
5. **Module 1 en caliente:** si el volumen de tareas por persona crece mucho (miles), poblar
   `UserPerformanceSnapshot` (la tabla existe, sin uso) con un job nocturno y leer de ahí
   ([ADR-002](adr/002-module1-performance-calculation.md)).

## Conclusión

Con 10.000 encuestas (y hasta unas 40.000) el diseño actual **no necesita cambios
estructurales**. Hacen falta dos ajustes baratos: el índice `(workspaceId, reviewPeriod, …)`
en `surveys` y el rate limit por usuario. Lo demás es backlog para cuando el volumen sea
10 veces mayor que el escenario analizado.
