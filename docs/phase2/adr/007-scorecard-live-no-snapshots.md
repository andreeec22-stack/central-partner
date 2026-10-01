# ADR-007: Scorecard calculado en vivo, sin snapshots

- **Estado:** Aceptada
- **Archivos:** `apps/api/src/modules/scorecard/scorecard.service.ts`

## Contexto

El prompt proponía una tabla `dashboard_snapshots` (una fila por workspace y trimestre)
poblada por un job programado al cierre de cada periodo, más una caché de 1 hora.

Dos hechos lo contradicen:
- Con CR-04, los resultados de un trimestre **pueden cambiar después** (llega otra
  evaluación).
- Los OKRs de un trimestre se siguen actualizando hasta su cierre.

Un snapshot congelaría números que ya no son ciertos, o necesitaría reescribirse con cada
cambio, que es justo lo que hace una caché.

## Decisión

- `GET /performance-dashboard` calcula los KPIs **en vivo** desde `performance_reviews` y
  `okrs` para el trimestre pedido **y los 3 anteriores** (la tendencia). Son dos consultas
  acotadas por `(workspaceId, periodo)`.
- **Caché en Redis de 5 minutos** por (workspace, trimestre, alcance). El alcance es
  `company`, `dept:{id}:team` (vista del jefe) o `dept:{id}:all` (el director viendo un área).
  Se invalida al recalcular un resultado, al publicarlo y al cambiar un OKR. Sin Redis, cada
  lectura recalcula.
- Cada persona cuenta una vez: la media de la empresa queda ponderada por número de personas
  en cada área.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| Snapshots y job de cierre (el prompt) | Datos congelados que CR-04 vuelve falsos; un job más que operar |
| Caché de 1 hora en el cliente | Tras publicar o hacer un check-in, el director vería datos viejos hasta 1 hora. Los eventos de socket ya refrescan las vistas abiertas. |
| Vista materializada en Postgres | Costo de refresco y complejidad, sin necesidad con este volumen |

## Consecuencias

- La tendencia de trimestres pasados refleja correcciones posteriores. Es lo deseado, pero
  significa que la tendencia "cambia" si alguien recalcula un trimestre viejo.
- La invalidación borra solo las claves del trimestre afectado. La comparación "equipo frente
  a empresa" de un jefe puede tardar hasta 5 minutos en reflejar cambios de **otras** áreas.
- Si el volumen crece mucho (más de 50.000 resultados por trimestre), conviene mover las
  medias a SQL (`AVG … GROUP BY`) antes que agregar snapshots.
