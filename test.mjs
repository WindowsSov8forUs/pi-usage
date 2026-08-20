import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stateDir = mkdtempSync(join(tmpdir(), "pi-usage-test-"));
process.env.PI_CODING_AGENT_DIR = stateDir;
process.env.PI_USAGE_CONFIG_PATH = join(stateDir, "pi-usage.json");
const waitUntil = async (predicate, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for asynchronous UI update");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

writeFileSync(join(stateDir, "pi-usage.json"), JSON.stringify({
  version: 1,
  profiles: [{
    id: "custom-session",
    label: "Custom",
    priority: 500,
    match: { providers: ["acme"], models: ["pro-*"] },
    billing: "metered",
    source: { type: "session", budget: 1, currency: "USD" },
  }],
}), "utf8");

try {
  const {
    calculateSessionSpend,
    matchesProfile,
    normalizeMeter,
    parseResetAtMilliseconds,
    valuesAtPath,
  } = await import("./core.ts");

  const payload = {
    data: {
      windows: [{ used: "25", limit: 100, seconds: 18_000 }],
      balances: [{ value: "1.25" }, { value: 2.75 }],
    },
  };
  assert.deepEqual(valuesAtPath(payload, "data.windows[0].used"), ["25"]);
  assert.deepEqual(valuesAtPath(payload, "data.balances[*].value"), ["1.25", 2.75]);

  assert.deepEqual(normalizeMeter(payload, {
    type: "quota",
    label: "Plan",
    usedPath: "data.windows[0].used",
    limitPath: "data.windows[0].limit",
    windowSecondsPath: "data.windows[0].seconds",
  }, "Fallback"), {
    type: "quota",
    label: "Plan",
    used: 25,
    limit: 100,
    remaining: 75,
    remainingPercent: 75,
    windowMinutes: 300,
    windowLabel: undefined,
    resetAt: undefined,
    resetAtMs: undefined,
    unit: undefined,
    currency: undefined,
    precision: 2,
  });

  const fixedNow = 1_800_000_000_000;
  const timedMeter = normalizeMeter({
    used_percent: 20,
    limit_window_seconds: 2_592_000,
    period: "monthly",
    reset_after_seconds: 7_200,
  }, {
    type: "quota",
    usedPercentPath: "used_percent",
    windowSecondsPath: "limit_window_seconds",
    windowLabelPath: "period",
    resetAfterSecondsPath: "reset_after_seconds",
  }, "Timed", fixedNow);
  assert.equal(timedMeter?.windowMinutes, 43_200);
  assert.equal(timedMeter?.windowLabel, "monthly");
  assert.equal(timedMeter?.resetAtMs, fixedNow + 7_200_000);
  assert.equal(parseResetAtMilliseconds("2030-01-01T00:00:00Z"), Date.parse("2030-01-01T00:00:00Z"));
  assert.equal(parseResetAtMilliseconds("1800000000"), 1_800_000_000_000);
  assert.equal(parseResetAtMilliseconds("1800000000000"), 1_800_000_000_000);

  const balance = normalizeMeter(payload, {
    type: "balance",
    remainingPath: "data.balances[*].value",
    aggregate: "sum",
    scale: 2,
    currency: "USD",
  }, "Credits");
  assert.equal(balance?.remaining, 8);
  assert.equal(balance?.label, "Credits");

  const percentageOnlyBalance = normalizeMeter({ data: { used_percent: "25" } }, {
    type: "balance",
    usedPercentPath: "data.used_percent",
    currency: "USD",
  }, "Percent Balance");
  assert.equal(percentageOnlyBalance?.remainingPercent, 75);
  assert.equal(percentageOnlyBalance?.remaining, undefined);
  assert.equal(percentageOnlyBalance?.limit, undefined);

  assert.equal(matchesProfile({
    providers: ["acme", "corp-*"],
    models: ["pro-?"],
    baseUrls: ["https://*.example.com/*"],
  }, {
    provider: "acme",
    id: "pro-1",
    baseUrl: "https://ai.example.com/v1",
  }), true);
  assert.equal(matchesProfile({ models: ["lite-*"] }, { provider: "acme", id: "pro-1" }), false);

  const statsNow = new Date(2025, 6, 27, 12).getTime();
  const entries = [
    {
      type: "message",
      timestamp: new Date(statsNow - 86_400_000).toISOString(),
      message: {
        role: "assistant",
        provider: "acme",
        model: "pro-1",
        timestamp: statsNow - 86_400_000,
        usage: { input: 127_400, output: 5_100_000, cacheRead: 800_000, cacheWrite: 0, totalTokens: 6_027_400, cost: { total: 0.125 } },
      },
    },
    {
      type: "message",
      timestamp: new Date(statsNow).toISOString(),
      message: {
        role: "assistant",
        provider: "acme",
        model: "other",
        timestamp: statsNow,
        usage: { input: 94_100, output: 1_800_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_894_100, cost: { total: 9 } },
      },
    },
    { type: "message", message: { role: "user" } },
  ];
  assert.equal(calculateSessionSpend(entries, { provider: "acme", id: "pro-1" }), 0.125);

  const {
    extractUsageSamples,
    formatUsd,
    loadHistoricalUsageSamples,
    mergeUsageSamples,
    modelsForMetric,
    renderUsageStats,
    summarizeUsage,
  } = await import("./stats.ts");
  const currentSamples = extractUsageSamples(entries);
  assert.equal(currentSamples.length, 2);
  assert.equal(currentSamples[0].cost, 0.125);
  assert.equal(currentSamples[1].cost, 9);
  const edgeSamples = extractUsageSamples([
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "priced-only",
        model: "legacy-cost",
        timestamp: statsNow - 1_000,
        usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0.005 } },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "unpriced",
        model: "zero-cost",
        timestamp: statsNow - 2_000,
        usage: { input: 100, output: 0, totalTokens: 100 },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "invalid-cost",
        model: "negative-cost",
        timestamp: statsNow - 3_000,
        usage: { input: 100, output: 0, totalTokens: 100, cost: { total: -1 } },
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "invalid-cost",
        model: "infinite-cost",
        timestamp: statsNow - 4_000,
        usage: { input: 100, output: 0, totalTokens: 100, cost: { total: Infinity } },
      },
    },
  ]);
  assert.equal(edgeSamples.length, 4);
  assert.equal(edgeSamples[0].tokens, 0);
  assert.equal(edgeSamples[0].cost, 0.005);
  assert.deepEqual(edgeSamples.slice(1).map((sample) => sample.cost), [0, 0, 0]);
  assert.equal(mergeUsageSamples([edgeSamples[0]], [{ ...edgeSamples[0], cost: 0.006 }]).length, 2);
  const allStatistics = summarizeUsage(currentSamples, "all", statsNow + 1);
  assert.equal(allStatistics.models.length, 2);
  assert.equal(allStatistics.models[0].key, "acme/pro-1");
  assert.equal(allStatistics.models[0].tokens, 5_227_400);
  assert.equal(allStatistics.models[0].cache, 800_000);
  assert.equal(allStatistics.models[0].cost, 0.125);
  assert.equal(allStatistics.models[0].dailyCost.get("2025-07-26"), 0.125);
  assert.equal(allStatistics.totalTokens, 7_121_500);
  assert.equal(allStatistics.totalCost, 9.125);
  assert.equal(allStatistics.zeroCostModels, 0);
  assert.equal(summarizeUsage(currentSamples, "7d", statsNow + 1).dateKeys.length, 7);

  const historyDir = join(stateDir, "sessions", "--test--");
  mkdirSync(historyDir, { recursive: true });
  const historicalEntry = {
    type: "message",
    timestamp: new Date(statsNow).toISOString(),
    message: {
      role: "assistant",
      provider: "other-provider",
      model: "deepseek-v4-pro",
      timestamp: statsNow,
      usage: { input: 1_700_000, output: 52_200, cacheRead: 0, cacheWrite: 0, totalTokens: 1_752_200, cost: { total: 1 } },
    },
  };
  writeFileSync(join(historyDir, "usage.jsonl"), [
    JSON.stringify({ type: "session", version: 3, id: "test", timestamp: new Date(statsNow).toISOString(), cwd: stateDir }),
    JSON.stringify(entries[0]),
    JSON.stringify(historicalEntry),
  ].join("\n"), "utf8");
  const historicalSamples = await loadHistoricalUsageSamples(join(stateDir, "sessions"));
  assert.equal(historicalSamples.length, 2);
  assert.equal(mergeUsageSamples(currentSamples, historicalSamples).length, 3);
  const combinedSamples = mergeUsageSamples(currentSamples, historicalSamples, edgeSamples);
  const combinedStatistics = summarizeUsage(combinedSamples, "all", statsNow + 1);
  assert.equal(combinedStatistics.totalCost, 10.13);
  assert.equal(combinedStatistics.zeroCostModels, 3);
  assert.deepEqual(modelsForMetric(combinedStatistics, "cost").map((item) => item.key), [
    "acme/other",
    "other-provider/deepseek-v4-pro",
    "acme/pro-1",
    "priced-only/legacy-cost",
  ]);
  assert.equal(modelsForMetric(combinedStatistics, "tokens").some((item) => item.key === "priced-only/legacy-cost"), false);
  assert.equal(formatUsd(0.125), "$0.125");
  assert.equal(formatUsd(9), "$9");
  assert.equal(formatUsd(1_250), "$1.3k");

  const chart = renderUsageStats({
    width: 90,
    height: 9,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    statistics: summarizeUsage(mergeUsageSamples(currentSamples, historicalSamples), "all", statsNow + 1),
    labels: new Map([
      ["acme/pro-1", "Pro 1"],
      ["acme/other", "Fable 5"],
      ["other-provider/deepseek-v4-pro", "deepseek-v4-pro"],
    ]),
    range: "all",
    metric: "tokens",
  }).join("\n");
  assert.match(chart, /Tokens per Day/);
  assert.match(chart, /● Pro 1 .*● Fable 5 .*● deepseek-v4-pro/);
  assert.match(chart, /In: 127\.4k · Out: 5\.1m · Cache: 800k/);
  assert.match(chart, /All time · Last 7 days · Last 30 days/);
  assert.match(chart, /[─│╭╮╰╯]/);
  assert.match(chart, /^\s*0 ┼[─┴┬┼]+$/m);
  const dateAxis = chart.split("\n").find((line) => line.includes("Jul 26") && line.includes("Jul 27"));
  assert.ok(dateAxis);
  assert.equal(dateAxis.match(/Jul 26/g)?.length, 1);
  assert.equal(dateAxis.match(/Jul 27/g)?.length, 1);
  assert.ok(dateAxis.indexOf("Jul 26") > 10);
  assert.ok(dateAxis.indexOf("Jul 27") < 78);
  assert.ok(chart.split("\n").every((line) => line.length <= 88));
  const dimChart = renderUsageStats({
    width: 140,
    height: 5,
    theme: {
      fg: (color, text) => color === "dim" ? `\x1b[2m${text}\x1b[22m` : text,
      bold: (text) => text,
    },
    statistics: summarizeUsage(mergeUsageSamples(currentSamples, historicalSamples), "all", statsNow + 1),
    labels: new Map([
      ["acme/pro-1", "Pro 1"],
      ["acme/other", "Fable 5"],
      ["other-provider/deepseek-v4-pro", "deepseek-v4-pro"],
    ]),
    range: "all",
    metric: "tokens",
  }).join("\n");
  assert.match(dimChart, /Pro 1\x1b\[2m \(.*%\)\x1b\[22m/);
  assert.match(dimChart, /\x1b\[2m  In: 127\.4k · Out: 5\.1m · Cache: 800k\x1b\[22m/);

  const costChart = renderUsageStats({
    width: 140,
    height: 5,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    statistics: summarizeUsage(edgeSamples, "all", statsNow + 1),
    labels: new Map([
      ["priced-only/legacy-cost", "Legacy Cost"],
      ["unpriced/zero-cost", "Zero Cost"],
      ["invalid-cost/negative-cost", "Negative Cost"],
      ["invalid-cost/infinite-cost", "Infinite Cost"],
    ]),
    range: "all",
    metric: "cost",
  }).join("\n");
  assert.match(costChart, /Cost per Day/);
  assert.match(costChart, /\$0\.005/);
  assert.match(costChart, /Legacy Cost \(100\.0%\)/);
  assert.match(costChart, /Cost: \$0\.005/);
  assert.match(costChart, /3 models with \$0 recorded cost hidden/);
  assert.doesNotMatch(costChart, /In:|Out:|Cache:|Zero Cost|Negative Cost|Infinite Cost/);
  assert.ok(costChart.split("\n").every((line) => line.length <= 88));

  const emptyCostChart = renderUsageStats({
    width: 80,
    theme: { fg: (_color, text) => text, bold: (text) => text },
    statistics: summarizeUsage(edgeSamples.slice(1), "all", statsNow + 1),
    labels: new Map(),
    range: "all",
    metric: "cost",
  }).join("\n");
  assert.match(emptyCostChart, /No recorded model cost was found in Pi sessions/);
  assert.match(emptyCostChart, /3 models with \$0 recorded cost hidden/);
  assert.match(emptyCostChart, /Tokens · Cost/);
  assert.match(emptyCostChart, /All time · Last 7 days · Last 30 days/);

  const indexModule = await import("./index.ts");
  const extension = indexModule.default;
  const codexNow = 1_800_000_000_000;
  const codexMeters = indexModule.codexMetersFromPayload({
    rate_limit: {
      primary_window: {
        used_percent: 20,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3_600,
      },
      primary: {
        used_percent: 20,
        limit_window_seconds: 18_000,
        reset_after_seconds: 3_600,
      },
      secondary_window: {
        used_percent: 40,
        limit_window_seconds: 604_800,
        reset_at: (codexNow + 4 * 86_400_000) / 1_000,
      },
    },
    rate_limits: [{
      used_percent: 40,
      limit_window_seconds: 604_800,
      reset_at: (codexNow + 4 * 86_400_000) / 1_000,
    }],
    additional_rate_limits: [{
      limit_name: "Codex Spark",
      metered_feature: "codex_spark",
      rate_limit: {
        primary_window: {
          used_percent: 5,
          limit_window_seconds: 604_800,
          reset_at: (codexNow + 2 * 86_400_000) / 1_000,
        },
      },
    }],
    code_review_rate_limit: {
      primary_window: {
        used_percent: 10,
        limit_window_seconds: 2_592_000,
        reset_at: new Date(codexNow + 14 * 86_400_000).toISOString(),
      },
    },
  }, codexNow);
  assert.equal(codexMeters.length, 4);
  assert.equal(codexMeters.some((meter) => /^\d+$/.test(meter.label) || meter.label === "Additional"), false);
  const codexPrimary = codexMeters.find((meter) => meter.label === "Codex" && meter.windowMinutes === 300);
  const codexWeekly = codexMeters.find((meter) => meter.label === "Codex" && meter.windowMinutes === 10_080);
  const codexSpark = codexMeters.find((meter) => meter.label === "Codex Spark" && meter.windowMinutes === 10_080);
  const codeReview = codexMeters.find((meter) => meter.label === "Code Review" && meter.windowMinutes === 43_200);
  assert.equal(codexPrimary?.remainingPercent, 80);
  assert.equal(codexPrimary?.resetAtMs, codexNow + 3_600_000);
  assert.equal(codexWeekly?.remainingPercent, 60);
  assert.equal(codexWeekly?.resetAtMs, codexNow + 4 * 86_400_000);
  assert.equal(codexSpark?.remainingPercent, 95);
  assert.equal(codexSpark?.resetAtMs, codexNow + 2 * 86_400_000);
  assert.equal(codeReview?.remainingPercent, 90);
  assert.equal(codeReview?.resetAtMs, codexNow + 14 * 86_400_000);
  const handlers = new Map();
  const commands = new Map();
  const statuses = new Map();
  const widgets = new Map();
  const notifications = [];
  const customInteractions = [];
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
  };
  extension(pi);
  assert.ok(commands.has("usage"));
  assert.equal(commands.has("codex-usage"), false);
  assert.deepEqual(
    commands.get("usage").getArgumentCompletions("").map((item) => item.value),
    ["refresh", "reload", "status"],
  );
  assert.deepEqual(
    commands.get("usage").getArgumentCompletions("re").map((item) => item.value),
    ["refresh", "reload"],
  );
  assert.equal(commands.get("usage").getArgumentCompletions("unknown"), null);

  const model = {
    id: "pro-1",
    name: "Pro 1",
    provider: "acme",
    api: "openai-completions",
    baseUrl: "https://ai.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-model-key", headers: {} }),
      getProviderAuth: async () => ({ auth: { apiKey: "test-model-key" }, env: {} }),
      find: (provider, modelId) => modelId === "pro-1" ? {
        provider,
        id: modelId,
        name: "Pro 1",
      } : undefined,
      getAll: () => [{ provider: "catalog", id: "other", name: "Fable 5" }],
      getProviderDisplayName: (provider) => ({
        "renamed-codex": "OpenAI Codex",
        "renamed-openrouter": "OpenRouter",
        "renamed-deepseek": "DeepSeek",
      })[provider] ?? provider,
    },
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
    getContextUsage: () => ({ tokens: 250, contextWindow: 1000, percent: 25 }),
    ui: {
      theme: {
        fg: (_color, text) => text,
        bold: (text) => text,
      },
      custom: async (factory) => {
        const interaction = customInteractions.shift();
        assert.ok(interaction, "Unexpected custom UI dialog");
        return new Promise((resolve, reject) => {
          const component = factory({ requestRender: () => {} }, ctx.ui.theme, {}, resolve);
          Promise.resolve(interaction(component)).catch(reject);
        });
      },
      setStatus: (key, value) => statuses.set(key, value),
      setWidget: (key, value, options) => {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, { lines: value, options });
      },
      notify: (message, level) => notifications.push({ message, level }),
    },
  };
  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const status = widgets.get("pi-usage")?.lines.join("\n");
  assert.match(status, /^Custom • Context ─+ 75% • ─+ \$0\.875$/);
  assert.equal(widgets.get("pi-usage")?.options?.placement, "belowEditor");
  assert.equal(statuses.get("pi-usage"), undefined);
  widgets.set("other-extension", { lines: ["Other widget"], options: { placement: "belowEditor" } });

  customInteractions.push(async (component) => {
    const rendered = component.render(100).join("\n");
    assert.doesNotMatch(rendered, /pi-usage settings/);
    assert.match(rendered, /Refresh interval/);
    assert.match(rendered, /Show usage realtime widget.*true/);
    assert.match(rendered, /General.*Site Types.*Stats/);
    assert.match(rendered, /Esc to close/);
    assert.doesNotMatch(rendered, /Esc to cancel|Changes save and apply immediately|pi-usage\.json|Edit complete JSON|Reset to defaults/);
    component.handleInput("\r");
    component.handleInput("\r");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\x1b[B");
    component.handleInput("\r");
    assert.equal(widgets.has("pi-usage"), false);
    assert.equal(widgets.get("other-extension")?.lines.join("\n"), "Other widget");
    component.handleInput("\t");
    const siteTypeRendered = component.render(100).join("\n");
    assert.match(siteTypeRendered, /\bacme\b/);
    component.handleInput("\r");
    component.handleInput("\t");
    const statsRendered = component.render(100).join("\n");
    assert.match(statsRendered, /Tokens per Day/);
    assert.match(statsRendered, /Loading usage history/);
    assert.match(statsRendered, /Tokens · Cost/);
    assert.doesNotMatch(statsRendered, /● Pro 1|● Fable 5|In: 127\.4k/);
    component.handleInput("\x1b[B");
    const costLoadingRendered = component.render(100).join("\n");
    assert.match(costLoadingRendered, /Cost per Day/);
    assert.match(costLoadingRendered, /Loading usage history/);
    component.handleInput("\x1b[C");
    const recentStatsRendered = component.render(100).join("\n");
    assert.match(recentStatsRendered, /Cost per Day/);
    assert.match(recentStatsRendered, /Last 7 days/);
    component.handleInput("\x1b[D");
    assert.match(component.render(100).join("\n"), /Cost per Day/);
    await waitUntil(() => !component.render(100).join("\n").includes("Loading usage history"));
    const loadedCostRendered = component.render(100).join("\n");
    assert.match(loadedCostRendered, /Cost per Day/);
    assert.match(loadedCostRendered, /Cost: \$9/);
    assert.doesNotMatch(loadedCostRendered, /Loading usage history|In:|Out:|Cache:/);
    component.handleInput("\x1b[A");
    assert.match(component.render(100).join("\n"), /Tokens per Day/);
    component.handleInput("\x1b[B");
    assert.match(component.render(100).join("\n"), /Cost per Day/);
    component.handleInput("\x1b");
  });
  await commands.get("usage").handler("", ctx);
  const savedConfig = JSON.parse(readFileSync(join(stateDir, "pi-usage.json"), "utf8"));
  assert.equal(savedConfig.refreshIntervalSeconds, 300);
  assert.equal(savedConfig.showUsageRealtimeWidget, false);
  assert.equal(widgets.has("pi-usage"), false);
  assert.equal(widgets.has("other-extension"), true);
  assert.deepEqual(savedConfig.providerModes["new-api"], ["acme"]);
  assert.equal(savedConfig.profiles[0].id, "custom-session");

  await commands.get("usage").handler("unknown", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "Usage: /usage [refresh|reload|status]",
    level: "error",
  });

  customInteractions.push((component) => {
    const rendered = component.render(100).join("\n");
    assert.match(rendered, /General.*Site Types.*Stats/);
    assert.match(rendered, /Tokens per Day/);
    assert.match(rendered, /● Pro 1 .*● Fable 5/);
    assert.match(rendered, /In: 127\.4k · Out: 5\.1m · Cache: 800k/);
    assert.doesNotMatch(rendered, /Loading usage history|Refresh interval|Usage profile:|pi-usage\.json/);
    component.handleInput("\x1b[B");
    const cachedCostRendered = component.render(100).join("\n");
    assert.match(cachedCostRendered, /Cost per Day/);
    assert.match(cachedCostRendered, /● Fable 5 .*● deepseek-v4-pro .*● Pro 1/);
    assert.match(cachedCostRendered, /Cost: \$9/);
    assert.doesNotMatch(cachedCostRendered, /Loading usage history|In:|Out:|Cache:/);
    component.handleInput("\x1b[C");
    assert.match(component.render(100).join("\n"), /Cost per Day/);
    component.handleInput("\x1b[A");
    assert.match(component.render(100).join("\n"), /Tokens per Day/);
    component.handleInput("\x1b");
  });
  await commands.get("usage").handler("status", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "Usage: /usage [refresh|reload|status]",
    level: "error",
  });

  writeFileSync(join(stateDir, "pi-usage.json"), JSON.stringify({
    version: 1,
    maxMeters: 1,
    profiles: [{
      id: "remote-plan",
      label: "Remote",
      priority: 600,
      match: { providers: ["acme"] },
      billing: "subscription",
      source: {
        type: "http-json",
        request: {
          url: "https://usage.example/${provider}/${model}",
          auth: { type: "none" },
        },
        meters: [
          {
            type: "quota",
            label: "Hourly",
            usedPercentPath: "data.windows[0].used_percent",
            windowSecondsPath: "data.windows[0].seconds",
            resetAfterSecondsPath: "data.windows[0].reset_after_seconds",
          },
          {
            type: "quota",
            label: "Daily",
            usedPercentPath: "data.windows[1].used_percent",
            windowSecondsPath: "data.windows[1].seconds",
            resetAfterSecondsPath: "data.windows[1].reset_after_seconds",
          },
          {
            type: "quota",
            label: "Weekly",
            usedPercentPath: "data.windows[2].used_percent",
            windowSecondsPath: "data.windows[2].seconds",
            resetAfterSecondsPath: "data.windows[2].reset_after_seconds",
          },
          {
            type: "quota",
            label: "Monthly",
            usedPercentPath: "data.windows[3].used_percent",
            windowSecondsPath: "data.windows[3].seconds",
            windowLabelPath: "data.windows[3].period",
            resetAfterSecondsPath: "data.windows[3].reset_after_seconds",
          },
        ],
      },
    }],
  }), "utf8");
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      data: {
        windows: [
          { used_percent: 10, seconds: 3_600, reset_after_seconds: 1_800 },
          { used_percent: 20, seconds: 86_400, reset_after_seconds: 7_200 },
          { used_percent: 30, seconds: 604_800, reset_after_seconds: 345_600 },
          { used_percent: 40, seconds: 2_592_000, period: "monthly", reset_after_seconds: 1_209_600 },
        ],
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await commands.get("usage").handler("reload", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requestedUrl, "https://usage.example/acme/pro-1");
  const subscriptionDisplay = widgets.get("pi-usage")?.lines.join("\n");
  assert.match(subscriptionDisplay, /^Remote • 1h /);
  assert.match(subscriptionDisplay, / • 1d /);
  assert.match(subscriptionDisplay, / • 1w /);
  assert.match(subscriptionDisplay, / • 1mo /);
  assert.match(subscriptionDisplay, /\(resets 30m\)/);
  assert.match(subscriptionDisplay, /\(resets 2h\)/);
  assert.match(subscriptionDisplay, /\(resets 4d\)/);
  assert.match(subscriptionDisplay, /\(resets 2w\)/);
  assert.doesNotMatch(subscriptionDisplay, /\breset\s/);
  assert.equal(subscriptionDisplay.split(" • ").length, 5);

  const commandCtx = { ...ctx };
  await commands.get("usage").handler("refresh", commandCtx);
  assert.deepEqual(notifications.at(-1), {
    message: "Usage refreshed: Remote.",
    level: "info",
  });
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  await commands.get("usage").handler("refresh", ctx);
  assert.deepEqual(notifications.at(-1), {
    message: "Usage refresh failed: network down",
    level: "error",
  });
  const failedDisplay = widgets.get("pi-usage")?.lines.join("\n");
  assert.ok(failedDisplay?.startsWith(subscriptionDisplay));
  assert.match(failedDisplay, /\(1m ago\)$/);

  writeFileSync(join(stateDir, "pi-usage.json"), JSON.stringify({
    version: 1,
    providerModes: {
      "new-api": ["acme"],
    },
  }), "utf8");
  const newApiRequests = [];
  globalThis.fetch = async (url) => {
    const requestUrl = String(url);
    newApiRequests.push(requestUrl);
    if (requestUrl.endsWith("/api/status")) {
      return new Response(JSON.stringify({ data: { quota_display_type: "CNY", quota_per_unit: 500000, usd_exchange_rate: 1 } }), { status: 200 });
    }
    if (requestUrl.includes("/billing/subscription")) {
      return new Response(JSON.stringify({ hard_limit_usd: 100 }), { status: 200 });
    }
    if (requestUrl.includes("/billing/usage")) {
      return new Response(JSON.stringify({ total_usage: 2500 }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  };
  await commands.get("usage").handler("reload", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(newApiRequests.some((url) => url === "https://ai.example.com/api/status"));
  assert.ok(newApiRequests.some((url) => url.startsWith("https://ai.example.com/") && url.includes("/billing/subscription")));
  assert.ok(newApiRequests.some((url) => url.includes("/billing/usage")));
  const newApiDisplay = widgets.get("pi-usage")?.lines.join("\n");
  assert.match(newApiDisplay, /^acme • ─+ ¥75$/);

  writeFileSync(join(stateDir, "pi-usage.json"), JSON.stringify({ version: 1 }), "utf8");
  model.provider = "renamed-codex";
  model.api = "openai-codex-responses";
  model.baseUrl = "https://chatgpt.example/backend-api";
  let officialRequest;
  globalThis.fetch = async (url) => {
    officialRequest = String(url);
    return new Response(JSON.stringify({
      rate_limit: {
        primary_window: {
          used_percent: 25,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
      },
    }), { status: 200 });
  };
  await commands.get("usage").handler("reload", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(officialRequest, "https://chatgpt.example/backend-api/wham/usage");
  assert.match(widgets.get("pi-usage")?.lines.join("\n"), /^OpenAI Codex • 5h ─+ 75%/);
  assert.doesNotMatch(widgets.get("pi-usage")?.lines.join("\n"), /OpenAI Codex • Codex/);

  model.provider = "renamed-openrouter";
  model.api = "openai-completions";
  model.baseUrl = "https://openrouter.ai/api/v1";
  globalThis.fetch = async (url) => {
    officialRequest = String(url);
    return new Response(JSON.stringify({ data: { limit_remaining: 80, usage: 20, limit: 100 } }), { status: 200 });
  };
  await commands.get("usage").handler("reload", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(officialRequest, "https://openrouter.ai/api/v1/key");
  const openRouterDisplay = widgets.get("pi-usage")?.lines.join("\n");
  assert.match(openRouterDisplay, /^OpenRouter • ─+ \$80$/);

  model.provider = "renamed-deepseek";
  model.baseUrl = "https://api.deepseek.com/v1";
  globalThis.fetch = async (url) => {
    officialRequest = String(url);
    return new Response(JSON.stringify({ balance_infos: [{ total_balance: "12.5", currency: "CNY" }] }), { status: 200 });
  };
  await commands.get("usage").handler("reload", ctx);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(officialRequest, "https://api.deepseek.com/user/balance");
  const deepSeekDisplay = widgets.get("pi-usage")?.lines.join("\n");
  assert.equal(deepSeekDisplay, "DeepSeek • ¥12.5 left");
  assert.doesNotMatch(deepSeekDisplay, /─/);
  globalThis.fetch = originalFetch;

  for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
  assert.equal(widgets.get("pi-usage"), undefined);
  assert.equal(statuses.get("pi-usage"), undefined);

  console.log("pi-usage regression tests passed");
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
