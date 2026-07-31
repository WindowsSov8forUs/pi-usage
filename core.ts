export type ModelLike = {
	id: string;
	provider: string;
	api?: string;
	baseUrl?: string;
};

export type ProfileMatch = {
	providers?: string[];
	models?: string[];
	apis?: string[];
	baseUrls?: string[];
};

export type MeterBase = {
	label?: string;
	aggregate?: "first" | "sum" | "min" | "max";
	scale?: number;
	precision?: number;
	unit?: string;
	currency?: string;
	currencyPath?: string;
};

export type QuotaMeterConfig = MeterBase & {
	type: "quota";
	usedPercentPath?: string;
	remainingPercentPath?: string;
	usedPath?: string;
	limitPath?: string;
	windowMinutesPath?: string;
	windowSecondsPath?: string;
	windowLabelPath?: string;
	resetAtPath?: string;
	resetAfterSecondsPath?: string;
};

export type BalanceMeterConfig = MeterBase & {
	type: "balance";
	remainingPath?: string;
	usedPath?: string;
	limitPath?: string;
	usedPercentPath?: string;
	remainingPercentPath?: string;
};

export type MeterConfig = QuotaMeterConfig | BalanceMeterConfig;

export type NormalizedMeter = {
	type: "quota" | "balance";
	label: string;
	used?: number;
	limit?: number;
	remaining?: number;
	remainingPercent?: number;
	windowMinutes?: number;
	windowLabel?: string;
	resetAt?: string;
	resetAtMs?: number;
	unit?: string;
	currency?: string;
	precision: number;
};

type SessionMessage = {
	role?: string;
	provider?: string;
	model?: string;
	usage?: { cost?: { total?: unknown } };
};

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/,/g, "").trim();
	if (!normalized) return undefined;
	const parsed = Number(normalized);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function pathSegments(path: string): string[] {
	return path
		.replace(/\[\s*(\d+|\*)\s*\]/g, ".$1")
		.split(".")
		.map((part) => part.trim())
		.filter(Boolean);
}

export function valuesAtPath(payload: unknown, path: string | undefined): unknown[] {
	if (!path) return [];
	let values: unknown[] = [payload];
	for (const segment of pathSegments(path)) {
		const next: unknown[] = [];
		for (const value of values) {
			if (segment === "*") {
				if (Array.isArray(value)) next.push(...value);
				else {
					const item = record(value);
					if (item) next.push(...Object.values(item));
				}
				continue;
			}
			if (Array.isArray(value) && /^\d+$/.test(segment)) {
				const item = value[Number(segment)];
				if (item !== undefined) next.push(item);
				continue;
			}
			const item = record(value);
			if (item && item[segment] !== undefined) next.push(item[segment]);
		}
		values = next;
		if (values.length === 0) break;
	}
	return values;
}

function aggregateNumbers(
	payload: unknown,
	path: string | undefined,
	aggregate: MeterBase["aggregate"] = "first",
): number | undefined {
	const numbers = valuesAtPath(payload, path).flatMap((value) => {
		const parsed = finiteNumber(value);
		return parsed === undefined ? [] : [parsed];
	});
	if (numbers.length === 0) return undefined;
	if (aggregate === "sum") return numbers.reduce((total, value) => total + value, 0);
	if (aggregate === "min") return Math.min(...numbers);
	if (aggregate === "max") return Math.max(...numbers);
	return numbers[0];
}

