import type {
	ExtensionAPI,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	calculateSessionSpend,
	isNormalizedMeter,
	matchesProfile,
	normalizeMeter,
	parseResetAtMilliseconds,
	type MeterConfig,
	type ModelLike,
	type NormalizedMeter,
	type ProfileMatch,
} from "./core.ts";

const STATUS_KEY = "pi-usage";
const DEFAULT_REFRESH_SECONDS = 60;
const DEFAULT_BAR_WIDTH = 12;
const CONFIG_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const BUNDLED_CONFIG_PATH = fileURLToPath(new URL("./pi-usage.json", import.meta.url));
const CONFIG_PATH = process.env.PI_USAGE_CONFIG_PATH ?? join(CONFIG_DIR, "pi-usage.json");
const CACHE_PATH = join(CONFIG_DIR, "pi-usage-cache.json");
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";

type BillingType = "subscription" | "metered";

type AuthConfig = {
	type?: "model" | "provider" | "env" | "none";
	provider?: string;
	env?: string;
	header?: string;
	scheme?: string;
	inheritHeaders?: boolean;
};

type HttpSource = {
	type: "http-json";
	request: {
		url: string;
		method?: "GET" | "POST";
		headers?: Record<string, string>;
		body?: unknown;
		timeoutSeconds?: number;
		auth?: AuthConfig;
	};
	meters: MeterConfig[];
};

type SessionSource = {
	type: "session";
	budget?: number;
	currency?: string;
	showContext?: boolean;
	showCost?: boolean;
};

type NewApiSource = {
	type: "new-api";
	baseUrl?: string;
	auth?: AuthConfig;
	currency?: string;
	precision?: number;
};

type UsageSource = HttpSource | { type: "codex" } | SessionSource | NewApiSource;

type UsageProfile = {
	id: string;
	label: string;
	enabled?: boolean;
	priority?: number;
	match?: ProfileMatch;
	billing: BillingType;
	source: UsageSource;
};

type ProviderModes = {
	"new-api": string[];
};

type UsageConfig = {
	version: 1;
	refreshIntervalSeconds: number;
	barWidth: number;
	maxMeters: number;
	disabledBuiltIns: string[];
	providerModes: ProviderModes;
	profiles: UsageProfile[];
};

type CacheEntry = {
	updatedAt: number;
	meters: NormalizedMeter[];
};

type CacheFile = {
	version: 1;
	entries: Record<string, CacheEntry>;
};

type ResolvedAuth = {
	apiKey?: string;
	headers: Record<string, string>;
	env: Record<string, string>;
};

const BUILT_IN_PROFILES: UsageProfile[] = [
	{
		id: "codex",
		label: "Codex",
		priority: 300,
		match: { providers: ["openai-codex"] },
		billing: "subscription",
		source: { type: "codex" },
	},
	{
		id: "openrouter",
		label: "OpenRouter",
		priority: 200,
		match: { baseUrls: ["*openrouter.ai/*"] },
		billing: "metered",
		source: {
			type: "http-json",
			request: {
				url: "https://openrouter.ai/api/v1/key",
				auth: { type: "model" },
			},
			meters: [{
				type: "balance",
				remainingPath: "data.limit_remaining",
				usedPath: "data.usage",
				limitPath: "data.limit",
				currency: "USD",
			}],
		},
	},
	{
		id: "deepseek",
		label: "DeepSeek",
		priority: 200,
		match: { baseUrls: ["*deepseek.com*"] },
		billing: "metered",
		source: {
			type: "http-json",
			request: {
				url: "https://api.deepseek.com/user/balance",
				auth: { type: "model" },
			},
			meters: [{
				type: "balance",
				remainingPath: "balance_infos[0].total_balance",
				currencyPath: "balance_infos[0].currency",
			}],
		},
	},
	{
		id: "session",
		label: "Session",
		priority: -1_000,
		billing: "metered",
		source: { type: "session", currency: "USD", showContext: true, showCost: true },
	},
];

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? [...new Set(value
			.filter((item): item is string => typeof item === "string" && !!item.trim())
			.map((item) => item.trim()))]
		: [];
}

function parseProviderModes(value: unknown): ProviderModes {
	if (value === undefined) return { "new-api": [] };
	const item = record(value);
	if (!item) throw new Error("providerModes must be an object");
	const supported = new Set(["new-api"]);
	const unknown = Object.keys(item).filter((name) => !supported.has(name));
	if (unknown.length > 0) throw new Error(`providerModes contains unsupported third-party mode: ${unknown.join(", ")}`);
	if (item["new-api"] !== undefined && !Array.isArray(item["new-api"])) {
		throw new Error("providerModes.new-api must be an array");
	}
	return { "new-api": stringArray(item["new-api"]) };
}

function parseMatch(value: unknown): ProfileMatch | undefined {
	const item = record(value);
	if (!item) return undefined;
	return {
		providers: stringArray(item.providers),
		models: stringArray(item.models),
		apis: stringArray(item.apis),
		baseUrls: stringArray(item.baseUrls),
	};
}

