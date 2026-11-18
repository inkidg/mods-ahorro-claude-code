import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// ───────────────────────────────────────────────────────────────────────────
// EL CAPATAZ  (equivalente a "el sabueso" del video)
//
// Idea: no toda tarea necesita tu modelo caro. Cuando Claude DELEGA una tarea
// de buscar / leer / localizar archivos a un subagente, El Capataz la manda al
// modelo barato (Haiku). Las tareas que piden cabeza se quedan en el modelo
// fuerte de la sesion. Resultado: tu limite dura mas.
//
// Mecanismo: engancha el evento `agent.spawn` (cada vez que arranca un
// subagente) y, si la tarea huele a busqueda, reescribe su `model` a "haiku".
// ───────────────────────────────────────────────────────────────────────────

const MODELO_BARATO = 'haiku'

// Subagentes que por definicion son de exploracion/busqueda.
const AGENTE_BUSCADOR = /explore|buscad|search|research/i

// Pistas de que la tarea es "buscar/leer/localizar" (barata -> Haiku).
const TAREA_BUSQUEDA =
  /\b(busca\w*|localiza\w*|encuentra\w*|encontrar|lee|leer|lista\w*|revisa\s+archivos?|grep|find|search|locate|look\s+up|read|list|scan|d[oó]nde\s+est[aá]|qu[eé]\s+archivo|which\s+file|where\s+is)\b/i

// Pistas de que la tarea PIDE CABEZA (nunca degradar a Haiku).
const TAREA_PROFUNDA =
  /\b(implementa\w*|dise[nñ]a\w*|refactor\w*|arregla\w*|depura\w*|debug|planifica\w*|\bplan\b|decide|analiza\s+a\s+fondo|arquitect\w*|architecture|escribe\s+c[oó]digo|write\s+code|fix\s+the|solve)\b/i

const stats = atom(
  { plugin: 'el-capataz', key: 'stats' } as const,
  { aHaiku: 0, intactas: 0 },
)

type Stats = { aHaiku: number; intactas: number }

const etiqueta = (s: Stats) => `👷 Capataz · ${s.aHaiku}→Haiku`

function esBusqueda(subagentType: string, texto: string): boolean {
  if (AGENTE_BUSCADOR.test(subagentType)) return true
  if (TAREA_PROFUNDA.test(texto)) return false
  return TAREA_BUSQUEDA.test(texto)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'capataz',
      description: 'Ver cuantas tareas repartio El Capataz a Haiku',
    })
    $.ui.status(etiqueta(await read($, stats)))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    // Los forks y los companeros de equipo heredan modelo si o si: no tocar.
    const texto = `${e.description} ${e.prompt}`
    const aHaiku = !e.fork && !e.isTeammate && esBusqueda(e.subagentType, texto)

    // 1) Deja arrancar el subagente (con el modelo reescrito si procede).
    const ran = aHaiku ? await next({ ...e, model: MODELO_BARATO }) : await next(e)

    // 2) Feedback. Si algo falla aqui, el subagente ya arranco: no pasa nada.
    try {
      const s = await update($, stats, p =>
        aHaiku
          ? { ...p, aHaiku: p.aHaiku + 1 }
          : { ...p, intactas: p.intactas + 1 },
      )
      $.ui.status(etiqueta(s))
      if (aHaiku) {
        $.ui.toast(`👷 El Capataz mando esta busqueda a ${MODELO_BARATO}`)
      }
    } catch {
      /* el feedback es opcional */
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'capataz' }, async $ => {
    const s = await read($, stats)
    const cuerpo =
      s.aHaiku > 0
        ? `Cada una de esas ${s.aHaiku} busquedas se resolvio con el modelo barato en vez de quemar tu modelo fuerte.`
        : `Aun no ha repartido ninguna busqueda. En cuanto Claude delegue una busqueda a un subagente, la veras aqui.`
    return {
      text:
        `👷 EL CAPATAZ\n` +
        `• Busquedas enviadas a Haiku: ${s.aHaiku}\n` +
        `• Tareas que pedian cabeza (intactas): ${s.intactas}\n\n` +
        cuerpo,
    }
  })
}
