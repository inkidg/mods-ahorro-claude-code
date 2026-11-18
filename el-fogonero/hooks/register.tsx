import { atom, read, update } from 'claude-code'
import type { Register, StateDollar, Timer } from 'claude-code'

// ───────────────────────────────────────────────────────────────────────────
// EL FOGONERO  (equivalente a "el termo" del video)
//
// Claude guarda tu conversacion unos minutos en cache. Si te vas y vuelves
// tarde, tu siguiente mensaje la manda entera otra vez y gasta un monton de
// tokens. El Fogonero:
//   • mide cuanto contexto se reenviaria (tras cada turno),
//   • te AVISA ~1 minuto antes de que la cache se enfrie (temporizador),
//   • te dice cuantos tokens releeria tu proximo mensaje si la dejas enfriar.
//
// Comandos:
//   /fogonero          -> informe de la temperatura
//   /fogonero 5        -> cuenta la cache como de 5 min
//   /fogonero 60       -> cuenta la cache como de 60 min (1 h)
//   /fogonero freno    -> silencia/reactiva los avisos
// ───────────────────────────────────────────────────────────────────────────

const RATE_USD_POR_MTOK = 1.25 // coste aprox de re-escribir 1M tokens en cache (ajustable)

type Brasa = { tokens: number; ultimoTurno: number; modelo: string }
type Ajustes = { ttlMin: number; freno: boolean }

const brasa = atom(
  { plugin: 'el-fogonero', key: 'brasa' } as const,
  { tokens: 0, ultimoTurno: 0, modelo: '' } as Brasa,
)
const ajustes = atom(
  { plugin: 'el-fogonero', key: 'ajustes' } as const,
  { ttlMin: 5, freno: false } as Ajustes,
)

// Temporizador del aviso "un minuto antes" (se reinicia cada turno).
let temporizador: Timer | null = null

// ── Formateo ────────────────────────────────────────────────────────────────
const miles = (n: number) =>
  Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')

const usd = (tok: number) => ((tok / 1_000_000) * RATE_USD_POR_MTOK).toFixed(2)

