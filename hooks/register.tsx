// usage-guard: shows the account's usage for the week, and pauses this
// session's workers when the weekly all-models window reaches a threshold.
//
// Readings come from three places; within one weekly window the highest
// figure stands (usage only grows inside a window), and a newer window wins:
//   - `session.measure`, pushed by the engine when a rate-limit window moves
//     (rateLimits kind 'seven_day' and 'five_hour');
//   - `$.session.usage()`, read once at session.start to seed the figures;
//   - the desktop app's get_usage tool, polled every 15 minutes so the figures
//     stay current while this session is idle (the per-model weekly windows
//     come only from there).
//
// The guard trips once per weekly window. The trip is saved in $.store,
// keyed by that window's resetsAt, BEFORE any session is touched, so a reload
// or a restart never trips twice. It re-arms when that resetsAt passes, when
// the usage is reset under the same resetsAt (a figure RESET_DROP or more below
// the last), or with `/usage-guard rearm`. A missing or stale reading never trips it. A
// failed tool call is logged in the pane and retried at the next reading.

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  McpToolName,
  Register,
  SessionRateLimit,
} from 'claude-code'

import type {
  UsageGuardDryRun,
  UsageGuardLogLine,
  UsageGuardSession,
  UsageGuardState,
  UsageGuardTrip,
  UsageGuardUsage,
  UsageGuardWindow,
  UsageGuardWorker,
} from '../types'

const PANE = 'usage-guard'
const STORE_KEY = 'guard-1'

const DEFAULT_THRESHOLD = 80
// Every 15 minutes: session.measure already pushes the weekly figure after each
// turn, so the poll only covers idle stretches and the per-model windows, and
// each poll is a tool call in this session's transcript.
const POLL_MS = 15 * 60_000
const FIRST_POLL_MS = 5_000
// A weekly figure older than this is stale: it never trips the guard (two
// missed polls).
const STALE_MS = 30 * 60_000
// Within this much of the window's reset a figure belongs to a week that is
// ending: it never trips the guard (so a figure of the old week read just
// after the reset cannot trip the new one).
const RESET_MARGIN_MS = 10 * 60_000
// Runs of a trip whose steps keep failing, the first included (one a reading).
const MAX_ATTEMPTS = 6
const LOG_LINES = 30
const HISTORY = 10
// A plan reset can zero the usage while leaving the window's resetsAt alone.
// A weekly figure this many points below the last one can only be that, since
// usage only grows inside a window: it replaces the figure and re-arms a trip.
const RESET_DROP = 20

const WEEKLY_LABEL = 'Weekly · all models'
const FIVE_HOUR_LABEL = '5-hour limit'

const GET_USAGE: McpToolName = 'mcp__ccd_session_mgmt__get_usage'
const GET_SESSION: McpToolName = 'mcp__ccd_session_mgmt__get_session'
const LIST_SESSIONS: McpToolName = 'mcp__ccd_session_mgmt__list_sessions'
const STOP_SESSION: McpToolName = 'mcp__ccd_session_mgmt__stop_session'
const SEND_MESSAGE: McpToolName = 'mcp__ccd_session_mgmt__send_message'

const DEFAULT_GUARD: UsageGuardState = {
  threshold: DEFAULT_THRESHOLD,
  mode: 'armed',
  trip: null,
  history: [],
  lastDryRun: null,
}
const EMPTY_USAGE: UsageGuardUsage = { weekly: null, fiveHour: null, models: [] }

// What the pane draws. Change a tag when its value's fields change: it
// declines what an earlier version stored, which outlives a reload.
const usageAtom = atom({ plugin: 'usage-guard', key: 'usage' } as const, EMPTY_USAGE, {
  shape: 'usage-1',
})
const guardAtom = atom({ plugin: 'usage-guard', key: 'guard' } as const, DEFAULT_GUARD, {
  shape: 'guard-1',
})
const logAtom = atom({ plugin: 'usage-guard', key: 'log' } as const, [] as UsageGuardLogLine[], {
  shape: 'log-1',
})

type $ = EngineInterface

