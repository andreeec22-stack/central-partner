# ADR-005: Estrategia de autoguardado

- **Estado:** Aceptada
- **Fecha:** 2026-09-30
- **Archivos:** `apps/web/src/lib/useAutoSave.ts`,
  `apps/web/src/pages/performance/surveys/SurveyResponsePage.tsx`,
  `apps/api/src/modules/surveys/surveys.service.ts` (`saveResponses`)

## Contexto

Una encuesta puede tener hasta 50 preguntas, y responderla puede tomar varios minutos. El
riesgo 7 pedía autoguardado cada 30 segundos, sin bloquear la interfaz y con un indicador
de "Guardando…".

Restricciones:
- La encuesta se bloquea al enviarse.
- El director puede corregir respuestas enviadas.
- El rate limit global es de 300 requests por minuto **por IP** (ver
  [security-audit](../security-audit-phase1.md), sección S6).

## Decisión

**Cliente: un hook genérico `useAutoSave(save, keyOf, intervalMs = 30_000)`.**

1. **Cola con deduplicación:** los cambios se guardan en un `Map` por `questionId`. Si una
   misma pregunta cambia 10 veces, solo viaja el último valor.
2. **Temporizador desde el primer cambio sin guardar**, no reiniciado en cada tecla: se
   guarda como mucho 30 s después del primer cambio. Si no hay cambios, no hay requests. Un
   *debounce* clásico, que reinicia en cada tecla, podría no guardar nunca a quien no deja de
   escribir.
3. **`flush()` inmediato** en tres casos: el botón "Guardar borrador", **antes de enviar**
   (el envío espera a que el guardado termine bien) y al desmontar el componente (con
   *fire-and-forget*).
4. **Los fallos no bloquean:** si el guardado falla, los cambios vuelven a la cola, salvo que
   se hayan editado otra vez mientras tanto, y se reintentan en 30 s. El estado pasa a
   `error` y se muestra "No se pudo guardar; lo reintentamos en 30 s". Nunca se muestra un
   error modal.
5. **Estados visibles**, anunciados con `role="status"` y `aria-live="polite"`:

   | Estado | Texto |
   |---|---|
   | `idle` | Tus respuestas se guardan automáticamente |
   | `pending` | Cambios sin guardar · se guardan solos cada 30 s |
   | `saving` | Guardando borrador… |
   | `saved` | Borrador guardado · 17:06 |
   | `error` | No se pudo guardar; lo reintentamos en 30 s |

6. **`beforeunload`:** si hay cambios pendientes, el navegador pide confirmación antes de
   salir de la página.
7. **Semilla única:** el formulario toma las respuestas del servidor **una sola vez**, así un
   refetch en segundo plano (por el foco de la ventana o un evento de socket) no pisa lo que
   se está escribiendo. Además, `useSurvey` desactiva `refetchOnWindowFocus`.

**Servidor: `POST /surveys/:id/responses` con `{ answers: [{ questionId, value, comment? }] }`.**

1. **Upsert** sobre `@@unique([surveyId, questionId])` dentro de una transacción. `value: null`
   borra la respuesta.
2. **Idempotente:** reenviar el mismo lote deja el mismo estado. Un reintento tras un timeout
   de red es seguro.
3. **Validación por tipo** antes de escribir (`validateAnswerValue`). Si una respuesta del
   lote es inválida, no se escribe ninguna.
4. **Bloqueos** (`answerBlock`): cancelada → 403 para todos · no evaluador → 403 · enviada,
   no iniciada o vencida → 403 salvo ADMIN.
5. Recalcula `answeredQuestions` y `completionPercentage`. Si la encuesta estaba SCHEDULED y
   su inicio ya pasó, la activa.

## Por qué 30 s y no tiempo real

| Opción | Requests por persona-minuto con edición continua | Riesgo de pérdida | Veredicto |
|---|---|---|---|
| Guardar en cada cambio | 10–60 | Ninguno | Revienta el rate limit por IP en una oficina: 30 personas × 20 = 600 > 300 |
| Debounce de 1–2 s | 5–20 | Mínimo | Mismo problema a escala; además, escrituras de a una pregunta |
| WebSocket con sincronización | Continuo | Ninguno | Complejidad (conflictos, reconexión) sin beneficio: una encuesta tiene **un solo** editor |
| **Agrupado a 30 s + flush en eventos clave** | **≤ 2** | ≤ 30 s de cambios si el navegador se cierra de golpe *y* el guardado de desmontaje falla | **Elegido** |

La pérdida máxima es acotada y rara: además del temporizador, se guarda al enviar, al pulsar
"Guardar", al navegar dentro de la app y, antes de cerrar la pestaña, el navegador avisa.

## Consecuencias

- **Probado:** con timers falsos (guardado a los 30 s con el último valor, reintento tras
  error y `flush` inmediato), con el formulario (guardado antes de enviar) y en el navegador
  real (un `POST` a los 30 s y el indicador "Borrador guardado").
- **El guardado al desmontar es fire-and-forget.** Si la encuesta venció justo antes, el
  servidor responde 403 y ese cambio se pierde sin aviso.
- **`beforeunload` usa solo `e.preventDefault()`** (`useAutoSave.ts:82`). Chrome y Firefox
  actuales lo respetan; Safari antiguo necesita además `e.returnValue = ''`.
- **Sin control de concurrencia entre pestañas:** si la misma persona abre la encuesta en dos
  pestañas, gana el último guardado de cada pregunta. Es aceptable con un solo editor.
- **Hook reutilizable:** sirve para otros formularios largos, como el feedback del jefe, que
  hoy guarda con un botón.
