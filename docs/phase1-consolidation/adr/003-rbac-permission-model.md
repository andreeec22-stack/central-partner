# ADR-003: Modelo de permisos (RBAC) de las evaluaciones

- **Estado:** Aceptada. El hallazgo de *Casos borde*, punto 1, está resuelto: el alcance del jefe es su **equipo**, es decir, las personas cuyo rol no es JEFE_AREA ni ADMIN.
- **Fecha:** 2026-09-30
- **Archivos:** `apps/api/src/modules/surveys/surveys.access.ts`,
  `apps/api/src/modules/performance/performance.service.ts` (`canSeePerformanceOf`)

## Contexto

Las evaluaciones son datos de RRHH: más sensibles que las tareas. El proyecto ya tenía un
modelo de alcance por departamento (`lib/permissions.ts`):

- ADMIN ve todo.
- JEFE_AREA ve su área **y** las áreas que el director le concedió en
  `DepartmentVisibility`, en modo lectura.
- USER y VIEWER ven solo su área.

"Gestionar un área" siempre significa `user.departmentId === area`; el campo
`Department.headId` es informativo y no otorga nada. Un jefe que figura como `headId` de
otra área, sin pertenecer a ella, **no** la gestiona, igual que en `canManageArea` y en
`weeks.service`.

Decisiones del usuario:
- *"Un colaborador ve la evaluación de su jefe sobre él cuando se publica su resultado."*
- El prompt de riesgos pedía **403** para quien no tiene permiso.

## Decisión

Toda la lógica está en funciones puras de `surveys.access.ts`, probadas en unit tests:

| Función | Regla |
|---|---|
| `checkSurveyAccess(user, survey, reviewPublished)` | ADMIN sí · VIEWER no · evaluador sí · evaluado: solo si es `MANAGER_REVIEW` + `COMPLETED` + resultado publicado · JEFE_AREA: si `survey.departmentId` es su área |
| `surveyVisibilityFilter(user, publishedPeriods)` | La misma regla, como filtro Prisma para listas (`OR` de las ramas) |
| `canManageEvaluationsOf(user, subject)` | Crear, cancelar, publicar y editar feedback: ADMIN a cualquiera; JEFE_AREA a personas de su área, **nunca a sí mismo** |
| `checkReviewAccess` / `reviewVisibilityFilter` | ADMIN todo · JEFE su área (su propio resultado solo cuando está publicado) · cualquiera su propio resultado publicado |
| `canSeePerformanceOf` (Module 1) | ADMIN, la propia persona o el JEFE_AREA de su área |

Decisiones clave:

1. **Las concesiones de `DepartmentVisibility` no se aplican.** Un jefe con visibilidad de
   lectura sobre otra área ve sus tareas, pero no sus evaluaciones. Está probado en
   integración.
2. **Nadie ve evaluaciones sobre sí mismo hechas por otros** hasta que su resultado se
   publica. Esto aplica también a los jefes, por ejemplo cuando el director evalúa a un jefe.
3. **403 frente a 404:** fuera del workspace responde 404; si la encuesta existe en el
   workspace pero no hay permiso, responde 403 (lo pedía el prompt).
4. **Solo el evaluador responde.** El ADMIN puede además corregir en cualquier momento,
   incluso encuestas enviadas o vencidas. Una encuesta cancelada no la puede tocar nadie.
5. **La interfaz no decide:** cada ítem trae `permissions` (`canAnswer`, `canCancel`,
   `canEdit`, `canPublish`, `canComment`), calculado en el servidor. La web solo lo lee.
6. **Tablero:** el de un JEFE_AREA excluye sus propias evaluaciones. Por eso su caché es por
   persona (`jefe:{id}`), no por área.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Reutilizar `departmentScope` (incluye concesiones) | Quien recibe visibilidad para coordinar tareas vería los puntajes de otra área. Es una fuga de datos de RRHH. |
| Gestión por `headId` (jefe de varias áreas) | Rompería la coherencia con tareas, KPIs y cierre semanal, que usan `departmentId`. En el seed, Jefe Finanzas figura como `headId` de 9 áreas; con esta regla vería 9 áreas de evaluaciones sin pertenecer a ellas. Si se quiere, debe decidirse para **todo** el sistema, no solo para encuestas. |
| Permisos configurables por el director (matriz editable) | El back office ya fijó que la matriz de roles está en el código (decisión del 30/09). Menos superficie de error. |
| 404 para todo lo no permitido (no revelar existencia) | Es lo más seguro, pero el prompt pidió 403 explícitamente. Como los IDs son UUID v4, adivinar uno no es viable. Ver [security-audit](../security-audit-phase1.md) (sección S4). |
| Colaborador ve la evaluación del jefe en cuanto se envía | El jefe perdería la oportunidad de preparar el feedback. El usuario eligió "al publicar". |

## Cómo escala a 100 jefes

- **Consultas:** el filtro es un `OR` de 2 a 4 ramas, cada una respaldada por un índice
  (`evaluatorId,status`, `departmentId,status`, `evaluatedUserId,reviewPeriod,status`). Su
  costo depende de las filas de cada rama, no del número de jefes.
- **Caché del tablero:** una entrada por jefe y trimestre. Con 100 jefes son como máximo
  101 claves por trimestre (100 más la del director), con un TTL de 5 minutos. Al cambiar una
  encuesta se invalidan `all` y las claves de los jefes **de esa área**: una query y un
  `DEL` de pocas claves.
- **Sin estado por jefe que mantener:** no hay tablas de permisos que sincronizar. Todo se
  deriva de `role` y `departmentId`.

## Casos borde

1. **✅ Resuelto: varios JEFE_AREA en la misma área se veían entre sí.** Si el director evalúa al jefe A,
   el jefe B (misma área) ve esa evaluación y la incluye en su tablero, porque la rama
   "JEFE ve su área" no excluye a otros jefes (`surveys.access.ts:23`,
   `surveys.dashboard.ts:43`). **Recomendación:** en esa rama, exigir que el evaluado no sea
   ADMIN ni JEFE_AREA; un jefe solo ve evaluaciones de colaboradores. Ver
   [code-review](../code-review-phase1.md), hallazgo CR-01.
2. **Cambio de área:** las encuestas guardan el `departmentId` del momento de su creación. El
   jefe anterior las sigue viendo y el nuevo no (ADR-001).
3. **Director evaluado:** un ADMIN no tiene `departmentId`, así que no puede ser evaluado. Es
   intencional.
4. **Jefe sin área** (`departmentId = null`): ve y responde solo las encuestas donde es
   evaluador. Su tablero responde 403.
5. **Evaluador desactivado:** su encuesta queda abierta sin nadie que la responda. El jefe o
   el director deben cancelarla y crear otra. No hay reasignación.
6. **Rol cambiado a VIEWER** con encuestas asignadas: pierde el acceso a ellas, que quedan
   abiertas.