// The module's own copy of the guard and the figures: the source of truth
// for the logic, loaded from $.store (and $.state) once per load, written
// through to both on every change.
let guardNow: UsageGuardState = DEFAULT_GUARD
let usageNow: UsageGuardUsage = EMPTY_USAGE
let loading: Promise<void> | undefined
let isBusy = false
let poller: { cancel: () => void } | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await ensureLoaded($)
    await $.command.register({
      name: 'usage-guard',
      description: 'Weekly usage and the usage guard: status | rearm | disarm | dryrun | threshold <n>',
      argumentHint: '[status|rearm|disarm|dryrun|threshold <n>]',
    })

    // Seed from the status line's figures, then poll get_usage.
    try {
      const seeded = await $.session.usage()
      await intake($, fromRateLimits(seeded.rateLimits, 'seed', await $.clock.now()))
    } catch (err) {
      await note($, `could not read $.session.usage(): ${errorText(err)}`)
    }
    poller?.cancel()
    const every = $.clock.every(POLL_MS, () => void tick($))
    const first = $.clock.after(FIRST_POLL_MS, () => void tick($))
    poller = { cancel: () => (every.cancel(), first.cancel()) }

    void $.ui.open({ id: PANE, title: 'Weekly usage' })

    return next(e)
  })

  // Pushed figures: record them now, judge them in a dispatch of their own.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.rateLimits.length > 0) {
        await ensureLoaded($)
        await intake($, fromRateLimits(e.rateLimits, 'measure', await $.clock.now()))
        $.clock.after(0, () => void evaluate($))
      }
    } catch (err) {
      $.ui.log(`usage-guard: measure: ${errorText(err)}`, { to: 'debug' })
    }

    return next(e)
  })

  on('command.run', { command: 'usage-guard' }, async ($, e) => {
    await ensureLoaded($)

    return { text: await runCommand($, e.args) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const usage = await read($, usageAtom)
    const guard = await read($, guardAtom)
    const lines = await read($, logAtom)
    const now = await $.clock.now()
    const width = Math.max(10, Math.min(40, e.props.bodyColumns - 12))
    const weekly = usage.weekly
    const problem = weeklyProblem(weekly, now)
    const trip = guard.trip

    return (
      <Box flexDirection="column">
        <Text bold>Week, all models</Text>
        {weekly === null ? (
          <Text dimColor>No weekly reading yet.</Text>
        ) : (
          <Box flexDirection="column">
            <Text>
              <Text color={tone(weekly.percentUsed, guard.threshold)}>{bar(weekly.percentUsed, width)}</Text>{' '}
              <Text bold>{pct(weekly.percentUsed)}</Text>
            </Text>
            <Text dimColor>
              {resetText(weekly, now)} · read {ago(now - weekly.at)} by {weekly.source}
            </Text>
            {problem !== undefined && <Text color="warning">Not usable to trip: {problem}.</Text>}
          </Box>
        )}

        <Text> </Text>
        <Text bold>5-hour window</Text>
        {usage.fiveHour === null ? (
          <Text dimColor>No 5-hour reading yet.</Text>
        ) : (
          <Text>
            <Text color={tone(usage.fiveHour.percentUsed, 90)}>{bar(usage.fiveHour.percentUsed, width)}</Text>{' '}
            {pct(usage.fiveHour.percentUsed)} <Text dimColor>{resetText(usage.fiveHour, now)}</Text>
          </Text>
        )}

        {usage.models.length > 0 && <Text> </Text>}
        {usage.models.length > 0 && <Text bold>Per model, weekly</Text>}
        {usage.models.map(model => (
          <Text>
            {model.label.replace(/^weekly\s*·\s*/i, '')}: {pct(model.percentUsed)}{' '}
            <Text dimColor>{resetText(model, now)}</Text>
          </Text>
        ))}
        {usage.planStatus !== undefined && <Text dimColor>Plan limits: {usage.planStatus}.</Text>}

        <Text> </Text>
        <Text bold>Guard</Text>
        <Text color={trip !== null ? 'error' : guard.mode === 'armed' ? 'success' : 'warning'}>
          {guardLine(guard)}
        </Text>
        <Text dimColor>/usage-guard status | rearm | disarm | dryrun | threshold &lt;n&gt;</Text>

        {trip !== null && <Text> </Text>}
        {trip !== null && <Text bold>Workers the guard paused ({trip.workers.length})</Text>}
        {trip !== null && !trip.isListed && <Text color="warning">The worker list has not been read yet.</Text>}
        {trip?.workers.map(worker => (
          <Text>
            {worker.stop === 'done' && worker.message === 'done' ? 'ok ' : '!! '}
            {worker.title} <Text dimColor>stop {worker.stop} · message {worker.message}</Text>
          </Text>
        ))}

        {guard.lastDryRun !== null && <Text> </Text>}
        {guard.lastDryRun !== null && <Text bold>Dry run at {clockTime(guard.lastDryRun.at)}</Text>}
        {guard.lastDryRun !== null && <Text dimColor>{dryRunSummary(guard.lastDryRun)}</Text>}
        {guard.lastDryRun?.sessions.map(session => (
          <Text dimColor>  would stop: {session.title}</Text>
        ))}

        {lines.length > 0 && <Text> </Text>}
        {lines.length > 0 && <Text bold>Log</Text>}
        {lines.slice(-8).map(line => (
          <Text dimColor>
            {clockTime(line.at)} {line.text}
            {(line.count ?? 1) > 1 ? ` (x${line.count})` : ''}
          </Text>
        ))}
      </Box>
    )
  })
}

