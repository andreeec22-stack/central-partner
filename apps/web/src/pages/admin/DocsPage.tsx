import { AdminPageHeader } from '../../components/admin/AdminKit';

// In-app guide for the director: the weekly ritual and who can do what.
const SECTIONS: { title: string; items: string[] }[] = [
  {
    title: 'El ritual semanal',
    items: [
      'Lunes: la semana se abre sola (zona horaria del espacio) con los KPIs y funciones de la anterior. Cada jefe recibe “Tu semana está lista”.',
      'Cada día: cada responsable marca el % de avance de sus tareas (0 · 25 · 50 · 75 · 100). El semáforo de la tarea se calcula por fecha: verde al 100%, amarillo si vence hoy, rojo si ya pasó su día, gris si aún no llega.',
      'Sábado: los jefes registran el real de cada KPI y marcan cada función (Sí / Parcial / No).',
      'Sábado desde las 10:00: en Gestión de semanas se valida, se archiva y lo pendiente pasa a la semana siguiente como “Viene de Sem. NN”.',
      'Último sábado del mes: cada área tiene la tarea “🏁 Exponer resultados del mes”.',
    ],
  },
  {
    title: 'El índice',
    items: [
      '① Avance: promedio del % de las tareas que ya vencieron (hasta hoy).',
      '② KPIs: promedio del cumplimiento real ÷ meta (o meta ÷ real si “menos es mejor”), cada KPI hasta 100%.',
      '③ Funciones: Sí = 1, Parcial = ½, No = 0; “no aplica” no cuenta.',
      'Índice = promedio de los que ya tienen datos. Semáforo: ≥ 90% verde, 70–89% amarillo, < 70% rojo.',
    ],
  },
  {
    title: 'Administración',
    items: [
      'Usuarios: se invitan por correo (la persona elige su contraseña). Desactivar no borra nada y se puede revertir.',
      'Permisos: cada rol tiene reglas fijas que el servidor verifica. Por jefe se configura si puede crear tareas y qué otras áreas puede ver (solo lectura).',
      'Departamentos: desactivar solo es posible sin tareas activas; sus personas quedan sin área.',
      'Auditoría: todo cambio queda registrado con quién, cuándo y los valores de antes y después. Se exporta a CSV o Excel.',
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <AdminPageHeader title="Documentación" description="Cómo funciona Central Partner." />
      {SECTIONS.map((s) => (
        <section key={s.title} aria-labelledby={s.title} className="rounded-2xl border border-line bg-surface p-5 shadow-card">
          <h2 id={s.title} className="font-bold">
            {s.title}
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-ink-soft">
            {s.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
