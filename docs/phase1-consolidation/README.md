# Módulo de Desempeño (Phase 1)

> Autoevaluaciones, evaluaciones del jefe y resultados trimestrales de cada persona,
> combinados con un índice de productividad calculado desde sus tareas.
>
> Estado al 30 sep 2026: implementado y probado, **sin commitear**; migración
> `20260930214620_performance_surveys` aplicada en las BD de desarrollo y de test.

## Índice de esta carpeta

| Documento | Para qué leerlo |
|---|---|
| [architecture.md](architecture.md) | Diagramas C4, flujos y dónde encaja en el resto del sistema |
| [adr/](adr/README.md) | Las 5 decisiones de diseño, con alternativas y trade-offs |
| [code-review-phase1.md](code-review-phase1.md) | Revisión archivo por archivo, con bugs y casos borde encontrados |
| [security-audit-phase1.md](security-audit-phase1.md) | Inyección, RBAC, validación, exposición de datos y rate limiting |
| [scalability-phase1.md](scalability-phase1.md) | Qué pasa con 10.000 encuestas; índices, N+1 y caché |
| [testing-strategy.md](testing-strategy.md) | Cobertura medida, huecos y cómo escribir tests nuevos |
| [development-guide.md](development-guide.md) | Setup, tests, cómo agregar un tipo de encuesta o pregunta y depuración |
| [deployment.md](deployment.md) | Migraciones, rollback, monitoreo y escalado |

**Antes de la Phase 2**, lee la sección *Pendientes antes de Phase 2* al final de este archivo.

## Qué es

Central Partner ya medía **áreas** cada semana (índice ①②③ y semáforo). Este módulo mide
**personas** cada trimestre, desde dos ángulos:

1. **Lo que dicen las encuestas** (`performanceScore`): una plantilla de preguntas que
   responde la propia persona (*autoevaluación*) y su jefe (*evaluación del jefe*).
2. **Lo que dicen sus tareas** (`productivityIndex`, "Module 1"): tareas completadas,
   entregadas a tiempo y los KPIs de su área, en las últimas 4 semanas.

Ambos se combinan en un **puntaje dual** por encuesta, y las encuestas del trimestre se
consolidan en un **resultado de desempeño** (`PerformanceReview`), que el jefe completa con
retroalimentación y **publica** a la persona.

## Cómo funciona

```
Director crea plantilla (DRAFT) ──activar──▶ ACTIVE (preguntas congeladas)
                                                   │
Director / Jefe crea evaluaciones para una persona ◀┘
   ├─ Autoevaluación      (la responde la persona)
   └─ Evaluación del jefe (la responde quien la crea, u otro jefe/director)
        │  al crearla se captura el índice de productividad (Module 1, timeout 3 s)
        ▼
SCHEDULED ──fecha de inicio──▶ ACTIVE ──enviar──▶ COMPLETED
     └───────────── cancelar ─────────┴──▶ CANCELLED
        │ respuestas en borrador, autoguardado cada 30 s
        ▼ al enviar: performanceScore + dualScore; se recalcula el resultado del trimestre
PerformanceReview (persona × trimestre) ──jefe escribe feedback──▶ publicar ──▶ la persona lo ve
```

| Rol | Puede |
|---|---|
| **Director (ADMIN)** | Todo: plantillas, evaluar a cualquiera, ver el tablero de la empresa, corregir respuestas enviadas |
| **Jefe de área** | Evaluar y ver evaluaciones de las personas de **su** departamento; publicar sus resultados |
| **Colaborador** | Responder su autoevaluación; ver su resultado y la evaluación de su jefe **cuando se publican** |
| **Lector** | Nada en este módulo |

Detalle y justificación: [ADR-003](adr/003-rbac-permission-model.md).

## Casos de uso

- **Cierre de trimestre:** el director activa la plantilla "Evaluación trimestral" y cada
  jefe crea, para cada persona de su equipo, *autoevaluación + evaluación del jefe*.
- **Seguimiento:** en *Desempeño → Mi equipo* el jefe ve quién envió, quién está vencido y
  los promedios por área.
- **Conversación de feedback:** el jefe abre el resultado de la persona, escribe
  fortalezas, oportunidades de mejora y metas, y lo publica. La persona lo lee y puede
  responder con sus comentarios.
- **Corrección:** si alguien envió un valor por error, el director corrige la respuesta y
  los puntajes se recalculan. La corrección queda en auditoría.

## Superficie técnica

| Capa | Dónde |
|---|---|
| Schema | `apps/api/prisma/schema.prisma`: 5 tablas y 6 enums nuevos, más un valor en `NotificationType` |
| API | `apps/api/src/modules/surveys/`, `apps/api/src/modules/performance/` |
| Endpoints | `/api/v1/surveys/*`, `/api/v1/performance-reviews/*`, `GET /api/v1/workspaces/:id/team/:userId/performance` |
| Scheduler | `startSurveyScheduler()` en `apps/api/src/index.ts`: SCHEDULED → ACTIVE cada minuto |
| Web | `/performance`, `/performance/surveys/:id`, `/performance/reviews[/:id]`, `/admin/surveys` |
| Tiempo real | eventos `survey:changed`, `review:changed` |
| Auditoría | 10 acciones `SURVEY_*` / `PERFORMANCE_REVIEW_*` en `ActivityLog` |

La lista completa de endpoints está en [architecture.md](architecture.md#endpoints).

## Limitaciones conocidas

1. **`collaboration_score` siempre es `null`.** No hay una fuente fiable; el índice de
   productividad se calcula con los otros tres componentes, con sus pesos redistribuidos
   ([ADR-002](adr/002-module1-performance-calculation.md)).
2. **`kpi_achievement` es del área, no de la persona.** Todos los miembros de un área
   reciben el mismo valor.
3. **Solo dos tipos de encuesta**: autoevaluación y evaluación del jefe. No hay 360°, pares
   ni evaluación ascendente ([guía para agregarlo](development-guide.md#agregar-un-tipo-de-encuesta)).
4. **El índice de productividad es una foto** tomada al crear la encuesta; no se actualiza
   si después cambian las tareas.
5. **Las encuestas vencidas no se cierran solas:** quedan abiertas y marcadas como "Vencida"
   hasta que un jefe las cancele.
6. **Un resultado publicado se sigue recalculando** si después se envía otra encuesta del
   mismo trimestre. La persona podría ver cambiar sus números sin aviso.
7. **Publicar no se puede deshacer**: no existe "despublicar".
8. **No hay exportación a Excel** de resultados, a diferencia del tablero semanal.

## Pendientes antes de Phase 2

Ordenados por prioridad. El detalle está en [code-review-phase1.md](code-review-phase1.md)
y [security-audit-phase1.md](security-audit-phase1.md).

| # | Qué | Severidad | Esfuerzo |
|---|---|---|---|
| 1 | ~~Un jefe ve las evaluaciones de otro jefe de su mismo departamento~~ | ✅ Resuelto (CR-01) | — |
| 2 | ~~Carreras en enviar/cancelar/crear~~ | ✅ Resuelto (CR-02, CR-03) | — |
| 3 | ~~Rate limit global por IP~~ | ✅ Resuelto (S6: ahora por usuario) | — |
| 4 | Doble autenticación en `/workspaces/*` (2 lookups de sesión por request) | Baja | XS |
| 5 | Índice `surveys(workspaceId, reviewPeriod, departmentId)` para el tablero y los filtros por periodo | Baja | XS |
| 6 | Zona horaria del navegador frente a la del workspace en el modal de creación | Baja | S |
| 7 | Commitear Phase 1 | Proceso | XS |
