"use strict";

/**
 * thelounge-plugin-seedrpg-gathering  v0.17.0
 *
 * Drives SeedRPG gathering activities from The Lounge. Activities tick
 * continuously until stopped, so runs are bounded by time, success count, or
 * xp -- this plugin issues the start, counts ticks, issues the stop, and moves
 * to the next queued run.
 *
 * Registers /unkgather (alias /unkg). Run "/unkgather help" for the full list.
 *
 *   /unkgather on
 *   /unkgather q forage 3 for 10m   run !forage 3 for ten minutes
 *   /unkgather q mine 2 x25         run !mine 2 until 25 successful actions
 *   /unkgather q chop 1 until 500xp run !chop 1 until 500xp gained
 *   /unkgather rotate forage 3 for 10m | mine 2 x25
 *
 * Changelog
 *   0.17.0 When no shorter route exists: report the best available option and
 *          offer ignore budget|travel|minimum, or adapt to re-divide the
 *          window from travel measured during the run.
 *   0.16.0 "daily no" searches for a shorter route, trading node level for
 *          travel time only as far as needed to clear the thresholds.
 *   0.15.2 Reminders now state the travel cost (known vs assumed) and the
 *          gathering time it leaves per activity.
 *   0.15.1 Remind every 30m from 00:00 UTC until the cycle's start time while
 *          a warned-about schedule is still unaccepted.
 *   0.15.0 Warn and require explicit acceptance when a schedule leaves under
 *          30m gathering per stop, or spends more time travelling than
 *          gathering.
 *   0.14.1 Daily cycle skips activities whose node is not yet mapped, so the
 *          route and budget are not thrown off by an unroutable stop.
 *   0.14.0 "daily within 10h" -- give a wall-clock budget and let the plugin
 *          subtract estimated travel and split the rest across activities.
 *   0.13.0 Per-activity daily limits: "all for 1h, fish for 15m, hunt off".
 *   0.12.1 Gauntlets always queue solo.
 *   0.12.0 Optional post-cycle actions: set a waypoint, queue a gauntlet, or
 *          start a dungeon once the daily gathering finishes.
 *   0.11.2 With no recall item, read the real position from !stats instead of
 *          trusting the remembered one.
 *   0.11.1 Sum duplicate consumable stacks -- the same item appears several
 *          times in one listing.
 *   0.11.0 Check !inv consumables for a recall item before the daily cycle;
 *          without one, route from last known position instead of assuming
 *          we teleported home.
 *   0.10.3 Drop mid-cycle re-routing -- positions are only learned on arrival,
 *          so it could not improve the order of stops still ahead.
 *   0.10.1 Record partial work from manually stopped or skipped runs too.
 *   0.10.0 Persistent per-day statistics: every finished run is recorded to
 *          disk by UTC day and queryable with /unkgather stats.
 *   0.9.3  Anchor the !home parser on its real format; capture the discovered
 *          town list.
 *   0.9.2  Read home from the game with !home instead of a fixed constant, so
 *          it keeps working as new towns are discovered.
 *   0.9.1  Daily cycle opens with !recall so routes plan from a known origin.
 *   0.9.0  Learn node coordinates from travel and order the daily cycle by
 *          proximity. Adds /unkgather map.
 *   0.8.0  Daily cycle: run every gathering activity once a day at a chosen
 *          UTC time, sharing one limit. Survives a Lounge restart.
 *   0.7.2  Remove all stall detection. Count/xp runs now arm no timer at all.
 *   0.7.1  Remove the travel stall guard entirely -- travel cannot stall, so
 *          the guard only ever fired falsely and cancelled the trip.
 *   0.7.0  Register as /unkgather (alias /unkg) instead of /seed; add a help
 *          subcommand.
 *   0.6.1  Auto-attach the listener for commands that need it; never send a
 *          bare "!<activity>" as a start (it is a status query); detect the
 *          status reply so a failed start reports immediately.
 *   0.6.0  Model the queue -> travel -> gather sequence. The run clock now
 *          starts on arrival at the node, not on DM's acknowledgement, so
 *          travel time is no longer billed against the run's limit.
 *   0.5.0  Gate run start on DM's "Started <x> at <node>!" confirmation;
 *          verify the confirmed node against the auto-picked one.
 *   0.4.0  Exclude [LOOT] and [MOVE] background events from tick counting.
 *   0.3.0  Auto-select the highest node allowed by !skills level.
 *   0.2.0  Time / hit-count / xp run limits, rotations, loot tallying.
 *   0.1.0  Command scaffold and DM privmsg listener.
 */

const PLUGIN_NAME = "seedrpg-gathering";

// Slash command this plugin registers, plus a shorter alias.
const COMMAND = "unkgather";
const ALIASES = ["unkg"];
const CMD = "/" + COMMAND;
const VERSION = "0.17.0";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Game model
// ---------------------------------------------------------------------------

const ACTIVITIES = {
	fish:    {noun: "spots", tag: "FISHING",     stat: "FSH", skill: "fishing"},
	mine:    {noun: "nodes", tag: "MINING",      stat: "MIN", skill: "mining"},
	chop:    {noun: "nodes", tag: "WOODCUTTING", stat: "WDC", skill: "woodcutting"},
	salvage: {noun: "nodes", tag: "SALVAGING",   stat: "SAL", skill: "salvaging"},
	forage:  {noun: "nodes", tag: "FORAGING",    stat: "FOR", skill: "foraging"},
	hunt:    {noun: "nodes", tag: "HUNTING",     stat: "HUN", skill: "hunting"},
};

// Everything !skills reports, for display purposes.
const STAT_NAMES = {
	OFF: "offense", DEF: "defense", EXP: "expertise", SUR: "survival", LCK: "luck",
	FSH: "fishing", MIN: "mining", WDC: "woodcutting", SAL: "salvaging",
	FOR: "foraging", HUN: "hunting", COOK: "cooking",
	CRF: "crafting", DNG: "dungeoneering", ARN: "arena",
};

const AUTO = "auto";

// Alternative names people reach for.
const ACTIVITY_ALIASES = {
	gather: "forage", forage: "forage", foraging: "forage",
	fishing: "fish", mining: "mine", woodcutting: "chop", chopping: "chop",
	wood: "chop", salvaging: "salvage", hunting: "hunt",
};

function resolveActivity(name) {
	const n = String(name || "").toLowerCase();
	if (ACTIVITIES[n]) return n;
	return ACTIVITY_ALIASES[n] || null;
}

// tag -> activity, built from the above
const TAG_TO_ACTIVITY = {};
for (const [act, meta] of Object.entries(ACTIVITIES)) {
	TAG_TO_ACTIVITY[meta.tag] = act;
}

const CONFIG = {
	botNick: "DM",
	minGapMs: 2500,          // floor between outbound commands
	maxWaitMs: 6 * 3600000,  // ceiling on any single run
	defaultLimit: {kind: "time", value: 10 * 60000},

	// Which command reports skill levels. (!stats is player stats; !skills is levels.)
	levelCommand: "!skills",

	// How long to gather reply lines after asking DM a question.
	collectMs: 4000,

	// Re-use cached levels / node lists for this long before re-querying.
	cacheMs: 5 * 60000,

	// Auto-pick the highest eligible node when none is specified.
	autoNode: true,

	// How long to wait for "Started <x> at <node>!" before giving up on a run.
	confirmMs: 25000,

	// The game day resets at 00:00 UTC, so the daily cycle defaults to just
	// after the reset.
	dailyDefaultUtcMinute: 5,

	// Travel is grid movement: 3 coordinate units per step, and observed at
	// ~67s per step. stepMs is refined from real runs as they complete.
	mapUnitsPerStep: 3,
	mapStepMs: 67000,

	// Fallback only. Home is normally read from the game with !home, which
	// keeps working as more towns are discovered. Manual override:
	// "<cmd> home <x>,<y>".
	homeCoords: [180, 240],

	// Grace period after !recall before we start issuing gathering commands.
	recallMs: 6000,

	// Consumable that !recall spends. Matched case-insensitively against the
	// !inv consumables listing.
	recallItem: "home teleport",

	// Actions that can run after the daily gathering cycle finishes. Each maps
	// to the game command it issues; edit here if the syntax changes.
	finishers: {
		waypoint: (arg) => `!waypoint ${arg}`,
		// Unattended runs are always solo -- no group to coordinate with.
		gauntlet: (arg) => (arg ? `!gauntlet ${arg} solo` : "!gauntlet solo"),
		dungeon: (arg) => (arg ? `!queue dungeon ${arg}` : "!queue dungeon"),
	},

	// Gap between chained finisher commands.
	finisherGapMs: 4000,

	// Never allot less than this per stop when dividing a budget.
	minShareMs: 5 * 60000,

	// Below this much gathering per stop, the trip is mostly walking and the
	// schedule needs explicit confirmation.
	minGatherPerStopMs: 30 * 60000,

	// While a schedule is waiting to be accepted, nag every this often between
	// the UTC day rollover and the cycle's start time.
	reminderEveryMs: 30 * 60000,

	// NOTE: there are no stall guards anywhere. Neither travel nor gathering can
	// stall, so any silence-based timeout would only ever fire falsely and kill
	// a healthy run. Runs end on their limit, or when the user says so.
};

// ---------------------------------------------------------------------------
// Line parsing
//
// Real DM output looks like:
//   [FORAGING] Nick digs a hole. The hole contains additional hole.
//   [FORAGING] Nick gathers 2x Wild Carrots. Farm to inventory. (2x standard) +35xp (base 35: Seedpool +1%)
//   [LEVEL UP] Foraging reached level 4!  -  Nick reached microservice architecture of mind
//
// Flavor text is randomized and enormous, so we never match on it. A tick is a
// success iff it carries +Nxp.
// ---------------------------------------------------------------------------

const RE = {
	tag:     /^\[([A-Z][A-Z ]*)\]\s*/,
	xp:      /\+(\d+)\s*xp\b/i,
	payload: /\((?:(\d+)x\s+)?([a-z]+)\)\s*\+\d+\s*xp/i,   // (2x standard) +35xp
	item:    /\b(\d+)x\s+(?:[a-z]+\s+)*([A-Z][A-Za-z']*(?:\s+[A-Z][A-Za-z']*)*)/,
	levelUp: /^(\w+)\s+reached\s+level\s+(\d+)/i,
	// [LOOT] standard Plastic Casing x1 (+0 XP)  -  Nick extracted ...
	loot:    /^(?:([a-z]+)\s+)?(.+?)\s+x(\d+)\s*\(\+(\d+)\s*xp\)/i,
	// [FORAGING] Nick: Started foraging at Truffle Shuffle!
	started: /^(?:\S+:\s*)?Started\s+([a-z]+)\s+at\s+(.+?)\s*[!.]?\s*$/i,
	// [FISHING] Nick: Fishing Lv3 (609xp) | Not fishing
	statusLine: /^(?:\S+:\s*)?([A-Za-z]+)\s+Lv\s*(\d+)\s*\((\d+)\s*xp\)\s*\|\s*(.+)$/i,
	blocked: /\b(inventory (?:is )?full|not enough|too tired|no (?:energy|stamina)|you (?:have )?died|cannot|unable to)\b/i,
};

/** Returns {tag, activity, success, xp, qty, quality, item, levelUp, blocked} */
function parseLine(line) {
	const out = {raw: line};
	const tagMatch = line.match(RE.tag);

	if (tagMatch) {
		out.tag = tagMatch[1].trim();
		out.activity = TAG_TO_ACTIVITY[out.tag] || null;
		out.body = line.slice(tagMatch[0].length);
	} else {
		out.body = line;
	}

	if (out.tag === "LEVEL UP") {
		const lv = out.body.match(RE.levelUp);
		if (lv) out.levelUp = {skill: lv[1], level: parseInt(lv[2], 10)};
		return out;
	}

	// Travel. Not actionable in itself, but it marks the walk to a node, which
	// must not be billed against the run's time limit.
	if (out.tag === "MOVE") {
		out.move = true;
		const c = out.body.match(/\((\d+)\s*,\s*(\d+)\)/);
		if (c) out.coords = [parseInt(c[1], 10), parseInt(c[2], 10)];
		return out;
	}

	// Standalone loot drops. These fire independently of gathering ticks, so
	// they are tallied but must NOT count toward an activity's hit count.
	if (out.tag === "LOOT") {
		const m = out.body.match(RE.loot);
		if (m) {
			out.loot = {
				quality: m[1] || null,
				item: m[2].trim(),
				qty: parseInt(m[3], 10),
				xp: parseInt(m[4], 10),
			};
		}
		return out;
	}

	const st = out.body.match(RE.started);
	if (st) {
		out.started = {verb: st[1].toLowerCase(), node: st[2].trim()};
		return out;
	}

	// Reply to a bare "!fish" -- a status query, not a gathering tick.
	const stat = out.body.match(RE.statusLine);
	if (stat) {
		out.status = {
			skill: stat[1],
			level: parseInt(stat[2], 10),
			xp: parseInt(stat[3], 10),
			state: stat[4].trim(),
			idle: /^not\b/i.test(stat[4].trim()),
		};
		return out;
	}

	const xp = out.body.match(RE.xp);
	if (xp) {
		out.success = true;
		out.xp = parseInt(xp[1], 10);

		const p = out.body.match(RE.payload);
		if (p) {
			out.qty = p[1] ? parseInt(p[1], 10) : 1;
			out.quality = p[2];
		}

		const it = out.body.match(RE.item);
		if (it) {
			out.item = it[2].trim();
			if (out.qty === undefined) out.qty = parseInt(it[1], 10);
		}
	}

	if (RE.blocked.test(out.body)) out.blocked = true;

	return out;
}

