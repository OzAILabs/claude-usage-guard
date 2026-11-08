import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionRateLimit, ToolCallResult } from 'claude-code'

import type { UsageGuardState, UsageGuardTrip } from '../types'

// Nothing real is ever called here: every tool, send and prompt is answered
// by the test's own hooks, which stand for the engine beneath the plugin.

const NOW = Date.parse('2026-10-29T18:00:00.000Z')
const WEEK_RESET = '2026-10-31T16:59:59.854Z'
const FIVE_RESET = '2026-10-29T20:29:59.854Z'
const FIRST_POLL = 5_000
const POLL = 15 * 60_000
const MAIN = 'local_main'
const STORE_KEY = 'guard-1'
const MGMT = 'mcp__ccd_session_mgmt__'

const START = { cwd: '/', surface: 'desktop', isInteractive: true } as const
const PRESENTATION = { isFullscreen: false, columns: 100 }

const PANE = {
  plugin: 'usage-guard',
  component: 'Pane',
  requestId: 'usage-guard',
  props: {
    title: 'Weekly usage',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

// get_usage's answer, as the desktop app gives it.
function planOf(weekly: number, resetsAt = WEEK_RESET) {
  return {
    plan: {
      status: 'ok',
      plan: 'Max',
      windows: [
        { label: '5-hour limit', percentUsed: 24, resetsAt: FIVE_RESET, resetsIn: '2h 29m' },
        { label: 'Weekly · all models', percentUsed: weekly, resetsAt, resetsIn: '1d 22h' },
        { label: 'Weekly · Fable', percentUsed: 3, resetsAt: '2026-10-31T17:00:00.000Z', resetsIn: '1d 23h' },
      ],
    },
    // This session's context window: never the account's weekly figure.
    context: { session: 'self', status: 'ok', percentUsed: 90 },
  }
}

// list_sessions {linked: true}: two workers this session started, one a worker
// started, and one of another starter (left alone).
const SESSIONS = [
  { sessionId: 'local_a', title: 'Docs writer', name: 'docs', isRunning: true, startedBy: MAIN },
  { sessionId: 'local_b', title: 'Test runner', name: 'tests', isRunning: true, startedBy: MAIN },
  { sessionId: 'local_c', title: 'Docs helper', isRunning: false, startedBy: 'local_a' },
  { sessionId: 'local_x', title: 'Not ours', isRunning: true, startedBy: 'local_someone_else' },
]

type Options = {
  usage?: () => unknown
  failStop?: Set<string>
  store?: Record<string, unknown>
  rateLimits?: SessionRateLimit[]
}

function world(on: On, options: Options = {}) {
  const calls: { tool: string; input: Record<string, unknown> }[] = []
  const events: string[] = []
  const sends: { to: string; text: string }[] = []
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const saved: Record<string, unknown> = {}
  const failStop = options.failStop ?? new Set<string>()
  let isSavedBeforeList: boolean | undefined

  // The store, in memory: `saved` holds only what the plugin wrote, so a test
  // tells a write from a value it seeded.
  const stored: Record<string, unknown> = { ...options.store }
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = JSON.parse(JSON.stringify(e.value))
    saved[e.key] = stored[e.key]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(stored) }))
  on('store.delete', (_, e) => {
    delete stored[e.key]
    return { value: undefined }
  })
  const clock = mock.clock(on, { now: NOW })
  const session = mock.session(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => ({
    value: { startedAt: NOW, context: { window: 1_000_000 }, rateLimits: options.rateLimits ?? [] },
  }))
  on('command.register', () => ({ value: { command: 'usage-guard' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', () => ({ value: { isSent: false, reason: 'no-surface' } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.send', (_, e) => {
    sends.push({ to: e.to, text: e.text })
    events.push(`send:${e.to}`)
    return { isDelivered: true }
  })
  on('prompt.submit', (_, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('tool.call', (_, e) => {
    const input = { ...(e as unknown as Record<string, unknown>) }
    delete input.tool
    delete input.tool_use_id
    const tool = String(e.tool)
    calls.push({ tool, input })
    events.push(`${tool.replace(MGMT, '')}:${String(input.session_id ?? '')}`)
    switch (tool) {
      case `${MGMT}get_usage`: {
        const usage = options.usage?.() ?? planOf(45)
        return usage instanceof Error ? answer(usage.message, true) : answer(usage)
      }
      case `${MGMT}get_session`:
        return answer({ sessionId: MAIN, title: 'Main' })
      case `${MGMT}list_sessions`:
        // Whether the trip was already saved when the first session was touched.
        isSavedBeforeList ??= (stored[STORE_KEY] as UsageGuardState | undefined)?.trip != null
        return answer(SESSIONS)
      case `${MGMT}stop_session`:
        return failStop.has(String(input.session_id))
          ? answer('stop failed: the socket closed', true)
          : answer('Stopped the turn.')
      case `${MGMT}send_message`:
        return answer('ok (delivery: queued; message_id: m1)')
      default:
        return answer(`unexpected tool ${tool}`, true)
    }
  })

  const tools = () => calls.map(call => call.tool.replace(MGMT, ''))
  const guard = () => saved[STORE_KEY] as UsageGuardState | undefined

  const savedBeforeList = () => isSavedBeforeList

  return { calls, events, sends, prompts, statuses, toasts, clock, session, tools, guard, savedBeforeList }
}

// An MCP tool's answer as core relays one: the text the model reads, and
// the content blocks.
function answer(value: unknown, isError = false): ToolCallResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return isError ? { isError: true, result: text, text } : { result: { content: [{ type: 'text', text }] }, text }
}

function command(args: string) {
  return { command: 'usage-guard', args, origin: { kind: 'composer' }, presentation: PRESENTATION } as const
}

function tripOf(weekResetsAt: string): UsageGuardTrip {
  return {
    weekResetsAt,
    trippedAt: NOW - 3_600_000,
    percent: 81,
    threshold: 80,
    isListed: true,
    workers: [],
    attempts: 1,
    isComplete: true,
    isLeadTold: true,
    errors: [],
  }
}

function guardOf(change: Partial<UsageGuardState>): UsageGuardState {
  return { threshold: 80, mode: 'armed', trip: null, history: [], lastDryRun: null, ...change }
}

test('the weekly reading is seeded from $.session.usage and then taken from session.measure', async ($, on) => {
  const w = world(on, { rateLimits: [{ kind: 'seven_day', percentUsed: 30, resetsAt: WEEK_RESET }] })

  await $.session.start(START)
  expect(w.statuses.at(-1)).toBe('Week 30% · 5h ?')

  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 45, resetsAt: WEEK_RESET },
      { kind: 'five_hour', percentUsed: 24, resetsAt: FIVE_RESET },
    ],
    changed: ['rateLimits'],
  })
  await w.clock.settle()

  expect(w.statuses.at(-1)).toBe('Week 45% · 5h 24%')
  expect(w.tools()).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Week, all models$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /45%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /armed at 80%/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the weekly reading is parsed from get_usage, never from the context window', async ($, on) => {
  const w = world(on)

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)

  expect(w.tools()).toEqual(['get_usage'])
  expect(w.calls[0]?.input).toEqual({})
  expect(w.statuses.at(-1)).toBe('Week 45% · 5h 24%')
  expect(w.sends).toEqual([])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Fable: 3%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets Sat 31 Oct 16:59Z/ })).toBeDefined()
    await ui.unmount()
  }
})