function parseProfile(value: unknown, index: number): UsageProfile {
	const item = record(value);
	if (!item) throw new Error(`profiles[${index}] must be an object`);
	const id = typeof item.id === "string" ? item.id.trim() : "";
	const label = typeof item.label === "string" ? item.label.trim() : "";
	if (!id || !/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`profiles[${index}].id is invalid`);
	if (!label) throw new Error(`profiles[${index}].label is required`);
	if (item.billing !== "subscription" && item.billing !== "metered") {
		throw new Error(`profiles[${index}].billing must be subscription or metered`);
	}
	const source = record(item.source);
	if (!source || (source.type !== "codex" && source.type !== "session" && source.type !== "new-api" && source.type !== "http-json")) {
		throw new Error(`profiles[${index}].source.type is unsupported`);
	}
	if (source.type === "http-json") {
		const request = record(source.request);
		if (!request || typeof request.url !== "string" || !request.url.trim()) {
			throw new Error(`profiles[${index}].source.request.url is required`);
		}
		if (!Array.isArray(source.meters) || source.meters.length === 0) {
			throw new Error(`profiles[${index}].source.meters must not be empty`);
		}
		for (const [meterIndex, meter] of source.meters.entries()) {
			const parsed = record(meter);
			if (!parsed || (parsed.type !== "quota" && parsed.type !== "balance")) {
				throw new Error(`profiles[${index}].source.meters[${meterIndex}].type is unsupported`);
			}
		}
	}
	return {
		id,
		label,
		enabled: item.enabled !== false,
		priority: finiteNumber(item.priority) ?? 100,
		match: parseMatch(item.match),
		billing: item.billing,
		source: source as unknown as UsageSource,
	};
}

function defaultConfig(): UsageConfig {
	return {
		version: 1,
		refreshIntervalSeconds: DEFAULT_REFRESH_SECONDS,
		barWidth: DEFAULT_BAR_WIDTH,
		maxMeters: 2,
		disabledBuiltIns: [],
		providerModes: { "new-api": [] },
		profiles: [],
	};
}

