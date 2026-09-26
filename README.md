# thelounge-plugin-seedrpg-gathering

A [The Lounge](https://thelounge.chat/) plugin that passively tracks SeedRPG gathering activity over IRC. It watches DMs from the game bot and keeps hit/xp/loot stats and learned node positions.

**It never sends anything to the game.** Earlier versions queued and auto-started `!forage`/`!mine`/`!chop`/`!salvage`/`!hunt`/`!fish` runs, ran a full daily cycle, auto-equipped gear, and auto-recalled -- all of that is gone, because the game's rules no longer allow sending automated commands. Start, stop, and control your own gathering in-game exactly as you normally would; this plugin only listens and reports.

It registers the command `/unkgather`, aliased to the shorter `/unkg`. Everything below works with either.

## Features

- Purely passive: reads DMs from the game bot, never writes to IRC
- Tracks hit/xp/loot per gathering session, watching for the game's own "Started X at Y!" / tick / "Stopped X" lines
- Persistent per-day statistics, queryable with `/unkg stats`
- Learns node positions and travel speed from your own trips, for reference (`/unkg map`)
- Passively caches whatever node lists or `!skills` lines your own commands happen to produce (`/unkg nodes`, `/unkg levels`) -- it never asks for them itself
- Reports deaths (including hardcore ones) for visibility only; it takes no recovery action

## Installing

1. Clone this repo or download `index.js` and `package.json`.
2. Install it as a Lounge plugin/package -- see The Lounge's [plugin docs](https://thelounge.chat/docs/plugins) for where your install expects packages, or install directly from this git URL if your Lounge setup supports it:
   ```
   thelounge install git+https://github.com/Unknowing9393/Unknowing-Gatherer.git
   ```
3. Restart The Lounge. If it loaded, `/unkg help` will respond in any window.

## Getting started

```
/unkg on
```

Attaches a listener to private messages from the game bot (`DM` by default). Nothing is sent to the game -- this only starts watching what the bot already says to you.

```
/unkg status
```

Shows whether a gathering session is currently being watched, and its progress so far.

## How it tracks a session

Whenever the game bot reports `Started <activity> at <node>!` (because *you* ran `!hunt`, `!mine`, etc. yourself), the plugin starts watching that activity: it counts ticks and hits, tallies xp and loot, and learns the node's position and travel speed from your own trip there. When the bot reports `Stopped <activity>...` (or you start a different activity without an explicit stop), the session is finalized: a summary is printed and it's recorded into that day's stats.

If you turn the plugin on while already mid-session, it picks up tracking from the next tick it sees, rather than waiting for a "Started" line that already happened.

```
/unkg loot     # session totals since the last restart
/unkg stats    # today's totals per activity, broken down by node
/unkg stats yesterday   # also: week, all, days, YYYY-MM-DD
```

Each activity's totals are broken down per node whenever you've worked more than one that day -- so `hunt` shows its overall line plus one line per node you actually hunted at, letting you tell a good node from a bad one at a glance.

## Learned nodes

```
/unkg map
```

Lists every node position learned from your own trips, with an estimated distance/time from your last known position once its travel speed has been measured. This is informational only -- nothing here plans or suggests a route.

## Node lists and skill levels

The plugin has no way to ask the game for a node list or your skill levels -- it can only see them when *you* run `!hunt nodes`, `!skills`, etc. yourself, and caches whatever it happens to see:

```
/unkg nodes hunt     # the last hunting node list seen, if any
/unkg levels         # the last !skills line seen, if any
```

## Deaths

Every `[DEATH]` line is reported, including whether it was `[HARDCORE]`-tagged. No action is taken either way -- recovering (resetting home, recalling, re-equipping) would mean sending commands, which this plugin no longer does.

## Notes

- Persistent state (per-day stats, learned node map) is stored per-network under The Lounge's plugin storage directory.
- `/unkg debug` echoes every DM line along with its parse -- useful for confirming the plugin is seeing what you expect.
- Full command reference is always available in-client with `/unkg help`.

## License

MIT
