"use strict";

/**
 * thelounge-plugin-seedrpg-gathering  v1.1.0
 *
 * A passive, read-only monitor for SeedRPG gathering. It watches DMs from
 * the game bot and tracks hits/xp/loot and learned node positions -- it
 * never sends anything to the game itself. Start/stop/control your own
 * gathering in-game as you normally would; this only listens.
 *
 * Registers /unkgather (alias /unkg). Run "/unkgather help" for the full list.
 *
 * Changelog
 *   1.1.0 /unkg stats now breaks results down by node, not just activity --
 *         stored as store[day][activity][node] instead of one bucket per
 *         activity. Old history (a flat bucket per activity, no node) still
 *         reads back fine, folded in as a single "unknown" node.
 *   1.0.0 Reworked from an automation plugin (queued runs, a daily cycle,
 *         auto-equip, auto-recall, ...) into a pure observer: the game's
 *         rules no longer allow sending automated commands, so every
 *         feature that sent one is gone. What's left reuses the same line
 *         parsing this plugin already knew (tags, xp/loot patterns, node
 *         lists, !skills, "Started X at Y!") to keep tracking stats and
 *         node positions from whatever you do manually. See git history
 *         for the previous automation design.
 */

const PLUGIN_NAME = "seedrpg-gathering";

// Slash command this plugin registers, plus a shorter alias.
const COMMAND = "unkgather";
const ALIASES = ["unkg"];
const CMD = "/" + COMMAND;
const VERSION = "1.1.0";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Game model
// ---------------------------------------------------------------------------

const ACTIVITIES = {
	fish:    {noun: "nodes", tag: "FISHING",     stat: "FSH", skill: "fishing"},
	mine:    {noun: "nodes", tag: "MINING",      stat: "MIN", skill: "mining"},
	chop:    {noun: "nodes", tag: "WOODCUTTING", stat: "WDC", skill: "woodcutting"},
	salvage: {noun: "nodes", tag: "SALVAGING",   stat: "SAL", skill: "salvaging"},
	forage:  {noun: "nodes", tag: "FORAGING",    stat: "FOR", skill: "foraging"},
	hunt:    {noun: "nodes", tag: "HUNTING",     stat: "HUN", skill: "hunting"},
};

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

	// Fallback only, for the ETA shown in "/unkg map" before a node's real
	// travel speed has been learned from watching a real trip to it.
	fallbackMsPerUnit: 67000,
};

// ---------------------------------------------------------------------------
// Line parsing
//
// Real DM output looks like:
//   [FORAGING] Nick digs a hole. The hole contains additional hole.
//   [FORAGING] Nick gathers 2x Wild Carrots. Farm to inventory. (2x standard) +35xp (base 35: Seedpool +1%)
//   [LEVEL UP] Foraging reached level 4!  -  Nick reached microservice architecture of mind
//
// Flavor text is randomized and enormous, so we never match on it. A tick is
// a success if it carries +Nxp. None of this ever triggers an outbound
// message -- it only classifies lines the game bot already sent.
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
	// [FISHING] Nick: Stopped fishing. 100 catches this session.
	stopped: /^(?:\S+:\s*)?Stopped\s+([a-z]+)\b/i,
	// [FISHING] Nick: Fishing Lv3 (609xp) | Not fishing
	statusLine: /^(?:\S+:\s*)?([A-Za-z]+)\s+Lv\s*(\d+)\s*\((\d+)\s*xp\)\s*\|\s*(.+)$/i,
};

