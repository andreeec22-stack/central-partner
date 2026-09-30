# Despliegue — Módulo de Desempeño

> **Estado real:** el repositorio **no tiene** hoy Dockerfile de la API, pipeline de CI ni
> configuración de hosting. `apps/web/.env.example` menciona Vercel (web) y Railway (API)
> como destino previsto. Esta guía describe lo que el módulo necesita, sea cual sea la
> plataforma.

## Qué trae la Phase 1

| Pieza | Cambio |
|---|---|
| BD | Migración `20260930214620_performance_surveys`: 5 tablas, 6 enums, 20 índices y el valor `SURVEY_ASSIGNED` en `NotificationType`. Solo aditiva: no toca tablas ni datos existentes. |
| API | Rutas nuevas y un **scheduler en proceso** (`startSurveyScheduler`, cada 60 s) |
| Web | Rutas nuevas, con carga diferida por página |
| Configuración | **Ninguna variable de entorno nueva.** Redis sigue siendo opcional (sin él no hay caché del tablero). |

## Estrategia de migraciones

1. **Solo `prisma migrate deploy` en los entornos compartidos.** Nunca `migrate dev` ni
   `db push`.
2. **Orden de despliegue:** primero la migración, después la API y después la web.
   - La migración es aditiva: la API anterior sigue funcionando con las tablas nuevas.
   - Una API nueva **sin** la migración falla en cuanto el scheduler consulta `surveys`, un
     minuto después de arrancar.
3. **Ejecutar la migración como paso separado** (release command o job), no en el arranque de
   cada réplica, para evitar migraciones concurrentes. Prisma toma un advisory lock, pero
   igual conviene un solo ejecutor.
4. **`ALTER TYPE … ADD VALUE`** (en `NotificationType`) no se puede usar dentro de la misma
   transacción que lo crea. La migración no usa el valor nuevo, así que es seguro en
   Postgres 12+.
5. **Verificación posterior:**
   ```sql
   SELECT migration_name, finished_at FROM "_prisma_migrations" ORDER BY started_at DESC LIMIT 3;
   SELECT count(*) FROM survey_templates;   -- 0 en un entorno nuevo, sin error
   ```
6. **Datos semilla:** en producción **no** se corre `db:seed`, porque borra el workspace demo
   y se niega a correr con `NODE_ENV=production`. El director crea las plantillas desde
   `/admin/surveys`.

## Rollback

**Nivel 1: solo código (preferido).** Redesplegar la versión anterior de la API y la web.
Las tablas nuevas quedan sin uso, lo cual es inocuo. No se pierden datos, y volver a
avanzar no requiere nada.

**Nivel 2: revertir el esquema.** Solo si hay que eliminar el módulo por completo.
**⚠ Borra todas las evaluaciones.** Haz primero un respaldo:
`pg_dump -t 'survey*' -t performance_reviews`.

```sql
BEGIN;
-- La API vieja no conoce SURVEY_ASSIGNED: estas filas romperían su cliente Prisma al leerlas.
DELETE FROM notifications WHERE type = 'SURVEY_ASSIGNED';
DROP TABLE IF EXISTS survey_responses, surveys, survey_questions, survey_templates, performance_reviews CASCADE;
DROP TYPE IF EXISTS "SurveyTemplateStatus", "SurveyQuestionType", "SurveyType",
                    "SurveyStatus", "PerformanceRating", "RiskLevel";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260930214620_performance_surveys';
COMMIT;
```

Limitaciones del nivel 2:
- **Postgres no permite quitar un valor de un enum.** `SURVEY_ASSIGNED` queda en
  `NotificationType`. Es inocuo para la API vieja, porque ya no hay filas que lo usen.
- **Volver a aplicar la migración** fallaría en su `ALTER TYPE … ADD VALUE 'SURVEY_ASSIGNED'`
  porque el valor ya existe. Antes de re-desplegar, ejecuta a mano el resto del SQL de la
  migración y márcala con
  `npx prisma migrate resolve --applied 20260930214620_performance_surveys`.