// ---------------------------------------------------------------------------
// Node list + skill level parsing
//
// Real formats:
//   [FISHING] Spots: [20] Cache Harbor (ocean, Lv15+, standard) | [1] Red's Refuge (pond, Lv1+, standard)
//   [MINING] Nodes: [1] Chris's Cache (coastal, Lv16+, standard) | [3] Mt Array (coastal, Lv1+, standard)
//   Nick OFF:9 DEF:8 EXP:7 SUR:7 LCK:8 | FSH:3 MIN:7 WDC:6 SAL:4 FOR:4 HUN:3 COOK:4 | CRF:3 DNG:6 ARN:4
//
// Note the whole node list arrives on ONE line, pipe-separated.
// ---------------------------------------------------------------------------

const RE_NODE_LIST = /\b(?:nodes|spots)\s*:/i;
const RE_NODE_ENTRY = /\[(\d+)\]\s*([^(|]+?)\s*\(([^)]*)\)/g;
const RE_STAT_PAIR = /\b([A-Z]{2,4})\s*:\s*(\d+)/g;

/** Parses a full "Nodes: ..." line into [{id, name, level, terrain, quality}]. */
function parseNodeList(line) {
	const body = line.replace(RE.tag, "");
	if (!RE_NODE_LIST.test(body)) return [];

	const out = [];
	let m;
	RE_NODE_ENTRY.lastIndex = 0;

	while ((m = RE_NODE_ENTRY.exec(body)) !== null) {
		const attrs = m[3].split(",").map((a) => a.trim());
		const lvl = m[3].match(/\blv\.?\s*(\d+)\s*\+?/i);

		out.push({
			id: m[1],
			name: m[2].trim(),
			level: lvl ? parseInt(lvl[1], 10) : 1,
			terrain: attrs[0] && !/^lv/i.test(attrs[0]) ? attrs[0] : null,
			quality: attrs.length > 2 ? attrs[attrs.length - 1] : null,
		});
	}

	return out;
}