function loadConfig(): { config: UsageConfig; path: string; error?: string } {
	const path = existsSync(CONFIG_PATH)
		? CONFIG_PATH
		: process.env.PI_USAGE_CONFIG_PATH === undefined && existsSync(BUNDLED_CONFIG_PATH)
			? BUNDLED_CONFIG_PATH
			: CONFIG_PATH;
	if (!existsSync(path)) return { config: defaultConfig(), path };
	try {
		const root = record(JSON.parse(readFileSync(path, "utf8")));
		if (!root) throw new Error("root must be an object");
		if (root.version !== undefined && root.version !== 1) throw new Error("only version 1 is supported");
		const refresh = finiteNumber(root.refreshIntervalSeconds) ?? DEFAULT_REFRESH_SECONDS;
		const barWidth = finiteNumber(root.barWidth) ?? DEFAULT_BAR_WIDTH;
		const maxMeters = finiteNumber(root.maxMeters) ?? 2;
		return {
			path,
			config: {
				version: 1,
				refreshIntervalSeconds: Math.max(15, Math.min(3_600, refresh)),
				barWidth: Math.max(4, Math.min(30, Math.trunc(barWidth))),
				maxMeters: Math.max(1, Math.min(6, Math.trunc(maxMeters))),
				disabledBuiltIns: stringArray(root.disabledBuiltIns),
				providerModes: parseProviderModes(root.providerModes),
				profiles: Array.isArray(root.profiles) ? root.profiles.map(parseProfile) : [],
			},
		};
	} catch (error) {
		return {
			config: defaultConfig(),
			path,
			error: `Invalid ${path}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function loadCache(): CacheFile {
	try {
		const root = record(JSON.parse(readFileSync(CACHE_PATH, "utf8")));
		const saved = record(root?.entries);
		const entries: Record<string, CacheEntry> = {};
		for (const [key, value] of Object.entries(saved ?? {})) {
			const item = record(value);
			const updatedAt = finiteNumber(item?.updatedAt);
			const meters = Array.isArray(item?.meters) ? item.meters.filter(isNormalizedMeter) : [];
			if (updatedAt !== undefined && meters.length > 0) entries[key] = { updatedAt, meters };
		}
		return { version: 1, entries };
	} catch {
		return { version: 1, entries: {} };
	}
}

function saveCache(cache: CacheFile): void {
	try {
		const temporaryPath = `${CACHE_PATH}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
		renameSync(temporaryPath, CACHE_PATH);
	} catch {
		// Live data remains available when optional cache persistence fails.
	}
}

function providerModeProfiles(modes: ProviderModes): UsageProfile[] {
	return modes["new-api"].map((provider, index) => ({
		id: `provider-mode-new-api-${index}`,
		label: provider,
		priority: 100,
		match: { providers: [provider] },
		billing: "metered",
		source: { type: "new-api" },
	}));
}

function effectiveProfiles(config: UsageConfig): UsageProfile[] {
	const userIds = new Set(config.profiles.map((profile) => profile.id));
	const disabled = new Set(config.disabledBuiltIns);
	const builtIns = BUILT_IN_PROFILES.filter((profile) => !disabled.has(profile.id) && !userIds.has(profile.id));
	return [...config.profiles, ...providerModeProfiles(config.providerModes), ...builtIns]
		.filter((profile) => profile.enabled !== false)
		.map((profile, order) => ({ profile, order }))
		.sort((left, right) => (right.profile.priority ?? 0) - (left.profile.priority ?? 0) || left.order - right.order)
		.map(({ profile }) => profile);
}

function modelLike(model: Model<Api>): ModelLike {
	return { id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl };
}

function findProfile(config: UsageConfig, model: Model<Api>): UsageProfile | undefined {
	return effectiveProfiles(config).find((profile) => matchesProfile(profile.match, modelLike(model)));
}

function cacheKey(profile: UsageProfile, model: Model<Api>): string {
	return `${profile.id}:${model.provider}:${model.id}`;
}

function extractCodexAccountId(token: string): string | undefined {
	try {
		const payload = record(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")));
		const auth = record(payload?.[CODEX_AUTH_CLAIM]);
		return typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id
			? auth.chatgpt_account_id
			: undefined;
	} catch {
		return undefined;
	}
}

function responseError(prefix: string, response: Response, text: string): Error {
	const detail = text.replace(/\s+/g, " ").trim().slice(0, 400);
	return new Error(`${prefix}: HTTP ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ""}`);
}

async function optionalProviderEnv(registry: ModelRegistry, provider: string): Promise<Record<string, string>> {
	try {
		return { ...((await registry.getProviderAuth(provider))?.env ?? {}) };
	} catch {
		return {};
	}
}

async function modelAuth(registry: ModelRegistry, model: Model<Api>): Promise<ResolvedAuth> {
	const resolved = await registry.getApiKeyAndHeaders(model);
	if (!resolved.ok) throw new Error(resolved.error);
	return {
		apiKey: resolved.apiKey,
		headers: { ...(resolved.headers ?? {}) },
		env: await optionalProviderEnv(registry, model.provider),
	};
}

async function providerAuth(registry: ModelRegistry, provider: string): Promise<ResolvedAuth> {
	const resolved = await registry.getProviderAuth(provider);
	if (!resolved) throw new Error(`Credentials unavailable for provider ${provider}`);
	return {
		apiKey: resolved.auth.apiKey,
		headers: { ...(resolved.auth.headers ?? {}) },
		env: { ...(resolved.env ?? {}) },
	};
}

function templateString(value: string, model: Model<Api>, env: Record<string, string>): string {
	return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
		if (key === "provider") return model.provider;
		if (key === "model") return model.id;
		if (key === "api") return model.api;
		if (key === "baseUrl") return model.baseUrl.replace(/\/$/, "");
		if (key.startsWith("env:")) return env[key.slice(4)] ?? process.env[key.slice(4)] ?? "";
		return "";
	});
}

function templateValue(value: unknown, model: Model<Api>, env: Record<string, string>): unknown {
	if (typeof value === "string") return templateString(value, model, env);
	if (Array.isArray(value)) return value.map((item) => templateValue(item, model, env));
	const item = record(value);
	if (!item) return value;
	return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, templateValue(child, model, env)]));
}

async function resolveRequestAuth(
	config: AuthConfig | undefined,
	registry: ModelRegistry,
	model: Model<Api>,
): Promise<ResolvedAuth> {
	const type = config?.type ?? "model";
	if (type === "none") return { headers: {}, env: {} };
	if (type === "provider") return providerAuth(registry, config?.provider ?? model.provider);
	if (type === "env") {
		const env = await optionalProviderEnv(registry, model.provider);
		const name = config?.env;
		if (!name) throw new Error("request.auth.env is required for env auth");
		const apiKey = env[name] ?? process.env[name];
		if (!apiKey) throw new Error(`Environment credential ${name} is unavailable`);
		return { apiKey, headers: {}, env };
	}
	return modelAuth(registry, model);
}

function authenticatedHeaders(authConfig: AuthConfig | undefined, auth: ResolvedAuth): Headers {
	const headers = new Headers(authConfig?.inheritHeaders === false ? undefined : auth.headers);
	const header = authConfig?.header ?? "authorization";
	if (auth.apiKey && !headers.has(header)) {
		const scheme = authConfig?.scheme === undefined ? "Bearer" : authConfig.scheme;
		headers.set(header, scheme ? `${scheme} ${auth.apiKey}` : auth.apiKey);
	}
	headers.set("accept", "application/json");
	return headers;
}

