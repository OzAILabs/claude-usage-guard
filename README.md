# usage-guard

A Claude Code mod that keeps an eye on your weekly Claude usage and, when it
reaches a limit you set, pauses the sessions your main session started.

It was built to run a group of long-lived worker sessions without burning a
whole week's plan by accident.

## Install

In Claude Code, type:

```
/plugin install usage-guard --marketplace OzAILabs/claude-usage-guard
```

If your version doesn't take `--marketplace`, add the marketplace first, then install:

```
/plugin marketplace add OzAILabs/claude-usage-guard
/plugin install usage-guard@usage-guard
```

## What it does

- **A "Weekly usage" pane and a status-line entry** (`Week 42% · 5h 18%`): the
  weekly all-models window, the 5-hour window, and the per-model weekly windows,
  each with its reset time (shown in UTC).
- **A guard, armed at 80% by default.** When the weekly all-models figure reaches
  the threshold, the guard trips once for that week:
  1. It saves the trip first, so a reload or restart never trips twice.
  2. It lists the sessions this session started (and the ones they started).
  3. It stops each one's turn in flight.
  4. It sends each one a hold message: start no new work, leave files
     consistent, note where you stopped, end the turn, and wait to be resumed.
  5. It tells you with a toast and a notification, and tells this session with
     a prompt.

  Failed steps are logged in the pane and retried at the next reading (up to
  six runs).
- **It re-arms by itself** when the weekly window resets, or when your usage is
  reset partway through a week (a drop of 20 points or more under the same reset
  time).
- **It never trips on a bad reading:** none yet, no reset time, older than 30
  minutes, or within 10 minutes of the reset.

It never resumes anything. Paused sessions stay paused until you, or the session
that started them, tell them to go on.

## Commands

```
/usage-guard status          show the figures and the guard (and open the pane)
/usage-guard threshold <n>   set the trip point, 1-100 (saved)
/usage-guard dryrun          list the sessions it would stop; stops and messages nothing
/usage-guard disarm          turn the guard off
/usage-guard rearm           turn it back on, or clear this week's trip
```

Run `/usage-guard dryrun` once after installing to see exactly which sessions
the guard would pause.

## Where it works

- **Claude desktop app (Code tab):** everything. The poll, the session list,
  stop and message use the app's own session tools (`get_usage`,
  `get_session`, `list_sessions`, `stop_session`, `send_message`).
- **Terminal:** the pane and status line show the figures Claude Code reports
  after each turn. The 15-minute poll and the pause need the desktop app's
  tools; without them, each failed call is logged in the pane and nothing is
  stopped.

The poll runs every 15 minutes and shows up as a tool call in the session's
transcript.

## Where it keeps its state

The guard's record (threshold, mode, this week's trip and the last ten trips)
is kept in the mod's own store, under the key `guard-1`. Change it with the
`/usage-guard` commands, not by editing the file: the running mod holds its own
copy and writes it back.

## Development

```
claude plugin validate .
claude plugin test .
```

The tests (`tests/usage-guard.test.tsx`) stand in for every tool, message and
prompt, so nothing real is called. Claude Code writes the editor types into
`.claude-plugin/types/` when it loads the mod; after that, `tsc -p .`
type-checks it.

## License

MIT