/** Parses the !skills line into {FSH: 3, MIN: 7, ...}. */
function parseStats(line) {
	const out = {};
	let m;
	RE_STAT_PAIR.lastIndex = 0;

	while ((m = RE_STAT_PAIR.exec(line)) !== null) {
		out[m[1].toUpperCase()] = parseInt(m[2], 10);
	}

	// Require a few pairs so a stray "HP:20" in flavor text doesn't count.
	return Object.keys(out).length >= 3 ? out : null;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

function toMs(n, unit) {
	const v = parseInt(n, 10);
	const u = String(unit).toLowerCase();
	if (u.startsWith("h")) return v * 3600000;
	if (u === "m" || u.startsWith("min")) return v * 60000;
	if (u === "d") return v * 86400000;
	return v * 1000;
}

function parseDuration(text) {
	const t = String(text).trim();
	const clock = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
	if (clock) {
		const h = parseInt(clock[1] || "0", 10);
		return ((h * 60 + parseInt(clock[2], 10)) * 60 + parseInt(clock[3], 10)) * 1000;
	}
	let total = 0;
	const re = /(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
	let m;
	while ((m = re.exec(t)) !== null) total += toMs(m[1], m[2]);
	return total;
}

function fmt(ms) {
	if (ms <= 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/**
 * Reads an "!inv consumables" reply:
 *   Nick Consumables: 15xCrab Boil, 18xCaptain's Chowder, 5xHome Teleport, ...
 *
 * Entries are "<qty>x<Item>" with no space, comma separated. The same item can
 * appear several times (separate stacks), so quantities are summed rather than
 * taking the first match.
 *
 * Returns {held} for the named item, or null if this is not a consumables line.
 */
function parseRecallStock(line, itemName) {
	const body = String(line).replace(RE.tag, "");
	if (!/\bconsumables\s*:/i.test(body)) return null;

	const name = String(itemName || CONFIG.recallItem).toLowerCase();
	const list = body.slice(body.search(/\bconsumables\s*:/i)).replace(/^[^:]*:/, "");

	let held = 0;
	let found = false;

	for (const entry of list.split(",")) {
		const m = entry.trim().match(/^(\d+)\s*x\s*(.+?)\s*$/i);
		if (!m) continue;
		if (m[2].toLowerCase() !== name) continue;
		held += parseInt(m[1], 10);
		found = true;
	}

	return found ? {held} : {held: 0};
}

/**
 * Reads the !stats reply, whose final field is the player's current position:
 *   Nick HP: 1300/1300 | Salvaging | striker | OFF:15 ... | online | (14, 481)
 *
 * Anchored on the HP field so nothing else can be mistaken for it.
 */
function parseStatsLine(line) {
	const body = String(line).replace(RE.tag, "");
	if (!/\bHP\s*:\s*\d+/i.test(body)) return null;

	const pos = body.match(/\((\d+)\s*,\s*(\d+)\)\s*$/);
	const hp = body.match(/\bHP\s*:\s*(\d+)\s*\/\s*(\d+)/i);

	// The field after HP is the current activity, or absent when idle.
	const act = body.match(/\bHP\s*:\s*\d+\s*\/\s*\d+\s*\|\s*([A-Za-z]+)\s*\|/);
	const doing = act ? act[1].toLowerCase() : null;

	return {
		coords: pos ? [parseInt(pos[1], 10), parseInt(pos[2], 10)] : null,
		hp: hp ? [parseInt(hp[1], 10), parseInt(hp[2], 10)] : null,
		activity: doing,
		online: /\bonline\b/i.test(body),
	};
}

/**
 * Parses the !home reply:
 *   Nick: Home is SeedHaven (180, 240). Set with !home <town>. Available: SeedHaven
 *
 * Anchored on "Home is" so a [MOVE] line -- which also carries coordinates --
 * can never be mistaken for it.
 */
function parseHome(line) {
	const body = String(line).replace(RE.tag, "");
	const m = body.match(/\bHome is\s+(.+?)\s*\((\d+)\s*,\s*(\d+)\)/i);
	if (!m) return null;

	const avail = body.match(/\bAvailable:\s*(.+?)\s*$/i);

	return {
		town: m[1].trim(),
		coords: [parseInt(m[2], 10), parseInt(m[3], 10)],
		available: avail
			? avail[1].split(/\s*[,|]\s*/).map((t) => t.trim()).filter(Boolean)
			: [],
	};
}

/** Minutes-after-UTC-midnight -> "02:05". */
function fmtUtc(minutes) {
	const h = Math.floor(minutes / 60), m = minutes % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
}

/** "02:00" | "0200" | "2:00" -> minutes after UTC midnight, or null. */
function parseUtcTime(text) {
	const m = String(text).trim().match(/^(\d{1,2}):?(\d{2})$/);
	if (!m) return null;
	const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
	if (h > 23 || min > 59) return null;
	return h * 60 + min;
}

/** Next UTC occurrence of a given minute-of-day, as a Date. */
function nextUtcOccurrence(minutes) {
	const now = new Date();
	const next = new Date(Date.UTC(
		now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
		Math.floor(minutes / 60), minutes % 60, 0, 0
	));
	if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
	return next;
}

function describeLimit(limit) {
	if (!limit) return "until stopped";
	if (limit.kind === "share") return "share of budget";
	if (limit.kind === "time") return `for ${fmt(limit.value)}`;
	if (limit.kind === "count") return `${limit.value} hits`;
	if (limit.kind === "xp") return `${limit.value}xp`;
	return "until stopped";
}

function stripFormatting(str) {
	// eslint-disable-next-line no-control-regex
	return String(str).replace(/\x03(\d{1,2}(,\d{1,2})?)?|\x04[0-9a-fA-F]{6}|[\x00-\x1F]/g, "");
}

// ---------------------------------------------------------------------------
// Run: one queued unit of work
// ---------------------------------------------------------------------------

class Run {
	constructor(activity, node, limit) {
		this.activity = activity;
		this.node = node;
		this.limit = limit || Object.assign({}, CONFIG.defaultLimit);
		this.reset();
	}

	reset() {
		this.state = "idle";        // idle -> pending -> traveling -> running
		this.confirmedNode = null;
		this.travelSteps = 0;
		this.travelStartedAt = 0;
		this.travelMs = 0;
		this.coords = null;
		this.startedAt = 0;
		this.lastTick = 0;
		this.ticks = 0;
		this.successes = 0;
		this.xp = 0;
		this.loot = new Map();
	}

	describe() {
		const target = this.limit.kind === "time" ? `for ${fmt(this.limit.value)}`
			: this.limit.kind === "count" ? `x${this.limit.value}`
			: this.limit.kind === "xp" ? `until ${this.limit.value}xp`
			: "until stopped";
		const n = this.node === AUTO ? " [auto]" : this.node ? " " + this.node : "";
		return `!${this.activity}${n} ${target}`;
	}

	/** How much of the limit is consumed, 0..1 (null = unbounded). */
	progress() {
		if (this.state !== "running") return 0;
		if (this.limit.kind === "time") {
			return (Date.now() - this.startedAt) / this.limit.value;
		}
		if (this.limit.kind === "count") return this.successes / this.limit.value;
		if (this.limit.kind === "xp") return this.xp / this.limit.value;
		return null;
	}

	isDone() {
		const p = this.progress();
		return p !== null && p >= 1;
	}

	/** ms until the time limit expires, or null for non-time limits. */
	msRemaining() {
		if (this.limit.kind !== "time") return null;
		return Math.max(0, this.limit.value - (Date.now() - this.startedAt));
	}

	summary() {
		const items = [...this.loot.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, n]) => `${n}x ${name}`)
			.join(", ");
		const elapsed = fmt(Date.now() - this.startedAt) +
			(this.travelMs ? ` (+${fmt(this.travelMs)} travel)` : "");
		const rate = this.ticks ? Math.round((this.successes / this.ticks) * 100) : 0;
		return `!${this.activity}${this.confirmedNode ? " @ " + this.confirmedNode : ""} done: ` +
			`${this.successes}/${this.ticks} hits (${rate}%), ` +
			`+${this.xp}xp, ${elapsed}${items ? " -- " + items : ""}`;
	}
}

// ---------------------------------------------------------------------------
// Session: one per network
// ---------------------------------------------------------------------------

const sessions = new Map();

// Set in onServerStart -- needed for the persistent storage path.
let API = null;

const DAILY_FILE = "unkgather-daily.json";
const MAP_FILE = "unkgather-nodes.json";
const STATS_FILE = "unkgather-stats.json";
const STATS_KEEP_DAYS = 60;

/** UTC date key -- the game day resets at 00:00 UTC, so days are UTC days. */
function utcDay(date) {
	return (date || new Date()).toISOString().slice(0, 10);
}

function dayOffset(days) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return utcDay(d);
}

function storeFile(name) {
	try {
		return path.join(API.Config.getPersistentStorageDir(), name);
	} catch (err) {
		return null;
	}
}

function readJson(name, fallback) {
	const f = storeFile(name);
	if (!f) return fallback;
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch (err) {
		return fallback;
	}
}

function writeJson(name, obj) {
	const f = storeFile(name);
	if (!f) return;
	try {
		fs.writeFileSync(f, JSON.stringify(obj, null, "\t"));
	} catch (err) {
		// best effort
	}
}

/** Grid distance between two [x, y] points. Movement is axis-aligned. */
function manhattan(a, b) {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/** Distance in coordinate units -> estimated travel time. */
function travelEstimate(units, stepMs) {
	const steps = Math.round(units / CONFIG.mapUnitsPerStep);
	return {steps, ms: steps * (stepMs || CONFIG.mapStepMs)};
}

function readDailyStore() {
	return readJson(DAILY_FILE, {});
}

function writeDailyStore(obj) {
	writeJson(DAILY_FILE, obj);
}

class Session {
	constructor(network, client, chanId) {
		this.network = network;
		this.client = client;
		this.chanId = chanId;

		this.queue = [];
		this.rotation = null;
		this.current = null;
		this.timer = null;
		this.lastSend = 0;
		this.halted = null;
		this.debug = false;
		this.attached = false;
		this.totals = {runs: 0, successes: 0, xp: 0, loot: new Map()};

		this.daily = {enabled: false, atMin: CONFIG.dailyDefaultUtcMinute, plan: null};
		this.dailyTimer = null;
		this.reminderTimer = null;
		this.pendingWarnings = null;
		this.pendingSummary = null;

		this.lastPos = null;   // most recent coordinates seen
		this.finishers = [];   // [{kind, arg}] run after the daily cycle

		this.levels = new Map();     // skill -> {level, at}
		this.nodeCache = new Map();  // activity -> {nodes, at}
		this.collector = null;       // active reply-gathering buffer
		this.starting = false;       // guards against overlapping starts
	}

	say(text) {
		this.client.sendMessage(text, this.chanId);
	}

	// -- wiring ------------------------------------------------------------

	attach() {
		if (this.attached) return true;
		const irc = this.network.irc;
		if (!irc) {
			this.say("No IRC connection on this network.");
			return false;
		}

		this.handler = (event) => {
			if (!event || !event.nick) return;
			if (event.nick.toLowerCase() !== CONFIG.botNick.toLowerCase()) return;
			if (event.target && event.target.startsWith("#")) return;  // PMs only
			this.onLine(stripFormatting(event.message || ""));
		};

		irc.on("privmsg", this.handler);
		irc.on("notice", this.handler);
		this.attached = true;
		return true;
	}

	detach() {
		const irc = this.network.irc;
		if (irc && this.attached) {
			irc.removeListener("privmsg", this.handler);
			irc.removeListener("notice", this.handler);
		}
		this.attached = false;
		this.clearTimer();
	}

	// -- inbound -----------------------------------------------------------

	onLine(line) {
		if (!line.trim()) return;
		const p = parseLine(line);

		// While waiting on a reply to a question we asked, buffer everything.
		if (this.collector) {
			this.collector.lines.push(line);
			if (this.debug) this.say(`[collect] ${line}`);
			if (this.collector.until && this.collector.until(line)) this.collector.finish();
			return;
		}

		if (this.debug) {
			const bits = [p.tag || "-"];
			if (p.success) bits.push(`HIT +${p.xp}xp`);
			if (p.item) bits.push(`${p.qty}x ${p.item}`);
			if (p.levelUp) bits.push(`LEVEL ${p.levelUp.level}`);
			if (p.blocked) bits.push("BLOCK");
			this.say(`[${bits.join(" ")}] ${line}`);
		}

		if (p.levelUp) {
			this.say(`Level up: ${p.levelUp.skill} -> ${p.levelUp.level}`);
			this.levels.clear();   // re-query before the next auto pick
			return;
		}

		if (p.move) {
			const r = this.current;
			if (r && r.state === "traveling") {
				r.travelSteps++;
				r.lastProgress = Date.now();
				if (p.coords) r.coords = p.coords;
			}
			if (p.coords) this.lastPos = p.coords;
			return;
		}

		if (p.tag === "LOOT") {
			if (p.loot) {
				this.totals.loot.set(p.loot.item, (this.totals.loot.get(p.loot.item) || 0) + p.loot.qty);
				this.totals.xp += p.loot.xp;
				if (this.current) this.current.xp += p.loot.xp;
				if (this.debug) this.say(`[loot] ${p.loot.qty}x ${p.loot.item} +${p.loot.xp}xp`);
			}
			return;
		}

		if (p.blocked && this.current) {
			this.halted = line;
			this.stopCurrent(`halted: ${line}`);
			return;
		}

		const run = this.current;
		if (!run) return;

		// A status reply while we are waiting to start means the command did
		// not begin anything. Fail now rather than after the timeout.
		if (p.status) {
			if (run.state === "pending" && p.activity === run.activity && p.status.idle) {
				this.clearTimer();
				this.say(`!${run.activity} did not start (${CONFIG.botNick} reports: ${p.status.state}) -- skipping.`);
				this.current = null;
				setTimeout(() => this.advance(), CONFIG.minGapMs);
			}
			return;
		}

		// Start confirmation: this is what actually begins the run.
		if (p.started) {
			if (run.state !== "pending") return;
			if (p.activity !== run.activity) return;

			if (this.confirmTimer) {
				clearTimeout(this.confirmTimer);
				this.confirmTimer = null;
			}

			// This is the acknowledgement, not arrival. The walk to the node
			// comes next, and must not be billed against the run's limit.
			run.state = "traveling";
			run.confirmedNode = p.started.node;
			run.travelStartedAt = Date.now();
			run.lastProgress = Date.now();

			const want = run.resolved && run.resolved.name;
			const mismatch = want && want.toLowerCase() !== p.started.node.toLowerCase();

			this.say(
				`Queued ${p.started.node}` +
				(mismatch ? ` (expected ${want})` : "") +
				` -- travelling`
			);

			// Travel is unbounded and cannot stall, so nothing is armed here.
			// The run clock starts on arrival. /unkgather skip aborts manually.
			return;
		}

		// Arrival. The first line tagged with our activity after the walk means
		// we are at the node -- THIS is where the clock starts. The line itself
		// is the "begins gathering" flavour, not a gather attempt, so it is not
		// counted as a tick.
		if (run.state === "traveling") {
			if (!p.activity || p.activity !== run.activity) return;

			run.travelMs = Date.now() - run.travelStartedAt;

			// The last coordinates before arrival are effectively where this
			// node lives. Learned once, reused to plan future routes.
			if (run.coords && run.confirmedNode) {
				this.rememberNode(run.activity, run.confirmedNode, run.coords,
					run.travelSteps, run.travelMs);
				this.lastPos = run.coords;
			}
			run.state = "running";
			run.startedAt = Date.now();
			run.lastTick = Date.now();

			this.say(
				`Arrived at ${run.confirmedNode}` +
				(run.travelSteps ? ` (${run.travelSteps} steps, ${fmt(run.travelMs)})` : "") +
				` -- running ${run.limit.kind === "time" ? fmt(run.limit.value)
					: run.limit.kind === "count" ? run.limit.value + " hits"
					: run.limit.value + "xp"}`
			);

			this.armTimer();
			return;
		}

		// Nothing counts until we have arrived and the clock is going.
		if (run.state !== "running") return;

		// Only lines tagged with the exact activity we started are ticks.
		// Background events ([LOOT], [MOVE], dungeon chatter) are excluded, or
		// they would inflate hit counts and satisfy x<N> limits spuriously.
		if (!p.activity || p.activity !== run.activity) return;

		run.ticks++;
		run.lastTick = Date.now();

		if (p.success) {
			run.successes++;
			run.xp += p.xp || 0;
			if (p.item) run.loot.set(p.item, (run.loot.get(p.item) || 0) + (p.qty || 1));
		}

		if (run.isDone()) this.finishRun();
	}

	/**
	 * Issues the configured post-cycle actions once the queue drains. Only
	 * fires for a daily cycle, so ad-hoc queues are unaffected.
	 */
	runFinishers() {
		if (!this.dailyRunActive || !this.finishers.length) return;
		this.dailyRunActive = false;

		this.say(`Gathering done -- starting: ${this.finishers.map(describeFinisher).join(", ")}`);

		this.finishers.forEach((f, i) => {
			setTimeout(() => {
				const build = CONFIG.finishers[f.kind];
				if (build) this.send(build(f.arg));
			}, i * CONFIG.finisherGapMs);
		});
	}

	// -- statistics ---------------------------------------------------------

	recordRun(run) {
		const store = readJson(STATS_FILE, {});
		const day = utcDay();

		if (!store[day]) store[day] = {};
		const bucket = store[day][run.activity] || {
			runs: 0, ticks: 0, hits: 0, xp: 0,
			gatherMs: 0, travelMs: 0, loot: {},
		};

		bucket.runs += 1;
		bucket.ticks += run.ticks;
		bucket.hits += run.successes;
		bucket.xp += run.xp;
		bucket.gatherMs += Math.max(0, Date.now() - run.startedAt);
		bucket.travelMs += run.travelMs || 0;
		for (const [item, n] of run.loot) {
			bucket.loot[item] = (bucket.loot[item] || 0) + n;
		}
		if (run.confirmedNode) bucket.lastNode = run.confirmedNode;

		store[day][run.activity] = bucket;

		// Trim old days so the file cannot grow without bound.
		const cutoff = dayOffset(-STATS_KEEP_DAYS);
		for (const k of Object.keys(store)) {
			if (k < cutoff) delete store[k];
		}

		writeJson(STATS_FILE, store);
	}

	/** Merges one or more day buckets into a single per-activity report. */
	statsFor(days) {
		const store = readJson(STATS_FILE, {});
		const merged = {};

		for (const day of days) {
			const d = store[day];
			if (!d) continue;
			for (const [act, b] of Object.entries(d)) {
				const m = merged[act] || {
					runs: 0, ticks: 0, hits: 0, xp: 0,
					gatherMs: 0, travelMs: 0, loot: {},
				};
				m.runs += b.runs;
				m.ticks += b.ticks;
				m.hits += b.hits;
				m.xp += b.xp;
				m.gatherMs += b.gatherMs;
				m.travelMs += b.travelMs;
				for (const [item, n] of Object.entries(b.loot || {})) {
					m.loot[item] = (m.loot[item] || 0) + n;
				}
				merged[act] = m;
			}
		}

		return merged;
	}

	reportStats(label, days) {
		const merged = this.statsFor(days);
		const acts = Object.keys(merged);

		if (!acts.length) {
			this.say(`No activity recorded for ${label}.`);
			return;
		}

		const tot = {runs: 0, ticks: 0, hits: 0, xp: 0, gatherMs: 0, travelMs: 0};
		this.say(`-- ${label} --`);

		acts.sort((a, b) => merged[b].xp - merged[a].xp).forEach((act) => {
			const m = merged[act];
			const rate = m.ticks ? Math.round((m.hits / m.ticks) * 100) : 0;
			const xpHr = m.gatherMs ? Math.round(m.xp / (m.gatherMs / 3600000)) : 0;
			const items = Object.entries(m.loot)
				.sort((a, b) => b[1] - a[1])
				.slice(0, 3)
				.map(([n, q]) => `${q}x ${n}`)
				.join(", ");

			this.say(
				`  ${act.padEnd(8)} ${String(m.hits).padStart(4)}/${String(m.ticks).padEnd(5)} ` +
				`${String(rate).padStart(3)}%  ${String(m.xp).padStart(6)}xp  ` +
				`${String(xpHr).padStart(5)}xp/h  ${fmt(m.gatherMs)}+${fmt(m.travelMs)} travel` +
				(items ? `  ${items}` : "")
			);

			for (const k of Object.keys(tot)) tot[k] += m[k];
		});

		const totRate = tot.ticks ? Math.round((tot.hits / tot.ticks) * 100) : 0;
		const clock = tot.gatherMs + tot.travelMs;
		const eff = clock ? Math.round((tot.gatherMs / clock) * 100) : 0;
		this.say(
			`  TOTAL    ${tot.hits}/${tot.ticks} ${totRate}%  ${tot.xp}xp  ` +
			`over ${fmt(clock)} (${eff}% gathering, ${100 - eff}% travel)`
		);
	}

	// -- learned node map ---------------------------------------------------

	mapStore() {
		const m = readJson(MAP_FILE, null) || {};
		if (!m.nodes) m.nodes = {};
		if (!m.stats) m.stats = {stepMs: CONFIG.mapStepMs, samples: 0};
		return m;
	}

	mapKey(activity, nodeName) {
		return `${activity}|${String(nodeName).toLowerCase()}`;
	}

	/** Records where a node is, learned from the last coords before arrival. */
	rememberNode(activity, nodeName, coords, steps, ms) {
		if (!coords || !nodeName) return;

		const m = this.mapStore();
		m.nodes[this.mapKey(activity, nodeName)] = {
			activity,
			name: nodeName,
			x: coords[0],
			y: coords[1],
			seen: new Date().toISOString(),
		};

		// Refine the per-step time from real observations.
		if (steps > 2 && ms > 0) {
			const prev = m.stats.stepMs || CONFIG.mapStepMs;
			const n = m.stats.samples || 0;
			m.stats.stepMs = Math.round((prev * n + ms / steps) / (n + 1));
			m.stats.samples = n + 1;
		}

		writeJson(MAP_FILE, m);
	}

	home() {
		const m = this.mapStore();
		return (m.home && m.home.length === 2) ? m.home : CONFIG.homeCoords;
	}

	setHome(coords, town, available) {
		const m = this.mapStore();
		m.home = coords;
		if (town) m.homeTown = town;
		if (available && available.length) m.towns = available;
		writeJson(MAP_FILE, m);
	}

	homeTown() {
		return this.mapStore().homeTown || null;
	}

	/**
	 * Checks whether a recall consumable is available. Returns the count, 0 if
	 * the listing was read and none were found, or null if the reply could not
	 * be read at all (in which case the caller should not assume either way).
	 */
	async recallStock() {
		const lines = await this.ask(
			"!inv consumables",
			(l) => parseRecallStock(l, CONFIG.recallItem) !== null
		);


		for (const l of lines) {
			const r = parseRecallStock(l, CONFIG.recallItem);
			if (r) return r.held;
		}

		// No consumables line was seen at all -- caller should not assume.
		return null;
	}

	/**
	 * Asks the game where we are. Authoritative, unlike the remembered
	 * position, which may be stale after a restart or manual play.
	 */
	async fetchPosition() {
		const lines = await this.ask("!stats", (l) => parseStatsLine(l) !== null);

		for (const l of lines) {
			const st = parseStatsLine(l);
			if (st && st.coords) {
				this.lastPos = st.coords;
				return st;
			}
		}

		return null;
	}

	/**
	 * Asks the game where home is. Falls back to the stored value, then to the
	 * configured default, so a parse failure degrades rather than breaks.
	 */
	async fetchHome() {
		const lines = await this.ask("!home", (l) => parseHome(l) !== null);

		for (const l of lines) {
			const h = parseHome(l);
			if (!h) continue;
			this.setHome(h.coords, h.town, h.available);
			return h;
		}

		return null;
	}

	nodePos(activity, nodeName) {
		const e = this.mapStore().nodes[this.mapKey(activity, nodeName)];
		return e ? [e.x, e.y] : null;
	}

	stepMs() {
		return this.mapStore().stats.stepMs || CONFIG.mapStepMs;
	}

	/**
	 * Greedy nearest-neighbour ordering of planned stops, starting from our
	 * current position. Stops with no known location go last, in given order.
	 */
	orderByProximity(stops, from) {
		const known = stops.filter((s) => s.pos);
		const unknown = stops.filter((s) => !s.pos);

		const out = [];
		let cur = from;

		while (known.length) {
			let bestIdx = 0;
			if (cur) {
				let bestDist = Infinity;
				known.forEach((s, i) => {
					const d = manhattan(cur, s.pos);
					if (d < bestDist) {
						bestDist = d;
						bestIdx = i;
					}
				});
			}
			const pick = known.splice(bestIdx, 1)[0];
			pick.fromDist = cur ? manhattan(cur, pick.pos) : null;
			out.push(pick);
			cur = pick.pos;
		}

		return out.concat(unknown);
	}

	// -- daily cycle --------------------------------------------------------

	dailyKey() {
		return this.network.uuid || this.network.name;
	}

	restoreDaily() {
		const saved = readDailyStore()[this.dailyKey()];
		if (!saved || !saved.enabled) return false;
		this.daily = {
			enabled: true,
			atMin: saved.atMin,
			// Older saves stored a single shared limit.
			budget: saved.budget || null,
			accepted: Boolean(saved.accepted),
			nodeOverrides: saved.nodeOverrides || null,
			ignore: saved.ignore || null,
			adapt: Boolean(saved.adapt),
			plan: saved.plan || (saved.limit
				? Object.fromEntries(Object.keys(ACTIVITIES).map((a) => [a, saved.limit]))
				: null),
		};
		this.finishers = saved.finishers || [];
		this.armDaily();

		// If it was left unaccepted, re-check and resume nagging.
		if (!this.daily.accepted) {
			(async () => {
				try {
					const est = await this.estimateDaily(this.lastPos || this.home());
					const warns = this.dailyWarnings(est);
					this.pendingWarnings = warns.length ? warns : null;
					this.pendingSummary = warns.length ? this.dailySummarySentence(est) : null;
					if (warns.length) this.armReminders();
				} catch (err) {
					// leave reminders off if the estimate cannot be built
				}
			})();
		}

		return true;
	}

	persistDaily() {
		const store = readDailyStore();
		if (this.daily.enabled) {
			store[this.dailyKey()] = {
				enabled: true,
				atMin: this.daily.atMin,
				plan: this.daily.plan,
				budget: this.daily.budget || null,
				accepted: Boolean(this.daily.accepted),
				nodeOverrides: this.daily.nodeOverrides || null,
				ignore: this.daily.ignore || null,
				adapt: Boolean(this.daily.adapt),
				finishers: this.finishers,
			};
		} else {
			delete store[this.dailyKey()];
		}
		writeDailyStore(store);
	}

	nextDailyAt() {
		return nextUtcOccurrence(this.daily.atMin);
	}

	clearReminders() {
		if (this.reminderTimer) {
			clearTimeout(this.reminderTimer);
			this.reminderTimer = null;
		}
	}

	/**
	 * Nags every 30 minutes between 00:00 UTC and the cycle's start time while
	 * a warned-about schedule is still unaccepted. Silent once accepted, or
	 * outside that window.
	 */
	armReminders() {
		this.clearReminders();

		if (!this.daily.enabled || this.daily.accepted || !this.pendingWarnings) return;

		const now = new Date();
		const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		const startMs = midnight + this.daily.atMin * 60000;
		const nowMs = now.getTime();

		// Next slot: on the half hour from midnight, before the cycle starts.
		let next;
		if (nowMs < midnight) {
			next = midnight;
		} else if (nowMs < startMs) {
			const since = nowMs - midnight;
			next = midnight + (Math.floor(since / CONFIG.reminderEveryMs) + 1) * CONFIG.reminderEveryMs;
			if (next >= startMs) next = null;
		} else {
			// Past today's start -- pick up at the next UTC midnight.
			next = midnight + 86400000;
		}

		if (next === null) return;   // no slots left before the cycle runs

		this.reminderTimer = setTimeout(() => {
			this.reminderTimer = null;
			if (!this.daily.enabled || this.daily.accepted || !this.pendingWarnings) return;

			const start = nextUtcOccurrence(this.daily.atMin);
			const left = start.getTime() - Date.now();

			this.say(this.pendingSummary || this.pendingWarnings.join("; "));
			this.say(
				`Daily cycle starts in ${fmt(left)} and will NOT run unless accepted -- ` +
				`${CMD} daily accept, or change the plan.`
			);

			this.armReminders();
		}, Math.max(next - nowMs, 1000));
	}

	armDaily() {
		if (this.dailyTimer) {
			clearTimeout(this.dailyTimer);
			this.dailyTimer = null;
		}
		if (!this.daily.enabled) return;

		const when = this.nextDailyAt();
		const delay = Math.max(when.getTime() - Date.now(), 1000);
		this.dailyTimer = setTimeout(() => {
			this.dailyTimer = null;
			this.fireDaily();
		}, delay);
	}

	/** Queue every gathering activity once, each with the shared limit. */
	fireDaily() {
		if (!this.daily.enabled) return;

		if (this.current || this.queue.length) {
			this.say(`Daily cycle skipped -- previous work still in progress (${this.queue.length} queued).`);
			this.armDaily();
			return;
		}

		if (!this.attached && !this.attach()) {
			this.armDaily();
			return;
		}

		this.rotation = null;   // daily is a one-shot pass, not a loop
		this.dailyRunActive = true;
		this.dailyStartedAt = Date.now();
		this.armDaily();        // schedule tomorrow before the work begins

		// Recall home first so the route plans from a known origin -- but only
		// if a teleport is actually held. Without one, !recall does nothing and
		// planning from "home" would be planning from somewhere we are not.
		this.startDailyFromKnownPosition();
	}

	/**
	 * Establishes where the cycle starts, then plans the route.
	 *
	 * With a recall consumable: teleport home and read the town coordinates.
	 * Without one: fall back to the last position we observed, and route from
	 * there rather than pretending to be at home.
	 */
	async startDailyFromKnownPosition() {
		let stock = null;
		try {
			stock = await this.recallStock();
		} catch (err) {
			stock = null;
		}

		if (stock === 0) {
			// No teleport. Ask where we actually are rather than trusting a
			// remembered position, which may be badly stale.
			let st = null;
			try {
				st = await this.fetchPosition();
			} catch (err) {
				st = null;
			}

			if (st && st.coords) {
				this.say(`No ${CONFIG.recallItem} -- routing from current position ` +
					`${st.coords[0]},${st.coords[1]}` +
					(st.activity ? ` (currently ${st.activity})` : "") + ".");
			} else if (this.lastPos) {
				this.say(`No ${CONFIG.recallItem}, could not read !stats -- ` +
					`routing from last known ${this.lastPos[0]},${this.lastPos[1]}.`);
			} else {
				this.say(`No ${CONFIG.recallItem} and no known position -- ` +
					`stops will run in declared order.`);
			}

			this.planDaily();
			return;
		}

		if (stock === null) {
			// Could not read the listing at all. Try the recall anyway; it is
			// harmless if it fails, and the alternative is a worse route.
			this.say("Could not read consumables -- attempting recall anyway.");
		} else {
			this.say(`Recalling home (${stock} ${CONFIG.recallItem}${stock === 1 ? "" : "s"} held).`);
		}

		this.send("!recall");

		setTimeout(async () => {
			// Ask the game where home actually is -- this keeps working as new
			// towns are discovered and home moves.
			let home = null;
			try {
				home = await this.fetchHome();
			} catch (err) {
				home = null;
			}

			if (home) {
				this.lastPos = home.coords;
				this.say(`Home: ${home.town} (${home.coords[0]},${home.coords[1]})`);
			} else if (this.lastPos) {
				this.say(`Could not read !home -- routing from ${this.lastPos[0]},${this.lastPos[1]}.`);
			} else {
				this.lastPos = this.home();
				this.say(`Could not read !home -- using stored ${this.lastPos[0]},${this.lastPos[1]}.`);
			}

			this.planDaily();
		}, CONFIG.recallMs);
	}

	/**
	 * Resolves which node each activity will use, then orders the stops by
	 * proximity so the cycle walks a short route instead of a fixed one.
	 * Falls back to the declared order for nodes we have not mapped yet.
	 */
	/**
	 * Every node for this activity that our level allows AND whose position we
	 * know, best level first. These are the candidates a route can trade
	 * between when the highest-level pick is too far away.
	 */
	async candidates(activity) {
		const level = await this.getLevel(activity);
		const nodes = await this.getNodes(activity);
		if (!nodes.length) return [];

		const eligible = (level === null ? nodes : nodes.filter((n) => n.level <= level))
			.map((n) => Object.assign({}, n, {pos: this.nodePos(activity, n.name)}))
			.filter((n) => n.pos);

		return eligible.sort((a, b) => b.level - a.level);
	}

	/** Total travel for a given choice of node per activity, greedily routed. */
	routeCost(choice, from) {
		const stops = Object.entries(choice).map(([act, node]) => ({act, node, pos: node.pos}));
		const ordered = this.orderByProximity(stops, from);
		const stepMs = this.stepMs();
		let ms = 0;
		for (const st of ordered) {
			if (st.fromDist) ms += travelEstimate(st.fromDist, stepMs).ms;
		}
		return {ms, ordered};
	}

	/**
	 * Finds the highest-level set of nodes whose route still leaves acceptable
	 * gathering time. Starts from the best nodes and repeatedly downgrades
	 * whichever one buys the most travel saving per level given up, stopping as
	 * soon as the schedule clears its guards.
	 */
	async optimiseRoute(from) {
		const plan = this.daily.plan || {};
		const pool = {};

		for (const act of Object.keys(plan)) {
			const c = await this.candidates(act);
			if (c.length) pool[act] = c;
		}

		if (!Object.keys(pool).length) return null;

		// Start with the best node for each activity.
		const choice = {};
		const idx = {};
		for (const [act, list] of Object.entries(pool)) {
			choice[act] = list[0];
			idx[act] = 0;
		}

		const evaluate = () => {
			const {ms, ordered} = this.routeCost(choice, from);
			const shared = ordered.filter((st) => plan[st.act].kind === "share");
			const fixedMs = ordered
				.filter((st) => plan[st.act].kind === "time")
				.reduce((a, st) => a + plan[st.act].value, 0);

			let per = null;
			if (shared.length) {
				per = Math.max(
					Math.floor((this.daily.budget - ms - fixedMs) / shared.length),
					0
				);
			}

			const perStop = ordered.map((st) =>
				plan[st.act].kind === "share" ? per : plan[st.act].value);
			const gatherMs = perStop.reduce((a, v) => a + v, 0);
			const minPerStop = perStop.length ? Math.min(...perStop) : 0;

			return {
				travelMs: ms, ordered, gatherMs, minPerStop, per,
				ok: minPerStop >= CONFIG.minGatherPerStopMs && gatherMs >= ms,
			};
		};

		let best = evaluate();
		const steps = [];

		// Hill-climb: each round, downgrade the single node that saves the most
		// travel per level surrendered.
		for (let guard = 0; guard < 40 && !best.ok; guard++) {
			let pick = null;

			for (const [act, list] of Object.entries(pool)) {
				const next = idx[act] + 1;
				if (next >= list.length) continue;

				const was = choice[act];
				choice[act] = list[next];
				const trial = evaluate();
				choice[act] = was;

				const saved = best.travelMs - trial.travelMs;
				const lost = Math.max(was.level - list[next].level, 1);
				const value = saved / lost;

				if (saved > 0 && (!pick || value > pick.value)) {
					pick = {act, next, value, saved, lost, node: list[next], trial};
				}
			}

			if (!pick) break;   // nothing left that helps

			choice[pick.act] = pick.node;
			idx[pick.act] = pick.next;
			best = pick.trial;
			steps.push(
				`${pick.act}: ${pool[pick.act][pick.next - 1].name} (Lv${pool[pick.act][pick.next - 1].level}) ` +
				`-> ${pick.node.name} (Lv${pick.node.level}), saves ${fmt(pick.saved)}`
			);
		}

		return {choice, steps, result: best};
	}

	/**
	 * Works out which stops will run, in what order, and what each costs.
	 * Shared by the live cycle and the setup-time preview, so the warning you
	 * get when scheduling reflects what will actually happen.
	 */
	async estimateDaily(from) {
		const plan = this.daily.plan || {};
		const overrides = this.daily.nodeOverrides || {};
		const stops = [];

		for (const act of Object.keys(plan)) {
			let node = null;

			// A node chosen by the optimiser wins over the highest-level pick.
			if (overrides[act]) {
				const list = await this.candidates(act);
				node = list.find((n) => n.name.toLowerCase() === overrides[act].toLowerCase()) || null;
			}

			if (!node) {
				try {
					node = await this.pickNode(act, {quiet: true});
				} catch (err) {
					node = null;
				}
			}

			if (!node) continue;
			stops.push({act, node, pos: node.pos || this.nodePos(act, node.name)});
		}

		if (!stops.length) return null;

		const unmapped = stops.filter((st) => !st.pos);
		const mappedStops = stops.filter((st) => st.pos);
		const planned = mappedStops.length ? mappedStops : stops;

		const ordered = this.orderByProximity(planned, from);
		const stepMs = this.stepMs();

		let travelMs = 0;
		let knownLegs = 0;
		for (const st of ordered) {
			if (st.fromDist) {
				travelMs += travelEstimate(st.fromDist, stepMs).ms;
				knownLegs++;
			}
		}

		// Unmapped legs would otherwise look free; charge them the average.
		const avgLeg = knownLegs ? travelMs / knownLegs : 0;
		const estTravel = travelMs + (ordered.length - knownLegs) * avgLeg;

		// Resolve budget shares.
		const limits = {};
		const shared = ordered.filter((st) => plan[st.act].kind === "share");
		const fixedMs = ordered
			.filter((st) => plan[st.act].kind === "time")
			.reduce((a, st) => a + plan[st.act].value, 0);

		let spare = null;
		let per = null;

		if (shared.length) {
			spare = this.daily.budget - estTravel - fixedMs;
			per = Math.max(Math.floor(spare / shared.length), CONFIG.minShareMs);
			for (const st of shared) limits[st.act] = {kind: "time", value: per};
		}

		for (const st of ordered) {
			if (!limits[st.act]) limits[st.act] = plan[st.act];
		}

		const gatherMs = ordered.reduce((a, st) => {
			const l = limits[st.act];
			return a + (l.kind === "time" ? l.value : 0);
		}, 0);

		const timed = ordered.filter((st) => limits[st.act].kind === "time");
		const minPerStop = timed.length
			? Math.min(...timed.map((st) => limits[st.act].value))
			: null;

		// Which stops fall under the gathering threshold, and by how much.
		const short = timed.filter((st) => limits[st.act].value < CONFIG.minGatherPerStopMs);

		return {
			ordered, unmapped, limits, travelMs, estTravel, fixedMs,
			gatherMs, spare, per, minPerStop, timed, short,
			knownTravelMs: travelMs,
			assumedTravelMs: Math.max(estTravel - travelMs, 0),
			assumedLegs: ordered.length - knownLegs,
			mapped: ordered.filter((st) => st.pos).length,
		};
	}

	/**
	 * The headline sentence: what travel costs, and what that leaves to
	 * gather with. Names the assumed portion separately so an estimate built
	 * on unmapped legs is not mistaken for a measurement.
	 */
	dailySummarySentence(est) {
		if (!est) return null;

		const travel = est.assumedTravelMs
			? `${fmt(est.estTravel)} (${fmt(est.knownTravelMs)} known + ${fmt(est.assumedTravelMs)} assumed ` +
				`across ${est.assumedLegs} unmapped leg${est.assumedLegs === 1 ? "" : "s"})`
			: `${fmt(est.estTravel)}`;

		if (!est.timed.length) {
			return `Your travel time of ${travel} applies before any gathering starts.`;
		}

		const total = est.timed.length;
		const short = est.short.length;

		let gather;
		if (!short) {
			gather = `${fmt(est.minPerStop)} or more for each of ${total} activities`;
		} else if (short === total) {
			gather = `under ${fmt(CONFIG.minGatherPerStopMs)} for all ${total} activities ` +
				`(as little as ${fmt(est.minPerStop)})`;
		} else {
			gather = `under ${fmt(CONFIG.minGatherPerStopMs)} for ${short} of ${total} activities ` +
				`(${est.short.map((st) => st.act).join(", ")}; as little as ${fmt(est.minPerStop)})`;
		}

		return `Your travel time of ${travel} will result in gather time of ${gather}.`;
	}

	/**
	 * Shown when no shorter route exists: what the best option actually is,
	 * and the ways to proceed anyway.
	 */
	sayOptions(est) {
		if (est) {
			const acts = est.ordered.map((st) =>
				`${st.act} @ ${st.node.name} (Lv${st.node.level})`).join(", ");
			this.say(`Best available: ${acts}`);
			this.say(
				`  ~${fmt(est.estTravel)} travel, ${fmt(est.gatherMs)} gathering, ` +
				`${fmt(est.minPerStop || 0)} at the shortest stop`
			);
		}

		this.say("Options:");
		if (this.daily.budget) {
			this.say(`  ${CMD} daily ignore budget    keep the per-stop times, overrun the window`);
		}
		this.say(`  ${CMD} daily ignore travel    accept travel exceeding gather time`);
		this.say(`  ${CMD} daily ignore minimum   accept stops under ${fmt(CONFIG.minGatherPerStopMs)}`);
		if (this.daily.budget) {
			this.say(`  ${CMD} daily adapt            re-divide the window as real travel is measured`);
		}
		this.say(`  ${CMD} daily accept            run it as-is`);
	}

	/** Reasons this schedule looks like a bad use of the window. */
	dailyWarnings(est) {
		const w = [];
		if (!est) return w;

		const ig = this.daily.ignore || {};

		if (!ig.minimum && est.minPerStop !== null && est.minPerStop < CONFIG.minGatherPerStopMs) {
			w.push(`only ${fmt(est.minPerStop)} gathering per stop ` +
				`(under the ${fmt(CONFIG.minGatherPerStopMs)} threshold)`);
		}

		if (!ig.travel && est.gatherMs && est.estTravel > est.gatherMs) {
			w.push(`travel ~${fmt(est.estTravel)} exceeds gathering ${fmt(est.gatherMs)}`);
		}

		if (!ig.budget && est.spare !== null && est.spare <= 0) {
			w.push(`budget ${fmt(this.daily.budget)} is entirely consumed by travel`);
		}

		return w;
	}

	async planDaily() {
		const stops = [];

		const plan = this.daily.plan || {};

		for (const act of Object.keys(plan)) {
			let node = null;
			try {
				node = await this.pickNode(act, {quiet: true});
			} catch (err) {
				node = null;
			}
			if (!node) continue;
			stops.push({act, node, pos: this.nodePos(act, node.name)});
		}

		if (!stops.length) {
			this.say("Daily cycle: could not resolve any nodes -- skipping today.");
			return;
		}

		// Drop stops whose node position is unknown. They cannot be routed, so
		// they land at the end of the run and their travel cost is a guess --
		// which throws off both the route and any wall-clock budget.
		const unmapped = stops.filter((st) => !st.pos);
		const mappedStops = stops.filter((st) => st.pos);

		if (unmapped.length && mappedStops.length) {
			this.say(
				`Skipping unmapped: ${unmapped.map((st) => `${st.act} (${st.node.name})`).join(", ")}` +
				` -- visit once with ${CMD} q <activity> to add ${unmapped.length === 1 ? "it" : "them"} to the map.`
			);
		}

		// Nothing mapped at all: run everything, since this is the survey pass.
		const planned = mappedStops.length ? mappedStops : stops;

		const ordered = this.orderByProximity(planned, this.lastPos);

		// Re-check the guards against the live route. If the schedule was
		// confirmed at setup we proceed; otherwise skip rather than spend the
		// night walking.
		{
			const est = await this.estimateDaily(this.lastPos);
			const warns = this.dailyWarnings(est);
			if (warns.length && !this.daily.accepted) {
				this.say(this.dailySummarySentence(est) || warns.join("; "));
				this.say(`Daily cycle skipped -- accept with ${CMD} daily accept, or change the plan.`);
				this.pendingWarnings = warns;
				this.pendingSummary = this.dailySummarySentence(est);
				this.armReminders();
				return;
			}
			this.pendingWarnings = null;
			this.pendingSummary = null;
			this.clearReminders();
		}
		const stepMs = this.stepMs();

		let travelMs = 0;
		for (const st of ordered) {
			if (st.fromDist) travelMs += travelEstimate(st.fromDist, stepMs).ms;
		}

		const mapped = ordered.filter((s) => s.pos).length;

		// Resolve any "share of budget" limits now that travel is estimated.
		const resolved = {};
		const shared = ordered.filter((st) => plan[st.act].kind === "share");

		if (shared.length) {
			// Unmapped stops contribute no estimate, so assume they cost about
			// the average of the ones we do know -- otherwise the budget would
			// be handed out as if they were free.
			const knownLegs = ordered.filter((st) => st.fromDist).length;
			const avgLeg = knownLegs ? travelMs / knownLegs : 0;
			const unknownLegs = ordered.length - knownLegs;
			const estTravel = travelMs + unknownLegs * avgLeg;

			const fixedMs = ordered
				.filter((st) => plan[st.act].kind === "time")
				.reduce((a, st) => a + plan[st.act].value, 0);

			const spare = this.daily.budget - estTravel - fixedMs;
			const each = Math.floor(spare / shared.length);

			if (each < CONFIG.minShareMs) {
				this.say(
					`Budget ${fmt(this.daily.budget)} leaves only ${fmt(Math.max(spare, 0))} ` +
					`for ${shared.length} stops after ~${fmt(estTravel)} travel` +
					(fixedMs ? ` and ${fmt(fixedMs)} fixed` : "") + ".");
				if (spare <= 0) {
					this.say("Nothing left to gather with -- skipping today.");
					return;
				}
				this.say(`Using the ${fmt(CONFIG.minShareMs)} minimum per stop instead.`);
			}

			const per = Math.max(each, CONFIG.minShareMs);
			for (const st of shared) resolved[st.act] = {kind: "time", value: per};

			this.say(
				`Budget ${fmt(this.daily.budget)} -- ~${fmt(estTravel)} travel` +
				(unknownLegs ? ` (${unknownLegs} leg${unknownLegs === 1 ? "" : "s"} estimated)` : "") +
				(fixedMs ? `, ${fmt(fixedMs)} fixed` : "") +
				` -> ${fmt(per)} each`
			);
		}

		const limitFor = (act) => resolved[act] || plan[act];
		const limitMs = ordered.reduce((a, st) => {
			const l = limitFor(st.act);
			return a + (l.kind === "time" ? l.value : 0);
		}, 0);

		this.queue = ordered.map(
			(st) => new Run(st.act, st.node.id || st.node.name, Object.assign({}, limitFor(st.act)))
		);

		this.say(
			`Daily cycle: ${ordered.length} stops -- ` +
			ordered.map((st) => `${st.act} ${describeLimit(limitFor(st.act))}`).join(" -> ")
		);
		this.say(
			`Route: ${mapped}/${ordered.length} nodes mapped` +
			(travelMs ? `, est. ${fmt(travelMs)} travel` : "") +
			(limitMs ? `, ${fmt(limitMs + travelMs)} total` : "")
		);

		this.advance();
	}

	dailyStatus() {
		if (!this.daily.enabled) {
			return `Daily cycle off. Set with ${CMD} daily all for 1h [at 02:00]`;
		}
		const when = this.nextDailyAt();
		const inMs = when.getTime() - Date.now();
		const plan = this.daily.plan || {};
		const what = this.daily.budget
			? `${Object.keys(plan).length} activities within ${fmt(this.daily.budget)} (travel included)`
			: describePlan(plan);
		return `Daily cycle on -- ${what}, at ${fmtUtc(this.daily.atMin)} ` +
			`(next ${when.toISOString().slice(0, 16).replace("T", " ")} UTC, in ${fmt(inMs)})` +
			(this.daily.adapt ? " | adaptive" : "") +
			(this.daily.ignore && Object.keys(this.daily.ignore).length
				? ` | ignoring: ${Object.keys(this.daily.ignore).join(", ")}`
				: "") +
			(this.finishers.length
				? ` | then: ${this.finishers.map(describeFinisher).join(", ")}`
				: "");
	}

	// -- asking DM questions ------------------------------------------------

	/** Send `text`, then buffer every DM line for collectMs and return them. */
	ask(text, until, ms) {
		if (this.collector) this.collector.finish();
		this.send(text);

		return new Promise((resolve) => {
			const c = {
				lines: [],
				timer: null,
				until: until || null,
				finish: () => {
					if (c.timer) clearTimeout(c.timer);
					if (this.collector === c) this.collector = null;
					resolve(c.lines);
				},
			};
			c.timer = setTimeout(c.finish, ms || CONFIG.collectMs);
			this.collector = c;
		});
	}

	async getLevel(activity) {
		const stat = ACTIVITIES[activity].stat;
		const hit = this.levels.get(stat);
		if (hit && Date.now() - hit.at < CONFIG.cacheMs) return hit.level;

		const lines = await this.ask(CONFIG.levelCommand, (l) => parseStats(l) !== null);
		const at = Date.now();

		for (const l of lines) {
			const stats = parseStats(l);
			if (!stats) continue;
			for (const [k, v] of Object.entries(stats)) this.levels.set(k, {level: v, at});
		}

		const got = this.levels.get(stat);
		return got ? got.level : null;
	}

	async getNodes(activity) {
		const hit = this.nodeCache.get(activity);
		if (hit && Date.now() - hit.at < CONFIG.cacheMs) return hit.nodes;

		const lines = await this.ask(
			`!${activity} ${ACTIVITIES[activity].noun}`,
			(l) => parseNodeList(l).length > 0
		);
		const nodes = lines.reduce((acc, l) => acc.concat(parseNodeList(l)), []);
		if (nodes.length) this.nodeCache.set(activity, {nodes, at: Date.now()});
		return nodes;
	}

	/** Highest-level node at or below our skill level. */
	async pickNode(activity, opts) {
		const quiet = opts && opts.quiet;
		const level = await this.getLevel(activity);
		const nodes = await this.getNodes(activity);

		if (!nodes.length) {
			if (!quiet) this.say(`Could not read a ${ACTIVITIES[activity].noun} list for !${activity}.`);
			return null;
		}

		const sorted = nodes.slice().sort((a, b) => b.level - a.level);

		if (level === null) {
			if (!quiet) this.say(`Could not read your ${ACTIVITIES[activity].skill} level -- using lowest node.`);
			return sorted[sorted.length - 1];
		}

		const eligible = sorted.filter((n) => n.level <= level);
		if (!eligible.length) {
			const lowest = sorted[sorted.length - 1];
			if (!quiet) this.say(`${ACTIVITIES[activity].skill} ${level} is below every node (min ${lowest.level}) -- trying ${lowest.name}.`);
			return lowest;
		}

		const best = eligible[0];
		const next = sorted.filter((n) => n.level > level).pop();
		if (!quiet) {
			this.say(
				`${ACTIVITIES[activity].skill} ${level} -> ${best.name} (lv ${best.level})` +
				(next ? `, next unlock ${next.name} at ${next.level}` : "")
			);
		}
		return best;
	}

	// -- scheduling --------------------------------------------------------

	clearTimer() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.confirmTimer) {
			clearTimeout(this.confirmTimer);
			this.confirmTimer = null;
		}
	}

	/**
	 * Only time-limited runs need a wall clock. Count and xp limits resolve on
	 * inbound ticks, so they arm nothing -- there is no stall detection
	 * anywhere: a quiet run is assumed to still be running, and only the user
	 * ends it (/unkgather skip or stop).
	 */
	armTimer() {
		this.clearTimer();
		const run = this.current;
		if (!run) return;

		const remaining = run.msRemaining();
		if (remaining === null) return;   // count/xp limit -- nothing to time

		this.timer = setTimeout(() => {
			this.timer = null;
			if (run.isDone()) this.finishRun();
			else this.armTimer();
		}, Math.max(Math.min(remaining, CONFIG.maxWaitMs), 1000));
	}

	// -- run lifecycle -----------------------------------------------------

	/**
	 * With `adapt` on, re-divides the remaining window across the stops still
	 * to come, using travel actually measured so far instead of the estimate.
	 * Runs before each stop, so an unexpectedly long walk shortens what
	 * follows rather than overrunning the window.
	 */
	adaptRemaining() {
		if (!this.dailyRunActive || !this.daily.adapt || !this.daily.budget) return;
		if (!this.dailyStartedAt || !this.queue.length) return;

		const elapsed = Date.now() - this.dailyStartedAt;
		const remainingBudget = this.daily.budget - elapsed;

		// Estimate the travel still ahead from the map.
		const stepMs = this.stepMs();
		let cur = this.lastPos;
		let travelAhead = 0;
		for (const run of this.queue) {
			const pos = this.nodePos(run.activity, run.confirmedNode || run.node);
			if (cur && pos) travelAhead += travelEstimate(manhattan(cur, pos), stepMs).ms;
			if (pos) cur = pos;
		}

		const spare = remainingBudget - travelAhead;
		const per = Math.floor(spare / this.queue.length);

		if (per < CONFIG.minShareMs) {
			this.say(
				`Window nearly spent (${fmt(Math.max(remainingBudget, 0))} left, ` +
				`~${fmt(travelAhead)} of it travel) -- dropping the last ` +
				`${this.queue.length} stop${this.queue.length === 1 ? "" : "s"}.`
			);
			this.queue = [];
			return;
		}

		const before = this.queue[0].limit.value;
		if (Math.abs(per - before) < 60000) return;   // not worth announcing

		for (const run of this.queue) run.limit = {kind: "time", value: per};
		this.say(
			`Adapting: ${fmt(remainingBudget)} left for ${this.queue.length} stops ` +
			`(~${fmt(travelAhead)} travel) -> ${fmt(per)} each` +
			(per < before ? ` (was ${fmt(before)})` : ` (up from ${fmt(before)})`)
		);
	}

	advance() {
		if (this.halted) return;
		this.adaptRemaining();

		if (!this.queue.length && this.rotation) {
			this.queue = this.rotation.map((r) => new Run(r.activity, r.node, r.limit));
		}

		if (!this.queue.length) {
			this.current = null;
			this.say("Queue empty.");
			this.runFinishers();
			return;
		}

		this.startRun(this.queue.shift());
	}

	async startRun(run) {
		if (this.starting) return;
		this.starting = true;

		try {
			let node = run.node;

			if (node === AUTO || (!node && CONFIG.autoNode)) {
				const picked = await this.pickNode(run.activity);
				node = picked ? (picked.id || picked.name) : null;
				run.resolved = picked;
			}

			if (this.halted) return;

			// A bare "!fish" is a STATUS QUERY, not a start. Sending it when
			// node resolution failed looks like a start that never confirms,
			// then burns the confirmation timeout. Fail immediately instead.
			if (!node) {
				this.say(
					`No node resolved for !${run.activity} -- not starting. ` +
					`Try ${CMD} nodes ${run.activity}, or queue an explicit node.`
				);
				this.current = null;
				setTimeout(() => this.advance(), CONFIG.minGapMs);
				return;
			}

			this.current = run;
			run.reset();
			run.state = "pending";
			run.requestedNode = node;
			this.send(node ? `!${run.activity} ${node}` : `!${run.activity}`);
			this.say(`Sent !${run.activity}${node ? " " + node : ""}` +
				(run.resolved ? ` (${run.resolved.name}, Lv${run.resolved.level}+)` : "") +
				` -- awaiting confirmation`);

			// The clock starts only when DM confirms. Until then, nothing counts.
			this.confirmTimer = setTimeout(() => {
				this.confirmTimer = null;
				if (this.current === run && run.state === "pending") {
					this.say(`No start confirmation for !${run.activity} after ${fmt(CONFIG.confirmMs)} -- skipping.`);
					this.current = null;
					this.advance();
				}
			}, CONFIG.confirmMs);
		} finally {
			this.starting = false;
		}
	}

	finishRun() {
		const run = this.current;
		if (!run) return;

		this.clearTimer();
		this.send(`!${run.activity} stop`);
		this.say(run.summary());
		this.recordRun(run);

		this.totals.runs++;
		this.totals.successes += run.successes;
		this.totals.xp += run.xp;
		for (const [name, n] of run.loot) {
			this.totals.loot.set(name, (this.totals.loot.get(name) || 0) + n);
		}

		this.current = null;
		setTimeout(() => this.advance(), CONFIG.minGapMs);
	}

	stopCurrent(reason) {
		const run = this.current;
		this.clearTimer();
		if (run) {
			this.send(`!${run.activity} stop`);
			this.say(`${run.summary()} (${reason})`);
			// Work done before an early stop still counts.
			if (run.state === "running" && run.ticks) this.recordRun(run);
			this.current = null;
		}
	}

	// -- outbound ----------------------------------------------------------

	send(text) {
		const irc = this.network.irc;
		if (!irc) return;
		const gap = CONFIG.minGapMs - (Date.now() - this.lastSend);
		const fire = () => {
			irc.say(CONFIG.botNick, text);
			this.lastSend = Date.now();
		};
		if (gap > 0) setTimeout(fire, gap); else fire();
	}
}

