# Phase 2 — Sprint 1 + CR-04

> **Estado al 1 de octubre de 2026:** implementado y probado, **sin commitear**. Migración
> `20261001000917_okrs_scorecard_recalculation` aplicada en las BD de desarrollo y de test.
> Siguen pendientes el Sprint 2 (integraciones) y el Sprint 3 (pulido, E2E y accesibilidad).

## Qué se entregó

| Pieza | Dónde | Notas |
|---|---|---|
| **CR-04:** resultados publicados que cambian | `surveys/reviews.service.ts` (`upsertPerformanceReview`, `refreshReview`, `recalculateReview`) | Al **enviar**, corregir o cancelar una encuesta: si el resultado ya estaba publicado y cambia, se guarda `lastRecalculatedAt` y `recalculationCount`, se registra el antes y el después en Auditoría (`PERFORMANCE_REVIEW_RECALCULATED`) y se notifica a los jefes del área (`RESULT_RECALCULATED`). También existe `POST /performance-reviews/:id/recalculate`. |
| **OKRs** | `modules/okrs/` | Tres niveles: empresa, área y persona. De 1 a 5 resultados clave por objetivo. Árbol, check-ins con historial, auditoría y evento `okr:changed`. |
| **Dashboard de desempeño** | `modules/scorecard/`, `GET /performance-dashboard` | Cuatro KPIs, tendencia de 4 trimestres, áreas contra su meta (`Department.performanceTarget`, 80 por defecto), alertas, vista de empresa (director) y vista de equipo (jefe, o el director eligiendo un área). Caché de 5 minutos invalidada al cambiar resultados u OKRs. |
| **Web** | `/performance/dashboard`, `/performance/okrs` | Sub-navegación de Desempeño; insignia "Recalculado" y botón "Recalcular" en el resultado; OKRs de la persona junto a su resultado; meta de desempeño en Departamentos. |
| **Seed** | `prisma/seed.ts` | 4 OKRs en cascada (empresa → Marketing → Ana) con un check-in, y meta del 85 % para Marketing. |

## Decisiones de este sprint

| # | Decisión | Por qué |
|---|---|---|
| [ADR-006](adr/006-okr-status-by-elapsed-time.md) | El estado de un OKR compara su avance con lo esperado a la fecha | Con la regla literal (< 70 % absoluto), todo OKR estaría "en riesgo" desde el primer día del trimestre. Decisión del usuario. |
| [ADR-007](adr/007-scorecard-live-no-snapshots.md) | Scorecard calculado en vivo con caché, sin tabla de snapshots ni jobs | Los resultados pasados cambian por CR-04; un snapshot congelaría números viejos. |
| [ADR-008](adr/008-cr04-recalculation-notices.md) | CR-04 se dispara al cambiar de estado una encuesta, no en cada respuesta | Las respuestas se autoguardan cada 30 s: notificar en cada guardado sería spam. |

## Diferencias con el prompt maestro (y por qué)

