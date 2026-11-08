// usage-guard's state contract: the values its pane and status line draw
// from ($.state), each kept under a shape tag. The guard's own record is
// also saved in $.store (key 'guard-1'), so a reload or restart keeps it.

/** One usage window as the guard read it. */
export type UsageGuardWindow = {
  /** 'Weekly · all models', '5-hour limit', 'Weekly · <model>'. */
  label: string
  /** 0 to 100, at most one decimal. */
  percentUsed: number
  /** When the window resets, ISO 8601; absent when the source left it out. */
  resetsAt?: string
  /** Where the figure came from. */
  source: 'measure' | 'seed' | 'poll'
  /** $.clock.now() when it was read. */
  at: number
}

/** The figures the pane draws. */
export type UsageGuardUsage = {
  /** The weekly all-models window: the one the guard trips on. */
  weekly: UsageGuardWindow | null
  fiveHour: UsageGuardWindow | null
  /** The per-model weekly windows (get_usage only). */
  models: UsageGuardWindow[]
  /** get_usage's plan status when it was not 'ok' ('unavailable', ...). */
  planStatus?: string
}

/** A session the guard would stop (dry run) or stopped (trip). */
export type UsageGuardSession = {
  sessionId: string
  title: string
  /** The short handle a linked session carries. */
  name?: string
  isRunning?: boolean
}

export type UsageGuardStep = 'pending' | 'done' | 'failed'

/** One worker of a trip: its stop and its hold message. */
export type UsageGuardWorker = UsageGuardSession & {
  stop: UsageGuardStep
  stopNote?: string
  message: UsageGuardStep
  messageNote?: string
}

/** What one trip did; saved before any session is touched. */
export type UsageGuardTrip = {
  /** The weekly window's resetsAt the trip belongs to: its key. */
  weekResetsAt: string
  trippedAt: number
  percent: number
  threshold: number
  /** Whether list_sessions answered, so `workers` is the list. */
  isListed: boolean
  workers: UsageGuardWorker[]
  /** Runs so far (the first, then one per reading while steps fail). */
  attempts: number
  /** Every step done, or the retries ran out. */
  isComplete: boolean
  /** The toast and the prompt to this session went out. */
  isLeadTold: boolean
  /** The failures of the latest run. */
  errors: string[]
}

export type UsageGuardDryRun = {
  at: number
  sessions: UsageGuardSession[]
  error?: string
  note?: string
}

export type UsageGuardMode = 'armed' | 'disarmed'

/** The guard's record: what $.store keeps under 'guard-1'. */
export type UsageGuardState = {
  threshold: number
  mode: UsageGuardMode
  /** This week's trip; null while armed and not tripped. */
  trip: UsageGuardTrip | null
  /** Earlier trips, newest last (ten kept). */
  history: UsageGuardTrip[]
  lastDryRun: UsageGuardDryRun | null
}

export type UsageGuardLogLine = { at: number; text: string; count?: number }

declare module 'claude-code' {
  interface PluginState {
    'usage-guard': {
      usage: Shaped<UsageGuardUsage>
      guard: Shaped<UsageGuardState>
      log: Shaped<UsageGuardLogLine[]>
    }
  }
}
