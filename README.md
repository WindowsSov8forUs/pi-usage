# pi-usage

根据 Pi 当前选中的模型自动显示订阅额度、账户余额、预算消耗或会话上下文/成本。

额度信息通过 `belowEditor` widget 独占输入框下方一行，不与其他扩展的 footer status 挤在同一行。

Widget 采用 `name • window1 • window2` 布局。订阅窗口保留进度条，例如 `Codex • 5h ───── 82% (resets 2h 13m) • 1w ─── 64% (resets 4d 8h)`。按量计费在能直接取得百分比或能由余额/已用量与总量计算百分比时也显示进度条，例如 `OpenRouter • ───── $80`；只有余额或消费额而没有任何总量信息时不显示进度条，例如 `DeepSeek • ¥12.5 left`。

## 安装

从 GitHub Release 对应的 tag 安装（将仓库所有者和版本替换为实际值）：

```bash
pi install git:github.com/OWNER/pi-usage@v0.1.0
```

也可以先临时试用，不写入 Pi 设置：

```bash
pi -e git:github.com/OWNER/pi-usage@v0.1.0
```

指定 tag 的安装是固定版本；发布新版本后，使用新 tag 再执行一次 `pi install`。如果安装不带 tag 的默认分支版本，则可通过 `pi update --extensions` 拉取更新，但可复现性不如 Release tag。

## 内置适配

无需配置即可启用：

- `openai-codex`：读取 ChatGPT Codex 返回的全部订阅窗口（主、次级、旧版及专项 rate-limit），显示剩余百分比和重置倒计时。
- 官方 `openrouter`：读取当前 API Key 的 usage、limit 和剩余额度。
- 官方 `deepseek`：读取账户余额及货币单位。
- 其他模型：显示当前上下文剩余比例；模型配置包含价格时，同时显示当前会话中该模型的累计成本。

OpenRouter 和 DeepSeek 根据当前模型的官方 `baseUrl` 自动识别，因此即使在 Pi 中使用了自定义 provider 名称也无需配置。第三方 New API/One API 站点才需要在 `providerModes` 中声明 provider 名称。

扩展直接使用 Pi 当前选中模型的配置：provider 名称、模型名、API 类型、`baseUrl`，以及 Pi 已解析的 API Key/headers。模型切换时自动切换 usage 模式，不需要在本扩展中重复填写模型、URL 或密钥。

## 配置文件

配置路径：

```text
~/.pi/agent/pi-usage.json
```

首次自定义时可复制仓库中的 `pi-usage.json` 到上述路径。把配置放在 Pi 的用户目录，而不是 Git package clone 内，可避免 `pi update` 或切换 Release tag 时被 Git 重置。为兼容旧的手动安装，如果用户目录中没有配置，扩展仍会回退读取扩展目录旁的 `pi-usage.json`。修改后运行：

```text
/usage reload
```

其他命令：

```text
/usage refresh
/usage reload
/usage status
```

| 命令 | 功能 |
|---|---|
| `/usage refresh` | 重新查询当前已匹配 profile 的远程额度，或重新计算本地 session 指标；不重新读取配置文件。成功后直接更新独立 usage 行；失败时保留最后成功缓存并弹出具体错误。 |
| `/usage reload` | 重新读取 `~/.pi/agent/pi-usage.json`（或兼容路径），按当前模型重新选择 profile，应用缓存并在后台发起新一次刷新；同时重建刷新和倒计时定时器。 |
| `/usage status` | 不发送 usage 请求；显示当前 profile ID、当前 `provider/model`、实际配置路径，以及最近一次刷新错误（如有）。 |

输入 `/usage ` 后，Pi TUI 会提供 `refresh`、`reload`、`status` 三个参数候选。无参数 `/usage` 不执行刷新；它和其他非法参数一样只显示 `/usage [refresh|reload|status]` 用法错误。

## 顶层配置

```json
{
  "version": 1,
  "refreshIntervalSeconds": 60,
  "barWidth": 12,
  "maxMeters": 2,
  "providerModes": {
    "new-api": ["soruxgpt-ai"]
  },
  "disabledBuiltIns": [],
  "profiles": []
}
```

