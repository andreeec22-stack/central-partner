# Estrategia de testing — Módulo de Desempeño

## Estado actual (medido el 2026-09-30)

| Suite | Archivo | Tests | Qué cubre |
|---|---|---|---|
| API unit | `apps/api/tests/unit/surveys.test.ts` | 23 | scoring (productividad, normalización, ponderado, dual, rating y riesgo, agregado, periodos), validadores, RBAC puro, `withTimeout` con timers falsos |
| API integración | `apps/api/tests/integration/surveys.test.ts` | 15 | Module 1 (métricas y acceso), plantillas, crear (con fallback por error y por cuelgue), visibilidad por rol, borradores, bloqueos, envío, resultado y publicación, tablero e invalidación, scheduler |
| Web | `apps/web/src/__tests__/performance/surveys.test.tsx` | 8 | `useAutoSave` (30 s, reintento, flush), `SurveyResponsePage` (autoguardado, guardado antes de enviar, solo lectura, 403), reglas del editor de plantillas |

Totales del proyecto (tras las correcciones CR-01, CR-02, CR-03 y S6): API unit 98, integración 146 y web 69, todos en verde.

**Cobertura de la API** (Jest, unit + integración del módulo):

| Archivo | Líneas | Ramas | Sin cubrir |
|---|---|---|---|
| `scoring.ts` | 98,4 % | 91 % | l. 89 |
| `surveys.validators.ts` | 100 % | 96 % | — |
| `surveys.access.ts` | 100 % | 90 % | — |
| `surveys.schemas.ts` | 100 % | 100 % | — |
| `surveys.dashboard.ts` | 97,5 % | 73 % | l. 20 |
| `reviews.service.ts` | 98,4 % | 65 % | l. 136 |
| `surveys.service.ts` | 94,7 % | 75 % | `value: null`, evaluado sin área, log del scheduler |
| `surveys.routes.ts` | 94,6 % | 100 % | `GET /templates/:id`, `DELETE` exitoso |
| `templates.service.ts` | **84,5 %** | **39 %** | transiciones inválidas, borrado, getTemplate de un JEFE |
| `performance.service.ts` | 90,7 % | 76 % | **cálculo de `kpi_achievement`** |
| **Total módulo** | **95,3 %** | **75,6 %** | |

La cobertura de la web no se mide: `@vitest/coverage-v8` no está instalado.

## Pirámide y criterio

```
          ▲  Navegador (manual, hoy)     — flujo real con API y BD de demo
         ▲▲▲ Integración API (Jest+Postgres) — contratos HTTP, RBAC real, transacciones
       ▲▲▲▲▲ Unit (Jest / Vitest)          — reglas puras: scoring, access, validators, hooks
```

- **Unit** para toda regla que se pueda expresar como función pura. Por eso scoring, access
  y validators están separados de los servicios.
- **Integración** para lo que depende de la BD o del cableado: permisos de extremo a extremo,
  unicidad, transacciones y auditoría. Cada test siembra un workspace nuevo (`seedWorkspace`)
  tras un `TRUNCATE`.
- **Componente (web)** para la lógica con temporizadores y estados de carga. La API se mockea
  con `vi.mock('../../lib/api')`.
- **E2E: no existe infraestructura.** Hay una skill `playwright-cli` disponible en el entorno,
  pero nada en el repositorio.

## Qué falta testear

Prioridad alta, ligado a hallazgos del [code review](code-review-phase1.md):
1. ✅ **CR-01:** cubierto (unit + integración).
2. ✅ **CR-02 y CR-03, concurrencia:** cubierto (envío frente a cancelación, envíos simultáneos
   y creaciones simultáneas). Además S6 está cubierto en `tests/unit/rate-limit.test.ts`.
3. **`kpi_achievement`:** crear una semana con KPIs registrados para el área y verificar el
   valor y el efecto en el índice.

Prioridad media:

4. Plantillas: DRAFT→ARCHIVED (409), borrado exitoso, JEFE pidiendo un DRAFT (404),
   `updateTemplate` que reemplaza preguntas.
5. Resultados: acceso entre workspaces (404), `nextReviewDate: null`, recálculo tras publicar
   (CR-04), fecha imposible (CR-11).
6. `saveResponses` con `value: null` (borra la respuesta y recuenta el avance).
7. Web: tests de `PerformancePage` (tablero y cancelar), `ReviewDetailPage` (publicar y
   comentar), `CreateSurveyModal` (crear las dos evaluaciones y el error del segundo POST,
   CR-05) y del editor de plantillas (agregar, mover y quitar preguntas).
8. `useAutoSave`: el guardado al desmontar y el aviso de `beforeunload`.

Prioridad baja:

9. E2E con Playwright del flujo completo (crear → responder → enviar → publicar → ver) sobre
   `api-demo-db` y `web-demo-db`.
10. Cobertura web (instalar `@vitest/coverage-v8`) con un umbral mínimo en CI (cuando exista).

## Cómo escribir tests nuevos

**Unit (API)**: reglas puras, sin BD.
```ts
import { ratingFor } from '../../src/modules/surveys/scoring';
it('rates 80 as meets', () => expect(ratingFor(80)).toBe('MEETS_EXPECTATIONS'));
```
Para el acceso, construye un `AuthUser` y un `Survey` parcial. Hay un helper `user()` en
`tests/unit/surveys.test.ts`.

**Integración (API)**: siempre con los helpers existentes.
```ts
import { seedWorkspace, type Seed } from './fixtures';   // director + Marketing (2 jefes, 2 users, viewer) + Finanzas
import { call, resetDatabase } from './helpers';

beforeEach(async () => { await resetDatabase(); s = await seedWorkspace(); });

const t = await activeTemplate();                        // helper del archivo surveys.test.ts
const res = await createSurvey(s.mkt.jefe.token, { templateId: t.id, type: 'MANAGER_REVIEW', evaluatedUserId: s.mkt.user.id });
expect(res.status).toBe(201);
```

Reglas:
- **Verifica también la auditoría** cuando la acción la escribe
  (`prisma.activityLog.findFirstOrThrow({ where: { action } })`).
- **Mockea Module 1** con `jest.spyOn(perf, 'getPerformanceMetrics')`, porque el servicio lo
  llama a través del namespace `perf`. Restaura con `afterEach(() => jest.restoreAllMocks())`.
- **Tiempos:** para fechas usa `inDays(n)`; para tareas, `dueAt(offset)` (zona Lima). Para la
  caché, espía `cache.invalidate` (Redis está apagado en los tests).
- **Nunca** apuntes a la BD de desarrollo: `tests/setup-env.ts` fija `central_partner_test`.

**Web (Vitest)**
```ts
const api = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async (o) => ({ ...(await o<typeof import('../../lib/api')>()), api }));
```
- Para temporizadores, activa `vi.useFakeTimers()` **después** de que la página cargó
  (`findBy…`); si no, TanStack Query no resuelve.
- Avanza el tiempo dentro de `act(async () => void vi.advanceTimersByTime(30_000))`.
- Busca por rol, etiqueta o texto visible, no por clases.
