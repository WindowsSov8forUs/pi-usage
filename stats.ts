import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const USAGE_RANGES = ["all", "7d", "30d"] as const;
export type UsageRange = typeof USAGE_RANGES[number];

export type UsageSample = {
	timestamp: number;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
};

export type ModelUsageSummary = {
	key: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cache: number;
	tokens: number;
	daily: Map<string, number>;
};

export type UsageStatistics = {
	dateKeys: string[];
	models: ModelUsageSummary[];
	totalTokens: number;
};

export type StatsTheme = {
	fg: (color: "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text" | "syntaxFunction" | "syntaxString", text: string) => string;
	bold: (text: string) => string;
};

type DisplayModel = ModelUsageSummary & { label: string };

type StatsRenderOptions = {
	width: number;
	height?: number;
	theme: StatsTheme;
	statistics: UsageStatistics;
	labels: Map<string, string>;
	range: UsageRange;
	loading?: boolean;
	error?: string;
	maxModels?: number;
};

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function nonnegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function entryTimestamp(entry: Record<string, unknown>, message: Record<string, unknown>): number | undefined {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	if (typeof entry.timestamp === "string") {
		const parsed = Date.parse(entry.timestamp);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function sampleFromEntry(value: unknown): UsageSample | undefined {
	const entry = record(value);
	const message = record(entry?.message);
	if (entry?.type !== "message" || message?.role !== "assistant") return undefined;
	if (typeof message.provider !== "string" || !message.provider || typeof message.model !== "string" || !message.model) return undefined;
	const timestamp = entryTimestamp(entry, message);
	if (timestamp === undefined) return undefined;
	const usage = record(message.usage);
	if (!usage) return undefined;
	const input = nonnegativeNumber(usage.input);
	const output = nonnegativeNumber(usage.output);
	const cacheRead = nonnegativeNumber(usage.cacheRead);
	const cacheWrite = nonnegativeNumber(usage.cacheWrite);
	const reportedTotal = nonnegativeNumber(usage.totalTokens);
	const tokens = input + output > 0 ? input + output : reportedTotal;
	if (tokens <= 0 && cacheRead + cacheWrite <= 0) return undefined;
	return {
		timestamp,
		provider: message.provider,
		model: message.model,
		input,
		output,
		cacheRead,
		cacheWrite,
		tokens,
	};
}

export function extractUsageSamples(entries: unknown[]): UsageSample[] {
	return entries.flatMap((entry) => {
		const sample = sampleFromEntry(entry);
		return sample ? [sample] : [];
	});
}

function sampleFingerprint(sample: UsageSample): string {
	return [
		sample.timestamp,
		sample.provider,
		sample.model,
		sample.input,
		sample.output,
		sample.cacheRead,
		sample.cacheWrite,
		sample.tokens,
	].join("|");
}

export function mergeUsageSamples(...groups: UsageSample[][]): UsageSample[] {
	const unique = new Map<string, UsageSample>();
	for (const sample of groups.flat()) unique.set(sampleFingerprint(sample), sample);
	return [...unique.values()].sort((left, right) => left.timestamp - right.timestamp);
}

async function sessionFiles(directory: string): Promise<string[]> {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...await sessionFiles(path));
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
	}
	return files;
}

async function samplesFromSessionFile(path: string): Promise<UsageSample[]> {
	const samples: UsageSample[] = [];
	try {
		const input = createReadStream(path, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				const sample = sampleFromEntry(JSON.parse(line));
				if (sample) samples.push(sample);
			} catch {
				// Ignore a partial final line while Pi is still writing the active session.
			}
		}
	} catch {
		// One unreadable session should not hide statistics from every other session.
	}
	return samples;
}

export async function loadHistoricalUsageSamples(sessionRoot: string): Promise<UsageSample[]> {
	const files = await sessionFiles(sessionRoot);
	const samples: UsageSample[] = [];
	for (const path of files.sort()) samples.push(...await samplesFromSessionFile(path));
	return mergeUsageSamples(samples);
}