// ---------------------------------------------------------------------------
// "forage 3 for 10m" / "mine 2 x25" / "chop until 500xp" -> Run
// ---------------------------------------------------------------------------

/**
 * Pulls a trailing limit clause off a string.
 * Returns {limit, rest} -- limit is null if no clause was found.
 */
function extractLimit(text) {
	let s = String(text).trim();
	let limit = null;
	let m;

	if ((m = s.match(/(^|\s+)until\s+(\d+)\s*xp$/i))) {
		limit = {kind: "xp", value: parseInt(m[2], 10)};
		s = s.slice(0, m.index);
	} else if ((m = s.match(/(^|\s+)x\s*(\d+)$/i))) {
		limit = {kind: "count", value: parseInt(m[2], 10)};
		s = s.slice(0, m.index);
	} else if ((m = s.match(/(^|\s+)(\d+)\s*(?:actions?|hits?|successes)$/i))) {
		limit = {kind: "count", value: parseInt(m[2], 10)};
		s = s.slice(0, m.index);
	} else if ((m = s.match(/(^|\s+)for\s+(.+)$/i))) {
		const ms = parseDuration(m[2]);
		if (ms) {
			limit = {kind: "time", value: Math.min(ms, CONFIG.maxWaitMs)};
			s = s.slice(0, m.index);
		}
	}

	return {limit, rest: s.trim()};
}