test('at the threshold it stops each linked worker, then sends each the hold message', async ($, on) => {
  const w = world(on, { usage: () => planOf(80) })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)

  // Listed, stopped (all three before any message), then messaged.
  expect(w.events).toEqual([
    'get_usage:',
    'get_session:self',
    'list_sessions:',
    'stop_session:local_a',
    'stop_session:local_b',
    'stop_session:local_c',
    'send:local_a',
    'send:local_b',
    'send:local_c',
  ])
  expect(w.calls[2]?.input).toEqual({ linked: true, limit: 100 })
  expect(w.sends[0]?.text).toBe(
    'PAUSED by the usage guard: weekly usage at 80% (threshold 80%). Hold: start no new work, ' +
      'leave files consistent, note where you stopped, and end your turn. ' +
      'Resume only when the session that started you or the user says resume.',
  )

  // This session is told, once, by prompt and by a row a running turn reads.
  expect(w.prompts).toEqual([
    'USAGE GUARD TRIPPED at 80% weekly: workers paused [Docs writer (docs), Test runner (tests), Docs helper]. ' +
      'Stop running workflows (TaskStop), start no new work, report to the user, and wait for their word to resume.',
  ])
  expect(w.session.appended()).toHaveLength(1)
  expect(w.toasts).toEqual(['Usage guard tripped at 80% weekly: paused 3 workers.'])
  expect(w.statuses.at(-1)).toBe('Week 80% · 5h 24% · guard TRIPPED')

  // The record: saved before any session was touched, then filled in with
  // the week's key, the sessions and what was done to each.
  expect(w.savedBeforeList()).toBe(true)
  const trip = w.guard()?.trip
  expect(trip?.weekResetsAt).toBe(WEEK_RESET)
  expect(trip?.trippedAt).toBe(NOW + FIRST_POLL)
  expect(trip?.isComplete).toBe(true)
  expect(trip?.workers.map(one => [one.sessionId, one.title, one.stop, one.message])).toEqual([
    ['local_a', 'Docs writer', 'done', 'done'],
    ['local_b', 'Test runner', 'done', 'done'],
    ['local_c', 'Docs helper', 'done', 'done'],
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /tripped at 18:00Z at 80%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Test runner/ })).toBeDefined()
    await ui.unmount()
  }
})

