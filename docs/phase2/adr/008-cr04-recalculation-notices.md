# ADR-008: CR-04, avisos de resultados recalculados

- **Estado:** Aceptada (decisión de producto: "Opción A — avisar al jefe y regenerar automático")
- **Archivos:** `apps/api/src/modules/surveys/reviews.service.ts`, `surveys.service.ts` (`afterStatusChange`)

## Contexto

Un resultado trimestral ya **publicado** cambiaba en silencio si llegaba otra encuesta del
mismo trimestre. El prompt pedía disparar el recálculo cuando "una nueva SurveyResponse es
enviada". Pero las respuestas se guardan como borrador cada 30 s (ADR-005), y un borrador no
cambia el resultado. Lo que lo cambia es que una encuesta cambie de **estado**.

## Decisión

1. `upsertPerformanceReview` sigue siendo la única forma de calcular un resultado. Ahora,
   además, compara los campos visibles del resultado antes y después:
   - `overallDualScore`, `overallPerformanceScore`, `overallProductivityIndex`;
   - el puntaje de autoevaluación y el del jefe;
   - rating, riesgo y encuestas completadas.

   Si el resultado estaba publicado y alguno de esos campos cambió, guarda
   `lastRecalculatedAt` y suma 1 a `recalculationCount`.
2. `refreshReview` lo llama **después del commit** de la acción y, si hubo recálculo:
   - registra `PERFORMANCE_REVIEW_RECALCULATED` en ActivityLog, con `changes` (el antes y
     después de cada campo), el motivo y la encuesta que lo causó: ese es el **historial**;
   - notifica `RESULT_RECALCULATED` a los **jefes del área** de la persona. Si la persona es
     jefe, notifica a los directores. Nunca notifica a quien hizo la acción;
   - emite `review:changed`.
3. **Disparadores:** enviar una encuesta, una corrección del director sobre una encuesta
   enviada, una cancelación y la creación (que solo cambia el número de encuestas iniciadas,
   así que no genera aviso). También `POST /performance-reviews/:id/recalculate`, que es
   idempotente: si nada cambió, no avisa.
4. La persona evaluada **no** recibe aviso (la decisión fue avisar al jefe), pero ve la
   insignia "Recalculado el …" en su resultado.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Recalcular en cada respuesta guardada | Un aviso cada 30 s por borrador; los borradores no cuentan en el resultado |
| Bloquear nuevas encuestas del trimestre tras publicar | Opción B, descartada por el usuario: se pierden evaluaciones legítimas |
| Guardar el historial en una tabla propia | ActivityLog ya es la auditoría del sistema, se filtra en la página de Auditoría y se exporta |

## Consecuencias

- **Email y Slack** del aviso quedan para el Sprint 2, con las integraciones. Hoy el aviso se
  ve en la app (toast vía socket).
- El valor anterior del puntaje queda en ActivityLog, pero las **respuestas** anteriores de
  una corrección siguen sin guardarse (S9 de la auditoría de la Phase 1).
