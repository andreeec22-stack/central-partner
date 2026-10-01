# ERROR_LOG — Central Partner MVP

Registro de los escenarios de error previstos (con su prevención, implementación y test) y
de los errores reales encontrados al implementar cada fase. El prompt sugería
`apps/documentation/ERROR_LOG.md`; vive en `docs/` junto al resto de la documentación.

---

## Fase 2 · Reporte semanal en Excel

Módulo: `apps/api/src/modules/reports/`. Endpoints bajo `/api/v1/export`, todos ADMIN.

### E2.1 · FILE_SIZE_VALIDATION
- **Tipo:** validación · **HTTP:** 413 `FILE_TOO_LARGE`
- **Trigger:** una semana con más de 50.000 filas a escribir, o un archivo resultante de más de 10 MB.
- **Prevención:**
  1. **Antes de construir**, `estimateRows()` cuenta tareas, KPIs, funciones e histórico de
     la semana (`reports.service.ts:107`).
  2. **Después de escribir**, se verifica el tamaño del buffer (`reports.service.ts:125`).
- **Diferencia con el prompt:** el prompt contaba *todas* las tareas y comentarios del
  workspace (`db.task.count()`). Eso rechazaría semanas pequeñas en un workspace grande, y
  los comentarios no se exportan. Se cuenta solo lo que el reporte escribe.
- **Contradicción del prompt:** "límites de datos: sin límite" frente a "máximo 10 MB y
  50.000 filas". Para el Excel se aplican los límites, porque un .xlsx gigante no se puede
  abrir. Son configurables en `reportLimits`.
- **Tests:** `tests/integration/reports.test.ts` (E2.1, ambos límites) y `tests/unit/reports.test.ts` (estimación).

### E2.2 · MEMORY_OVERFLOW
- **Tipo:** recursos
- **Prevención:**
  - El tope de E2.1 acota la memoria a unos pocos MB por reporte.
  - Los datos de una semana cerrada salen de su **snapshot** `WeeklyArchive`, sin volver a
    consultar las tareas.
- **Diferencia con el prompt:** el prompt proponía `workbook.xlsx.createReadStream()`, que no
  existe en ExcelJS. El modo streaming (`stream.xlsx.WorkbookWriter`) no permite volver
  sobre hojas ya escritas, y el driver de storage recibe un buffer. Con el tope de 10 MB, el
  buffer es la opción simple y segura.
- **Test:** cubierto indirectamente por E2.1. No hay un test de memoria.

### E2.3 · ENCODING
- **Tipo:** formato
- **Prevención:** ninguna especial. Un .xlsx es XML UTF-8 por definición, y el BOM solo
  importa en CSV. CSV no se ofrece (ver `INVALID_FORMAT`). El nombre del archivo en la
  descarga usa RFC 6266 (`filename*=UTF-8''…`).
- **Test:** `tests/unit/reports.test.ts`, "E2.3": escribe y relee un workbook con
  "Diseño", "ñandú" y "José", sin pérdida.

### E2.4 · PERMISSION_CHECK
- **Tipo:** autorización · **HTTP:** 403 `FORBIDDEN`
- **Prevención:** `requireRole('ADMIN')` sobre **todo** `/export`
  (`reports.routes.ts:19`), y cada consulta se filtra por `workspaceId`.
- **Mejora sobre el prompt:**
  - **No** se entregan URLs firmadas de 30 días: funcionarían como un link público a un
    documento confidencial. `downloadUrl` es una ruta de la API que exige el token de
    ADMIN.
  - La respuesta lleva `Cache-Control: private, no-store`.
  - Cada descarga queda en Auditoría (`REPORT_DOWNLOADED`).
- **Test:** "E2.4" en `reports.test.ts`: jefe, colaborador y lector reciben 403 al
  listar, descargar, eliminar y generar.

### E2.5 · CONCURRENT_EXPORTS
- **Tipo:** concurrencia · **HTTP:** 409 `EXPORT_IN_PROGRESS`
- **Prevención:** `pg_try_advisory_xact_lock` por semana, dentro de la transacción de
  generación (`reports.service.ts:101`). El lock se libera solo al terminar la transacción,
  también si falla, así que no puede quedar colgado como un lock de Redis cuyo `DEL` no
  corrió.
- **Diferencia con el prompt:** el prompt usaba Redis (`SET NX EX`), pero Redis es opcional
  en este proyecto: sin él, el lock no existiría.
- **Test:** "E2.5" (determinista): la primera generación se detiene dentro de su escritura
  a storage, la segunda recibe 409, y al liberar la primera la semana se puede volver a
  generar.

### E2.6 · FILE_CLEANUP
- **Tipo:** retención
- **Prevención:**
  - `purgeExpiredReports()` corre cada hora (`startReportCleanup` en `index.ts`), borra el
    archivo de los reportes con más de 30 días y marca `purgedAt`.
  - La fila se conserva para la auditoría.
  - Descargar o restaurar un reporte vencido responde 410 `EXPORT_EXPIRED`.
  - Eliminar un reporte es soft delete: se puede restaurar hasta que vence.