/**
 * Parses one post-cycle action:
 *   waypoint 180 240   |   waypoint SeedHaven   |   gauntlet 3
 *   gauntlet Rust solo |   dungeon 5            |   dungeon
 */
/**
 * Parses a daily plan: a comma-separated list of "<activity|all> <limit>"
 * clauses. "all" sets the baseline for every activity; a named activity
 * overrides it. "<activity> off" excludes one.
 *
 *   all for 1h
 *   all for 1h, fish for 15m
 *   all for 1h, fish off
 *   mine for 90m, chop for 90m          (only these two run)
 *
 * Returns {plan: {activity: limit}, errors: []}. Every limit is independent,
 * so activities are equalised by time rather than by level.
 */
function parseDailyPlan(text) {
	const plan = {};
	const errors = [];
	let baseline = null;
	let budget = null;

	for (const raw of String(text).split(",")) {
		const clause = raw.trim();
		if (!clause) continue;

		// "within 10h" / "total 10h" -- a wall-clock budget covering travel.
		// Gathering time is derived from it once the route is known.
		const b = clause.match(/^(?:all\s+)?(?:within|total|budget|in)\s+(.+)$/i);
		if (b) {
			const ms = parseDuration(b[1]);
			if (!ms) {
				errors.push(`bad duration "${b[1]}"`);
				continue;
			}
			budget = ms;
			baseline = {kind: "share"};   // placeholder, resolved at plan time
			continue;
		}

		// "<name> off" excludes an activity from the cycle.
		const off = clause.match(/^(\S+)\s+(?:off|skip|none)$/i);
		if (off) {
			const act = resolveActivity(off[1]);
			if (!act) {
				errors.push(`unknown activity "${off[1]}"`);
				continue;
			}
			plan[act] = null;
			continue;
		}

		const {limit, rest} = extractLimit(clause);
		if (!limit) {
			errors.push(`no limit in "${clause}"`);
			continue;
		}

		const who = rest.trim().toLowerCase();

		if (!who || who === "all" || who === "each" || who === "every") {
			baseline = limit;
			continue;
		}

		const act = resolveActivity(who);
		if (!act) {
			errors.push(`unknown activity "${who}"`);
			continue;
		}

		plan[act] = limit;
	}

	// Apply the baseline to anything not named explicitly.
	if (baseline) {
		for (const act of Object.keys(ACTIVITIES)) {
			if (!(act in plan)) plan[act] = baseline;
		}
	}

	// Drop excluded entries now that the baseline has been applied.
	for (const act of Object.keys(plan)) {
		if (!plan[act]) delete plan[act];
	}

	return {plan, errors, baseline, budget};
}

