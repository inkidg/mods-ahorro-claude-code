import { atom, read, update } from 'claude-code'
import type { Register, SessionUsage } from 'claude-code'

// ───────────────────────────────────────────────────────────────────────────
// EL VIGIA  (equivalente a "el chivato" del video)
//
// Un panel en vivo con el estado de tu Claude ahora mismo:
//   • TU LIMITE   -> ventanas de limite (semana / 5 horas) con % y cuando se renueva
//   • CONTEXTO    -> cuanto del contexto llevas usado (ej. 86k de 1.0M)
//   • QUIEN GASTA -> tokens movidos por cada modelo en la sesion (opus, haiku...)
//   • COSTE       -> lo que llevarias gastado si pagaras por API
//
// Datos: `$.session.usage()` da limite + contexto + coste (lo mismo que la barra
// de estado). El "quien gasta" lo acumulamos modelo a modelo desde `turn.complete`.
// ───────────────────────────────────────────────────────────────────────────

const PANEL = 'vigia'

const gasto = atom(
  { plugin: 'el-vigia', key: 'gasto' } as const,
  {} as Record<string, number>,
)

// ── Formateo ────────────────────────────────────────────────────────────────
const formatK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1_000
    ? `${Math.round(n / 1000)}k`
    : `${Math.round(n)}`

const barra = (pct: number, ancho = 10): string => {
  const n = Math.max(0, Math.min(ancho, Math.round((pct / 100) * ancho)))
  return '█'.repeat(n) + '░'.repeat(ancho - n)
}

function familia(modelo: string): string {
  const s = (modelo || '').toLowerCase()
  if (s.includes('opus')) return 'opus'
  if (s.includes('haiku')) return 'haiku'
  if (s.includes('sonnet')) return 'sonnet'
  if (s.includes('fable')) return 'fable'
  return modelo || 'otro'
}

const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
function fechaCorta(iso?: string): string {
  if (!iso) return 's/f'
  try {
    const d = new Date(iso)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${DIAS[d.getDay()]} ${hh}:${mm}`
  } catch {
    return iso
  }
}

const LABEL_LIMITE: Record<string, string> = {
  seven_day: 'Semana',
  five_hour: '5 horas',
  spend_limit: 'Gasto',
}

function etiquetaEstado(us: SessionUsage): string {
  const sem = us.rateLimits.find(r => r.kind === 'seven_day')
  const ctx = Math.round(us.context.percent ?? 0)
  const semTxt = sem ? `${Math.round(sem.percentUsed)}%` : '–'
  return `🔭 Vigía · Sem ${semTxt} · ctx ${ctx}%`
}

// ── Mod ──────────────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vigia',
      description: 'Abrir el panel de consumo (limite, contexto, quien gasta, coste)',
    })
    try {
      $.ui.status(etiquetaEstado(await $.session.usage()))
    } catch {
      $.ui.status('🔭 Vigía · listo')
    }
    return next(e)
  })

  // Acumula tokens por modelo y refresca la barra de estado.
  on('turn.complete', async ($, e, next) => {
    try {
      if (e.usage) {
        const u = e.usage
        const tok =
          u.input_tokens +
          u.output_tokens +
          u.cache_read_input_tokens +
          u.cache_creation_input_tokens
        const fam = familia(u.model)
        await update($, gasto, g => ({ ...g, [fam]: (g[fam] ?? 0) + tok }))
      }
      $.ui.status(etiquetaEstado(await $.session.usage()))
    } catch {
      /* medir es opcional */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'vigia' }, async $ => {
    await $.ui.open({ id: PANEL, title: 'El Vigía · consumo' })
    return { text: '🔭 Panel de El Vigía abierto.' }
  })

  // El panel en vivo.
  on('ui.render', { component: 'Pane', requestId: PANEL }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    let us: SessionUsage
    try {
      us = await $.session.usage()
    } catch {
      return (
        <Box flexDirection="column">
          <Text>🔭 EL VIGÍA</Text>
          <Text dimColor>No puedo leer el consumo ahora mismo.</Text>
        </Box>
      )
    }

    const g = await read($, gasto)
    const familias = Object.entries(g).sort((a, b) => b[1] - a[1])
    const maxTok = familias[0]?.[1] ?? 0

    const limites = us.rateLimits
      .slice()
      .sort((a, b) => (a.kind === 'seven_day' ? -1 : 1))

    const ctxTok = us.context.tokens ?? 0
    const ctxWin = us.context.window ?? 0
    const ctxPct = Math.round(us.context.percent ?? 0)
    const coste = us.cost?.usd

    return (
      <Box flexDirection="column">
        <Text>🔭 EL VIGÍA · tu Claude ahora mismo</Text>
        <Text> </Text>

        <Text>TU LÍMITE</Text>
        {limites.length === 0 && <Text dimColor>  (sin datos de límite)</Text>}
        {limites.map(r => (
          <Text>
            {'  '}
            {(LABEL_LIMITE[r.kind] ?? r.kind).padEnd(8)} {barra(r.percentUsed)}{' '}
            {Math.round(r.percentUsed)}% · se renueva {fechaCorta(r.resetsAt)}
          </Text>
        ))}
        <Text> </Text>

        <Text>CONTEXTO</Text>
        <Text>
          {'  '}
          {barra(ctxPct)} {formatK(ctxTok)} / {ctxWin ? formatK(ctxWin) : '?'} ({ctxPct}%)
        </Text>
        <Text> </Text>

        <Text>QUIÉN GASTA (esta sesión)</Text>
        {familias.length === 0 && <Text dimColor>  (aún nada medido)</Text>}
        {familias.map(([fam, tok]) => (
          <Text>
            {'  '}
            {fam.padEnd(8)} {formatK(tok).padStart(6)} {barra(maxTok ? (tok / maxTok) * 100 : 0)}
          </Text>
        ))}
        <Text> </Text>

        <Text>
          COSTE si pagaras por API: {coste === undefined ? 'n/d' : `$${coste.toFixed(2)}`}
        </Text>
      </Box>
    )
  })
}
