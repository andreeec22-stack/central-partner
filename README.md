# Central Partner

Gestión de tareas multi-departamento (reemplazo del sistema Excel "SOLO 3 COSAS").

## Requisitos

- Node.js 20+
- Docker Desktop (Postgres 16, Redis 7, Meilisearch)

## Arranque local

```bash
npm install
npm run infra:up                                  # Postgres + Redis + Meilisearch
cp apps/api/.env.example apps/api/.env            # y pon un JWT_SECRET aleatorio
npm run db:migrate -w @central-partner/api        # aplica migraciones
npm run db:seed -w @central-partner/api           # datos demo (opcional)
npm run dev:api                                   # API en http://localhost:3000
npm run dev -w @central-partner/web               # App en http://localhost:5173
```

En desarrollo la app llama a `/api` y `/socket.io` en el propio Vite, que hace proxy a la API
(misma URL de origen, así la cookie httpOnly de sesión funciona igual que en producción).

### Cuentas demo (`db:seed`)

Todas con la contraseña `demo-12345`, dominio `@demo.local`:

| Cuenta | Rol | Notas |
|---|---|---|
| `director@` | Director (ADMIN) | Ve todo, crea tareas en cualquier departamento |
| `jefe.marketing@` | Jefe de área | **Puede** crear tareas (Marketing) |
| `jefe.finanzas@` | Jefe de área | **No** puede crear tareas |
| `ana@`, `luis@` | Colaborador | Marketing: actualizan avance de sus tareas |
| `carla@` | Colaborador | Finanzas |
| `lector@` | Lector | Solo lectura (Marketing) |

## Tests

```bash
npm run test:unit -w @central-partner/api
# Integración (necesita Docker levantado; usa la BD central_partner_test):
DATABASE_URL=postgresql://central:central@localhost:5432/central_partner_test npx -w @central-partner/api prisma migrate deploy
npm run test:integration -w @central-partner/api
npm run test -w @central-partner/web
```

## Estructura

```
apps/api        Hono + Prisma + Socket.IO (REST /api/v1)
apps/web        React 19 + Vite + Tailwind 4 + TanStack Query + Zustand
infra/          scripts de inicialización de Docker
```
