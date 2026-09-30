# ADR-004: Sistema de puntajes

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Archivos:** `apps/api/src/modules/surveys/scoring.ts` (funciones puras, 98 % de cobertura)

## Contexto

Hay que combinar respuestas en escalas distintas (1–5, 1–7, 0–100, texto y ranking) con el
índice de productividad, y consolidar varias encuestas por persona y trimestre.

El sistema ya tenía una convención visual, el **semáforo de áreas**: ≥ 90 % en meta 🟢,
70–89 % en riesgo 🟡 y < 70 % crítico 🔴.

El prompt de riesgos proponía estos umbrales: ≥90 EXCEEDS, ≥80 MEETS, ≥70 DEVELOPING,
≥60 NEEDS_IMPROVEMENT y <60 NOT_YET_RATED. Tenía dos errores:
- Un 40 quedaba como "sin calificar".
- `performanceScore && productivityIndex` trataba un 0 real como un dato faltante.

## Decisión

**Escala común 0–100, un decimal. `null` significa "sin dato" y nunca es 0.**

1. **Normalización por pregunta** (`normalizeAnswer`):
   - LIKERT_5: `(v−1)/4·100` (1 → 0, 3 → 50, 5 → 100)
   - LIKERT_7: `(v−1)/6·100`
   - NUMERIC: el valor tal cual, acotado a 0–100
   - TEXT y RANKING: no puntúan
2. **`performanceScore`** = media ponderada por `weight` de las respuestas con puntaje. Si no
   hay ninguna respondida, es `null`: el caso de una plantilla con la única pregunta con
   puntaje opcional y sin responder. La plantilla exige al menos una pregunta con puntaje y
   al menos 3 preguntas (riesgo 3).
3. **`dualScore`** (por encuesta, congelado al enviar):
   `overall_score` = media de `productivity_index` y `performance_score` **que existan**.
   Con uno solo, es ese; con ninguno, `null`.
4. **Rating** (`ratingFor`), sobre `overall_score`:

   | Puntaje | Rating | Semáforo equivalente |
   |---|---|---|
   | ≥ 90 | `EXCEEDS_EXPECTATIONS` · Supera expectativas | 🟢 |
   | 80–89,9 | `MEETS_EXPECTATIONS` · Cumple expectativas | 🟡 (mitad alta) |
   | 70–79,9 | `DEVELOPING` · En desarrollo | 🟡 (mitad baja) |
   | < 70 | `NEEDS_IMPROVEMENT` · Necesita mejorar | 🔴 |
   | `null` | `NOT_YET_RATED` · Sin calificar | ⚪ |

   **Riesgo** (`riskFor`): ≥ 80 LOW · 70–79,9 MEDIUM · < 70 HIGH · `null` → `null`.
5. **Consolidado trimestral** (`aggregateReview`): medias simples, sobre las encuestas
   completadas, de `overall_score`, de `performanceScore`, de `productivityIndex`, y por
   separado de las autoevaluaciones (`selfAssessmentScore`) y de las evaluaciones del jefe
   (`managerReviewScore`). El rating y el riesgo del resultado salen de `overallDualScore`.

## Por qué esos valores

- **70 y 90 son los mismos cortes del semáforo.** Un director que ya lee "< 70 = rojo" no
  necesita aprender otra escala: rojo equivale a "necesita mejorar" y verde a "supera".
- **80 parte la banda amarilla** (70–89), que es demasiado ancha para una conversación de
  desempeño. El que "cumple" (80+) se distingue del que "está en desarrollo" (70–79). Es el
  único umbral nuevo.
- **Riesgo alineado con los mismos cortes:** HIGH coincide exactamente con el rojo, y MEDIUM
  con "en desarrollo".
- **Likert 1 → 0 %** (y no 20 %) para que la escala use el rango completo y "Muy bajo" pese
  lo que dice.

## Alternativas consideradas

| Alternativa | Por qué no |
|---|---|
| Umbrales del prompt (<60 = "sin calificar") | Confunde "no hay datos" con "mal desempeño", y ordena mal NEEDS_IMPROVEMENT y DEVELOPING. |
| Dar más peso a la evaluación del jefe que a la autoevaluación | Razonable, pero es una decisión de política de RRHH que nadie tomó. Hoy la media es simple por encuesta y ambos puntajes se muestran por separado para que el jefe los compare. Cambiarlo solo toca `aggregateReview`. |
| Media ponderada por número de preguntas entre encuestas | Una plantilla larga dominaría el resultado. |
| Faltantes = 0 | Castiga la falta de datos como si fuera mal desempeño. |
| Escala 1–5 final (como Likert) | Las demás métricas del sistema están en %. |

## Consecuencias

- Cualquier cambio de umbrales se hace en `ratingFor` y `riskFor` (un archivo). Hay tests que
  fijan los bordes: 90 → EXCEEDS y 69,9 → NEEDS_IMPROVEMENT.
- **Los puntajes guardados no se recalculan** si cambia la fórmula. Un cambio de umbrales
  requiere un script que recorra `surveys` y llame a `upsertPerformanceReview` por cada
  `(persona, periodo)`.
- **Con productividad en `null`, `overall_score` es solo la encuesta.** Dos personas con el
  mismo puntaje pueden venir de fuentes distintas. La UI muestra ambos componentes para que
  se note.
- **Autoevaluación y evaluación del jefe pesan igual en `overallDualScore`.** Una
  autoevaluación inflada sube el resultado. El jefe lo nota al comparar las tarjetas
  "Autoevaluación" y "Evaluación del jefe" del resultado, pero el número consolidado no lo
  corrige.