/** Returns {tag, activity, success, xp, qty, quality, item, levelUp, death, move, loot, started, stopped, status} */
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

	// The game's own death signal. A normal death and a hardcore one both
	// carry [DEATH]; only a hardcore death also carries a separate
	// [HARDCORE] tag inline in the body, e.g. "You were slain by X!
	// [HARDCORE] Lost ... Your N equipped items were scattered to a
	// dungeon." Reported only -- nothing here can recover from it, since
	// that would mean sending !home/!recall/!equip.
	if (out.tag === "DEATH") {
		out.death = true;
		out.hardcoreDeath = /\[HARDCORE\]/.test(out.body);
		return out;
	}

	// Travel. Not actionable in itself, but it marks the walk to a node,
	// which must not be counted as a gathering tick.
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

	const sp = out.body.match(RE.stopped);
	if (sp) {
		out.stopped = {verb: sp[1].toLowerCase()};
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
// Only ever seen in passing (from a command the player typed themselves) --
// never requested. Note the whole node list arrives on ONE line, pipe-separated.
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

/** Parses a !skills line into {FSH: 3, MIN: 7, ...}. */
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
// Formatting / storage helpers
// ---------------------------------------------------------------------------

function fmt(ms) {
	if (ms <= 0) return "0s";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

function stripFormatting(str) {
	// eslint-disable-next-line no-control-regex
	return String(str).replace(/\x03(\d{1,2}(,\d{1,2})?)?|\x04[0-9a-fA-F]{6}|[\x00-\x1F]/g, "");
}

/** UTC date key -- the game day resets at 00:00 UTC, so days are UTC days. */
function utcDay(date) {
	return (date || new Date()).toISOString().slice(0, 10);
}

function dayOffset(days) {
	const d = new Date();
	d.setUTCDate(d.getUTCDate() + days);
	return utcDay(d);
}

/** Grid distance between two [x, y] points. Movement is axis-aligned. */
function manhattan(a, b) {
	return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

/**
 * Distance in coordinate units -> estimated travel time, given a ms/unit
 * rate learned from watching a real trip to that node (see
 * Session#rememberNode); falls back to a conservative worst case otherwise.
 * Only ever used for the "/unkg map" ETA display.
 */
function travelEstimate(units, msPerUnit) {
	return {ms: Math.round(units * (msPerUnit || CONFIG.fallbackMsPerUnit))};
}

const sessions = new Map();

// Set in onServerStart -- needed for the persistent storage path.
let API = null;

const MAP_FILE = "unkgather-nodes.json";
const STATS_FILE = "unkgather-stats.json";
const STATS_KEEP_DAYS = 60;

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

// ---------------------------------------------------------------------------
// Watch: one activity session currently being observed
// ---------------------------------------------------------------------------

class Watch {
	constructor(activity) {
		this.activity = activity;
		this.node = null;             // from "Started X at Y!"
		this.state = "traveling";     // traveling -> running
		this.travelFrom = null;
		this.travelStartedAt = Date.now();
		this.travelSteps = 0;
		this.travelMs = 0;
		this.coords = null;
		this.startedAt = 0;
		this.lastTick = 0;
		this.ticks = 0;
		this.successes = 0;
		this.xp = 0;
		this.loot = new Map();
	}

	summary() {
		const items = [...this.loot.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, n]) => `${n}x ${name}`)
			.join(", ");
		const elapsed = fmt(Date.now() - this.startedAt) +
			(this.travelMs ? ` (+${fmt(this.travelMs)} travel)` : "");
		const rate = this.ticks ? Math.round((this.successes / this.ticks) * 100) : 0;
		return `!${this.activity}${this.node ? " @ " + this.node : ""} stopped: ` +
			`${this.successes}/${this.ticks} hits (${rate}%), ` +
			`+${this.xp}xp, ${elapsed}${items ? " -- " + items : ""}`;
	}
}

// ---------------------------------------------------------------------------
// Session: one per network
// ---------------------------------------------------------------------------

class Session {
	constructor(network, client, chanId) {
		this.network = network;
		this.client = client;
		this.chanId = chanId;

		this.attached = false;
		this.debug = false;
		this.watch = null;
		this.lastPos = null;   // most recent coordinates seen

		this.totals = {runs: 0, successes: 0, xp: 0, loot: new Map()};
		this.levels = new Map();     // stat -> {level, at} -- from the last !skills line seen
		this.nodeCache = new Map();  // activity -> {nodes, at} -- from the last node list seen
	}

	say(text) {
		this.client.sendMessage(text, this.chanId);
	}

	// -- wiring: purely local, never sends anything to the game -----------

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
	}

	// -- inbound -------------------------------------------------------------

	onLine(line) {
		if (!line.trim()) return;
		const p = parseLine(line);

		if (this.debug) {
			const bits = [p.tag || "-"];
			if (p.success) bits.push(`HIT +${p.xp}xp`);
			if (p.item) bits.push(`${p.qty}x ${p.item}`);
			if (p.levelUp) bits.push(`LEVEL ${p.levelUp.level}`);
			this.say(`[${bits.join(" ")}] ${line}`);
		}

		if (p.levelUp) {
			this.say(`Level up: ${p.levelUp.skill} -> ${p.levelUp.level}`);
			return;
		}

		// Reported only -- nothing recovers from this. Recovering would mean
		// sending !home/!recall/!equip, which is exactly what is no longer
		// allowed.
		if (p.death) {
			this.say(`Death detected${p.hardcoreDeath ? " [HARDCORE]" : ""} -- ${line}`);
			return;
		}

		if (p.move) {
			if (this.watch && this.watch.state === "traveling") {
				this.watch.travelSteps++;
				if (p.coords) this.watch.coords = p.coords;
			}
			if (p.coords) this.lastPos = p.coords;
			return;
		}

		if (p.tag === "LOOT") {
			if (p.loot) {
				this.totals.loot.set(p.loot.item, (this.totals.loot.get(p.loot.item) || 0) + p.loot.qty);
				this.totals.xp += p.loot.xp;
				if (this.watch) this.watch.xp += p.loot.xp;
				if (this.debug) this.say(`[loot] ${p.loot.qty}x ${p.loot.item} +${p.loot.xp}xp`);
			}
			return;
		}

		// Passive caching -- whatever a node list or !skills line the player's
		// own commands turn up is remembered for display. Never asked for.
		if (p.activity) {
			const nodes = parseNodeList(line);
			if (nodes.length) this.nodeCache.set(p.activity, {nodes, at: Date.now()});
		}
		const stats = parseStats(line);
		if (stats) {
			for (const [k, v] of Object.entries(stats)) this.levels.set(k, {level: v, at: Date.now()});
		}

		if (p.status) return;   // reply to a bare "!<activity>" query, not a tick

		if (p.started) {
			const activity = p.activity || resolveActivity(p.started.verb);
			if (!activity) return;
			if (this.watch) this.finishWatch("switched");
			this.watch = new Watch(activity);
			this.watch.node = p.started.node;
			this.watch.travelFrom = this.lastPos;
			this.say(`Watching !${activity} -- travelling to ${p.started.node}`);
			return;
		}

		if (p.stopped) {
			if (this.watch) this.finishWatch("stopped");
			return;
		}

		// No "Started" line was seen for this (the plugin was turned on
		// mid-session) -- pick it up in progress rather than miss it entirely.
		if (!this.watch && p.activity && ACTIVITIES[p.activity] && p.success) {
			this.watch = new Watch(p.activity);
			this.watch.state = "running";
			this.watch.startedAt = Date.now();
			this.say(`Watching !${p.activity} (already in progress).`);
		}

		const w = this.watch;
		if (!w || w.activity !== p.activity) return;

		// Arrival. The first line tagged with our activity after the walk
		// means we are at the node -- THIS is where the clock starts. The
		// line itself is the "begins gathering" flavour, not a gather
		// attempt, so it is not counted as a tick.
		if (w.state === "traveling") {
			w.travelMs = Date.now() - w.travelStartedAt;

			if (w.coords) {
				this.rememberNode(w.activity, w.node, w.coords, w.travelSteps, w.travelMs, w.travelFrom);
				this.lastPos = w.coords;
			}

			w.state = "running";
			w.startedAt = Date.now();
			w.lastTick = Date.now();

			this.say(
				`Arrived at ${w.node}` +
				(w.travelSteps ? ` (${w.travelSteps} steps, ${fmt(w.travelMs)})` : "") +
				` -- watching`
			);
			return;
		}

		w.ticks++;
		w.lastTick = Date.now();

		if (p.success) {
			w.successes++;
			w.xp += p.xp || 0;
			if (p.item) w.loot.set(p.item, (w.loot.get(p.item) || 0) + (p.qty || 1));
		}
	}

	/** Finalizes the current watch: reports a summary and records it to per-day stats. */
	finishWatch(reason) {
		const w = this.watch;
		this.watch = null;
		if (!w) return;

		if (w.state !== "running") {
			this.say(`Stopped watching !${w.activity} before arrival (${reason}).`);
			return;
		}

		this.say(`${w.summary()} (${reason})`);

		if (w.ticks) this.recordWatch(w);

		this.totals.runs++;
		this.totals.successes += w.successes;
		this.totals.xp += w.xp;
		for (const [name, n] of w.loot) {
			this.totals.loot.set(name, (this.totals.loot.get(name) || 0) + n);
		}
	}

	// -- statistics -----------------------------------------------------------

	/** Fresh, empty per-node/activity stats bucket. */
	emptyBucket() {
		return {runs: 0, ticks: 0, hits: 0, xp: 0, gatherMs: 0, travelMs: 0, loot: {}};
	}

	addBucket(into, from) {
		into.runs += from.runs;
		into.ticks += from.ticks;
		into.hits += from.hits;
		into.xp += from.xp;
		into.gatherMs += from.gatherMs;
		into.travelMs += from.travelMs;
		for (const [item, n] of Object.entries(from.loot || {})) {
			into.loot[item] = (into.loot[item] || 0) + n;
		}
	}

	/** Stored per day as store[day][activity][node] -- so results can be told apart by node. */
	recordWatch(w) {
		const store = readJson(STATS_FILE, {});
		const day = utcDay();
		const node = w.node || "unknown";

		if (!store[day]) store[day] = {};
		if (!store[day][w.activity]) store[day][w.activity] = {};
		const bucket = store[day][w.activity][node] || this.emptyBucket();

		bucket.runs += 1;
		bucket.ticks += w.ticks;
		bucket.hits += w.successes;
		bucket.xp += w.xp;
		bucket.gatherMs += Math.max(0, Date.now() - w.startedAt);
		bucket.travelMs += w.travelMs || 0;
		for (const [item, n] of w.loot) {
			bucket.loot[item] = (bucket.loot[item] || 0) + n;
		}

		store[day][w.activity][node] = bucket;

		// Trim old days so the file cannot grow without bound.
		const cutoff = dayOffset(-STATS_KEEP_DAYS);
		for (const k of Object.keys(store)) {
			if (k < cutoff) delete store[k];
		}

		writeJson(STATS_FILE, store);
	}

	/**
	 * Merges one or more day buckets into a per-activity report, each with a
	 * per-node breakdown. Also reads the older flat "store[day][activity] =
	 * bucket" shape (from before results were split out by node) as a single
	 * node named "unknown", so past history still shows up.
	 */
	statsFor(days) {
		const store = readJson(STATS_FILE, {});
		const merged = {};

		for (const day of days) {
			const d = store[day];
			if (!d) continue;

			for (const [act, byNodeOrBucket] of Object.entries(d)) {
				if (!merged[act]) merged[act] = Object.assign(this.emptyBucket(), {byNode: {}});
				const m = merged[act];

				const byNode = typeof byNodeOrBucket.ticks === "number"
					? {unknown: byNodeOrBucket}
					: byNodeOrBucket;

				for (const [node, b] of Object.entries(byNode)) {
					if (!m.byNode[node]) m.byNode[node] = this.emptyBucket();
					this.addBucket(m.byNode[node], b);
				}
			}
		}

		for (const act of Object.keys(merged)) {
			const m = merged[act];
			for (const nb of Object.values(m.byNode)) this.addBucket(m, nb);
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

			// Only worth a breakdown once more than one node contributed --
			// otherwise it would just repeat the activity line above.
			const nodes = Object.keys(m.byNode);
			if (nodes.length > 1) {
				nodes.sort((a, b) => m.byNode[b].xp - m.byNode[a].xp).forEach((node) => {
					const nb = m.byNode[node];
					const nRate = nb.ticks ? Math.round((nb.hits / nb.ticks) * 100) : 0;
					this.say(
						`      ${node.padEnd(24)} ${String(nb.hits).padStart(4)}/${String(nb.ticks).padEnd(5)} ` +
						`${String(nRate).padStart(3)}%  ${String(nb.xp).padStart(6)}xp`
					);
				});
			}

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
		return m;
	}

	mapKey(activity, nodeName) {
		return `${activity}|${String(nodeName).toLowerCase()}`;
	}

	/**
	 * Records where a node is, learned from the last coords before arrival.
	 * When the trip's starting point is also known, this measures that
	 * approach's real ms-per-tile directly from distance covered and time
	 * taken -- travel speed depends on the region and road level along the
	 * way (roads run 1-5 tiles per step, off-road always 1), so it must be
	 * observed per node rather than assumed from one global constant. Purely
	 * informational: nothing here ever plans or sends a route.
	 */
	rememberNode(activity, nodeName, coords, steps, ms, from) {
		if (!coords || !nodeName) return;

		const m = this.mapStore();
		const key = this.mapKey(activity, nodeName);
		const prev = m.nodes[key];
		const entry = {
			activity,
			name: nodeName,
			x: coords[0],
			y: coords[1],
			seen: new Date().toISOString(),
		};

		if (prev && prev.msPerUnit) {
			entry.msPerUnit = prev.msPerUnit;
			entry.samples = prev.samples || 1;
		}

		// A short trip (few steps) is too noisy to trust, so it is recorded
		// but not used to refine the speed estimate.
		const dist = from ? manhattan(from, coords) : 0;
		if (steps > 2 && dist > 0 && ms > 0) {
			const rate = ms / dist;
			const n = entry.samples || 0;
			entry.msPerUnit = Math.round(((entry.msPerUnit || rate) * n + rate) / (n + 1));
			entry.samples = n + 1;
		}

		m.nodes[key] = entry;

		writeJson(MAP_FILE, m);
	}
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function helpLines() {
	return [
		`${PLUGIN_NAME} v${VERSION} -- ${CMD} (alias /${ALIASES[0]})`,
		"",
		"Passively watches DMs from the game bot and tracks your gathering --",
		"it never sends anything to the game itself. Start, stop, and control",
		"your own gathering in-game as usual; this only listens and keeps stats.",
		"",
		`  ${CMD} on                    :start watching PMs from ${CONFIG.botNick}`,
		`  ${CMD} off                   :stop watching`,
		`  ${CMD} status                :what's being watched right now, if anything`,
		`  ${CMD} stats                 :today's totals per activity`,
		`  ${CMD} stats yesterday       :also: week, all, days, YYYY-MM-DD`,
		`  ${CMD} loot                  :session totals (since last restart)`,
		`  ${CMD} map                   :node positions/travel times learned from your trips`,
		`  ${CMD} nodes <activity>      :last node list seen for that activity, if any`,
		`  ${CMD} levels                :last !skills line seen, if any`,
		`  ${CMD} debug                 :echo every DM line with its parse`,
		`  ${CMD} help                  :this list`,
		"",
		"Node lists and !skills are only ever learned by seeing you run those",
		"commands yourself -- this plugin has no way to ask for them.",
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
				}
				s.client = client;
				s.chanId = target.chan;

				const sub = (args[0] || "status").toLowerCase();
				const rest = args.slice(1).join(" ");

				switch (sub) {
					case "on":
						if (s.attach()) s.say(`Watching PMs from ${CONFIG.botNick}.`);
						break;

					case "off":
						s.detach();
						s.say("Detached.");
						break;

					case "status": {
						if (!s.attached) {
							s.say(`${PLUGIN_NAME} v${VERSION} | not attached -- ${CMD} on to start watching`);
							break;
						}
						const w = s.watch;
						if (!w) {
							s.say(`${PLUGIN_NAME} v${VERSION} | attached=true | nothing being watched`);
							break;
						}
						if (w.state === "traveling") {
							s.say(
								`Watching !${w.activity} -- travelling to ${w.node} ` +
								`(${w.travelSteps} steps, ${fmt(Date.now() - w.travelStartedAt)})`
							);
							break;
						}
						const rate = w.ticks ? Math.round((w.successes / w.ticks) * 100) : 0;
						s.say(
							`Watching !${w.activity} @ ${w.node} -- ${fmt(Date.now() - w.startedAt)}, ` +
							`${w.successes}/${w.ticks} hits (${rate}%), +${w.xp}xp`
						);
						break;
					}

					case "loot": {
						const t = s.totals;
						const items = [...t.loot.entries()]
							.sort((a, b) => b[1] - a[1])
							.map(([n, q]) => `${q}x ${n}`)
							.join(", ");
						s.say(`Session: ${t.runs} runs, ${t.successes} hits, +${t.xp}xp${items ? " -- " + items : ""}`);
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

					case "map": {
						const m = s.mapStore();
						const keys = Object.keys(m.nodes);
						if (!keys.length) {
							s.say("No nodes mapped yet -- positions are learned by watching you gather.");
							break;
						}
						const timed = keys.map((k) => m.nodes[k]).filter((n) => n.msPerUnit);
						s.say(
							`${keys.length} nodes mapped, ${timed.length} with a measured travel speed` +
							(s.lastPos ? ` | last known position ${s.lastPos[0]},${s.lastPos[1]}` : "")
						);
						keys.map((k) => m.nodes[k])
							.sort((a, b) => a.activity.localeCompare(b.activity))
							.forEach((n) => {
								const d = s.lastPos ? manhattan(s.lastPos, [n.x, n.y]) : null;
								const eta = d === null ? "" :
									`  ~${fmt(travelEstimate(d, n.msPerUnit).ms)} away` +
									(n.msPerUnit ? "" : " (unmeasured, worst case)");
								s.say(`  !${n.activity.padEnd(8)} ${n.name} @ ${n.x},${n.y}${eta}`);
							});
						break;
					}

					case "nodes": {
						const act = resolveActivity(rest.trim());
						if (!act) {
							s.say(`Usage: ${CMD} nodes <activity>   (shows the last list seen for it, if any)`);
							break;
						}
						const hit = s.nodeCache.get(act);
						if (!hit) {
							s.say(`No ${act} node list seen yet -- run "!${act} ${ACTIVITIES[act].noun}" yourself in-game once.`);
							break;
						}
						hit.nodes.slice().sort((a, b) => b.level - a.level).forEach((n) => {
							const extra = [n.terrain, n.quality].filter(Boolean).join(", ");
							s.say(`  Lv${String(n.level).padStart(3)}+  [${n.id}] ${n.name}${extra ? "  (" + extra + ")" : ""}`);
						});
						break;
					}

					case "levels": {
						if (!s.levels.size) {
							s.say(`No !skills line seen yet -- run !skills yourself in-game once.`);
							break;
						}
						s.say([...s.levels.entries()].map(([k, v]) => `${k}:${v.level}`).join(" "));
						break;
					}

					case "debug":
						s.debug = !s.debug;
						s.say(`Debug echo ${s.debug ? "on" : "off"}.`);
						break;

					case "help":
					case "?":
						helpLines().forEach((l) => s.say(l));
						break;

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