function firstString(payload: unknown, path: string | undefined): string | undefined {
	const value = valuesAtPath(payload, path)[0];
	if (typeof value === "string" && value.trim()) return value.trim();
	return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function scaled(value: number | undefined, scale = 1): number | undefined {
	return value === undefined ? undefined : value * scale;
}

function clampPercent(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.max(0, Math.min(100, value));
}

/** Parse ISO dates, Unix seconds, or Unix milliseconds into an absolute timestamp. */
export function parseResetAtMilliseconds(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() && !/^[-+]?\d+(?:\.\d+)?$/.test(value.trim())) {
		const parsed = Date.parse(value.trim());
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	const numeric = finiteNumber(value);
	if (numeric === undefined) return undefined;
	// Contemporary Unix milliseconds are around 1e12; seconds are around 1e9.
	return Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
}

export function normalizeMeter(
	payload: unknown,
	config: MeterConfig,
	fallbackLabel: string,
	now = Date.now(),
): NormalizedMeter | undefined {
	const scale = config.scale ?? 1;
	const aggregate = config.aggregate ?? "first";
	const used = scaled(aggregateNumbers(payload, config.usedPath, aggregate), scale);
	const limit = scaled(aggregateNumbers(payload, config.limitPath, aggregate), scale);
	const currency = config.currency ?? firstString(payload, config.currencyPath);
	const precision = Math.max(0, Math.min(8, Math.trunc(config.precision ?? 2)));

	if (config.type === "quota") {
		const usedPercent = scaled(aggregateNumbers(payload, config.usedPercentPath, aggregate), scale);
		const configuredRemaining = scaled(aggregateNumbers(payload, config.remainingPercentPath, aggregate), scale);
		const remainingPercent = clampPercent(
			configuredRemaining
				?? (usedPercent === undefined ? undefined : 100 - usedPercent)
				?? (used !== undefined && limit !== undefined && limit > 0 ? 100 * (limit - used) / limit : undefined),
		);
		if (remainingPercent === undefined && used === undefined && limit === undefined) return undefined;
		const configuredMinutes = aggregateNumbers(payload, config.windowMinutesPath, aggregate);
		const configuredSeconds = aggregateNumbers(payload, config.windowSecondsPath, aggregate);
		const windowMinutes = configuredMinutes ?? (configuredSeconds === undefined ? undefined : Math.ceil(configuredSeconds / 60));
		const resetAt = firstString(payload, config.resetAtPath);
		const resetAfterSeconds = aggregateNumbers(payload, config.resetAfterSecondsPath, aggregate);
		const resetAtMs = resetAfterSeconds !== undefined
			? now + Math.max(0, resetAfterSeconds) * 1_000
			: parseResetAtMilliseconds(resetAt);
		return {
			type: "quota",
			label: config.label ?? fallbackLabel,
			used,
			limit,
			remaining: used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined,
			remainingPercent,
			windowMinutes,
			windowLabel: firstString(payload, config.windowLabelPath),
			resetAt,
			resetAtMs,
			unit: config.unit,
			currency,
			precision,
		};
	}

	const configuredRemaining = scaled(aggregateNumbers(payload, config.remainingPath, aggregate), scale);
	const remaining = configuredRemaining
		?? (used !== undefined && limit !== undefined ? Math.max(0, limit - used) : undefined);
	const usedPercent = scaled(aggregateNumbers(payload, config.usedPercentPath, aggregate), scale);
	const configuredRemainingPercent = scaled(
		aggregateNumbers(payload, config.remainingPercentPath, aggregate),
		scale,
	);
	const remainingPercent = clampPercent(
		configuredRemainingPercent
			?? (usedPercent === undefined ? undefined : 100 - usedPercent)
			?? (remaining !== undefined && limit !== undefined && limit > 0 ? 100 * remaining / limit : undefined),
	);
	if (remaining === undefined && used === undefined && limit === undefined && remainingPercent === undefined) return undefined;
	return {
		type: "balance",
		label: config.label ?? fallbackLabel,
		used,
		limit,
		remaining,
		remainingPercent,
		unit: config.unit,
		currency,
		precision,
	};
}

function globRegex(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

function matchesAny(value: string | undefined, patterns: string[] | undefined): boolean {
	if (!patterns || patterns.length === 0) return true;
	if (value === undefined) return false;
	return patterns.some((pattern) => globRegex(pattern).test(value));
}

export function matchesProfile(match: ProfileMatch | undefined, model: ModelLike): boolean {
	if (!match) return true;
	return matchesAny(model.provider, match.providers)
		&& matchesAny(model.id, match.models)
		&& matchesAny(model.api, match.apis)
		&& matchesAny(model.baseUrl, match.baseUrls);
}

export function calculateSessionSpend(entries: unknown[], model: ModelLike): number {
	let total = 0;
	for (const entry of entries) {
		const item = record(entry);
		if (item?.type !== "message") continue;
		const message = record(item.message) as SessionMessage | undefined;
		if (message?.role !== "assistant" || message.provider !== model.provider || message.model !== model.id) continue;
		const cost = finiteNumber(message.usage?.cost?.total);
		if (cost !== undefined) total += cost;
	}
	return total;
}

export function isNormalizedMeter(value: unknown): value is NormalizedMeter {
	const item = record(value);
	if (!item || (item.type !== "quota" && item.type !== "balance") || typeof item.label !== "string") return false;
	if (finiteNumber(item.precision) === undefined) return false;
	if (!["used", "limit", "remaining", "remainingPercent", "windowMinutes", "resetAtMs"]
		.every((key) => item[key] === undefined || finiteNumber(item[key]) !== undefined)) return false;
	if (item.windowLabel !== undefined && typeof item.windowLabel !== "string") return false;
	if (item.resetAt !== undefined && typeof item.resetAt !== "string") return false;
	return true;
}
