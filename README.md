# thelounge-plugin-seedrpg-gathering

A [The Lounge](https://thelounge.chat/) plugin that drives SeedRPG gathering activities over IRC. It watches DMs from the game bot, queues up `!forage`/`!mine`/`!chop`/`!salvage`/`!hunt`/`!fish` runs, tracks hits/xp/loot, and can run a full unattended daily cycle across every gathering skill — picking nodes by your level, routing them by travel distance, and (optionally) recovering automatically if you die.

It registers the command `/unkgather`, aliased to the shorter `/unkg`. Everything below works with either.

## Features

- Queue single runs bounded by time, hit count, or xp, or loop a set of them with `rotate`
- Unattended **daily cycle**: runs every gathering skill once a day, auto-picks the highest node your level allows, and routes stops by learned travel distance
- Wall-clock budgets that divide travel-aware, with warnings (and required acceptance) for schedules that are mostly walking
- Learns node positions and per-step travel time from real runs — no manual map data needed
- `!recall` is only used when it actually saves a meaningful chunk of travel (configurable threshold) -- and between every stop, not just home, it checks every known town for whichever gets there fastest
- Persistent per-day statistics, queryable with `/unkg stats`
- Post-cycle actions: set a waypoint, queue a gauntlet, start a dungeon, or deposit loot once gathering finishes
- Hardcore recovery (home, recall, re-equip) on a `[HARDCORE]`-tagged death, on by default
- Per-activity gear loadouts: snapshot equipped gear from `!inv` and auto-`!equip` it before that activity's runs

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

`grind` is a special case -- there's no real command for it, it's just standing within range of a waypoint with nothing else queued, which the game auto-fights. So it only takes coordinates and a time limit:

```
/unkg q grind at 500 500 for 30m
```

This sends `!waypoint 500 500`, waits for it to be confirmed and then for `[MOVE]` to report within 10 steps of that spot, and only then starts the clock. It ends with `!waypoint clear` rather than a stop command, since neither exists for grinding. Gear is always equipped first -- a saved `grind gear` loadout if you have one, otherwise `!equip best`, since grinding is pure combat.

Queued runs go one after another. To loop a set forever, use `rotate`:

```
/unkg rotate forage for 10m | mine x25 | chop for 5m
```

```
/unkg list     # show what's running and queued
/unkg clear    # empty the queue, stop any rotation
```

## The daily cycle

Run gathering skills once a day, unattended, within a single wall-clock time budget -- travel between discovered nodes is estimated and subtracted first, and the rest is gathering time.

```
/unkg daily 10h            # split 10h across every activity, travel included
/unkg daily 10h at 02:00   # optional "at HH:MM" UTC start time
```

The game day resets at 00:00 UTC, so times (and the `at` suffix) are UTC.

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

If a schedule leaves too little gathering time per stop, the plugin warns and refuses to run it until you `accept` it (or shrink the plan), reminding every 30 minutes between 00:00 UTC and the scheduled start.

### Specializing

More stops means more travel, and travel time only grows the more of the map you've unlocked -- doing all six gathering skills every day eventually spends most of the budget just walking. If you mainly care about one skill, specialize in it: it gets the bulk of the budget, and one other activity rotates in daily for the rest, so every activity still gets covered eventually without doing all of them every day.

```
/unkg daily specialize hunt        # hunt gets 75% (the default) of the budget
/unkg daily specialize hunt 80     # hunt gets 80% instead
/unkg daily specialize off         # back to splitting the budget across every activity
/unkg daily specialize             # show the current specialty, if any
```

Which activity fills the remaining share normally just advances by one every time the cycle runs, cycling through the other five in order (hunt+mine, hunt+chop, hunt+salvage, ...). But first, it checks `!daily` (the game's own daily-task list) for an open task on one of those other activities that awards FL tokens -- gathering itself never grants FL, so a matching task jumps that activity in for today regardless of whose turn it is (highest FL wins; a tie between activities is broken by whichever's node has the shorter estimated travel *time* from the day's starting position -- not raw tile distance, since learned travel speed varies node to node).

All of this -- the !daily check and every travel estimate -- runs only after the day's actual starting position is settled (home if recalling, otherwise wherever you last were), not before, so it never reasons from stale state.

Either candidate (the FL jump, or the plain rotation pick) is only actually used if it leaves at least an hour of gathering time once its real travel is estimated. If not, every other activity is tried in turn and whichever leaves the most time wins instead, with a warning if even the best one still falls short -- a same-day pick can turn out to be much farther away than the one it's replacing, and a few minutes of gathering after hours of travel isn't worth doing. Either way, the rotation cursor advances past whichever activity actually gets used, so it doesn't cost that activity its normal turn later.

Because the two stops for the day aren't known until the cycle actually fires, specialty mode skips the usual pre-run preview/accept step -- the split (and estimated travel) is reported when the cycle starts instead.

A daily cycle starts with `!recall` + `!home` to establish a known starting point. Since `!recall` spends a consumable, it's only used when recalling home actually saves a meaningful chunk of travel:

```
/unkg daily recall <pct>    # only recall if it saves >= pct% of route travel (default 25%)
/unkg daily recall default  # reset to the 25% default
```

The plugin also remembers every town it's ever seen set as home -- `!home` only ever reports the currently-active one, so this builds up passively over time as home actually gets switched, not all at once. Between every queued stop (not just at the start of the day), it checks whether switching home to a different known town and recalling there would reach the *next* stop faster than walking there from wherever you currently are -- whichever town is quickest can change from stop to stop. Switching home has no cost of its own, so this is purely a travel-time trade, gated by the same recall percentage above. Whatever home was before the first such detour is remembered, and switched back to five minutes after the *last* one -- in the background, so it doesn't delay the gathering that follows. `/unkg home` (no argument) shows which towns have known coordinates so far.

If the last node worked today needs more SUR (from `!stats`) than you have plus a safety margin, the mobs guarding it are assumed too dangerous to linger near, so a `!deposit` + unconditional `!recall` run automatically before any post-cycle actions below:

```
/unkg daily safety <levels>  # deposit + recall if finishing node's Lv > SUR + levels (default 5)
/unkg daily safety default   # reset to the default margin
```

`!equip best` also always runs at the very end of the cycle (after any safety deposit/recall, before the actions below), so gear is optimal no matter where the day ends -- this is automatic and not user-configurable.

Post-cycle actions (run once daily gathering finishes):

```
/unkg after gauntlet 3
/unkg after deposit | waypoint 180 240 | dungeon 5   # chain several
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

Every `[DEATH]` line halts anything currently running (won't auto-resume the queue) -- that part always happens. But a `[HARDCORE]`-tagged death (the game scatters your equipped items to a dungeon) also triggers automatic recovery by default:

1. Sets your home town to SeedHaven
2. Recalls there
3. Re-equips your best gear once

A normal (non-hardcore) death does nothing beyond the halt. On by default and persists across Lounge restarts -- turn it off with:

```
/unkg hardcore off
```

## Gear loadouts

Stand next to (or already be running) an activity and snapshot your currently equipped gear as that activity's loadout:

```
/unkg hunt gear
/unkg mine gear     # also: chop, salvage, forage, fish, grind
```

This reads `!inv`'s default view (one line per equip slot, the `[E]`-flagged item's `#id`) and saves all 16 slots' item ids. From then on, every time that activity's queue starts a run, the plugin sends `!equip <id1> <id2> ...` first, so gear swaps automatically per activity -- useful if, say, hunting wants a combat-heavy set and mining doesn't need one at all.

```
/unkg hunt              # show the saved loadout, if any
/unkg hunt gear clear   # remove it
```

## Notes

- Time formats accepted everywhere: `45s`, `10m`, `1h30m`, `04:30`. Node names with spaces are fine unquoted.
- Persistent state (daily schedule, learned node map, per-day stats, hardcore setting, gear loadouts) is stored per-network under The Lounge's plugin storage directory.
- Full command reference is always available in-client with `/unkg help`.

## License

MIT