- `refreshIntervalSeconds`：远程接口刷新间隔，限制为 15～3600 秒。
- `barWidth`：进度条宽度，限制为 4～30。
- `maxMeters`：按量计费 profile 最多同时显示 1～6 个指标；订阅 profile 会显示接口返回的全部有效限额窗口，不受此项截断。
- `providerModes`：第三方站点配置，只需把 Pi `models.json` 中的 provider 名称填入对应模式。
- `disabledBuiltIns`：可填 `codex`、`openrouter`、`deepseek`、`session`。
- `profiles`：可选的高级自定义适配；通常保持空数组。

## 第三方 Provider 配置

配置方式类似 `pi-codex-conversion` 的 `scope.additionalProviders`：数组中只填写第三方 Pi provider 名称，必须与 `models.json` 的 `providers` 键完全一致。

```json
{
  "providerModes": {
    "new-api": ["soruxgpt-ai", "company-new-api"]
  }
}
```

`new-api` 适用于 New API/One API 系第三方站点。扩展自动从当前模型 `baseUrl` 移除末尾 `/v1`，复用当前 provider 的模型 Key，并识别站点的 USD、CNY 或 tokens 计价配置。选择该 provider 下任意模型后，底栏会自动切换。

官方 OpenAI/Codex、OpenRouter 和 DeepSeek 不写入这里：扩展直接根据 Pi 当前模型配置自动匹配。

## 高级：自定义 Profile

只有站点不是上述模式，或者需要特殊请求 URL、headers、响应字段映射时，才需要使用 `profiles`。用户 profile 优先于同优先级的简写模式，并可按 `provider`、`model`、`api`、`baseUrl` 共同匹配。

### 模型匹配

```json
{
  "match": {
    "providers": ["company-*"],
    "models": ["gpt-*", "claude-?"],
    "apis": ["openai-*", "anthropic-messages"],
    "baseUrls": ["https://ai.example.com/*"]
  }
}
```

数组内是“或”，不同字段之间是“且”。支持 `*` 和 `?`，忽略大小写；字段省略或使用空数组表示不限制。

### 数据源

#### New API 按量计费

```json
{
  "id": "my-new-api",
  "label": "My Gateway",
  "priority": 500,
  "match": {
    "providers": ["my-new-api-provider"],
    "baseUrls": ["https://gateway.example.com/*"]
  },
  "billing": "metered",
  "source": {
    "type": "new-api",
    "baseUrl": "https://gateway.example.com",
    "auth": { "type": "model" }
  }
}
```

该数据源复用模型 Key，优先请求 New API 的 `/v1/dashboard/billing/subscription` 与 `/v1/dashboard/billing/usage`，计算账户剩余额度；站点不支持这些兼容接口时，回退到 `/api/usage/token/`。它还读取公开 `/api/status` 中的 `quota_display_type`、`quota_per_unit` 和汇率，自动使用 USD、CNY 或 tokens。

`baseUrl` 可省略，此时从当前模型 `baseUrl` 自动移除末尾 `/v1`。也可以配置 `currency`、`precision`，或使用下文相同的 `auth` 配置。

#### 任意 HTTP JSON

```json
{
  "id": "my-plan",
  "label": "My Plan",
  "priority": 500,
  "match": { "providers": ["my-provider"] },
  "billing": "subscription",
  "source": {
    "type": "http-json",
    "request": {
      "url": "https://billing.example.com/usage?model=${model}",
      "method": "GET",
      "auth": { "type": "model" },
      "headers": { "x-account": "${env:ACCOUNT_ID}" },
      "timeoutSeconds": 20
    },
    "meters": []
  }
}
```

URL、header 和 JSON body 支持：

- `${provider}`、`${model}`、`${api}`、`${baseUrl}`：当前 Pi 模型配置。
- `${env:NAME}`：优先读取当前 provider 凭据中的 scoped env，再读取进程环境变量。

请求支持 `GET`、`POST` 和 JSON body。

#### 鉴权模式

```json
{ "type": "model" }
{ "type": "provider", "provider": "billing-provider" }
{ "type": "env", "env": "BILLING_KEY" }
{ "type": "none" }
```

- `model`：复用当前模型已经解析好的 API Key 和 headers。
- `provider`：使用指定 provider 在 Pi 中保存的凭据。
- `env`：读取 provider scoped env 或进程环境变量。
- `none`：不自动添加凭据。

可设置 `header` 和 `scheme`。默认生成 `Authorization: Bearer <key>`；`scheme: ""` 可用于 `x-api-key`。`inheritHeaders: false` 禁止把模型/provider 已解析 headers 复制到 usage 请求。