function startOfLocalDay(timestamp: number): Date {
	const date = new Date(timestamp);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addLocalDays(date: Date, count: number): Date {
	const result = new Date(date);
	result.setDate(result.getDate() + count);
	return result;
}

function dateKey(date: Date): string {
	return [
		String(date.getFullYear()).padStart(4, "0"),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

function rangeStart(samples: UsageSample[], range: UsageRange, today: Date): Date {
	if (range === "7d") return addLocalDays(today, -6);
	if (range === "30d") return addLocalDays(today, -29);
	const earliest = samples.reduce((minimum, sample) => Math.min(minimum, sample.timestamp), Number.POSITIVE_INFINITY);
	return Number.isFinite(earliest) ? startOfLocalDay(earliest) : today;
}

export function summarizeUsage(samples: UsageSample[], range: UsageRange, now = Date.now()): UsageStatistics {
	const today = startOfLocalDay(now);
	const start = rangeStart(samples, range, today);
	const startMs = start.getTime();
	const dateKeys: string[] = [];
	for (let date = start; date.getTime() <= today.getTime(); date = addLocalDays(date, 1)) dateKeys.push(dateKey(date));
	const models = new Map<string, ModelUsageSummary>();
	for (const sample of samples) {
		if (sample.timestamp < startMs || sample.timestamp > now) continue;
		const key = `${sample.provider}/${sample.model}`;
		let summary = models.get(key);
		if (!summary) {
			summary = {
				key,
				provider: sample.provider,
				model: sample.model,
				input: 0,
				output: 0,
				cache: 0,
				tokens: 0,
				daily: new Map(),
			};
			models.set(key, summary);
		}
		summary.input += sample.input;
		summary.output += sample.output;
		summary.cache += sample.cacheRead + sample.cacheWrite;
		summary.tokens += sample.tokens;
		const day = dateKey(startOfLocalDay(sample.timestamp));
		summary.daily.set(day, (summary.daily.get(day) ?? 0) + sample.tokens);
	}
	const sorted = [...models.values()].sort((left, right) => right.tokens - left.tokens || left.key.localeCompare(right.key));
	return {
		dateKeys,
		models: sorted,
		totalTokens: sorted.reduce((total, model) => total + model.tokens, 0),
	};
}

export function formatCompactNumber(value: number): string {
	const units: Array<[number, string]> = [[1_000_000_000, "b"], [1_000_000, "m"], [1_000, "k"]];
	for (const [size, suffix] of units) {
		if (Math.abs(value) >= size) {
			return `${(value / size).toFixed(1).replace(/\.0$/, "")}${suffix}`;
		}
	}
	return Math.round(value).toLocaleString("en-US");
}

function formatAxisNumber(value: number): string {
	return formatCompactNumber(value).replace(/m$/, "M").replace(/b$/, "B");
}

function niceMaximum(value: number): number {
	if (value <= 0) return 1;
	const step = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1);
	return Math.ceil(value / step) * step;
}

const UP = 1;
const DOWN = 2;
const LEFT = 4;
const RIGHT = 8;

function pathCharacter(bits: number): string {
	const characters: Record<number, string> = {
		[UP]: "│",
		[DOWN]: "│",
		[LEFT]: "─",
		[RIGHT]: "─",
		[UP | DOWN]: "│",
		[LEFT | RIGHT]: "─",
		[UP | RIGHT]: "╰",
		[UP | LEFT]: "╯",
		[DOWN | RIGHT]: "╭",
		[DOWN | LEFT]: "╮",
		[UP | DOWN | RIGHT]: "├",
		[UP | DOWN | LEFT]: "┤",
		[LEFT | RIGHT | UP]: "┴",
		[LEFT | RIGHT | DOWN]: "┬",
		[UP | DOWN | LEFT | RIGHT]: "┼",
	};
	return characters[bits] ?? "•";
}

function connectPath(grid: number[][], x1: number, y1: number, x2: number, y2: number): void {
	let x = x1;
	let y = y1;
	while (x !== x2 || y !== y2) {
		const nextX = x === x2 ? x : x + Math.sign(x2 - x);
		const nextY = y === y2 ? y : y + Math.sign(y2 - y);
		if (nextX > x) {
			grid[y][x] |= RIGHT;
			grid[nextY][nextX] |= LEFT;
		} else if (nextX < x) {
			grid[y][x] |= LEFT;
			grid[nextY][nextX] |= RIGHT;
		} else if (nextY > y) {
			grid[y][x] |= DOWN;
			grid[nextY][nextX] |= UP;
		} else {
			grid[y][x] |= UP;
			grid[nextY][nextX] |= DOWN;
		}
		x = nextX;
		y = nextY;
	}
}

function valuesForColumns(model: DisplayModel, dateKeys: string[], width: number): number[] {
	if (dateKeys.length === 0) return Array(width).fill(0);
	return Array.from({ length: width }, (_, column) => {
		const startIndex = Math.min(dateKeys.length - 1, Math.floor(column * dateKeys.length / width));
		const endIndex = Math.max(startIndex, Math.floor((column + 1) * dateKeys.length / width) - 1);
		let total = 0;
		for (let index = startIndex; index <= endIndex; index++) total += model.daily.get(dateKeys[index]) ?? 0;
		return total / (endIndex - startIndex + 1);
	});
}

const SERIES_COLORS = ["accent", "success", "warning", "error", "syntaxFunction", "syntaxString"] as const;

function renderChart(models: DisplayModel[], dateKeys: string[], width: number, height: number, theme: StatsTheme): string[] {
	const rawMaximum = Math.max(0, ...models.flatMap((model) => [...model.daily.values()]));
	const maximum = niceMaximum(rawMaximum);
	const yLabels = Array.from({ length: height }, (_, row) => formatAxisNumber(maximum * (height - 1 - row) / (height - 1)));
	const labelWidth = Math.max(1, ...yLabels.map((label) => visibleWidth(label)));
	const plotWidth = Math.max(8, width - labelWidth - 2);
	const paths = models.map((model) => {
		const grid = Array.from({ length: height }, () => Array(plotWidth).fill(0) as number[]);
		const values = valuesForColumns(model, dateKeys, plotWidth);
		const points = values.map((value, x) => ({
			x,
			y: Math.max(0, Math.min(height - 1, Math.round((height - 1) * (1 - value / maximum)))),
		}));
		for (let index = 1; index < points.length; index++) {
			const previous = points[index - 1];
			const current = points[index];
			connectPath(grid, previous.x, previous.y, current.x, previous.y);
			connectPath(grid, current.x, previous.y, current.x, current.y);
		}
		return grid;
	});
	const lines: string[] = [];
	for (let row = 0; row < height; row++) {
		let plot = "";
		for (let column = 0; column < plotWidth; column++) {
			let series = -1;
			for (let index = 0; index < paths.length; index++) {
				if (paths[index][row][column] !== 0) {
					series = index;
					break;
				}
			}
			plot += series < 0 ? " " : theme.fg(SERIES_COLORS[series % SERIES_COLORS.length], pathCharacter(paths[series][row][column]));
		}
		const crossesAxis = paths.some((path) => (path[row][0] & RIGHT) !== 0);
		const axis = row === height - 1 || crossesAxis ? "┼" : "┤";
		lines.push(`${yLabels[row].padStart(labelWidth)} ${theme.fg("dim", axis)}${plot}`);
	}
	return lines;
}

function dateLabel(key: string): string {
	const [year, month, day] = key.split("-").map(Number);
	return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(year, month - 1, day));
}

function renderDateAxis(dateKeys: string[], width: number, labelWidth: number): string {
	if (dateKeys.length === 0) return "";
	const prefix = " ".repeat(labelWidth + 2);
	const plotWidth = Math.max(8, width - labelWidth - 2);
	const maximumLabels = plotWidth >= 72 ? 4 : plotWidth >= 42 ? 3 : 2;
	const count = Math.min(maximumLabels, dateKeys.length);
	const characters = Array(plotWidth).fill(" ") as string[];
	let occupiedUntil = -1;
	for (let index = 0; index < count; index++) {
		const dateIndex = Math.min(dateKeys.length - 1, Math.floor((index + 0.5) * dateKeys.length / count));
		const label = dateLabel(dateKeys[dateIndex]);
		const bucketCenter = (dateIndex + 0.5) * plotWidth / dateKeys.length - 0.5;
		const start = Math.max(0, Math.min(plotWidth - label.length, Math.round(bucketCenter - (label.length - 1) / 2)));
		if (start <= occupiedUntil) continue;
		for (let offset = 0; offset < label.length; offset++) characters[start + offset] = label[offset];
		occupiedUntil = start + label.length;
	}
	return prefix + characters.join("");
}

function wrapLegend(models: DisplayModel[], width: number, theme: StatsTheme): string[] {
	const lines: string[] = [];
	let line = "";
	for (const [index, model] of models.entries()) {
		const bullet = theme.fg(SERIES_COLORS[index % SERIES_COLORS.length], "●");
		const segment = `${bullet} ${model.label}`;
		const separator = line ? theme.fg("dim", " · ") : "";
		if (line && visibleWidth(line + separator + segment) > width) {
			lines.push(line);
			line = segment;
		} else line += separator + segment;
	}
	if (line) lines.push(line);
	return lines;
}

function padVisible(text: string, width: number): string {
	return truncateToWidth(text, width, "") + " ".repeat(Math.max(0, width - visibleWidth(truncateToWidth(text, width, ""))));
}

function summaryLines(models: DisplayModel[], total: number, width: number, theme: StatsTheme): string[] {
	const block = (model: DisplayModel, index: number): [string, string] => {
		const share = total > 0 ? 100 * model.tokens / total : 0;
		const bullet = theme.fg(SERIES_COLORS[index % SERIES_COLORS.length], "●");
		const heading = `${bullet} ${model.label}${theme.fg("dim", ` (${share.toFixed(1)}%)`)}`;
		const cache = model.cache > 0 ? ` · Cache: ${formatCompactNumber(model.cache)}` : "";
		const details = `  In: ${formatCompactNumber(model.input)} · Out: ${formatCompactNumber(model.output)}${cache}`;
		return [heading, theme.fg("dim", details)];
	};
	if (width < 76 || models.length < 2) return models.flatMap((model, index) => block(model, index));
	const rows = Math.ceil(models.length / 2);
	const columnWidth = Math.floor((width - 3) / 2);
	const lines: string[] = [];
	for (let row = 0; row < rows; row++) {
		const left = block(models[row], row);
		const rightIndex = row + rows;
		const right = rightIndex < models.length ? block(models[rightIndex], rightIndex) : ["", ""] as [string, string];
		lines.push(`${padVisible(left[0], columnWidth)}   ${truncateToWidth(right[0], columnWidth, "")}`);
		lines.push(`${padVisible(left[1], columnWidth)}   ${truncateToWidth(right[1], columnWidth, "")}`);
	}
	return lines;
}

function rangeSelector(range: UsageRange, theme: StatsTheme): string {
	const labels: Array<[UsageRange, string]> = [["all", "All time"], ["7d", "Last 7 days"], ["30d", "Last 30 days"]];
	return labels.map(([value, label]) => value === range
		? theme.fg("accent", theme.bold(label))
		: theme.fg("dim", label)).join(theme.fg("dim", " · "));
}

export function renderUsageStats(options: StatsRenderOptions): string[] {
	const width = Math.max(20, Math.min(88, options.width));
	const displayModels = options.statistics.models.slice(0, options.maxModels ?? 6).map((model) => ({
		...model,
		label: options.labels.get(model.key) ?? model.model,
	}));
	if (displayModels.length === 0) {
		return [
			options.theme.bold("Tokens per Day"),
			"",
			options.loading
				? options.theme.fg("dim", "Loading usage history…")
				: options.theme.fg("dim", "No model usage was found in Pi sessions."),
			"",
			rangeSelector(options.range, options.theme),
			"",
			options.theme.fg("dim", "←/→ range · Tab pages · Esc to close"),
		];
	}
	const requestedHeight = options.height ?? 9;
	const chartHeight = Math.max(5, Math.min(9, requestedHeight));
	const maximum = niceMaximum(Math.max(0, ...displayModels.flatMap((model) => [...model.daily.values()])));
	const labelWidth = Math.max(...Array.from({ length: chartHeight }, (_, row) =>
		visibleWidth(formatAxisNumber(maximum * (chartHeight - 1 - row) / (chartHeight - 1)))));
	const lines = [
		options.theme.bold("Tokens per Day"),
		...renderChart(displayModels, options.statistics.dateKeys, width, chartHeight, options.theme),
		options.theme.fg("dim", renderDateAxis(options.statistics.dateKeys, width, labelWidth)),
		...wrapLegend(displayModels, width, options.theme),
		"",
		rangeSelector(options.range, options.theme),
		"",
		...summaryLines(displayModels, options.statistics.totalTokens, width, options.theme),
	];
	if (options.statistics.models.length > displayModels.length) {
		lines.push(options.theme.fg("dim", `+ ${options.statistics.models.length - displayModels.length} more models outside the chart`));
	}
	if (options.loading) lines.push(options.theme.fg("dim", "Loading usage history…"));
	if (options.error) lines.push(options.theme.fg("warning", `History unavailable: ${options.error}`));
	lines.push("", options.theme.fg("dim", "←/→ range · Tab pages · Esc to close"));
	return lines.map((line) => truncateToWidth(line, width, ""));
}