| El prompt decía | Se hizo | Motivo |
|---|---|---|
| Rutas `/workspaces/:id/dashboards/…` y `/workspaces/:id/okrs` | `/performance-dashboard` y `/okrs` | Convención del proyecto: el workspace sale del token. Además, montar más sub-apps en `/workspaces` repite la doble autenticación (CR-06). |
| `POST /workspaces/:id/performance/results/:resultId/recalculate` | `POST /performance-reviews/:id/recalculate` | Mismo motivo |
| `POST /notifications/recalculate-result` | No existe como endpoint | La notificación es efecto del recálculo, no algo que un cliente pida. |
| Tablas `dashboard_snapshots`, `dashboard_configs` | No creadas | Ver ADR-007. Configurar el layout del dashboard no estaba en ningún requisito funcional. |
| `Survey.lastRecalculatedAt`, `linkedOkrIds`; `PerformanceReview.isRecalculated`, `recalculatedFromSurveyIds` | `PerformanceReview.lastRecalculatedAt` + `recalculationCount`; el detalle (qué encuesta lo causó y el antes y después) va en ActivityLog | Lo que se recalcula es el resultado, no la encuesta. `isRecalculated` se deduce de `lastRecalculatedAt`. La relación con OKRs sale de (persona, trimestre), sin arrays de IDs que mantener. |
| Notification con `metadata JSON` y tipos `SURVEY_SUBMITTED`, `OKR_ALERT`, … | Solo se agregó `RESULT_RECALCULATED` | Sprint 1 no emite los demás; se agregarán con su caso de uso. |
| KPI "Desempeño = SUM(score × peso_area) / COUNT(personas)" | Media simple por persona | `peso_area` no está definido. Contar a cada persona una vez equivale a ponderar cada área por su número de personas. |
| KPI "Colaboración" | Siempre `null`, con la tarjeta "Aún sin fuente de datos" | No hay fuente (ADR-002 de la Phase 1). |
| "Cumplimiento de objetivos = completados / total" | Se mantiene, en color **neutro**, junto con el avance medio | A comienzo de trimestre siempre es 0 %: pintarlo de rojo alarmaría sin motivo. |
| Rate limit de 10 req/min por usuario en el dashboard | No aplicado; rige el límite global por usuario (300/min) | Con las pestañas, el refetch al enfocar y los eventos de socket, 10/min daría 429 en uso normal. La caché de 5 min ya protege la BD. |
| Bull Queue y tabla `AIInsights` | No en este sprint | Bull requiere Redis, que aquí es opcional. Se decide en el Sprint 2, con las integraciones. |
| Comentarios en OKRs | No (los check-ins llevan notas) | Queda para el Sprint 2 o 3. |

## Endpoints nuevos

| Método y ruta | Quién |
|---|---|
| `GET /performance-dashboard?period&departmentId` | ADMIN (empresa, o un área con `departmentId`) y JEFE_AREA (su equipo) |
| `GET /okrs?period&level&departmentId&ownerUserId` · `GET /okrs/tree?period` · `GET /okrs/:id` · `GET /okrs/:id/check-ins` | Todos. Los OKRs personales los ven solo la persona, su jefe y el director. |
| `POST /okrs` · `PATCH /okrs/:id` · `DELETE /okrs/:id` | Empresa: ADMIN. Área: ADMIN o jefe del área. Persona: ADMIN o el jefe de su equipo. |
| `POST /okrs/:id/check-ins` | Quien gestiona el OKR, más la persona dueña de un OKR personal |
| `POST /performance-reviews/:id/recalculate` | Gestor del resultado |

Códigos de error nuevos: `OKR_HAS_CHILDREN`.

## Tests

| Suite | Antes | Ahora |
|---|---|---|
| API unit | 98 | **111** (+13: progreso y estado de OKR, permisos, helpers del scorecard) |
| API integración | 146 | **152** (+6: CR-04, OKRs y scorecard) |
| Web | 69 | **74** (+5: árbol de OKRs, check-in, scorecard, insignia de recálculo) |

**Aviso de entorno:** dos corridas de integración en paralelo sobre `central_partner_test`
se bloquean mutuamente. Ambas hacen `TRUNCATE` y siembran los mismos fixtures. Lo mismo pasa
si `api-demo-db` está encendido mientras corren los tests, porque su scheduler escribe en esa
BD. Corre una suite a la vez y apaga los servidores de demo antes.

## Pendiente

- **Sprint 2:**
  - Email (SMTP existente, con plantillas y baja de suscripción).
  - Slack (webhook entrante, activado por variable de entorno; sin ella, log).
  - Google Calendar (OAuth, con fallback).
  - Reportes programados.
  - Exportar el scorecard (Excel/PDF).
  - Decidir la cola de trabajos.
- **Sprint 3:** E2E (Playwright), auditoría de accesibilidad, rendimiento con 1.000 personas,
  y docs y ADRs finales.
- **Abiertos de la Phase 1:** CR-05 a CR-16 (ver `docs/phase1-consolidation/code-review-phase1.md`).