## 指标映射

路径使用点号或数组下标，例如 `data.plan.used`、`balances[0].amount`。`[*]` 或 `.*` 可展开数组/对象，并配合 `aggregate: "sum" | "min" | "max"`；默认取第一个值。数字字符串会自动转换。

### 订阅额度

```json
{
  "type": "quota",
  "label": "Monthly",
  "usedPercentPath": "data.used_percent",
  "windowMinutesPath": "data.window_minutes",
	"windowLabelPath": "data.period",
	"resetAtPath": "data.reset_at",
	"resetAfterSecondsPath": "data.reset_after_seconds"
}
```

也可以提供 `remainingPercentPath`，或用 `usedPath` + `limitPath` 自动计算百分比。秒级窗口使用 `windowSecondsPath`。

- `windowLabelPath`：可选的接口窗口名称；`hourly`、`daily`、`weekly`、`monthly` 会显示为 `1h`、`1d`、`1w`、`1mo`。没有名称时根据窗口时长显示；30 天只显示 `30d`，不会被错误推断为自然月。
- `resetAfterSecondsPath`：距离重置的相对秒数，优先级高于绝对时间。
- `resetAtPath`：绝对重置时间，支持 ISO 字符串、Unix 秒和 Unix 毫秒。

每个 quota 会显示带括号的独立倒计时，例如 `(resets 2h 13m)`、`(resets 4d 8h)`。倒计时由本地定时器更新，不会为了更新文字额外请求供应商接口。多个订阅窗口全部保留，并在 `belowEditor` widget 中按接口配置顺序显示；Codex 窗口按类别和时长排序、重复的新旧字段会自动去重。

### 按量余额/预算

```json
{
  "type": "balance",
  "remainingPath": "data.balance",
  "usedPath": "data.spent",
  "limitPath": "data.budget",
	"remainingPercentPath": "data.remaining_percent",
  "currencyPath": "data.currency",
  "precision": 2
}
```

`remainingPath` 可省略，此时使用 `limit - used`。`balance` 也支持 `remainingPercentPath` 或 `usedPercentPath` 直接读取百分比。能够直接得到百分比，或能够由 `remaining/limit`、`used/limit` 推导百分比时显示进度条；没有任何总量或百分比信息时只显示余额/消费额，不显示进度条。固定货币可使用 `currency: "USD"`，非货币额度可使用 `unit: " credits"`。`scale` 可转换供应商内部计价单位。

## 本地会话数据源

没有账户查询接口时可显式配置：

```json
{
  "id": "session-budget",
  "label": "Session",
  "match": { "providers": ["anthropic"] },
  "billing": "metered",
  "source": {
    "type": "session",
    "budget": 5,
    "currency": "USD",
    "showContext": true,
    "showCost": true
  }
}
```

成本来自 Pi 会话中 assistant message 已计算的 `usage.cost.total`，并按当前 `provider/model` 过滤；它不是供应商账户账单。

## 缓存与安全

成功结果会被标准化后缓存到 `~/.pi/agent/pi-usage-cache.json`。缓存只保存数值指标和时间，不保存 API Key、请求 headers 或原始响应。远程刷新失败时继续显示最后一次成功值，并标出缓存年龄。

配置中的 HTTP endpoint 会收到你选择复用的凭据。只有在信任目标站点时才使用 `model` 或 `provider` 鉴权；跨站点接口优先使用独立的 `env` 凭据并设置 `inheritHeaders: false`。

## 发布 Release

仓库包含 `.github/workflows/release.yml`，通过 GitHub Actions 手动创建 tag 和 Release：

1. 修改 `package.json` 中的 `version`，提交并推送到默认分支。
2. 在 GitHub 仓库的 **Actions → Release → Run workflow** 中输入同一个版本号，例如 `0.1.0`（不要带 `v`）。
3. Workflow 使用 Node.js 22 安装依赖并运行测试，验证输入版本与 `package.json` 一致。
4. 测试通过后创建 `v0.1.0` tag 和 GitHub Release，并在 Release notes 与 job summary 中生成该仓库可直接复制的 `pi install` 命令。

Pi 的 Git package 安装会 clone 仓库、checkout 指定 tag、执行 `npm install`，再根据 `package.json` 的 `pi.extensions` 加载 `index.ts`；因此不需要额外上传压缩包或编译产物。

## License

MIT