- **Diferencia con el prompt:** el prompt hacía `deleteMany` de las filas y no borraba los
  archivos (que se acumularían), y perdía el rastro de auditoría.
- **Test:** "E2.6" (410, purga, idempotencia, auditoría `REPORTS_PURGED`) y "soft delete
  hides it and restore brings it back".

### E2.7 · REPORT_FAILURE_ON_CLOSE (no estaba en el prompt)
- **Trigger:** el reporte automático falla al cerrar la semana (storage caído, límite
  superado).
- **Prevención:** `generateOnClose` captura el error. La semana **sí** se cierra (el cierre
  ya hizo commit), la respuesta trae `report: null` y se registra `REPORT_GENERATION_FAILED`
  con el motivo. El modal de cierre lo explica y ofrece la descarga a demanda.
- **Test:** "a failing report never blocks closing the week".

### Errores encontrados al implementar la Fase 2

| # | Fecha | Descripción | Solución | Estado |
|---|---|---|---|---|
| 1 | 2026-10-01 | `closeWeek` ya tenía una variable `report` (el reporte de completitud); el typecheck falló por redeclaración | Se renombró a `weeklyReport` | ✅ |
| 2 | 2026-10-01 | El test esperaba las hojas de área en orden de creación (Marketing, Finanzas), pero el snapshot las ordena alfabéticamente | Se corrigió la expectativa; el orden alfabético es el mismo del dashboard | ✅ |
| 3 | 2026-10-01 | Los tests que cierran semanas habrían escrito reportes en `apps/api/uploads/`, la carpeta de desarrollo | `tests/setup-env.ts` apunta `LOCAL_STORAGE_DIR` a una carpeta temporal | ✅ |

---

## Fase 3 · E2E con Playwright

### E3.1 · TASK_CONFLICT (edición concurrente), funcionalidad nueva
- **Tipo:** concurrencia · **HTTP:** 409 `TASK_CONFLICT`
- **Trigger:** dos personas guardan la misma tarea partiendo de la misma versión.
- **Prevención (optimista, gana el primero; decisión del usuario):**
  - El cliente envía `expectedUpdatedAt`. El servidor bloquea la fila
    (`SELECT … FOR UPDATE`) y compara la versión (`tasks.service.ts → updateTask`).
  - Los campos de texto toman la versión **al empezar a editar**, para que un refresco por
    socket a mitad de la edición no la "actualice" y pise el cambio ajeno.
  - Los guardados del cliente se serializan, y una edición propia anterior no cuenta como
    conflicto (`lib/queries.ts → ownSaves`).
- **Compatibilidad:** sin `expectedUpdatedAt` se comporta como antes.
- **Tests:** `apps/api/tests/integration/conflicts.test.ts` (versión vieja, carrera
  simultánea, compatibilidad) y `apps/e2e/tests/conflicts.spec.ts` (diálogo, recargar,
  clics rápidos).

### Errores encontrados al implementar la Fase 3

| # | Fecha | Descripción | Solución | Estado |
|---|---|---|---|---|
| 4 | 2026-10-01 | `npm install` fallaba con `Invalid Version:`: el `package-lock.json` tenía una entrada `apps/web/node_modules/@vitejs/plugin-react` sin versión, que apuntaba a una carpeta sin `package.json`, resto de una instalación anterior | Se borraron la carpeta y la entrada; la versión real (6.1.1) está en la raíz | ✅ |
| 5 | 2026-10-01 | El prompt decía que Playwright "ya está en package.json"; no lo estaba | Workspace `apps/e2e` con `@playwright/test` 1.63 y Chromium | ✅ |
| 6 | 2026-10-01 | **E2E intermitente.** Al recargar el seed, el scheduler de la API creaba la semana actual del workspace recién creado antes que el seed, que fallaba con `Unique constraint (workspaceId, mondayDate)`; una vez dejó las consultas colgadas. **También afectaba a correr `db:seed` con la API de desarrollo encendida.** | El seed reutiliza la semana si ya existe y reemplaza sus definiciones. Nueva variable `SCHEDULERS_ENABLED` (por defecto `true`), en `false` para E2E; también sirve para dejar los schedulers en una sola réplica en producción. Tres corridas completas seguidas sin fallos | ✅ |
| 7 | 2026-10-01 | El lector del seed se llama "Lector", igual que su rol: un selector del test era ambiguo | Se ajustó el test | ✅ |
| 8 | 2026-10-01 | Ruido `[vite] ws proxy error: write ECONNABORTED` en la salida de E2E | Es el logger interno de Vite al cerrar pestañas con el socket abierto; inofensivo. Se intentó filtrar con un handler del proxy, no tuvo efecto y se revirtió | ⚪ Documentado |

## Errores de entorno conocidos

| # | Fecha | Descripción | Mitigación |
|---|---|---|---|
| A | 2026-10-01 | Dos corridas de tests de integración en paralelo sobre `central_partner_test` producen deadlocks en `TRUNCATE` y fixtures duplicados (`director@empresa.com already exists`). Pasa también si `api-demo-db` está encendido, porque su scheduler escribe en esa BD. | Correr una suite a la vez y apagar los servidores de demo antes de `test:integration`. |