function describePlan(plan) {
	const acts = Object.keys(plan);
	if (!acts.length) return "nothing";

	// Group activities that share a limit, for a compact summary.
	const groups = new Map();
	for (const act of acts) {
		const key = describeLimit(plan[act]);
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(act);
	}

	if (groups.size === 1 && acts.length === Object.keys(ACTIVITIES).length) {
		return `all ${[...groups.keys()][0]}`;
	}

	return [...groups.entries()]
		.map(([lim, list]) => `${list.join("+")} ${lim}`)
		.join(", ");
}

function parseFinisher(text) {
	const t = String(text).trim();
	if (!t) return null;

	const m = t.match(/^(waypoint|wp|gauntlet|gaunt|dungeon|dg)\b\s*(.*)$/i);
	if (!m) return null;

	const alias = m[1].toLowerCase();
	const kind = alias === "wp" ? "waypoint"
		: alias === "gaunt" ? "gauntlet"
		: alias === "dg" ? "dungeon"
		: alias;

	let arg = m[2].trim();
	if (kind === "waypoint" && !arg) return null;   // needs a destination

	// Gauntlets always run solo, so drop a redundant trailing "solo".
	if (kind === "gauntlet") arg = arg.replace(/\s*\bsolo\b\s*$/i, "").trim();

	return {kind, arg: arg || null};
}

