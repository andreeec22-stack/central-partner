# Despliegue en Railway

Railway **no ejecuta `docker-compose.prod.yml`**: cada contenedor es un servicio aparte.
El proyecto queda con 4 servicios en un mismo proyecto/entorno de Railway:

| Servicio   | Origen                         | Config-as-code            | Dominio público |
|------------|--------------------------------|---------------------------|-----------------|
| `Postgres` | plantilla de Railway           | —                         | no              |
| `Redis`    | plantilla de Railway           | —                         | no              |
| `api`      | este repo, `apps/api/Dockerfile` | `/apps/api/railway.toml` | no (va por `web`) |
| `web`      | este repo, `apps/web/Dockerfile` | `/apps/web/railway.toml` | **sí**          |

`web` es nginx: sirve el SPA y hace de proxy same-origin a `api` por la red privada
(`/api`, `/socket.io`, `/api/health`). Así la cookie de refresh y el websocket no
necesitan CORS ni `SameSite=None`.

## Por qué fallaba antes

- **E2E/tests en el build:** sin un `Dockerfile` en la raíz, Railway usa Railpack sobre
  el `package.json` raíz del monorepo (build de todos los workspaces, incluido
  `apps/e2e`). Los `railway.toml` fijan `builder = "DOCKERFILE"`; las imágenes solo
  instalan el workspace que necesitan (`apps/e2e` aporta únicamente su `package.json`
  para que `npm ci` respete el lockfile).
  **El config path hay que ponerlo en cada servicio**: Railway solo lee `railway.toml`
  de la raíz por su cuenta, y aquí no hay ninguno a propósito (son dos servicios distintos).
- **La API no arrancaba / health check:** la API escucha en `$PORT` (Railway lo inyecta)
  y expone `GET /health` (base de datos + Redis). El `CMD` aplica `prisma migrate deploy`
  antes de escuchar; por eso `healthcheckTimeout = 120`.
- **nginx con valores fijos:** antes tenía `listen 80` y `upstream api:3001` (nombres de
  docker-compose). Ahora el puerto y el upstream vienen de variables de entorno, y nginx
  resuelve la API en cada request con el DNS del contenedor, así un redeploy de `api`
  con otra IP privada no deja a `web` apuntando a la vieja.

## Paso a paso

1. **New Project → Deploy from GitHub repo** → `Central-Partner`. Railway crea un
   servicio. Renómbralo `api`.
2. En `api` → *Settings*:
   - *Root Directory*: vacío (los Dockerfiles construyen desde la raíz del repo).
   - *Config-as-code → Railway config file*: `/apps/api/railway.toml`.
3. **+ New → GitHub repo** (mismo repo) → renómbralo `web` → *Config file*:
   `/apps/web/railway.toml`. En *Networking → Generate Domain* (puerto `8080`, o el
   `PORT` que pongas).
4. **+ New → Database → PostgreSQL** y **+ New → Database → Redis**.
5. Variables (abajo). Railway redespliega al guardarlas.
6. Comprueba `https://<dominio-web>/health` (nginx) y `https://<dominio-web>/api/health`
   (API: `{"status":"ok","database":"ok","redis":"ok",...}`).
7. Datos iniciales: **no corras el seed** en producción (borra todo y crea datos demo).
   El primer usuario se registra desde la pantalla de registro: crea el workspace y
   queda como su ADMIN; el resto entra por invitación.

## Variables

Los `${{...}}` son *reference variables* de Railway: se escriben tal cual en el panel.

### `api`

```
PORT=3001
DATABASE_URL=${{Postgres.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}?family=0
JWT_SECRET=<openssl rand -base64 48>
APP_URL=https://<dominio-web>
CORS_ORIGIN=https://<dominio-web>
TRUST_PROXY=true
COOKIE_SECURE=true
COOKIE_SAMESITE=Lax
SCHEDULERS_ENABLED=true
LOG_LEVEL=info
```

- `PORT` fijo para que `web` pueda referenciarlo (`${{api.PORT}}`).
- `?family=0`: ioredis resuelve IPv4 e IPv6 (los entornos antiguos de Railway tienen red
  privada solo IPv6).
- `SCHEDULERS_ENABLED=true` en **una sola réplica** (ciclo semanal, encuestas, purga de reportes).
- Opcionales, igual que en `.env.example`: `SMTP_*`, `AWS_S3_*`/`AWS_ACCESS_KEY_ID`/
  `AWS_SECRET_ACCESS_KEY` (Supabase Storage es compatible con S3: `AWS_S3_ENDPOINT`),
  `SENTRY_DSN`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX`, `REPORT_GENERATIONS_PER_HOUR`.

**Archivos:** el disco de un servicio de Railway se pierde en cada deploy. Usa S3
(recomendado). Si prefieres un *Volume* montado en `/app/apps/api/uploads`, añade
`RAILWAY_RUN_UID=0`: Railway monta los volúmenes como root y la imagen corre como `node`.

### `web`

```
PORT=8080
API_UPSTREAM=${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}
TRUST_EDGE_PROXY=true
```

- `TRUST_EDGE_PROXY=true`: nginx toma la IP del cliente del `X-Forwarded-For` que añade
  el edge de Railway (la entrada de más a la derecha; las que el cliente falsifique a la
  izquierda se ignoran). Sin esto, todos los logins anónimos compartirían la IP del edge
  y el límite de `AUTH_RATE_LIMIT_MAX` intentos/minuto sería global. En docker-compose
  queda en `false`.

**Nunca** pongas secretos en `railway.toml`: está en el repo. Van en el panel de variables.

## Rollback y logs

- *Deployments* → deploy anterior → **Redeploy**. Las migraciones son aditivas; un rollback
  de código con un esquema más nuevo funciona mientras no se haya borrado nada.
- Logs: *Deployments → View logs* de cada servicio. La API escribe JSON por stdout;
  nginx, una línea por request con la IP real del cliente.
