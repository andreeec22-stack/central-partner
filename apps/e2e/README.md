# E2E — Playwright

Flujos críticos en un navegador real (Chromium) contra la API y la web reales.

```bash
npm run test:e2e                         # desde la raíz (headless)
npm run test:headed -w @central-partner/e2e
npm run test:debug -w @central-partner/e2e
npx playwright test tests/week-closure.spec.ts   # un archivo (desde apps/e2e)
npm run report -w @central-partner/e2e   # abre el reporte HTML (playwright-report/)
```

**Requisitos:** Docker levantado (`npm run infra:up`) y Chromium para Playwright
(`npx playwright install chromium`, una sola vez).

## Aislamiento

| | E2E | Para qué no choque con… |
|---|---|---|
| BD | `central_partner_e2e` (se crea y migra sola) | tu BD de desarrollo y `central_partner_test`, que los tests de integración vacían con `TRUNCATE` |
| API | puerto 3002, `SCHEDULERS_ENABLED=false` | tu API (3000) y la demo (3001); sin el scheduler, que competiría con el seed por la semana actual |
| Web | puerto 5176 | tu web (5173/5174) y la demo (5175) |

Playwright levanta los dos servidores (`webServer` en `playwright.config.ts`) y los apaga
al terminar. Los datos son el **seed demo**, recargado por las suites que los modifican
(`support/data.ts → reseed`). Se ejecuta con un solo worker y en orden, porque la BD es
compartida.

**Cuentas** (contraseña `demo-12345`): `director@`, `jefe.marketing@`, `ana.gomez@`
(colaboradora) y `viewer@` (lector), todas `@central.local`.

## Suites (37 tests)

| Archivo | Tests | Qué cubre |
|---|---|---|
| `auth.spec.ts` | 6 | Login de los 4 roles, logout (y que el refresh revocado no vuelva a entrar), contraseña incorrecta |
| `navigation.spec.ts` | 6 | Menú de administración solo para el director; `/admin/reports` redirige y la API da 403; semanas archivadas sin botón de cierre; el lector no ve Desempeño |
| `week-closure.spec.ts` | 8 | Semana pendiente y aviso de reporte automático; 403 para no-directores; cierre con reporte, descarga y auditoría; la semana sale de pendientes; tareas de semana cerrada en solo lectura (UI y 409 `WEEK_ARCHIVED`); fallo del reporte |
| `reports.spec.ts` | 9 | Reporte automático en la lista; descarga y auditoría; 16 hojas (13 áreas + resumen, histórico y notas); top/bottom 3; bloques de cada área; acentos y ñ; < 10 MB; eliminar y restaurar; regenerar |
| `permissions.spec.ts` | 5 | `/api/v1/export`: el director lista y descarga (`.xlsx`, `private, no-store`); jefe, colaborador y lector reciben 403 en listar, descargar, eliminar y generar |
| `conflicts.spec.ts` | 3 | Dos personas con la misma tarea abierta: el segundo recibe 409 y el diálogo "Cambios en conflicto", y el primero conserva su cambio; "Recargar" trae la versión nueva; dos clics rápidos de la misma persona no son conflicto |

## Notas

- **Fallo del reporte al cerrar** (week-closure): se simula reescribiendo la respuesta de
  `/close` con `report: null`. El fallo real del servidor está cubierto por
  `apps/api/tests/integration/reports.test.ts`.
- **Conflictos:** a la persona B se le corta el WebSocket (`routeWebSocket`) para que
  conserve la versión vieja en pantalla. Con tiempo real, B recibiría el cambio de A al
  instante, que es justamente lo que reduce los conflictos en uso normal.
- **Ruido en la consola:** `[vite] ws proxy error: write ECONNABORTED` aparece cuando
  Playwright cierra una pestaña con el socket abierto. Es inofensivo y lo imprime el logger
  interno de Vite.
- **Diferencias con el prompt:**
  - Las cuentas son las del seed (`@central.local`), no `@empresa.com`.
  - Son 13 áreas, no 14.
  - Los reportes se guardan en el storage existente, no en Supabase.
  - `/admin/reports/list` no existe: se prueba la API `/api/v1/export`.
  - Los puertos son 3002/5176 en vez de 5175, para no chocar con la demo.