function describeFinisher(f) {
	const base = f.arg ? `${f.kind} ${f.arg}` : f.kind;
	return f.kind === "gauntlet" ? `${base} (solo)` : base;
}

function parseRun(text) {
	if (!String(text).trim()) return null;

	const {limit, rest} = extractLimit(text);
	const s = rest;

	const parts = s.trim().replace(/^!/, "").split(/\s+/);
	const activity = (parts.shift() || "").toLowerCase();
	if (!ACTIVITIES[activity]) return null;

	const node = parts.join(" ") || (CONFIG.autoNode ? AUTO : null);
	return new Run(activity, node === "auto" ? AUTO : node, limit);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpLines() {
	const acts = Object.keys(ACTIVITIES).join("|");

	return [
		`${PLUGIN_NAME} v${VERSION} -- ${CMD} (alias /${ALIASES[0]})`,
		"",
		"SETUP",
		`  ${CMD} on                     watch PMs from ${CONFIG.botNick}`,
		`  ${CMD} off                    stop watching, cancel any run`,
		`  ${CMD} status                 what is running right now`,
		"",
		`QUEUE  -- a run is: <${acts}> [node] <limit>`,
		"       where limit is: for <time> | x<N> hits | until <N>xp",
		`  ${CMD} q forage for 10m       forage ten minutes, node auto-picked`,
		`  ${CMD} q mine x25             mine until 25 successful actions`,
		`  ${CMD} q chop until 500xp     chop until 500xp gained`,
		`  ${CMD} q fish 1 for 1h30m     fish node 1 for an hour and a half`,
		"",
		"  Queued runs happen one after another, then the queue empties.",
		"  To repeat them endlessly instead, separate runs with | and use rotate:",
		`  ${CMD} rotate forage for 10m | mine x25 | chop for 5m`,
		"       forage 10m, then mine 25 hits, then chop 5m, then start over.",
		"",
		`  ${CMD} list                   show what is running and queued`,
		`  ${CMD} clear                  empty queue and stop any rotation`,
		"",
		"DAILY  -- run every gathering skill once a day, unattended",
		`  ${CMD} daily within 10h      fit everything in 10h, travel included`,
		`  ${CMD} daily within 10h, fish off`,
		`  ${CMD} daily all for 1h      one hour of every activity`,
		`  ${CMD} daily all for 1h, fish for 15m, hunt off`,
		`  ${CMD} daily mine for 90m, chop for 90m at 02:00`,
		`  ${CMD} daily                 show schedule and next run`,
		`  ${CMD} daily accept          allow a schedule that was warned about`,
		`  ${CMD} daily no              find a shorter route using closer nodes`,
		`  ${CMD} daily options         best available route and ways to proceed`,
		`  ${CMD} daily ignore budget|travel|minimum`,
		`  ${CMD} daily adapt           re-divide the window as travel is measured`,
		"       Unaccepted schedules are reminded every 30m from 00:00 UTC.",
		`  ${CMD} daily off             cancel`,
		"       Each activity gets its own time; 'all' sets a baseline.",
		"       'within' divides a wall-clock budget after estimating travel.",
		"       The game day resets at 00:00 UTC; times are UTC.",
		"       Starts with !recall + !home, then walks the shortest route.",
		`  ${CMD} after gauntlet 3      run something once gathering finishes`,
		`  ${CMD} after waypoint 180 240 | dungeon 5    chain several`,
		`  ${CMD} after clear           cancel post-cycle actions`,
		`  ${CMD} map                   learned node positions and travel times`,
		`  ${CMD} home                  read home town from the game (!home)`,
		`  ${CMD} home <x>,<y>          override it manually`,
		"",
		"NODES",
		`  ${CMD} nodes <activity>       list nodes, * = your level allows it`,
		`  ${CMD} levels                 your skill levels`,
		`  ${CMD} auto on|off            auto-pick highest usable node (default on)`,
		`  ${CMD} refresh                clear cached levels and node lists`,
		"",
		"CONTROL",
		`  ${CMD} skip                   abandon current run, start next`,
		`  ${CMD} stop                   stop everything, clear queue`,
		`  ${CMD} resume                 un-halt after a blocked state`,
		`  ${CMD} loot                   session totals (since last restart)`,
		`  ${CMD} stats                  today's totals per activity`,
		`  ${CMD} stats yesterday        also: week, all, days, YYYY-MM-DD`,
		`  ${CMD} debug                  echo every DM line with its parse`,
		`  ${CMD} help                   this list`,
		"",
		"Time formats: 45s, 10m, 1h30m, 04:30.  Node names with spaces are fine.",
	];
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

module.exports = {
	onServerStart: (api) => {
		API = api;

		const handler = {
			allowDisconnected: true,
			input: function (client, target, command, args) {
				const key = target.network.uuid || target.network.name;
				let s = sessions.get(key);
				if (!s) {
					s = new Session(target.network, client, target.chan);
					sessions.set(key, s);
					// A Lounge restart drops in-memory state; rehydrate any
					// saved daily schedule the first time this session is used.
					if (s.restoreDaily()) {
						s.say(`Restored: ${s.dailyStatus()}`);
					}
				}
				s.client = client;
				s.chanId = target.chan;

				const sub = (args[0] || "status").toLowerCase();
				const rest = args.slice(1).join(" ");
				const acts = Object.keys(ACTIVITIES).join("|");

				// Anything that needs to READ DM's replies is useless without
				// the listener. Silently queueing work that can never observe a
				// result is worse than failing loudly, so attach on demand.
				const NEEDS_LISTENER = ["q", "queue", "rotate", "nodes", "levels", "skip", "resume", "daily", "after"];
				if (NEEDS_LISTENER.includes(sub) && !s.attached) {
					if (!s.attach()) return;   // attach() already reported why
					s.say(`Auto-attached (run ${CMD} on to do this explicitly).`);
				}

				switch (sub) {
					case "on":
						s.halted = null;
						if (s.attach()) s.say(`Watching PMs from ${CONFIG.botNick}.`);
						break;

					case "off":
						s.stopCurrent("detached");
						s.detach();
						s.say("Detached.");
						break;

					case "q":
					case "queue": {
						const run = parseRun(rest);
						if (!run) {
							s.say(`Usage: ${CMD} q <${acts}> [node] [for 10m | x25 | until 500xp]`);
							break;
						}
						s.queue.push(run);
						s.say(`Queued (${s.queue.length}): ${run.describe()}`);
						if (!s.current) s.advance();
						break;
					}

					case "rotate": {
						if (!rest) {
							s.rotation = null;
							s.say("Rotation cleared.");
							break;
						}
						const runs = rest.split("|").map((x) => parseRun(x)).filter(Boolean);
						if (!runs.length) {
							s.say(`Usage: ${CMD} rotate forage 3 for 10m | mine 2 x25`);
							break;
						}
						s.rotation = runs;
						s.queue = runs.map((r) => new Run(r.activity, r.node, r.limit));
						s.say(`Rotation set: ${runs.map((r) => r.describe()).join(" -> ")}`);
						if (!s.current) s.advance();
						break;
					}

					case "nodes": {
						const act = (rest || "").toLowerCase();
						if (!ACTIVITIES[act]) {
							s.say(`Usage: ${CMD} nodes <${acts}>`);
							break;
						}
						(async () => {
							const level = await s.getLevel(act);
							const nodes = await s.getNodes(act);
							if (!nodes.length) {
								s.say(`No ${ACTIVITIES[act].noun} parsed -- run ${CMD} debug and check the format.`);
								return;
							}
							nodes.slice().sort((a, b) => b.level - a.level).forEach((n) => {
								const ok = level === null ? "?" : n.level <= level ? "*" : " ";
								const extra = [n.terrain, n.quality].filter(Boolean).join(", ");
								s.say(`${ok} Lv${String(n.level).padStart(3)}+  [${n.id}] ${n.name}${extra ? "  (" + extra + ")" : ""}`);
							});
						})();
						break;
					}

					case "auto": {
						const v = (rest || "").toLowerCase();
						if (v === "on" || v === "off") CONFIG.autoNode = v === "on";
						s.say(`Auto node selection ${CONFIG.autoNode ? "on" : "off"}.`);
						break;
					}

					case "levels": {
						const show = () => {
							if (!s.levels.size) {
								s.say("No stats parsed from " + CONFIG.levelCommand);
								return;
							}
							const gather = [], other = [];
							for (const [k, v] of s.levels) {
								const label = `${STAT_NAMES[k] || k} ${v.level}`;
								(Object.values(ACTIVITIES).some((a) => a.stat === k) ? gather : other).push(label);
							}
							s.say(`gathering: ${gather.join(", ")}`);
							if (other.length) s.say(`other: ${other.join(", ")}`);
						};
						if (s.levels.size) show();
						else (async () => { await s.getLevel("forage"); show(); })();
						break;
					}

					case "refresh":
						s.levels.clear();
						s.nodeCache.clear();
						s.say("Level and node caches cleared.");
						break;

					case "skip":
						s.stopCurrent("skipped");
						s.advance();
						break;

					case "stop":
						s.stopCurrent("stopped");
						s.queue = [];
						s.rotation = null;
						break;

					case "resume":
						s.halted = null;
						s.say("Resumed.");
						s.advance();
						break;

					case "list":
						if (s.current) s.say(`* running: ${s.current.describe()}`);
						if (!s.queue.length) {
							s.say("Queue empty." + (s.rotation ? " (rotation will refill)" : ""));
							break;
						}
						s.queue.forEach((r, i) => s.say(`${i + 1}. ${r.describe()}`));
						break;

					case "clear":
						s.queue = [];
						s.rotation = null;
						s.say("Queue and rotation cleared.");
						break;

					case "loot": {
						const t = s.totals;
						const items = [...t.loot.entries()]
							.sort((a, b) => b[1] - a[1])
							.map(([n, q]) => `${q}x ${n}`)
							.join(", ");
						s.say(`Session: ${t.runs} runs, ${t.successes} hits, +${t.xp}xp${items ? " -- " + items : ""}`);
						break;
					}

					case "daily": {
						const arg = rest.trim();

						if (!arg) {
							s.say(s.dailyStatus());
							break;
						}

						if (/^ignore\b/i.test(arg)) {
							const what = arg.replace(/^ignore\s*/i, "").trim().toLowerCase();
							const map = {
								budget: "budget", total: "budget", time: "budget", window: "budget",
								travel: "travel",
								minimum: "minimum", min: "minimum", gather: "minimum",
							};
							const key = map[what];

							if (!key) {
								s.say(`Usage: ${CMD} daily ignore budget|travel|minimum   (or "none" to reset)`);
								if (what === "none" || what === "clear" || what === "reset") {
									s.daily.ignore = null;
									s.persistDaily();
									s.say("All thresholds re-enabled.");
								}
								break;
							}

							s.daily.ignore = Object.assign({}, s.daily.ignore, {[key]: true});
							s.daily.accepted = true;
							s.pendingWarnings = null;
							s.pendingSummary = null;
							s.clearReminders();
							s.persistDaily();
							s.say(`Ignoring ${key}. Active exemptions: ` +
								Object.keys(s.daily.ignore).join(", "));
							break;
						}

						if (/^(adapt|adaptive)$/i.test(arg)) {
							if (!s.daily.budget) {
								s.say(`Adapt needs a budget -- set one with ${CMD} daily within 10h`);
								break;
							}
							s.daily.adapt = !s.daily.adapt;
							s.daily.accepted = true;
							s.pendingWarnings = null;
							s.pendingSummary = null;
							s.clearReminders();
							s.persistDaily();
							s.say(s.daily.adapt
								? "Adapt on -- the window is re-divided across remaining stops as real travel is measured."
								: "Adapt off.");
							break;
						}

						if (/^(no|optimi[sz]e|closer|rethink)$/i.test(arg)) {
							if (!s.daily.enabled) {
								s.say("No daily cycle set.");
								break;
							}

							(async () => {
								s.say("Looking for a shorter route using closer nodes...");

								let opt = null;
								try {
									opt = await s.optimiseRoute(s.lastPos || s.home());
								} catch (err) {
									opt = null;
								}

								if (!opt) {
									s.say("Could not build an alternative -- no mapped nodes to choose from.");
									return;
								}

								if (!opt.steps.length) {
									s.say("No closer alternatives -- every activity has only one " +
										"reachable node at your level.");
									let est = null;
									try {
										est = await s.estimateDaily(s.lastPos || s.home());
									} catch (err) {
										est = null;
									}
									s.sayOptions(est);
									return;
								}

								s.daily.nodeOverrides = Object.fromEntries(
									Object.entries(opt.choice).map(([a, n]) => [a, n.name])
								);
								s.daily.accepted = false;
								s.persistDaily();

								opt.steps.forEach((line) => s.say("  " + line));

								const r = opt.result;
								s.say(
									`New route: ${r.ordered.map((st) => st.act).join(" -> ")} -- ` +
									`~${fmt(r.travelMs)} travel, ${fmt(r.minPerStop)} per stop`
								);

								if (r.ok) {
									s.daily.accepted = true;
									s.pendingWarnings = null;
									s.pendingSummary = null;
									s.clearReminders();
									s.persistDaily();
									s.say("This clears the thresholds and will run as scheduled.");
								} else {
									s.say(`Still short of ${fmt(CONFIG.minGatherPerStopMs)} per stop. ` +
										`${CMD} daily accept to run it anyway.`);
								}
							})();
							break;
						}

						if (/^(options|opts|why)$/i.test(arg)) {
							(async () => {
								let est = null;
								try {
									est = await s.estimateDaily(s.lastPos || s.home());
								} catch (err) {
									est = null;
								}
								const summary = s.dailySummarySentence(est);
								if (summary) s.say(summary);
								s.sayOptions(est);
							})();
							break;
						}

						if (/^(accept|confirm|force)$/i.test(arg)) {
							if (!s.daily.enabled) {
								s.say("No daily cycle set.");
								break;
							}
							s.daily.accepted = true;
							s.pendingWarnings = null;
							s.pendingSummary = null;
							s.clearReminders();
							s.persistDaily();
							s.say("Accepted -- the daily cycle will run as scheduled.");
							break;
						}

						if (/^(off|stop|disable)$/i.test(arg)) {
							s.daily.enabled = false;
							s.pendingWarnings = null;
							s.pendingSummary = null;
							s.clearReminders();
							if (s.dailyTimer) {
								clearTimeout(s.dailyTimer);
								s.dailyTimer = null;
							}
							s.persistDaily();
							s.say("Daily cycle off.");
							break;
						}

						// Optional "at HH:MM" suffix, then the per-activity plan.
						let text = arg;
						let atMin = s.daily.atMin;
						const at = text.match(/\s*\bat\s+(\S+)\s*(?:utc)?$/i);
						if (at) {
							const parsed = parseUtcTime(at[1]);
							if (parsed === null) {
								s.say(`Bad time "${at[1]}" -- use 24h UTC, e.g. at 02:00`);
								break;
							}
							atMin = parsed;
							text = text.slice(0, at.index);
						}

						const {plan, errors, budget} = parseDailyPlan(text);

						if (errors.length) {
							s.say(`Could not parse: ${errors.join("; ")}`);
							s.say(`Usage: ${CMD} daily all for 1h`);
							s.say(`       ${CMD} daily within 10h            split a budget, travel included`);
							s.say(`       ${CMD} daily within 10h, fish off`);
							s.say(`       ${CMD} daily all for 1h, fish for 15m, hunt off`);
							break;
						}

						if (!Object.keys(plan).length) {
							s.say(`Nothing scheduled. Try ${CMD} daily all for 1h`);
							break;
						}

						s.daily = {enabled: true, atMin, plan, budget, accepted: false,
							nodeOverrides: null, ignore: null, adapt: false};
						s.persistDaily();
						s.armDaily();
						s.say(s.dailyStatus());

						// Preview the route so a bad schedule is caught now,
						// not at 3am.
						(async () => {
							let est = null;
							try {
								est = await s.estimateDaily(s.lastPos || s.home());
							} catch (err) {
								est = null;
							}
							if (!est) return;

							s.say(`Estimate: ${est.ordered.length} stops, ` +
								`~${fmt(est.estTravel)} travel + ${fmt(est.gatherMs)} gathering ` +
								`= ${fmt(est.estTravel + est.gatherMs)}`);

							const warns = s.dailyWarnings(est);
							const summary = s.dailySummarySentence(est);

							s.pendingWarnings = warns.length ? warns : null;
							s.pendingSummary = warns.length ? summary : null;

							if (!warns.length) {
								s.clearReminders();
								return;
							}

							s.say(summary);
							s.say(`This will not run until accepted. Try ${CMD} daily no ` +
								`for a shorter route, or see ${CMD} daily options`);
							s.armReminders();
						})();

						// Show the per-activity breakdown when it is not uniform.
						const limits = new Set(Object.values(plan).map(describeLimit));
						if (limits.size > 1 || Object.keys(plan).length < Object.keys(ACTIVITIES).length) {
							Object.keys(plan).forEach((a) =>
								s.say(`  ${a.padEnd(8)} ${describeLimit(plan[a])}`));
							const skipped = Object.keys(ACTIVITIES).filter((a) => !(a in plan));
							if (skipped.length) s.say(`  skipped: ${skipped.join(", ")}`);
						}
						break;
					}

					case "after": {
						const arg = rest.trim();

						if (!arg) {
							s.say(s.finishers.length
								? `After the daily cycle: ${s.finishers.map(describeFinisher).join(", ")}`
								: `Nothing set. Try ${CMD} after gauntlet 3 | dungeon 5`);
							break;
						}

						if (/^(off|none|clear)$/i.test(arg)) {
							s.finishers = [];
							s.persistDaily();
							s.say("Post-cycle actions cleared.");
							break;
						}

						const parts = arg.split("|").map((x) => parseFinisher(x));
						if (parts.some((x) => !x)) {
							s.say(`Usage: ${CMD} after waypoint <x> <y>|<town> | gauntlet [id] | dungeon [id]`);
							s.say(`       ${CMD} after clear`);
							break;
						}

						s.finishers = parts;
						s.persistDaily();
						s.say(`After the daily cycle: ${parts.map(describeFinisher).join(", ")}`);
						break;
					}

					case "stats": {
						const arg = (rest || "today").trim().toLowerCase();

						if (arg === "today" || !arg) {
							s.reportStats(`today (${utcDay()} UTC)`, [utcDay()]);
						} else if (arg === "yesterday") {
							s.reportStats(`yesterday (${dayOffset(-1)} UTC)`, [dayOffset(-1)]);
						} else if (arg === "week" || arg === "7d") {
							const days = [];
							for (let i = 0; i < 7; i++) days.push(dayOffset(-i));
							s.reportStats("last 7 days", days);
						} else if (arg === "all") {
							s.reportStats("all recorded days", Object.keys(readJson(STATS_FILE, {})));
						} else if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
							s.reportStats(`${arg} UTC`, [arg]);
						} else if (arg === "days") {
							const keys = Object.keys(readJson(STATS_FILE, {})).sort().reverse();
							s.say(keys.length ? `Recorded days: ${keys.join(", ")}` : "Nothing recorded yet.");
						} else {
							s.say(`Usage: ${CMD} stats [today|yesterday|week|all|days|YYYY-MM-DD]`);
						}
						break;
					}

					case "home": {
						const arg = rest.trim();

						if (!arg) {
							// Ask the game rather than trusting the cache.
							(async () => {
								const h = await s.fetchHome();
								if (h) {
									s.say(`Home: ${h.town} (${h.coords[0]},${h.coords[1]})` +
										(h.available.length > 1
											? ` | available: ${h.available.join(", ")}`
											: ""));
								} else {
									const c = s.home();
									s.say(`Could not read !home -- using stored ${c[0]},${c[1]}. ` +
										`Set manually with ${CMD} home <x>,<y>`);
								}
							})();
							break;
						}

						const m = arg.match(/^(\d+)\s*[, ]\s*(\d+)$/);
						if (!m) {
							s.say(`Usage: ${CMD} home            read it from the game`);
							s.say(`       ${CMD} home 180,240   set manually`);
							break;
						}

						s.setHome([parseInt(m[1], 10), parseInt(m[2], 10)]);
						s.say(`Home set to ${m[1]},${m[2]}.`);
						break;
					}

					case "map": {
						const m = s.mapStore();
						const keys = Object.keys(m.nodes);
						if (!keys.length) {
							s.say("No nodes mapped yet -- positions are learned as you travel to them.");
							break;
						}
						s.say(`${keys.length} nodes mapped, ~${Math.round(s.stepMs() / 1000)}s/step ` +
							`(${m.stats.samples} sample${m.stats.samples === 1 ? "" : "s"})` +
							(s.lastPos ? ` | you are near ${s.lastPos[0]},${s.lastPos[1]}` : ""));
						keys.map((k) => m.nodes[k])
							.sort((a, b) => a.activity.localeCompare(b.activity))
							.forEach((n) => {
								const d = s.lastPos ? manhattan(s.lastPos, [n.x, n.y]) : null;
								const eta = d === null ? "" :
									`  ~${fmt(travelEstimate(d, s.stepMs()).ms)} away`;
								s.say(`  !${n.activity.padEnd(8)} ${n.name} @ ${n.x},${n.y}${eta}`);
							});
						break;
					}

					case "help":
					case "?":
						helpLines().forEach((l) => s.say(l));
						break;

					case "debug":
						s.debug = !s.debug;
						s.say(`Debug echo ${s.debug ? "on" : "off"}.`);
						break;

					case "status": {
						if (!s.current) {
							s.say(`${PLUGIN_NAME} v${VERSION} | attached=${s.attached} idle, queued=${s.queue.length}` +
								(s.halted ? ` HALTED: ${s.halted}` : ""));
							break;
						}
						const r = s.current;
						if (r.state === "pending") {
							s.say(`${r.describe()} -- awaiting start confirmation from ${CONFIG.botNick}`);
							break;
						}
						if (r.state === "traveling") {
							s.say(`${r.describe()} -- travelling to ${r.confirmedNode}` +
								` (${r.travelSteps} steps, ${fmt(Date.now() - r.travelStartedAt)}` +
								(r.coords ? `, at ${r.coords[0]},${r.coords[1]}` : "") + ")");
							break;
						}
						const pct = r.progress();
						const prog = pct === null ? "unbounded" : `${Math.min(100, Math.round(pct * 100))}%`;
						const rem = r.msRemaining();
						// With no stall detection, this is how you tell a live run
						// from a dead one -- check when the last tick landed.
						const quiet = r.lastTick ? Date.now() - r.lastTick : 0;
						s.say(
							`${r.describe()} -- ${prog}` +
							(rem !== null ? ` (${fmt(rem)} left)` : "") +
							` | ${r.successes}/${r.ticks} hits, +${r.xp}xp` +
							(r.ticks ? ` | last tick ${fmt(quiet)} ago` : "") +
							` | queued=${s.queue.length}`
						);
						break;
					}

					default:
						s.say(`Unknown subcommand "${sub}". Try ${CMD} help`);
				}
			},
		};

		// Same handler under the primary name and each alias.
		for (const name of [COMMAND].concat(ALIASES)) {
			api.Commands.add(name, handler);
		}
	},
};