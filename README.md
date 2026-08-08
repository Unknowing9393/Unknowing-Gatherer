# thelounge-plugin-seedrpg-gathering

A [The Lounge](https://thelounge.chat/) plugin that drives SeedRPG gathering activities over IRC. It watches DMs from the game bot, queues up `!forage`/`!mine`/`!chop`/`!salvage`/`!hunt`/`!fish` runs, tracks hits/xp/loot, and can run a full unattended daily cycle across every gathering skill — picking nodes by your level, routing them by travel distance, and (optionally) recovering automatically if you die.

It registers the command `/unkgather`, aliased to the shorter `/unkg`. Everything below works with either.

## Features

- Queue single runs bounded by time, hit count, or xp, or loop a set of them with `rotate`
- Unattended **daily cycle**: runs every gathering skill once a day, auto-picks the highest node your level allows, and routes stops by learned travel distance
- Wall-clock budgets that divide travel-aware, with warnings (and required acceptance) for schedules that are mostly walking
- Learns node positions and per-step travel time from real runs — no manual map data needed
- `!recall` is only used when it actually saves a meaningful chunk of travel (configurable threshold)
- Persistent per-day statistics, queryable with `/unkg stats`
- Post-cycle actions: set a waypoint, queue a gauntlet, or start a dungeon once gathering finishes
- Optional hardcore mode: auto-recover (home, recall, re-equip) on death

## Installing

1. Clone this repo or download `index.js` and `package.json`.
2. Install it as a Lounge plugin/package — see The Lounge's [plugin docs](https://thelounge.chat/docs/plugins) for where your install expects packages, or install directly from this git URL if your Lounge setup supports it:
   ```
   thelounge install git+https://github.com/Unknowing9393/Unknowing-Gatherer.git
   ```
3. Restart The Lounge. If it loaded, `/unkg help` will respond in any window.

## Getting started

```
/unkg on
```

Attaches a listener to private messages from the game bot (`DM` by default). Most commands that need to read a reply auto-attach for you the first time you use them — `/unkg on` is the explicit way to start watching.

```
/unkg status
```

Shows what's currently running, progress toward its limit, and how many runs are queued behind it.

## Queueing single runs

```
/unkg q <activity> [node] <limit>
```

- **activity**: `forage`, `mine`, `chop`, `salvage`, `hunt`, `fish` (aliases like `gather`, `fishing`, `wood` also work)
- **node**: optional — omit it and the plugin auto-picks the highest node your level allows
- **limit**: `for <time>` | `x<N>` hits | `until <N>xp`

```
/unkg q forage for 10m       # forage for ten minutes, node auto-picked
/unkg q mine x25             # mine until 25 successful actions
/unkg q chop until 500xp     # chop until 500xp gained
/unkg q fish 1 for 1h30m     # fish node 1 for an hour and a half
```

Queued runs go one after another. To loop a set forever, use `rotate`:

```
/unkg rotate forage for 10m | mine x25 | chop for 5m
```

```
/unkg list     # show what's running and queued
/unkg clear    # empty the queue, stop any rotation
```

## The daily cycle

Run every gathering skill once a day, unattended, routed by the shortest path between discovered nodes.

```
/unkg daily all for 1h                           # one hour of every activity
/unkg daily all for 1h, fish for 15m, hunt off    # per-activity overrides
/unkg daily within 10h                            # fit everything into a 10h budget, travel included
/unkg daily mine for 90m, chop for 90m at 02:00   # optional "at HH:MM" UTC start time
```

The game day resets at 00:00 UTC, so times are UTC. `within` divides a wall-clock budget across activities after estimating travel; `all`/per-activity sets a fixed baseline instead.

```
/unkg daily              # schedule + next run time
/unkg daily now           # run immediately, any time (alias: run / start)
/unkg daily nodes         # node picked per activity; flags any eligible-but-unmapped ones
/unkg daily options       # best available route and ways to proceed
/unkg daily no            # look for a shorter route via closer nodes
/unkg daily accept        # allow a schedule that was warned about
/unkg daily ignore budget|travel|minimum
/unkg daily adapt         # re-divide the remaining window as real travel is measured
/unkg daily off           # cancel
```

If a schedule leaves too little gathering time per stop, the plugin warns and refuses to run it until you `accept` it (or fix the plan), reminding every 30 minutes between 00:00 UTC and the scheduled start.

A daily cycle starts with `!recall` + `!home` to establish a known starting point. Since `!recall` spends a consumable, it's only used when recalling home actually saves a meaningful chunk of travel:

```
/unkg daily recall <pct>    # only recall if it saves >= pct% of route travel (default 25%)
/unkg daily recall default  # reset to the 25% default
```

Post-cycle actions (run once daily gathering finishes):

```
/unkg after gauntlet 3
/unkg after waypoint 180 240 | dungeon 5   # chain several
/unkg after clear                          # cancel them
```

Map and home:

```
/unkg map              # learned node positions and travel times
/unkg home              # read home town from the game
/unkg home <x>,<y>      # override manually
```

## Nodes and levels

```
/unkg nodes <activity>   # list nodes, * = your level allows it
/unkg levels             # your current skill levels
/unkg auto on|off        # auto-pick highest usable node (default on)
/unkg refresh            # clear cached levels/node lists
```

## Control

```
/unkg skip      # abandon the current run, start the next queued one
/unkg stop      # stop everything, clear the queue
/unkg resume    # un-halt after a blocked state (inventory full, death, etc.)
/unkg loot      # session totals since the last restart
/unkg stats [yesterday|week|all|days|YYYY-MM-DD]
/unkg debug     # echo every DM line with its parse (handy for troubleshooting)
/unkg help      # full in-client command list
```

## Hardcore mode

For permadeath runs:

```
/unkg hardcore on
```

On a `[DEATH]` line from the bot, this:

1. Halts anything currently running (won't auto-resume the queue)
2. Sets your home town to SeedHaven
3. Recalls there
4. Re-equips your best gear once

Off by default, and the setting persists across Lounge restarts. `/unkg hardcore off` disables it again.

## Notes

- Time formats accepted everywhere: `45s`, `10m`, `1h30m`, `04:30`. Node names with spaces are fine unquoted.
- Persistent state (daily schedule, learned node map, per-day stats, hardcore setting) is stored per-network under The Lounge's plugin storage directory.
- Full command reference is always available in-client with `/unkg help`.

## License

MIT