// ---------------------------------------------------------------- loading

async function ensureLoaded($: $): Promise<void> {
  loading ??= (async () => {
    const saved = await $.store.get(STORE_KEY)
    guardNow = isGuardState(saved) ? saved : DEFAULT_GUARD
    // The figures outlive a reload in $.state; a fresh process starts empty.
    usageNow = await read($, usageAtom)
    await update($, guardAtom, () => guardNow)
    refreshStatus($)
  })()
  try {
    await loading
  } catch (err) {
    loading = undefined
    throw err
  }
}

async function commitGuard($: $, next: UsageGuardState): Promise<void> {
  guardNow = next
  await update($, guardAtom, () => next)
  await $.store.set(STORE_KEY, next)
  refreshStatus($)
}

async function note($: $, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, logAtom, lines => {
    const last = lines[lines.length - 1]
    // A line said again (a poll failing every five minutes) is counted, not repeated.
    if (last !== undefined && last.text === text) {
      return [...lines.slice(0, -1), { at, text, count: (last.count ?? 1) + 1 }]
    }
    return [...lines, { at, text }].slice(-LOG_LINES)
  })
  $.ui.log(`usage-guard: ${text}`, { to: 'debug' })
}

// ---------------------------------------------------------------- readings

type Intake = Partial<Pick<UsageGuardUsage, 'weekly' | 'fiveHour' | 'models' | 'planStatus'>>

function fromRateLimits(limits: readonly SessionRateLimit[], source: 'measure' | 'seed', at: number): Intake {
  const windowOf = (kind: string, label: string): UsageGuardWindow | undefined => {
    const limit = limits.find(one => one.kind === kind)
    return limit !== undefined && isPercent(limit.percentUsed)
      ? { label, percentUsed: limit.percentUsed, resetsAt: limit.resetsAt, source, at }
      : undefined
  }
  const weekly = windowOf('seven_day', WEEKLY_LABEL)
  const fiveHour = windowOf('five_hour', FIVE_HOUR_LABEL)

  return { ...(weekly && { weekly }), ...(fiveHour && { fiveHour }) }
}

// get_usage answers { plan: { status, windows: [{ label, percentUsed,
// resetsAt, resetsIn }] }, context }. Only plan.windows is read: the
// context window's percentUsed is this session's, never the account's.
function fromGetUsage(value: unknown, at: number): { intake: Intake } | { problem: string; intake: Intake } {
  const plan = isObject(value) && isObject(value.plan) ? value.plan : undefined
  if (plan === undefined) {
    return { problem: 'get_usage answered no plan', intake: {} }
  }
  if (plan.status !== 'ok') {
    // 'unavailable' or 'not_applicable': no figures, only the status to show.
    return { problem: `plan limits ${String(plan.status)}`, intake: { planStatus: String(plan.status) } }
  }
  const intake: Intake = { models: [], planStatus: undefined }
  for (const one of Array.isArray(plan.windows) ? plan.windows : []) {
    if (!isObject(one) || typeof one.label !== 'string' || !isPercent(one.percentUsed)) {
      continue
    }
    const window: UsageGuardWindow = {
      label: one.label,
      percentUsed: one.percentUsed,
      resetsAt: typeof one.resetsAt === 'string' ? one.resetsAt : undefined,
      source: 'poll',
      at,
    }
    if (/^5-hour/i.test(one.label)) {
      intake.fiveHour = window
    } else if (/^weekly/i.test(one.label) && /all models/i.test(one.label)) {
      intake.weekly = window
    } else if (/^weekly/i.test(one.label)) {
      intake.models?.push(window)
    }
  }

  return { intake }
}

async function intake($: $, incoming: Intake): Promise<void> {
  usageNow = {
    weekly: mergeWindow(usageNow.weekly, incoming.weekly, true),
    fiveHour: mergeWindow(usageNow.fiveHour, incoming.fiveHour, false),
    models: incoming.models ?? usageNow.models,
    planStatus: 'planStatus' in incoming ? incoming.planStatus : usageNow.planStatus,
  }
  await update($, usageAtom, () => usageNow)
  refreshStatus($)
}

