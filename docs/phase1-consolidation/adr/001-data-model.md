# ADR-001: Modelo de datos de las encuestas de desempeño

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Archivos:** `apps/api/prisma/schema.prisma` (sección *Performance surveys*),
  migración `20260930214620_performance_surveys`

## Contexto

Se necesitaba guardar plantillas de preguntas reutilizables, evaluaciones de una persona
hechas por ella misma o por su jefe, respuestas que se guardan como borrador y se bloquean al
enviar, y un consolidado por persona y trimestre que el jefe comenta y publica.

La especificación original de Phase 1 hablaba de "6 tablas". Al contrastarla con el uso real
quedaron **5 tablas nuevas** y **6 enums**. Las tablas son `survey_templates`,
`survey_questions`, `surveys`, `survey_responses` y `performance_reviews`. La sexta tabla
propuesta, `SurveyNotification`, se descartó (ver alternativa D).

Restricciones heredadas del proyecto: IDs `uuid` con `@db.Uuid`, multi-tenant por
`workspaceId` en cada fila, enums de Postgres para los estados, soft delete de usuarios y
áreas, y `ActivityLog` como única tabla de auditoría.

## Decisión

```
SurveyTemplate 1───* SurveyQuestion
      │1                    │1
      *                     *
    Survey 1──────────* SurveyResponse     (unique: surveyId + questionId)
      │ evaluatorId, evaluatedUserId, departmentId → User / Department
      │ reviewPeriod "2026-Q3"
      ▼ (agregado, sin FK)
PerformanceReview                           (unique: userId + reviewPeriod)
```

1. **Un `Survey` es una evaluación de una persona hecha por un evaluador.** El tipo
   (`SELF_ASSESSMENT` o `MANAGER_REVIEW`) es una columna, no una tabla aparte. La
   autoevaluación es simplemente `evaluatorId = evaluatedUserId`.
2. **Las preguntas cuelgan de la plantilla, no de la encuesta.** Para que las respuestas
   sigan siendo interpretables, la plantilla **se congela al activarse**: solo los `DRAFT`
   se editan, y los que tienen encuestas no se borran (FK `Restrict`).
3. **Una respuesta por pregunta y encuesta** (`@@unique([surveyId, questionId])`). El
   borrador y la versión final son la misma fila, y el autoguardado hace *upsert*
   ([ADR-005](005-autosave-strategy.md)).
4. **`PerformanceReview` es un agregado reconstruible.** Se recalcula desde las filas
   `Survey` completadas de `(userId, reviewPeriod)` cada vez que cambia el estado de una
   ([ADR-004](004-survey-scoring-system.md)). Lo único que se escribe a mano son los textos
   del jefe y la publicación.
5. **Snapshots desnormalizados en `Survey`:** `departmentId` (el área de la persona al crear
   la encuesta), `totalQuestions`, `productivityIndex` y `productivityData` (la foto de
   Module 1), además de `performanceScore` y `dualScore` al enviar. Así las listas y el
   tablero no recalculan nada al leer.
6. **`reviewPeriod` es un string `YYYY-Qn`**, elegido al crear. Por defecto es el trimestre
   de `startDate` en la zona del workspace.
7. **Estados como enums de Postgres:** `SurveyStatus`, `SurveyTemplateStatus`,
   `SurveyQuestionType`, `SurveyType`, `PerformanceRating` y `RiskLevel`.
8. **Borrado:** todo en cascada desde `Workspace`. `Survey → SurveyTemplate` es `Restrict`,
   así que no se puede borrar una plantilla usada. `PerformanceReview.department` es
   `SetNull`.

## Alternativas consideradas

| # | Alternativa | Por qué se rechazó |
|---|---|---|
| A | Tablas separadas `SelfAssessment` y `ManagerReview` | Duplica columnas, lógica y endpoints; agregar 360° exigiría otra tabla. Con la columna `type` basta un valor de enum más. |
| B | Copiar las preguntas en cada encuesta (snapshot por encuesta) | Inmune a cambios de plantilla, pero multiplica filas (preguntas × encuestas) y complica comparar respuestas entre personas. Congelar la plantilla da la misma garantía más barata. |
| C | Guardar todas las respuestas como un único `Json` en `Survey` | Un solo write, pero pierde la unicidad por pregunta, impide consultar por pregunta y hace que dos guardados concurrentes se pisen el documento entero. |
| D | Tabla `SurveyNotification` | La tabla `Notification` existente ya cubre la campana y el socket; bastó agregar `SURVEY_ASSIGNED` a su enum. Los recordatorios (`remindedAt`) quedan para después. |
| E | `PerformanceReview` calculado siempre al vuelo (vista SQL) | No tiene dónde guardar los textos del jefe ni `publishedAt`, y el tablero haría el agregado en cada lectura. |
| F | `reviewPeriod` derivado de `endDate` | Se probó y se descartó en el navegador: una evaluación de Q3 que vence el 12 oct caía en Q4 y el tablero del trimestre actual salía vacío. |
| G | `status` como `String` (lo que proponía el prompt) | Pierde la validación de la base de datos y el tipado del cliente. Los enums son la convención del proyecto. |
| H | Índices de una columna para cada FK (lo que proponía el prompt) | Postgres usa el prefijo de un índice compuesto, así que se omitieron los que un compuesto ya cubre (se explica en el schema). |

## Consecuencias

**Positivas**
- Un nuevo tipo de encuesta (360°, pares) es un valor de enum más reglas de acceso, sin tablas nuevas.
- Las respuestas no se duplican nunca, gracias a la restricción única.
- El resultado se puede reconstruir en cualquier momento desde las encuestas.
- Las listas y el tablero leen columnas planas.

**Negativas y riesgos**
- **Snapshots que envejecen:** si una persona cambia de área, sus encuestas y su resultado
  siguen apuntando al área anterior. El jefe anterior las sigue viendo y el nuevo no.
  `PerformanceReview.departmentId` solo se fija al crear el resultado
  (`reviews.service.ts:43`).
- **Sin historial de respuestas:** el upsert sobreescribe. Si el director corrige una
  respuesta, el valor anterior solo queda en `ActivityLog` como metadato (qué preguntas
  cambiaron y el nuevo puntaje), no el valor viejo.
- **`dualScore` es `Json`:** su forma no la valida la base de datos. El tipo vive en
  `scoring.ts` (`DualScore`).
- **Valor de enum `SURVEY_ASSIGNED`:** no se puede quitar de `NotificationType` en un
  rollback. Ver [deployment.md](../deployment.md#rollback).