async function fetchHttpMeters(
	profile: UsageProfile,
	source: HttpSource,
	registry: ModelRegistry,
	model: Model<Api>,
	signal: AbortSignal,
): Promise<NormalizedMeter[]> {
	const authConfig = source.request.auth;
	const auth = await resolveRequestAuth(authConfig, registry, model);
	const headers = authenticatedHeaders(authConfig, auth);
	for (const [key, value] of Object.entries(source.request.headers ?? {})) {
		headers.set(key, templateString(value, model, auth.env));
	}

	const method = source.request.method ?? "GET";
	let body: string | undefined;
	if (source.request.body !== undefined) {
		body = JSON.stringify(templateValue(source.request.body, model, auth.env));
		if (!headers.has("content-type")) headers.set("content-type", "application/json");
	}
	const timeoutSeconds = Math.max(1, Math.min(120, source.request.timeoutSeconds ?? 20));
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutSeconds * 1_000)]);
	const response = await fetch(templateString(source.request.url, model, auth.env), {
		method,
		headers,
		body,
		signal: requestSignal,
	});
	const text = await response.text();
	if (!response.ok) throw responseError(`${profile.label} usage request failed`, response, text);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${profile.label} usage endpoint returned invalid JSON`);
	}
	const meters = source.meters.flatMap((meter) => {
		const normalized = normalizeMeter(payload, meter, profile.label);
		return normalized ? [normalized] : [];
	});
	if (meters.length === 0) throw new Error(`${profile.label} response did not match any configured meter path`);
	return meters;
}

async function fetchJsonObject(
	url: string,
	headers: Headers,
	signal: AbortSignal,
	label: string,
): Promise<Record<string, unknown>> {
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	const response = await fetch(url, { method: "GET", headers, signal: requestSignal });
	const text = await response.text();
	if (!response.ok) throw responseError(`${label} request failed`, response, text);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
	const item = record(payload);
	if (!item) throw new Error(`${label} returned a non-object response`);
	if (item.success === false || item.code === false || record(item.error)) {
		const message = typeof item.message === "string"
			? item.message
			: typeof record(item.error)?.message === "string" ? record(item.error)?.message : "API error";
		throw new Error(`${label}: ${message}`);
	}
	return item;
}

function newApiDisplay(status: Record<string, unknown> | undefined, source: NewApiSource): {
	currency?: string;
	unit?: string;
	precision: number;
	scale: number;
} {
	const data = record(status?.data);
	const displayType = typeof data?.quota_display_type === "string" ? data.quota_display_type.toUpperCase() : "USD";
	const quotaPerUnit = finiteNumber(data?.quota_per_unit) ?? 500_000;
	const exchangeRate = finiteNumber(data?.usd_exchange_rate) ?? 1;
	if (source.currency) return { currency: source.currency, precision: source.precision ?? 2, scale: 1 / quotaPerUnit };
	if (displayType === "TOKENS") return { unit: " tokens", precision: source.precision ?? 0, scale: 1 };
	if (displayType === "CNY") return { currency: "CNY", precision: source.precision ?? 2, scale: exchangeRate / quotaPerUnit };
	return { currency: "USD", precision: source.precision ?? 2, scale: 1 / quotaPerUnit };
}

async function fetchNewApiMeters(
	profile: UsageProfile,
	source: NewApiSource,
	registry: ModelRegistry,
	model: Model<Api>,
	signal: AbortSignal,
): Promise<NormalizedMeter[]> {
	const authConfig = source.auth ?? { type: "model" };
	const auth = await resolveRequestAuth(authConfig, registry, model);
	const headers = authenticatedHeaders(authConfig, auth);
	const configuredBase = source.baseUrl ? templateString(source.baseUrl, model, auth.env) : model.baseUrl;
	const baseUrl = configuredBase.replace(/\/v1\/?$/i, "").replace(/\/$/, "");
	const status = await fetchJsonObject(`${baseUrl}/api/status`, new Headers({ accept: "application/json" }), signal, `${profile.label} status`).catch(() => undefined);
	const display = newApiDisplay(status, source);

	try {
		const startDate = "1970-01-01";
		const endDate = new Date().toISOString().slice(0, 10);
		const [subscription, usage] = await Promise.all([
			fetchJsonObject(`${baseUrl}/v1/dashboard/billing/subscription`, headers, signal, `${profile.label} subscription`),
			fetchJsonObject(`${baseUrl}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`, headers, signal, `${profile.label} usage`),
		]);
		const limit = finiteNumber(subscription.hard_limit_usd);
		const usageInCents = finiteNumber(usage.total_usage);
		if (limit === undefined || usageInCents === undefined) throw new Error(`${profile.label} billing response is missing limit or usage`);
		const used = usageInCents / 100;
		const syntheticUnlimited = display.unit === undefined && limit >= 100_000_000;
		const effectiveLimit = syntheticUnlimited ? undefined : limit;
		const remaining = effectiveLimit === undefined ? undefined : Math.max(0, effectiveLimit - used);
		return [{
			type: "balance",
			label: profile.label,
			used,
			limit: effectiveLimit,
			remaining,
			remainingPercent: remaining !== undefined && effectiveLimit && effectiveLimit > 0
				? Math.max(0, Math.min(100, 100 * remaining / effectiveLimit))
				: undefined,
			unit: display.unit,
			currency: display.currency,
			precision: display.precision,
		}];
	} catch (billingError) {
		try {
			const tokenUsage = await fetchJsonObject(`${baseUrl}/api/usage/token/`, headers, signal, `${profile.label} token usage`);
			const data = record(tokenUsage.data);
			if (!data) throw new Error(`${profile.label} token usage returned no data`);
			const unlimited = data.unlimited_quota === true;
			const rawUsed = finiteNumber(data.total_used);
			const rawLimit = finiteNumber(data.total_granted);
			const rawRemaining = finiteNumber(data.total_available);
			if (rawUsed === undefined) throw new Error(`${profile.label} token usage returned no usage value`);
			const used = rawUsed * display.scale;
			const limit = unlimited || rawLimit === undefined ? undefined : rawLimit * display.scale;
			const remaining = unlimited || rawRemaining === undefined ? undefined : Math.max(0, rawRemaining * display.scale);
			return [{
				type: "balance",
				label: profile.label,
				used,
				limit,
				remaining,
				remainingPercent: remaining !== undefined && limit && limit > 0
					? Math.max(0, Math.min(100, 100 * remaining / limit))
					: undefined,
				unit: display.unit,
				currency: display.currency,
				precision: display.precision,
			}];
		} catch {
			throw billingError;
		}
	}
}

async function fetchCodexMeters(
	registry: ModelRegistry,
	model: Model<Api>,
	signal: AbortSignal,
): Promise<NormalizedMeter[]> {
	const auth = await modelAuth(registry, model);
	const headers = new Headers(model.headers);
	for (const [key, value] of Object.entries(auth.headers)) headers.set(key, value);
	if (auth.apiKey) headers.set("authorization", `Bearer ${auth.apiKey}`);
	const token = auth.apiKey ?? headers.get("authorization")?.replace(/^Bearer\s+/i, "");
	const accountId = token ? extractCodexAccountId(token) : undefined;
	if (accountId) headers.set("chatgpt-account-id", accountId);
	headers.set("accept", "application/json");
	headers.set("OAI-Language", "en");
	headers.set("originator", "pi");
	const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
	const response = await fetch(CODEX_USAGE_URL, { method: "GET", headers, signal: requestSignal });
	const text = await response.text();
	if (!response.ok) throw responseError("Codex usage request failed", response, text);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error("Codex usage endpoint returned invalid JSON");
	}
	const meters = codexMetersFromPayload(payload);
	if (meters.length === 0) throw new Error("Codex usage response has no quota windows");
	return meters;
}

function firstField(item: Record<string, unknown>, names: string[]): string | undefined {
	return names.find((name) => item[name] !== undefined);
}

function humanizeIdentifier(value: string): string {
	return value
		.replace(/_?rate_?limits?$/i, "")
		.replace(/[_-]+/g, " ")
		.trim()
		.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function codexWindowLabel(path: string[]): string {
	const groupPath = /^(primary|secondary)(?:_window)?$/i.test(path.at(-1) ?? "") ? path.slice(0, -1) : path;
	const group = [...groupPath].reverse().find((segment) => !/^rate_?limits?$/i.test(segment));
	return group ? humanizeIdentifier(group) || "Codex" : "Codex";
}

function codexWindowMeter(value: unknown, path: string[], now: number): NormalizedMeter | undefined {
	const item = record(value);
	if (!item) return undefined;
	const usedPercentPath = firstField(item, ["used_percent", "usedPercent"]);
	const remainingPercentPath = firstField(item, ["remaining_percent", "remainingPercent"]);
	const usedPath = firstField(item, ["used", "usage"]);
	const limitPath = firstField(item, ["limit", "quota"]);
	const windowMinutesPath = firstField(item, ["window_minutes", "limit_window_minutes"]);
	const windowSecondsPath = firstField(item, ["limit_window_seconds", "window_seconds"]);
	const resetAtPath = firstField(item, ["reset_at", "resets_at", "resetAt"]);
	const resetAfterSecondsPath = firstField(item, ["reset_after_seconds", "reset_in_seconds", "resetAfterSeconds"]);
	const windowLabelPath = firstField(item, ["window_label", "window_name", "period"]);
	const hasQuota = usedPercentPath !== undefined
		|| remainingPercentPath !== undefined
		|| (usedPath !== undefined && limitPath !== undefined);
	const hasWindowMetadata = windowMinutesPath !== undefined
		|| windowSecondsPath !== undefined
		|| resetAtPath !== undefined
		|| resetAfterSecondsPath !== undefined;
	const rateLimitPath = path.some((segment) => /rate_?limits?/i.test(segment));
	const conventionalWindow = /^(primary|secondary)(?:_window)?$/i.test(path.at(-1) ?? "");
	if (!hasQuota || !hasWindowMetadata || (!rateLimitPath && !conventionalWindow)) return undefined;
	const meter = normalizeMeter(item, {
		type: "quota",
		label: codexWindowLabel(path),
		usedPercentPath,
		remainingPercentPath,
		usedPath,
		limitPath,
		windowMinutesPath,
		windowSecondsPath,
		windowLabelPath,
		resetAtPath,
		resetAfterSecondsPath,
	}, "Codex", now);
	if (meter && !meter.windowLabel && meter.windowMinutes === undefined && conventionalWindow) {
		meter.windowLabel = humanizeIdentifier(path.at(-1)?.replace(/_window$/i, "") ?? "");
	}
	return meter;
}

/** Extract every quota window from current and legacy Codex usage payloads. */
export function codexMetersFromPayload(payload: unknown, now = Date.now()): NormalizedMeter[] {
	const meters: NormalizedMeter[] = [];
	const visit = (value: unknown, path: string[], depth: number): void => {
		if (depth > 8) return;
		const meter = codexWindowMeter(value, path, now);
		if (meter) {
			meters.push(meter);
			return;
		}
		if (Array.isArray(value)) {
			for (const [index, child] of value.entries()) visit(child, [...path, String(index)], depth + 1);
			return;
		}
		const item = record(value);
		if (!item) return;
		for (const [key, child] of Object.entries(item)) visit(child, [...path, key], depth + 1);
	};
	visit(payload, [], 0);

	const unique = new Map<string, NormalizedMeter>();
	for (const meter of meters) {
		const key = [
			meter.label,
			meter.windowLabel ?? "",
			meter.windowMinutes ?? "",
			meter.resetAtMs === undefined ? "" : Math.round(meter.resetAtMs / 1_000),
			meter.remainingPercent ?? "",
			meter.used ?? "",
			meter.limit ?? "",
		].join("|");
		if (!unique.has(key)) unique.set(key, meter);
	}
	return [...unique.values()].sort((left, right) => {
		const labelOrder = left.label.localeCompare(right.label);
		if (labelOrder !== 0) return labelOrder;
		return (left.windowMinutes ?? Number.POSITIVE_INFINITY) - (right.windowMinutes ?? Number.POSITIVE_INFINITY);
	});
}

function hasModelPricing(model: Model<Api>): boolean {
	return [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite]
		.some((value) => value > 0);
}

function sessionMeters(profile: UsageProfile, model: Model<Api>, ctx: ExtensionContext): NormalizedMeter[] {
	if (profile.source.type !== "session") return [];
	const meters: NormalizedMeter[] = [];
	const context = ctx.getContextUsage();
	if (profile.source.showContext !== false && context?.percent !== null) {
		meters.push({
			type: "quota",
			label: "Context",
			used: context.tokens ?? undefined,
			limit: context.contextWindow,
			remaining: context.tokens === null ? undefined : Math.max(0, context.contextWindow - context.tokens),
			remainingPercent: Math.max(0, Math.min(100, 100 - context.percent)),
			unit: " tokens",
			precision: 0,
		});
	}
	const used = calculateSessionSpend(ctx.sessionManager.getBranch(), modelLike(model));
	const limit = profile.source.budget;
	if (profile.source.showCost !== false && (hasModelPricing(model) || used > 0 || limit !== undefined)) {
		meters.push({
			type: "balance",
			label: profile.label,
			used,
			limit,
			remaining: limit === undefined ? undefined : Math.max(0, limit - used),
			remainingPercent: limit !== undefined && limit > 0
				? Math.max(0, Math.min(100, 100 * (limit - used) / limit))
				: undefined,
			currency: profile.source.currency ?? "USD",
			precision: 4,
		});
	}
	return meters;
}

function currencyUnit(currency: string | undefined, unit: string | undefined): { prefix: string; suffix: string } {
	if (unit) return { prefix: "", suffix: unit };
	if (!currency) return { prefix: "", suffix: "" };
	const normalized = currency.toUpperCase();
	if (normalized === "USD") return { prefix: "$", suffix: "" };
	if (normalized === "CNY" || normalized === "RMB") return { prefix: "¥", suffix: "" };
	if (normalized === "EUR") return { prefix: "€", suffix: "" };
	if (normalized === "GBP") return { prefix: "£", suffix: "" };
	return { prefix: "", suffix: ` ${currency}` };
}

function formatAmount(value: number, meter: NormalizedMeter): string {
	const { prefix, suffix } = currencyUnit(meter.currency, meter.unit);
	const fixed = value.toFixed(meter.precision);
	const formatted = meter.precision === 0
		? fixed
		: fixed.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
	return `${prefix}${formatted}${suffix}`;
}

function normalizeExplicitWindowLabel(label: string): string {
	const normalized = label.trim().toLowerCase();
	if (normalized === "hour" || normalized === "hourly") return "1h";
	if (normalized === "day" || normalized === "daily") return "1d";
	if (normalized === "week" || normalized === "weekly") return "1w";
	if (normalized === "month" || normalized === "monthly") return "1mo";
	return label.trim();
}

function formatWindowDuration(minutes: number): string {
	if (minutes > 0 && minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)}w`;
	if (minutes > 0 && minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
	if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function windowPeriod(meter: NormalizedMeter): string | undefined {
	const period = meter.windowLabel
		? normalizeExplicitWindowLabel(meter.windowLabel)
		: meter.windowMinutes === undefined ? undefined : formatWindowDuration(meter.windowMinutes);
	return period;
}

function windowDescriptor(meter: NormalizedMeter, profileLabel: string): string {
	const period = windowPeriod(meter);
	const meterLabel = meter.label.trim();
	const sameAsProfile = meterLabel.localeCompare(profileLabel.trim(), undefined, { sensitivity: "accent" }) === 0;
	const labelIsPeriod = period !== undefined
		&& normalizeExplicitWindowLabel(meterLabel).toLowerCase() === period.toLowerCase();
	const parts = [sameAsProfile || labelIsPeriod ? undefined : meterLabel, period].filter(
		(value): value is string => !!value,
	);
	return parts.join(" ");
}

function resetTimestamp(meter: NormalizedMeter): number | undefined {
	return meter.resetAtMs ?? parseResetAtMilliseconds(meter.resetAt);
}

function formatResetRemaining(timestamp: number, now = Date.now()): string {
	const milliseconds = timestamp - now;
	if (milliseconds <= 0) return "now";
	const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
	const totalDays = Math.floor(totalMinutes / (24 * 60));
	if (totalDays >= 7) {
		const weeks = Math.floor(totalDays / 7);
		const days = totalDays % 7;
		return days > 0 ? `${weeks}w ${days}d` : `${weeks}w`;
	}
	if (totalDays > 0) {
		const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
		return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`;
	}
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	return `${minutes}m`;
}

export default function piUsage(pi: ExtensionAPI) {
	let config = defaultConfig();
	let configPath = CONFIG_PATH;
	let configError: string | undefined;
	let cache = loadCache();
	let activeContext: ExtensionContext | undefined;
	let activeProfile: UsageProfile | undefined;
	let activeModel: Model<Api> | undefined;
	let activeMeters: NormalizedMeter[] = [];
	let lastUpdatedAt: number | undefined;
	let lastError: string | undefined;
	let refreshFailed = false;
	let refreshController: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;
	let generation = 0;

	function clearDisplay(ctx: ExtensionContext): void {
		// Clear the legacy footer status as well, so /reload cleanly migrates from
		// versions that rendered pi-usage on Pi's shared single-line status row.
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, undefined);
	}

	function setDisplay(ctx: ExtensionContext, text: string | undefined): void {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(STATUS_KEY, text === undefined ? undefined : [text], { placement: "belowEditor" });
	}

	function render(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !activeProfile) {
			clearDisplay(ctx);
			return;
		}
		if (activeMeters.length === 0) {
			setDisplay(ctx, refreshFailed ? ctx.ui.theme.fg("dim", `${activeProfile.label} unavailable`) : undefined);
			return;
		}
		// Subscription APIs often expose independent hourly/daily/weekly windows.
		// Never silently hide those windows behind the metered-account display cap.
		const displayedMeters = activeProfile.billing === "subscription"
			? activeMeters
			: activeMeters.slice(0, config.maxMeters);
		const chunks = displayedMeters.map((meter) => {
			const descriptor = windowDescriptor(meter, activeProfile.label);
			const label = descriptor ? ctx.ui.theme.fg("dim", `${descriptor} `) : "";
			const resetAt = meter.type === "quota" ? resetTimestamp(meter) : undefined;
			const reset = resetAt === undefined
				? ""
				: ctx.ui.theme.fg("dim", ` (resets ${formatResetRemaining(resetAt)})`);
			if (meter.remainingPercent !== undefined) {
				const value = meter.type === "balance" && meter.remaining !== undefined
					? formatAmount(meter.remaining, meter)
					: `${Math.round(meter.remainingPercent)}%`;
				const remainingBlocks = Math.round(config.barWidth * meter.remainingPercent / 100);
				const bar = ctx.ui.theme.fg("accent", "─".repeat(remainingBlocks))
					+ ctx.ui.theme.fg("dim", "─".repeat(config.barWidth - remainingBlocks));
				return `${label}${bar}${ctx.ui.theme.fg("dim", ` ${value}`)}${reset}`;
			}
			if (meter.remaining !== undefined) {
				return label + ctx.ui.theme.fg("accent", formatAmount(meter.remaining, meter)) + ctx.ui.theme.fg("dim", " left") + reset;
			}
			if (meter.used !== undefined) {
				return label + ctx.ui.theme.fg("accent", formatAmount(meter.used, meter)) + ctx.ui.theme.fg("dim", " used") + reset;
			}
			return label.trimEnd() + reset;
		});
		const age = refreshFailed && lastUpdatedAt !== undefined
			? ctx.ui.theme.fg("dim", ` (${Math.max(1, Math.floor((Date.now() - lastUpdatedAt) / 60_000))}m ago)`)
			: "";
		const name = ctx.ui.theme.fg("dim", activeProfile.label);
		setDisplay(ctx, [name, ...chunks].join(ctx.ui.theme.fg("dim", " • ")) + age);
	}

	function loadConfiguration(ctx?: ExtensionContext): void {
		const loaded = loadConfig();
		config = loaded.config;
		configPath = loaded.path;
		configError = loaded.error;
		if (configError && ctx?.hasUI) ctx.ui.notify(configError, "error");
	}

	function applyCached(profile: UsageProfile, model: Model<Api>): void {
		const saved = cache.entries[cacheKey(profile, model)];
		activeMeters = saved?.meters ?? [];
		lastUpdatedAt = saved?.updatedAt;
	}

	async function refresh(ctx: ExtensionContext): Promise<void> {
		if (refreshController || activeContext !== ctx || !activeProfile || !activeModel) return;
		const runGeneration = generation;
		const profile = activeProfile;
		const model = activeModel;
		const controller = new AbortController();
		refreshController = controller;
		const isCurrent = () => activeContext === ctx && generation === runGeneration && !controller.signal.aborted;
		try {
			let meters: NormalizedMeter[];
			if (profile.source.type === "session") meters = sessionMeters(profile, model, ctx);
			else if (profile.source.type === "codex") meters = await fetchCodexMeters(ctx.modelRegistry, model, controller.signal);
			else if (profile.source.type === "new-api") meters = await fetchNewApiMeters(profile, profile.source, ctx.modelRegistry, model, controller.signal);
			else meters = await fetchHttpMeters(profile, profile.source, ctx.modelRegistry, model, controller.signal);
			if (!isCurrent()) return;
			activeMeters = meters;
			lastUpdatedAt = Date.now();
			lastError = undefined;
			refreshFailed = false;
			if (profile.source.type !== "session") {
				cache.entries[cacheKey(profile, model)] = { updatedAt: lastUpdatedAt, meters };
				saveCache(cache);
			}
		} catch (error) {
			if (isCurrent()) {
				lastError = error instanceof Error ? error.message : String(error);
				refreshFailed = true;
			}
		} finally {
			if (refreshController === controller) refreshController = undefined;
			if (isCurrent()) render(ctx);
		}
	}

	function stop(): void {
		generation += 1;
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = undefined;
		if (countdownTimer) clearInterval(countdownTimer);
		countdownTimer = undefined;
		refreshController?.abort();
		refreshController = undefined;
		if (activeContext) clearDisplay(activeContext);
		activeContext = undefined;
		activeProfile = undefined;
		activeModel = undefined;
		activeMeters = [];
		lastUpdatedAt = undefined;
		lastError = undefined;
		refreshFailed = false;
	}

	function start(ctx: ExtensionContext, reloadConfig = true): void {
		stop();
		if (ctx.mode !== "tui" || !ctx.model) return;
		if (reloadConfig) loadConfiguration(ctx);
		const profile = findProfile(config, ctx.model);
		if (!profile) return;
		activeContext = ctx;
		activeProfile = profile;
		activeModel = ctx.model;
		if (profile.source.type !== "session") applyCached(profile, ctx.model);
		render(ctx);
		void refresh(ctx);
		if (profile.source.type !== "session") {
			refreshTimer = setInterval(
				() => activeContext && void refresh(activeContext),
				config.refreshIntervalSeconds * 1_000,
			);
			refreshTimer.unref?.();
		}
		if (profile.billing === "subscription") {
			countdownTimer = setInterval(() => activeContext && render(activeContext), 30_000);
			countdownTimer.unref?.();
		}
	}

	pi.on("session_start", (_event, ctx) => start(ctx));
	pi.on("session_shutdown", () => stop());
	pi.on("model_select", (_event, ctx) => start(ctx));
	pi.on("message_end", (event, ctx) => {
		if (event.message.role === "assistant" && activeProfile?.source.type === "session") void refresh(ctx);
	});

	pi.registerCommand("usage", {
		description: "Refresh, reload, or inspect the adaptive usage display",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trim().toLowerCase();
			const actions = ["refresh", "reload", "status"];
			const matches = actions.filter((action) => action.startsWith(normalized));
			return matches.length > 0 ? matches.map((action) => ({ value: action, label: action })) : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "refresh" && action !== "reload" && action !== "status") {
				ctx.ui.notify("Usage: /usage [refresh|reload|status]", "error");
				return;
			}
			if (action === "reload") {
				start(ctx, true);
				ctx.ui.notify(
					configError ? "Usage config has errors; built-ins remain active." : "Usage footer configuration reloaded.",
					configError ? "warning" : "info",
				);
				return;
			}
			if (action === "status") {
				const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
				const error = lastError ? ` · error: ${lastError}` : "";
				ctx.ui.notify(`Usage profile: ${activeProfile?.id ?? "none"} · model: ${model} · config: ${configPath}${error}`, lastError ? "warning" : "info");
				return;
			}
			await refresh(ctx);
			if (lastError) ctx.ui.notify(lastError, "error");
		},
	});
}