// Inside one window (the same reset, to the hour) the higher weekly figure
// stands, read at the later time; a window that resets later replaces it.
function mergeWindow(
  current: UsageGuardWindow | null,
  incoming: UsageGuardWindow | null | undefined,
  keepsHighest: boolean,
): UsageGuardWindow | null {
  if (incoming === undefined || incoming === null) return current
  if (current === null) return incoming
  const isSameWindow = incoming.resetsAt === undefined || isSameReset(current.resetsAt, incoming.resetsAt)
  if (!isSameWindow) {
    return (ms(incoming.resetsAt) ?? 0) >= (ms(current.resetsAt) ?? 0) ? incoming : current
  }

  const isPlanReset = current.percentUsed - incoming.percentUsed >= RESET_DROP
  return {
    ...incoming,
    percentUsed:
      keepsHighest && !isPlanReset ? Math.max(current.percentUsed, incoming.percentUsed) : incoming.percentUsed,
    resetsAt: incoming.resetsAt ?? current.resetsAt,
    at: Math.max(current.at, incoming.at),
  }
}

// Why the weekly figure may not trip the guard, or undefined when it may.
function weeklyProblem(weekly: UsageGuardWindow | null, now: number): string | undefined {
  if (weekly === null) return 'no weekly reading yet'
  if (!isPercent(weekly.percentUsed)) return 'the weekly reading has no percent'
  const resets = ms(weekly.resetsAt)
  if (resets === undefined) return 'the weekly reading has no reset time'
  if (resets - now <= RESET_MARGIN_MS) return 'its weekly window has reset or is about to'
  if (now - weekly.at > STALE_MS) return `the weekly reading is stale (${ago(now - weekly.at)} old)`
  return undefined
}

// ---------------------------------------------------------------- polling

async function tick($: $): Promise<void> {
  try {
    await ensureLoaded($)
    const now = await $.clock.now()
    const called = await callTool($, GET_USAGE, {})
    if (!called.ok) {
      await note($, `get_usage failed: ${called.error}`)
    } else {
      const parsed = fromGetUsage(called.value, now)
      if ('problem' in parsed) await note($, `get_usage: ${parsed.problem}`)
      await intake($, parsed.intake)
    }
  } catch (err) {
    await note($, `poll error: ${errorText(err)}`).catch(() => undefined)
  }
  // Judge even when the poll failed: a pending trip retries, a week re-arms.
  await evaluate($)
}

// ---------------------------------------------------------------- the guard

async function evaluate($: $): Promise<void> {
  if (isBusy) return
  isBusy = true
  try {
    await ensureLoaded($)
    const now = await $.clock.now()

    // 1. The tripped week has reset: re-arm.
    const tripped = guardNow.trip
    if (tripped !== null && now >= (ms(tripped.weekResetsAt) ?? Infinity)) {
      await commitGuard($, {
        ...guardNow,
        trip: null,
        history: [...guardNow.history, tripped].slice(-HISTORY),
      })
      await note($, 're-armed: the tripped weekly window has reset')
    }

    // 1b. The same window, but the usage was reset under it: re-arm too. Trips
    // that haven't finished stay, so a reset never hides failed steps.
    const held = guardNow.trip
    const reading = usageNow.weekly
    if (
      held !== null &&
      held.isComplete &&
      reading !== null &&
      weeklyProblem(reading, now) === undefined &&
      reading.percentUsed < guardNow.threshold &&
      held.percent - reading.percentUsed >= RESET_DROP
    ) {
      await commitGuard($, {
        ...guardNow,
        trip: null,
        history: [...guardNow.history, held].slice(-HISTORY),
      })
      await note($, `re-armed: weekly usage was reset under the window (${pct(reading.percentUsed)})`)
    }

    // 2. A trip whose steps failed: retry them, whatever the figure now.
    if (guardNow.trip !== null) {
      if (!guardNow.trip.isComplete) await runTrip($, guardNow.trip)
      return
    }

    // 3. Armed, not tripped this week: trip on a usable figure at the threshold.
    const weekly = usageNow.weekly
    if (guardNow.mode !== 'armed' || weekly === null) return
    if (weeklyProblem(weekly, now) !== undefined || weekly.percentUsed < guardNow.threshold) return

    const trip: UsageGuardTrip = {
      weekResetsAt: weekly.resetsAt ?? '',
      trippedAt: now,
      percent: weekly.percentUsed,
      threshold: guardNow.threshold,
      isListed: false,
      workers: [],
      attempts: 0,
      isComplete: false,
      isLeadTold: false,
      errors: [],
    }
    // Saved before any session is touched: a reload never trips twice.
    await commitGuard($, { ...guardNow, trip })
    await note($, `TRIPPED at ${pct(trip.percent)} weekly (threshold ${pct(trip.threshold)})`)
    await runTrip($, trip)
  } catch (err) {
    await note($, `guard error: ${errorText(err)}`).catch(() => undefined)
  } finally {
    isBusy = false
  }
}