test('it trips once a week: later readings above the threshold do nothing', async ($, on) => {
  let weekly = 80
  const w = world(on, { usage: () => planOf(weekly) })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)
  expect(w.sends).toHaveLength(3)

  weekly = 92
  await w.clock.advance(POLL * 3)

  expect(w.tools().filter(tool => tool !== 'get_usage')).toEqual([
    'get_session',
    'list_sessions',
    'stop_session',
    'stop_session',
    'stop_session',
  ])
  expect(w.sends).toHaveLength(3)
  expect(w.prompts).toHaveLength(1)
})

test('a trip saved for this week holds after a reload or restart', async ($, on) => {
  const w = world(on, {
    usage: () => planOf(95),
    store: { [STORE_KEY]: guardOf({ trip: tripOf(WEEK_RESET) }) },
  })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL + POLL)

  expect(w.tools()).toEqual(['get_usage', 'get_usage'])
  expect(w.sends).toEqual([])
  expect(w.prompts).toEqual([])
})

test('it re-arms when the weekly window resets, then trips again in the new week', async ($, on) => {
  const soon = new Date(NOW + 30 * 60_000).toISOString()
  const nextWeek = new Date(NOW + 7 * 24 * 3_600_000).toISOString()
  let usage = planOf(85, soon)
  const w = world(on, {
    usage: () => usage,
    store: { [STORE_KEY]: guardOf({ trip: tripOf(soon) }) },
  })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)
  expect(w.guard()).toBeUndefined()

  // The window resets: the new week reads low, and the guard re-arms.
  usage = planOf(2, nextWeek)
  await w.clock.advance(30 * 60_000)

  expect(w.guard()?.trip).toBeNull()
  expect(w.guard()?.history).toHaveLength(1)
  expect(w.sends).toEqual([])
  expect(w.statuses.at(-1)).toBe('Week 2% · 5h 24%')

  // A new week at the threshold trips it once more.
  usage = planOf(81, nextWeek)
  await w.clock.advance(POLL)

  expect(w.guard()?.trip?.weekResetsAt).toBe(nextWeek)
  expect(w.sends.map(one => one.to)).toEqual(['local_a', 'local_b', 'local_c'])
})

test('a usage reset under the same resetsAt re-arms it, and it trips again at the threshold', async ($, on) => {
  let weekly = 96
  const w = world(on, {
    usage: () => planOf(weekly),
    store: { [STORE_KEY]: guardOf({ trip: tripOf(WEEK_RESET) }) },
  })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)
  expect(w.guard()).toBeUndefined()

  // The plan's usage is reset: same resetsAt, far lower figure.
  weekly = 2
  await w.clock.advance(POLL)
  expect(w.guard()?.trip).toBeNull()
  expect(w.guard()?.history).toHaveLength(1)
  expect(w.sends).toEqual([])
  expect(w.statuses.at(-1)).toBe('Week 2% · 5h 24%')

  // It climbs back: below the threshold nothing happens, and at it the guard trips once.
  weekly = 79
  await w.clock.advance(POLL)
  expect(w.sends).toEqual([])
  weekly = 80
  await w.clock.advance(POLL)
  expect(w.guard()?.trip?.percent).toBe(80)
  expect(w.sends.map(one => one.to)).toEqual(['local_a', 'local_b', 'local_c'])
})

test('a small dip under the same resetsAt keeps the highest figure and the trip', async ($, on) => {
  let weekly = 85
  const w = world(on, {
    usage: () => planOf(weekly),
    store: { [STORE_KEY]: guardOf({ trip: tripOf(WEEK_RESET) }) },
  })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)

  weekly = 70
  await w.clock.advance(POLL)
  expect(w.guard()).toBeUndefined()
  expect(w.statuses.at(-1)).toMatch(/^Week 85%/)
})

