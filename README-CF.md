# 墨水屏看板 · Cloudflare Pages 部署指南

## 目录结构
```
edgeone-dashboard/
├── functions/
│   ├── api/
│   │   ├── generate.js             # 内容生成（GLM 文案 → 渲染 4 页 → 存 KV）
│   │   └── page/[page].js          # 页面输出（/api/page/quote 等 4 个固定 URL）
├── cron-worker/
│   ├── worker.js                   # 定时触发器（CF Pages 不支持 cron，用 Worker 补）
│   └── wrangler.toml               # cron 配置：UTC 23:00 = 北京 07:00
├── public/
│   └── index.html                  # 状态页
└── README.md
```

> 注：edgeone.json 在 Cloudflare 上无用，留着不影响。

## 部署步骤

### 1. 注册开通
- https://dash.cloudflare.com 注册/登录（免费计划即可）
- 需要一个 GitHub/GitLab 账号（CF Pages 直传 zip 不支持 Functions，必须走 Git）

### 2. 建_kv 存储
- 控制台 → **Storage & Databases → KV** → Create namespace
- 名称 `dashboard-kv`

### 3. 部署 Pages 项目
1. 把 `edgeone-dashboard` 文件夹推到 GitHub 仓库（functions/ 和 public/ 在仓库根目录）
2. CF 控制台 → **Workers & Pages → Create → Pages → Connect to Git** → 选仓库
3. 构建配置：Framework preset 选 **None**，构建命令**留空**，输出目录填 `public`
4. 部署后得到 `https://xxx.pages.dev`

### 4. 绑定 KV + 环境变量
项目 → **Settings**：
1. **Bindings** → 添加 **KV namespace**：Variable name 填 **`DASHBOARD_KV`**，选 `dashboard-kv`
2. **Variables and Secrets** → 添加：
   - `GLM_API_KEY` = 智谱 API Key
   - `CRON_SECRET` = 自定义一串字符（如 epd2026）
3. **每次改绑定/变量后必须重新部署**（Deployments → Retry deployment，或推个空提交）

### 5. 部署定时触发 Worker
CF 控制台 → **Workers & Pages → Create → Worker** → 命名 `epd-dashboard-cron` → Deploy：
1. Worker → **Edit code** → 粘贴 `cron-worker/worker.js` 全部内容 → Deploy
2. Worker → **Settings → Variables**：
   - `SITE_URL` = https://xxx.pages.dev
   - `CRON_SECRET` = 与 Pages 里一致
3. Worker → **Settings → Trigger Events → Cron Triggers** → 添加 `0 23 * * *`（UTC 23:00 = 北京 07:00）

或本地 wrangler 部署：`cd cron-worker && npx wrangler deploy`

### 6. 首次生成 + 验证
浏览器访问：
```
https://xxx.pages.dev/api/generate?key=epd2026
```
返回 JSON 四项都 "ok" 即成功。再打开：
```
https://xxx.pages.dev/api/page/quote
https://xxx.pages.dev/api/page/weather
https://xxx.pages.dev/api/page/architecture
https://xxx.pages.dev/api/page/extinct
```

### 7. 绑定 SenseCraft HMI
4 个 Web Content 页面分别指向上面 4 个 URL，Pagelist 轮播，设备 Interval = 1440。

## 修改要点
- 城市：generate.js 里 genWeather 的 latitude/longitude（当前北京）
- 文案模型：MODEL 常量（默认 glm-4.7-flash，可换 glm-4-plus）
- 更新时间：cron-worker/wrangler.toml 的 crons（注意是 UTC）