// One run of a trip: list the workers, stop each, then message each; the
// steps already done are skipped, so a later reading retries only failures.
async function runTrip($: $, start: UsageGuardTrip): Promise<void> {
  let trip: UsageGuardTrip = { ...start, attempts: start.attempts + 1, errors: [] }
  const save = async () => commitGuard($, { ...guardNow, trip })

  // a. Who are the workers: the sessions this session started (and theirs).
  if (!trip.isListed) {
    const listed = await listWorkers($)
    if (listed.ok) {
      const workers = listed.sessions.map(
        (one): UsageGuardWorker => ({ ...one, stop: 'pending', message: 'pending' }),
      )
      trip = { ...trip, isListed: true, workers }
      if (listed.note !== undefined) await note($, listed.note)
    } else {
      trip = { ...trip, errors: [...trip.errors, `list_sessions: ${listed.error}`] }
      await note($, `could not list the workers: ${listed.error}`)
    }
    await save()
  }

  // b. Stop each one's turn in flight (an idle session is left alone).
  for (const worker of trip.workers) {
    if (worker.stop === 'done') continue
    const stopped = await callTool($, STOP_SESSION, { session_id: worker.sessionId })
    const changed: UsageGuardWorker = stopped.ok
      ? { ...worker, stop: 'done', stopNote: firstLine(stopped.text) }
      : { ...worker, stop: 'failed', stopNote: stopped.error }
    if (!stopped.ok) {
      trip = { ...trip, errors: [...trip.errors, `stop ${worker.title}: ${stopped.error}`] }
      await note($, `stop failed for ${worker.title}: ${stopped.error}`)
    }
    trip = withWorker(trip, changed)
    await save()
  }

  // c. Then the hold message to each.
  const hold = holdMessage(trip)
  for (const worker of trip.workers) {
    if (worker.message === 'done') continue
    const sent = await sendHold($, worker.sessionId, hold)
    const changed: UsageGuardWorker = sent.ok
      ? { ...worker, message: 'done', messageNote: sent.note }
      : { ...worker, message: 'failed', messageNote: sent.error }
    if (!sent.ok) {
      trip = { ...trip, errors: [...trip.errors, `message ${worker.title}: ${sent.error}`] }
      await note($, `hold message failed for ${worker.title}: ${sent.error}`)
    }
    trip = withWorker(trip, changed)
    await save()
  }

  const isDone = trip.isListed && trip.workers.every(one => one.stop === 'done' && one.message === 'done')
  trip = { ...trip, isComplete: isDone || trip.attempts >= MAX_ATTEMPTS }
  if (trip.isComplete && !isDone) {
    await note($, `gave up after ${trip.attempts} runs: ${trip.errors.join('; ')}`)
  }
  if (isDone && start.attempts > 0) {
    await note($, 'every worker is now paused')
  }

  // d. Tell the person and this session, once.
  if (!trip.isLeadTold) {
    trip = { ...trip, isLeadTold: true }
    await save()
    await tellLead($, trip)
  } else {
    await save()
  }
}

async function tellLead($: $, trip: UsageGuardTrip): Promise<void> {
  const paused = trip.workers.filter(one => one.stop === 'done').map(label)
  const failures =
    trip.errors.length > 0
      ? ` Not done yet (the guard retries at each reading): ${trip.errors.join('; ')}.`
      : ''
  const text =
    `USAGE GUARD TRIPPED at ${pct(trip.percent)} weekly: workers paused [${paused.join(', ')}]. ` +
    'Stop running workflows (TaskStop), start no new work, report to the user, ' +
    `and wait for their word to resume.${failures}`

  $.ui.toast(`Usage guard tripped at ${pct(trip.percent)} weekly: paused ${paused.length} workers.`, {
    timeoutMs: 15_000,
  })
  void $.ui.notify(`Weekly usage at ${pct(trip.percent)}: paused ${paused.length} workers.`, {
    title: 'Usage guard',
  }).catch(() => undefined)
  // A row the running turn reads at its next step, if one is running ...
  try {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } catch (err) {
    await note($, `could not append the alert: ${errorText(err)}`)
  }
  // ... and a prompt of its own, which starts a turn once the session is idle.
  void $.prompt.submit({ text }).catch(err => note($, `could not submit the alert: ${errorText(err)}`))
}