test('rearm clears a trip by hand, and refuses while the reading is at or above the threshold', async ($, on) => {
  let weekly = 85
  const w = world(on, {
    usage: () => planOf(weekly),
    store: { [STORE_KEY]: guardOf({ trip: tripOf(WEEK_RESET) }) },
  })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)

  const refused = await $.command.run(command('rearm'))
  expect(refused.text).toMatch(/^Not re-armed: weekly is at 85%/)
  expect(w.guard()).toBeUndefined()

  const raised = await $.command.run(command('threshold 90'))
  expect(raised.text).toMatch(/^Threshold set to 90% \(saved\)/)
  expect(w.guard()?.threshold).toBe(90)

  const rearmed = await $.command.run(command('rearm'))
  expect(rearmed.text).toMatch(/^Armed at 90%/)
  expect(w.guard()?.trip).toBeNull()

  weekly = 89
  await w.clock.advance(POLL)
  expect(w.sends).toEqual([])
})

test('dryrun lists exactly the sessions it would stop and calls neither stop nor message', async ($, on) => {
  const w = world(on, { usage: () => planOf(95) })

  await $.session.start(START)
  const ran = await $.command.run(command('dryrun'))

  expect(ran.text).toBe(
    [
      'Dry run (nothing was stopped or messaged): the guard would stop, then message, 3 sessions.',
      '- Docs writer [docs] local_a (running)',
      '- Test runner [tests] local_b (running)',
      '- Docs helper local_c (idle)',
    ].join('\n'),
  )
  expect(w.tools()).toEqual(['get_session', 'list_sessions'])
  expect(w.sends).toEqual([])
  expect(w.prompts).toEqual([])
  expect(w.guard()?.lastDryRun?.sessions.map(one => one.sessionId)).toEqual(['local_a', 'local_b', 'local_c'])
  expect(w.guard()?.trip).toBeNull()
})

test('a missing reading never trips: plan limits unavailable, or no reset time', async ($, on) => {
  const w = world(on, { usage: () => ({ plan: { status: 'unavailable', note: 'try later' } }) })

  await $.session.start(START)
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 95 }],
    changed: ['rateLimits'],
  })
  await w.clock.advance(FIRST_POLL + POLL)

  expect(w.tools()).toEqual(['get_usage', 'get_usage'])
  expect(w.sends).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /no reset time/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Plan limits: unavailable/ })).toBeDefined()
  await ui.unmount()
})

test('a stale reading never trips, nor one of a week already reset', async ($, on) => {
  const w = world(on, {
    usage: () => new Error('get_usage is down'),
    store: { [STORE_KEY]: guardOf({ threshold: 99 }) },
  })

  await $.session.start(START)
  // A week that reset an hour ago, at 99.5% (over the threshold): not usable.
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 99.5, resetsAt: new Date(NOW - 3_600_000).toISOString() }],
    changed: ['rateLimits'],
  })
  await w.clock.settle()
  // A fresh reading at 95%, under the threshold of 99 ...
  await $.session.measure({
    context: { window: 1_000_000 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 95, resetsAt: WEEK_RESET }],
    changed: ['rateLimits'],
  })
  await w.clock.settle()

  // ... grows stale while get_usage fails, then the threshold drops under it.
  await w.clock.advance(35 * 60_000)
  await $.command.run(command('threshold 90'))
  await w.clock.advance(POLL)

  expect(w.tools().every(tool => tool === 'get_usage')).toBe(true)
  expect(w.sends).toEqual([])

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /stale/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /get_usage failed/ })).toBeDefined()
  await ui.unmount()
})

test('a failed stop is logged, never thrown, and retried at the next reading', async ($, on) => {
  const failStop = new Set(['local_b'])
  const w = world(on, { usage: () => planOf(83), failStop })

  await $.session.start(START)
  await w.clock.advance(FIRST_POLL)

  expect(w.sends.map(one => one.to)).toEqual(['local_a', 'local_b', 'local_c'])
  expect(w.prompts[0]).toMatch(/Not done yet \(the guard retries at each reading\): stop Test runner: stop failed/)
  expect(w.guard()?.trip?.isComplete).toBe(false)

  failStop.clear()
  await w.clock.advance(POLL)

  expect(w.events.slice(-2)).toEqual(['get_usage:', 'stop_session:local_b'])
  expect(w.sends).toHaveLength(3)
  expect(w.prompts).toHaveLength(1)
  expect(w.guard()?.trip?.isComplete).toBe(true)
})
