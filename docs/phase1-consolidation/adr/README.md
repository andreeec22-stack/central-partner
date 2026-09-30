# Architecture Decision Records — Phase 1

Cada ADR registra una decisión que sería cara de revertir, con su contexto, las alternativas
y las consecuencias. Formato: [Michael Nygard](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).

| # | Decisión | Estado |
|---|---|---|
| [001](001-data-model.md) | Modelo de datos: 5 tablas, un Survey = una evaluación | Aceptada |
| [002](002-module1-performance-calculation.md) | Productividad calculada en proceso desde tareas, con timeout y fallback | Aceptada |
| [003](003-rbac-permission-model.md) | Permisos por departamento propio; los permisos de visibilidad no cubren datos de RRHH | Aceptada (hallazgo CR-01 resuelto) |
| [004](004-survey-scoring-system.md) | Escala 0–100, `null` = sin dato, umbrales 90/80/70 | Aceptada |
| [005](005-autosave-strategy.md) | Autoguardado agrupado a 30 s con upsert por pregunta | Aceptada |

**Cómo agregar uno:** copia la estructura de cualquier ADR, numera con el siguiente número
libre y nunca edites uno aceptado. Si una decisión cambia, crea uno nuevo que diga
"Reemplaza a ADR-00X" y marca el viejo como *Reemplazada*.