function holdMessage(trip: UsageGuardTrip): string {
  return (
    `PAUSED by the usage guard: weekly usage at ${pct(trip.percent)} (threshold ${pct(trip.threshold)}). ` +
    'Hold: start no new work, leave files consistent, note where you stopped, ' +
    'and end your turn. Resume only when the session that started you or the user says resume.'
  )
}

// The SendMessage path first (the plugin API's own), then the desktop app's
// older send_message tool.
async function sendHold(
  $: $,
  sessionId: string,
  text: string,
): Promise<{ ok: true; note: string } | { ok: false; error: string }> {
  let first = ''
  try {
    const sent = await $.session.send({ to: sessionId, text })
    if (sent.isDelivered) return { ok: true, note: 'sent' }
    first = sent.reason
  } catch (err) {
    first = errorText(err)
  }
  const called = await callTool($, SEND_MESSAGE, { session_id: sessionId, message: text })
  if (!called.ok) return { ok: false, error: `${first}; send_message: ${called.error}` }
  // Its result ends "(delivery: delivered|queued|...; message_id: ...)".
  const delivery = /delivery:\s*([a-z_-]+)/i.exec(called.text)?.[1]?.toLowerCase()
  if (delivery !== undefined && delivery !== 'delivered' && delivery !== 'queued') {
    return { ok: false, error: `send_message: ${firstLine(called.text)}` }
  }

  return { ok: true, note: `send_message ${delivery ?? 'answered'}` }
}

// The workers: the linked sessions this session started, and the ones they
// started in turn; never this session or the one that started it.
async function listWorkers(
  $: $,
): Promise<{ ok: true; sessions: UsageGuardSession[]; note?: string } | { ok: false; error: string }> {
  const self = await callTool($, GET_SESSION, { session_id: 'self' })
  const selfRow = self.ok && isObject(self.value) ? self.value : undefined
  const selfId = typeof selfRow?.sessionId === 'string' ? selfRow.sessionId : undefined
  const parentId = typeof selfRow?.parentSessionId === 'string' ? selfRow.parentSessionId : undefined

  const listed = await callTool($, LIST_SESSIONS, { linked: true, limit: 100 })
  if (!listed.ok) return { ok: false, error: listed.error }
  if (!Array.isArray(listed.value)) return { ok: false, error: 'list_sessions answered no list' }

  const rows = listed.value.filter(isObject).filter(row => typeof row.sessionId === 'string')
  const isOther = (row: Record<string, unknown>) =>
    row.sessionId !== selfId && row.sessionId !== parentId && row.isArchived !== true
  let picked: Record<string, unknown>[]
  let fallback: string | undefined
  if (selfId !== undefined) {
    // Walk down from this session by startedBy.
    const family = new Set<unknown>([selfId])
    let isGrowing = true
    while (isGrowing) {
      isGrowing = false
      for (const row of rows) {
        if (!family.has(row.sessionId) && family.has(row.startedBy)) {
          family.add(row.sessionId)
          isGrowing = true
        }
      }
    }
    picked = rows.filter(row => row.sessionId !== selfId && family.has(row.sessionId))
  } else {
    picked = rows.filter(row => typeof row.startedBy === 'string')
    fallback = `get_session(self) failed (${self.ok ? 'no sessionId' : self.error}); took every linked session that has a starter`
  }

  const sessions = picked.filter(isOther).map(
    (row): UsageGuardSession => ({
      sessionId: String(row.sessionId),
      title: typeof row.title === 'string' && row.title !== '' ? row.title : String(row.sessionId),
      ...(typeof row.name === 'string' && { name: row.name }),
      ...(typeof row.isRunning === 'boolean' && { isRunning: row.isRunning }),
    }),
  )

  return { ok: true, sessions, ...(fallback !== undefined && { note: fallback }) }
}

// ---------------------------------------------------------------- the command

