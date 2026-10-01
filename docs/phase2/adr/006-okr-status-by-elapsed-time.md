# ADR-006: Estado de un OKR según el tiempo transcurrido

- **Estado:** Aceptada (decisión del usuario, 30 sep 2026)
- **Archivos:** `apps/api/src/modules/okrs/okr-progress.ts`

## Contexto

El prompt de la Phase 2 decía: *"Si progreso < 70 % → cambiar a At Risk automáticamente"*.
Con esa regla, todo OKR estaría en riesgo desde el día 1 del trimestre, porque al comenzar el
avance es cercano a 0. La alerta no distinguiría un objetivo atrasado de uno recién empezado.

## Decisión

- El **avance** de un OKR es la media de sus resultados clave. Cada resultado clave avanza
  según `(actual − inicio) / (meta − inicio)`, acotado a 0–100. Si la meta es menor que el
  inicio, "menos es mejor".
- El **avance esperado** es la fracción transcurrida de la ventana del OKR: desde el inicio
  del trimestre hasta su `deadline`, o el fin del trimestre si no tiene.
- El **estado** se calcula **al leer** (porque cambia con la fecha), comparando
  `avance / esperado`:

| Condición | Estado |
|---|---|
| avance ≥ 100 | `COMPLETED` |
| la ventana terminó sin llegar a 100 | `OFF_TRACK` |
| primer 10 % de la ventana, o el trimestre aún no empieza | `ON_TRACK` (periodo de gracia) |
| ≥ 70 % de lo esperado | `ON_TRACK` |
| 40–70 % de lo esperado | `AT_RISK` |
| < 40 % de lo esperado | `OFF_TRACK` |

Ejemplo: a mitad de trimestre se espera 50 %. Con 40 % está en curso, con 30 % en riesgo y
con 15 % fuera de curso.

## Alternativas

| Alternativa | Por qué no |
|---|---|
| < 70 % absoluto (el prompt) | Falsos positivos durante casi todo el trimestre |
| Guardar el estado en la BD y recalcularlo con un job diario | Requiere un job y puede quedar desfasado. Calcularlo al leer es barato: una división por OKR. |
| Pesos por resultado clave | Nadie lo pidió. La media simple es más fácil de explicar; agregarlos solo toca `okrProgress`. |

## Consecuencias

- El 70 % del prompt se conserva como umbral, pero **relativo** al tiempo.
- La UI dibuja en la barra una marca de "esperado a la fecha", para que el estado se entienda.
- El estado no se guarda, así que filtrar OKRs por estado en SQL no es posible: se filtra en
  memoria. Con el volumen esperado (decenas o cientos de OKRs por trimestre) no es un problema.