- Las filas de `activity_logs` con acciones `SURVEY_*` quedan; se muestran con su código
  crudo en la página de Auditoría de la versión vieja.

## Monitoreo

**Logs** (JSON, `lib/logger`):

| Evento | Nivel | Qué indica | Alerta sugerida |
|---|---|---|---|
| `productivity unavailable for survey` | warn | Module 1 falló o tardó más de 3 s | más de 5 en 10 min: revisar la carga de la BD |
| `survey scheduler crashed` | error | El scheduler no pudo correr | cualquiera |
| `surveys activated` | info | N encuestas pasaron de SCHEDULED a ACTIVE | — |
| `notify failed` (con `type: SURVEY_ASSIGNED`) | error | No se creó la notificación (la encuesta sí) | más de 0 sostenido |
| `cache read failed` / `cache invalidate failed` | warn | Redis intermitente (sigue funcionando sin caché) | sostenido |

**Métricas de negocio** (SQL periódico o tablero):

```sql
-- Encuestas creadas sin productividad (debería ser la minoría; NO_DATA es normal para gente sin tareas)
SELECT metadata->>'reason' AS reason, count(*) FROM activity_logs
 WHERE action = 'SURVEY_CREATED_WITHOUT_PRODUCTIVITY' AND "createdAt" > now() - interval '7 days' GROUP BY 1;

-- Encuestas vencidas sin enviar (no se cierran solas)
SELECT "workspaceId", count(*) FROM surveys
 WHERE status IN ('SCHEDULED','ACTIVE') AND "endDate" < now() GROUP BY 1;

-- Encuestas programadas que el scheduler no activó (debería ser 0)
SELECT count(*) FROM surveys WHERE status = 'SCHEDULED' AND "startDate" < now() - interval '5 minutes';
```

**HTTP:** vigilar la tasa de **429** (el rate limit por IP; ver
[security-audit, S6](security-audit-phase1.md)), la latencia p95 de
`POST /surveys` (incluye Module 1) y la de `GET /surveys/dashboard` cuando no hay caché.

**Salud:** `GET /health` ya cubre la base de datos y Redis. El módulo no agrega dependencias.

## Consideraciones de escalado

- **Varias réplicas de la API:**
  - El scheduler corre en **cada** réplica. El `updateMany … WHERE status='SCHEDULED'` es
    idempotente, así que no hay doble activación, pero sí eventos de socket duplicados
    (inocuos: la web deduplica en 200 ms).
  - Con muchas réplicas, conviene moverlo a un único worker o usar un advisory lock.
  - Socket.IO ya usa el adaptador de Redis: los eventos llegan a clientes conectados en
    cualquier réplica.
- **Caché:** sin Redis, cada `GET /surveys/dashboard` recalcula el tablero. Con varias
  réplicas, Redis es necesario para que la invalidación sea global. Sin él, cada réplica
  tampoco guarda caché local, así que no hay inconsistencia, solo más carga.
- **Rate limit:** sin Redis, el límite es por réplica (en memoria), es decir, efectivamente
  N × 300 por minuto.
- Límites de datos y consultas: ver [scalability-phase1.md](scalability-phase1.md).

## Checklist de despliegue

- [ ] Phase 1 commiteada y revisada (hoy **no** lo está)
- [x] Hallazgos CR-01 a CR-03 y S6 corregidos
- [ ] Respaldo de la BD
- [ ] `prisma migrate deploy` como paso previo; verificar `_prisma_migrations`
- [ ] Desplegar la API y confirmar que no aparece `survey scheduler crashed` en los primeros 2 minutos
- [ ] Desplegar la web
- [ ] Prueba de humo: el director crea una plantilla de 3 preguntas, la activa, crea una
  evaluación para un usuario de prueba, ese usuario responde y envía, el director publica y
  el usuario ve su resultado
- [ ] Las alertas de la tabla de monitoreo están configuradas