async function runCommand($: $, args: string): Promise<string> {
  const [verb = 'status', value] = args.trim().split(/\s+/).filter(Boolean)
  const now = await $.clock.now()

  switch (verb.toLowerCase()) {
    case 'status': {
      void $.ui.open({ id: PANE, title: 'Weekly usage' })
      return statusText(now)
    }
    case 'threshold': {
      const threshold = Number(value)
      if (value === undefined || !Number.isFinite(threshold) || threshold < 1 || threshold > 100) {
        return `Usage: /usage-guard threshold <1-100>. It is ${pct(guardNow.threshold)}.`
      }
      await commitGuard($, { ...guardNow, threshold })
      await note($, `threshold set to ${pct(threshold)}`)
      const weekly = usageNow.weekly
      const warn =
        guardNow.mode === 'armed' && guardNow.trip === null && weekly !== null && weekly.percentUsed >= threshold
          ? ` Weekly is at ${pct(weekly.percentUsed)}: the guard trips at the next reading.`
          : ''
      const tripped = guardNow.trip !== null ? ' The guard stays tripped until the week resets or /usage-guard rearm.' : ''
      return `Threshold set to ${pct(threshold)} (saved).${warn}${tripped}`
    }
    case 'rearm': {
      const weekly = usageNow.weekly
      if (weekly !== null && weeklyProblem(weekly, now) === undefined && weekly.percentUsed >= guardNow.threshold) {
        return (
          `Not re-armed: weekly is at ${pct(weekly.percentUsed)}, at or above the threshold ${pct(guardNow.threshold)}, ` +
          'so it would trip again at the next reading. Raise it first: /usage-guard threshold <n>.'
        )
      }
      const tripped = guardNow.trip
      await commitGuard($, {
        ...guardNow,
        mode: 'armed',
        trip: null,
        history: tripped !== null ? [...guardNow.history, tripped].slice(-HISTORY) : guardNow.history,
      })
      await note($, 're-armed by /usage-guard rearm')
      return `Armed at ${pct(guardNow.threshold)}.${tripped !== null ? ' The trip of this week was cleared; paused workers stay paused until this session or you resume them.' : ''}`
    }
    case 'disarm': {
      await commitGuard($, { ...guardNow, mode: 'disarmed' })
      await note($, 'disarmed by /usage-guard disarm')
      return 'Disarmed: the guard will not pause anyone until /usage-guard rearm.'
    }
    case 'dryrun':
    case 'dry-run': {
      // Lists only: get_session and list_sessions, never stop or message.
      const listed = await listWorkers($)
      const dryRun: UsageGuardDryRun = listed.ok
        ? { at: now, sessions: listed.sessions, ...(listed.note !== undefined && { note: listed.note }) }
        : { at: now, sessions: [], error: listed.error }
      await commitGuard($, { ...guardNow, lastDryRun: dryRun })
      void $.ui.open({ id: PANE, title: 'Weekly usage' })
      const rows = dryRun.sessions.map(
        one => `- ${one.title}${one.name ? ` [${one.name}]` : ''} ${one.sessionId}${one.isRunning === true ? ' (running)' : one.isRunning === false ? ' (idle)' : ''}`,
      )
      return [`Dry run (nothing was stopped or messaged): ${dryRunSummary(dryRun)}`, ...rows].join('\n')
    }
    default:
      return 'Usage: /usage-guard [status | rearm | disarm | dryrun | threshold <n>]'
  }
}