const mmss = (seg: number) => {
  const s = Math.max(0, Math.round(seg))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

async function temperatura($: StateDollar, now: number) {
  const b = await read($, brasa)
  const a = await read($, ajustes)
  const ttlSeg = a.ttlMin * 60
  const hayDatos = b.ultimoTurno > 0 && b.tokens > 0
  const edad = (now - b.ultimoTurno) / 1000
  const restante = ttlSeg - edad
  const caliente = restante > 0
  return { b, hayDatos, edad, restante, caliente, ttlMin: a.ttlMin, freno: a.freno }
}

// ── Mod ──────────────────────────────────────────────────────────────────────
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'fogonero',
      description: 'Temperatura de la cache y coste de recalentarla',
      argumentHint: '5 | 60 | freno',
    })
    const a = await read($, ajustes)
    $.ui.status(a.freno ? '🔥 Fogonero · freno' : '🔥 Fogonero · listo')
    return next(e)
  })

  // Cada turno del hilo principal: guarda el contexto, actualiza la barra y
  // reprograma el aviso "un minuto antes".
  on('turn.complete', async ($, e, next) => {
    try {
      if (!e.agentId && e.usage) {
        const u = e.usage
        const tokens =
          u.input_tokens +
          u.output_tokens +
          u.cache_read_input_tokens +
          u.cache_creation_input_tokens
        const now = await $.clock.now()
        await update($, brasa, () => ({ tokens, ultimoTurno: now, modelo: u.model }))

        const a = await read($, ajustes)
        $.ui.status(
          a.freno ? '🔥 Fogonero · freno' : `🔥 Fogonero · caliente · ${miles(tokens)} tok`,
        )

        // Reprograma el aviso a (TTL - 1 min). Cada turno reinicia la cuenta.
        temporizador?.cancel()
        temporizador = null
        if (!a.freno) {
          const antelacionMs = Math.max(1000, (a.ttlMin * 60 - 60) * 1000)
          temporizador = $.clock.after(antelacionMs, () => {
            void (async () => {
              try {
                const t = await temperatura($, await $.clock.now())
                if (!t.freno && t.hayDatos && t.caliente && t.restante <= 75) {
                  $.ui.toast(
                    `🔥 El Fogonero: a tu cache le queda ~1 min de calor (~${miles(t.b.tokens)} tok). Escribe ya si no quieres recalentar.`,
                  )
                }
              } catch {
                /* el aviso es opcional */
              }
            })()
          })
        }
      }
    } catch {
      /* medir es opcional: nunca romper el turno */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Justo antes de enviar: si la cache esta fria (y sin freno), avisa del coste.
  on('prompt.submit', async ($, e, next) => {
    try {
      const now = await $.clock.now()
      const { hayDatos, caliente, b, freno } = await temperatura($, now)
      if (!freno && hayDatos && !caliente) {
        $.ui.toast(
          `❄️ El Fogonero: cache fria. Este mensaje recalienta ~${miles(b.tokens)} tokens (~$${usd(b.tokens)}).`,
        )
        $.ui.status(`❄️ Fogonero · fria · ${miles(b.tokens)} tok`)
      }
    } catch {
      /* el aviso es opcional */
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Banda sobre el prompt: solo cuando importa (fria o a punto), y nunca con freno.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const now = await $.clock.now()
    const { hayDatos, caliente, restante, b, freno } = await temperatura($, now)
    if (!hayDatos || freno) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const tok = miles(b.tokens)
    const dolar = usd(b.tokens)

    if (!caliente) {
      return (
        <Box>
          <Text>❄️ </Text>
          <Text>
            Cache fria — tu proximo mensaje recalienta ~{tok} tokens (~${dolar})
          </Text>
        </Box>
      )
    }

    if (restante < 60) {
      return (
        <Box>
          <Text dimColor>
            🔥 Cache caliente — se enfria en {mmss(restante)} ({tok} tok en juego)
          </Text>
        </Box>
      )
    }

    return next(e) // caliente y con margen: no molestar
  })

  on('command.run', { command: 'fogonero' }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()

    // /fogonero freno  -> silencia o reactiva
    if (arg === 'freno') {
      const a = await update($, ajustes, p => ({ ...p, freno: !p.freno }))
      if (a.freno) {
        temporizador?.cancel()
        temporizador = null
      }
      $.ui.status(a.freno ? '🔥 Fogonero · freno' : '🔥 Fogonero · listo')
      return {
        text: a.freno
          ? '🧯 El Fogonero echo el freno: avisos silenciados. Escribe /fogonero freno otra vez para reactivarlos.'
          : '🔥 El Fogonero reactivado: vuelvo a avisarte de la cache.',
      }
    }

    // /fogonero 5  o  /fogonero 60  -> cambia el TTL (en minutos)
    const n = Number.parseInt(arg, 10)
    if (arg !== '' && Number.isFinite(n) && n > 0) {
      const a = await update($, ajustes, p => ({ ...p, ttlMin: n }))
      return {
        text: `🔥 El Fogonero ahora cuenta la cache como de ${a.ttlMin} min. Te avisare ~1 min antes de que se enfrie.`,
      }
    }

    if (arg !== '') {
      return { text: 'Uso: /fogonero · /fogonero 5 · /fogonero 60 · /fogonero freno' }
    }

    // /fogonero  -> informe
    const now = await $.clock.now()
    const { hayDatos, caliente, edad, restante, b, ttlMin, freno } = await temperatura($, now)
    if (!hayDatos) {
      return {
        text:
          '🔥 EL FOGONERO\n' +
          `Aun no hay datos. Cuento la cache como de ${ttlMin} min${freno ? ' (freno puesto)' : ''}.`,
      }
    }
    const estado = caliente
      ? `CALIENTE — se enfria en ${mmss(restante)}`
      : `FRIA — hace ${mmss(edad)} del ultimo turno`
    return {
      text:
        `🔥 EL FOGONERO · temperatura de la cache\n` +
        `• Estado: ${estado}${freno ? ' · 🧯 freno puesto' : ''}\n` +
        `• Contexto en juego: ${miles(b.tokens)} tokens\n` +
        `• Si se enfria, tu proximo mensaje recalienta eso (~$${usd(b.tokens)} aprox)\n` +
        `• Modelo del ultimo turno: ${b.modelo || 'desconocido'}\n` +
        `• Cache contada como de ${ttlMin} min (cambia con /fogonero 5 o /fogonero 60)`,
    }
  })
}
