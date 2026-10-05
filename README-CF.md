# 墨水屏看板 · Cloudflare Pages 部署指南

## 目录结构
```
elink-repo/
├── functions/api/
│   ├── generate.js          # 内容生成（GLM 文案 + CogView 生图 → 渲染 5 页 → 存 KV）
│   ├── page/[page].js       # 页面输出（/api/page/quote 等 5 个固定 URL）
│   ├── img/[name].js        # 图片输出（/api/img/landmark，读 KV 里的图片字节）
│   └── status.js            # 管理接口：状态查询
├── cron-worker/
│   ├── worker.js            # 定时触发器（CF Pages 不支持 cron，用 Worker 补）
│   └── wrangler.toml        # cron 配置：UTC 23:00 = 北京 07:00
├── public/
│   └── index.html           # 状态页（不含任何密钥）
└── .gitignore
```

> 注：`edgeone.json`、`README.md` 是早期 EdgeOne 方案的遗留文件，在 Cloudflare 上无用。

## 部署步骤

### 1. 注册开通
- https://dash.cloudflare.com 注册/登录（免费计划即可）
- 需要一个 GitHub/GitLab 账号（CF Pages 直传 zip 不支持 Functions，必须走 Git）

### 2. 建 KV 存储
- 控制台 → **Storage & Databases → KV** → Create namespace
- 名称 `dashboard-kv`

### 3. 部署 Pages 项目
1. 把仓库推到 GitHub（`functions/` 和 `public/` 在仓库根目录）
2. CF 控制台 → **Workers & Pages → Create → Pages → Connect to Git** → 选仓库
3. 构建配置：Framework preset 选 **None**，构建命令**留空**，输出目录填 `public`
4. 部署后得到 `https://xxx.pages.dev`

### 4. 绑定 KV + 环境变量
项目 → **Settings**：
1. **Bindings** → 添加 **KV namespace**：Variable name 填 **`DASHBOARD_KV`**，选 `dashboard-kv`
2. **Variables and Secrets** → 添加：
   - `GLM_API_KEY` = 智谱 API Key
   - `CRON_SECRET` = 自定义一串字符
3. **每次改绑定/变量后必须重新部署**（Deployments → Retry deployment，或推个空提交）

> 注意：`CRON_SECRET` 不要写进 `public/` 下的任何文件 —— 静态页面对所有人可见。

### 5. 部署定时触发 Worker
CF 控制台 → **Workers & Pages → Create → Worker** → 命名 `epd-dashboard-cron` → Deploy：
1. Worker → **Edit code** → 粘贴 `cron-worker/worker.js` 全部内容 → Deploy
2. Worker → **Settings → Variables**：
   - `SITE_URL` = https://xxx.pages.dev
   - `CRON_SECRET` = 与 Pages 里一致
3. Worker → **Settings → Trigger Events → Cron Triggers** → 添加 `0 23 * * *`（UTC 23:00 = 北京 07:00）

或本地 wrangler 部署：`cd cron-worker && npx wrangler deploy`

### 6. 首次生成 + 验证
推荐用请求头传密钥（不进 URL、不进日志）：
```bash
curl -H "X-Cron-Secret: 你的密钥" https://xxx.pages.dev/api/generate
```
或兼容的查询参数方式（密钥会进访问日志，不推荐）：
```
https://xxx.pages.dev/api/generate?key=你的密钥
```

返回 JSON 里 5 项都是 `"ok"` 即成功。再逐个打开验证：
```
/api/page/quote  /api/page/weather  /api/page/architecture
/api/page/extinct  /api/page/landmark
```

管理接口状态查询：
```bash
curl -H "X-Cron-Secret: 你的密钥" https://xxx.pages.dev/api/status
```
`/api/generate` 有 60 秒冷却，连续调用第二次会返回"调用过于频繁"。

### 7. 绑定 SenseCraft HMI
5 个 Web Content 页面分别指向：
```
/api/page/quote
/api/page/weather
/api/page/architecture
/api/page/extinct
/api/page/landmark        （含 AI 生成图）
```
加入 Pagelist 轮播，设备 Interval = 1440（分钟）= 每天刷新一次。

## KV 里存了什么

| 键 | 内容 |
|---|---|
| `page:quote` … `page:landmark` | 5 个页面的成品 HTML |
| `meta:quote` … `meta:landmark` | 各页更新时间戳 |
| `img:landmark` | AI 生成的图片**字节**（不是临时链接） |
| `meta:lastRunAt` | 上次全量生成时间（用于防重入冷却） |

**为什么图片要存字节**：智谱 CogView 返回的 URL 带签名，约 7 天后失效。若页面直接引用该 URL，墨水屏过几天就只剩占位符。所以 `generate.js` 生图后会立刻把图片下载并写入 KV，页面改用 `/api/img/landmark` 读取。

## 修改要点
| 想改什么 | 改哪里 |
|---|---|
| 天气城市 | `generate.js` 顶部 `CITY` 常量 |
| 文案模型 | `MODEL` 常量（当前 `glm-5.3-flash`） |
| 生图风格 | `E6_STYLE_PROMPT` 常量 |
| 生成冷却时间 | `COOLDOWN_MS`（默认 60 秒） |
| 每日更新时间 | `cron-worker/wrangler.toml` 的 `crons`（注意是 UTC） |