function statusText(now: number): string {
  const weekly = usageNow.weekly
  const problem = weeklyProblem(weekly, now)
  const lines = [
    weekly === null
      ? 'Weekly (all models): no reading yet.'
      : `Weekly (all models): ${pct(weekly.percentUsed)}, ${resetText(weekly, now)}; read ${ago(now - weekly.at)} by ${weekly.source}.` +
        (problem !== undefined ? ` Not usable to trip: ${problem}.` : ''),
    usageNow.fiveHour === null
      ? '5-hour: no reading yet.'
      : `5-hour: ${pct(usageNow.fiveHour.percentUsed)}, ${resetText(usageNow.fiveHour, now)}.`,
    ...usageNow.models.map(model => `${model.label}: ${pct(model.percentUsed)}, ${resetText(model, now)}.`),
    `Guard: ${guardLine(guardNow)}.`,
  ]
  const trip = guardNow.trip
  if (trip !== null) {
    lines.push(...trip.workers.map(one => `- ${label(one)}: stop ${one.stop}, message ${one.message}`))
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------- tool calls

type Called = { ok: true; text: string; value: unknown } | { ok: false; error: string }

// $.tool.call never throws here: a refusal, an error result or a rejection
// comes back as { ok: false, error }.
async function callTool($: $, tool: McpToolName, args: Record<string, unknown>): Promise<Called> {
  try {
    const ran = await $.tool.call({ ...args, tool })
    if (ran.deny !== undefined) return { ok: false, error: `refused: ${ran.deny}` }
    const text = resultText(ran.text, ran.result)
    if (ran.isError === true) return { ok: false, error: firstLine(text) || 'the tool reported an error' }
    return { ok: true, text, value: parseJson(text) }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

function resultText(text: unknown, result: unknown): string {
  if (typeof text === 'string') return text
  if (typeof result === 'string') return result
  const blocks = Array.isArray(result) ? result : isObject(result) && Array.isArray(result.content) ? result.content : undefined
  if (blocks !== undefined) {
    return blocks
      .filter(isObject)
      .map(block => (typeof block.text === 'string' ? block.text : ''))
      .join('')
  }
  return result === undefined ? '' : JSON.stringify(result)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- drawing

function refreshStatus($: $): void {
  const weekly = usageNow.weekly
  const five = usageNow.fiveHour
  const parts = [`Week ${weekly === null ? '?' : pct(weekly.percentUsed)}`, `5h ${five === null ? '?' : pct(five.percentUsed)}`]
  if (guardNow.trip !== null) parts.push('guard TRIPPED')
  else if (guardNow.mode === 'disarmed') parts.push('guard off')
  $.ui.status(parts.join(' · '))
}

function guardLine(guard: UsageGuardState): string {
  if (guard.trip !== null) {
    const trip = guard.trip
    const resets = ms(trip.weekResetsAt)
    return (
      `tripped at ${clockTime(trip.trippedAt)} at ${pct(trip.percent)} (threshold ${pct(trip.threshold)})` +
      (resets !== undefined ? `; re-arms ${dayTime(resets)}` : '') +
      (trip.isComplete ? '' : `; retrying (${trip.attempts}/${MAX_ATTEMPTS})`)
    )
  }
  return guard.mode === 'armed' ? `armed at ${pct(guard.threshold)}` : `disarmed (threshold ${pct(guard.threshold)})`
}

function dryRunSummary(dryRun: UsageGuardDryRun): string {
  if (dryRun.error !== undefined) return `could not list the workers: ${dryRun.error}`
  const count = dryRun.sessions.length
  const what = count === 0 ? 'no sessions' : `${count} session${count === 1 ? '' : 's'}`
  return `the guard would stop, then message, ${what}.${dryRun.note !== undefined ? ` ${dryRun.note}.` : ''}`
}

function resetText(window: UsageGuardWindow, now: number): string {
  const resets = ms(window.resetsAt)
  return resets === undefined ? 'reset time unknown' : `resets ${dayTime(resets)} (in ${span(resets - now)})`
}

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function tone(percent: number, threshold: number): string {
  return percent >= threshold ? 'error' : percent >= threshold - 10 ? 'warning' : 'success'
}

// ---------------------------------------------------------------- small helpers

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// Times in UTC, marked Z.
function clockTime(at: number): string {
  const date = new Date(at)
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`
}

function dayTime(at: number): string {
  const date = new Date(at)
  return `${DAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${clockTime(at)}`
}

function span(gap: number): string {
  if (gap <= 0) return 'now'
  const minutes = Math.round(gap / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

function ago(gap: number): string {
  return gap < 60_000 ? 'just now' : `${span(gap)} ago`
}

function pct(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`
}

function label(worker: UsageGuardSession): string {
  return worker.name !== undefined ? `${worker.title} (${worker.name})` : worker.title
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').slice(0, 200)
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ms(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const value = Date.parse(iso)
  return Number.isFinite(value) ? value : undefined
}

// Two sources spell one reset apart by milliseconds (16:59:59.854 and 17:00):
// the same reset to the hour.
function isSameReset(a: string | undefined, b: string | undefined): boolean {
  const left = ms(a)
  const right = ms(b)
  return left !== undefined && right !== undefined && Math.abs(left - right) < 3_600_000
}

function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function withWorker(trip: UsageGuardTrip, worker: UsageGuardWorker): UsageGuardTrip {
  return { ...trip, workers: trip.workers.map(one => (one.sessionId === worker.sessionId ? worker : one)) }
}

function isGuardState(value: unknown): value is UsageGuardState {
  return (
    isObject(value) &&
    typeof value.threshold === 'number' &&
    (value.mode === 'armed' || value.mode === 'disarmed') &&
    (value.trip === null || isObject(value.trip)) &&
    Array.isArray(value.history)
  )
}
