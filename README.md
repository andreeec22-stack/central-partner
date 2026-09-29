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
npm run dev:api                                   # API en http://localhost:3000
```

## Tests

```bash
npm run test:unit -w @central-partner/api
# Integración (necesita Docker levantado; usa la BD central_partner_test):
DATABASE_URL=postgresql://central:central@localhost:5432/central_partner_test npx -w @central-partner/api prisma migrate deploy
npm run test:integration -w @central-partner/api
```

## Estructura

```
apps/api        Hono + Prisma (API REST /api/v1, Socket.IO en fases siguientes)
apps/web        React 19 + Vite (fase Días 5–6)
infra/          scripts de inicialización de Docker
```
