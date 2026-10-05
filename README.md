# 墨水屏看板 · EdgeOne Pages 部署指南

## 目录结构
```
edgeone-dashboard/
├── edgeone.json                    # 定时任务：每天 07:00 触发 /api/generate
├── functions/
│   ├── api/
│   │   ├── generate.js             # 内容生成（GLM 文案 → 渲染 4 页 → 存 KV）
│   │   └── page/[page].js          # 页面输出（/api/page/quote 等 4 个固定 URL）
└── public/
    └── index.html                  # 状态页
```

## 部署步骤

### 1. 注册开通
- 腾讯云控制台搜 "EdgeOne Pages"，开通免费套餐
- 进入 Pages 控制台，先建一个 **KV 存储**，命名 `dashboard-kv`

### 2. 创建项目
- Pages 控制台 → 创建项目 → **直接上传**（本目录打包 zip 上传）
- 或推到 GitHub 仓库后选择 Git 导入（推荐，方便后续改代码自动部署）

### 3. 配置
项目设置里添加：
- **KV 绑定**：变量名必须填 `DASHBOARD_KV`，选择刚建的 `dashboard-kv`
- **环境变量**：
  - `GLM_API_KEY` = 智谱 API Key（https://bigmodel.cn/usercenter/proj-mgmt/apikeys）
  - `CRON_SECRET` = 随便一串字符（保护手动触发接口，可选）

### 4. 首次生成
浏览器访问：
```
https://你的域名.edgeone.app/api/generate?key=你的CRON_SECRET
```
返回 JSON 里四个页面都是 "ok" 即成功。

### 5. 绑定 SenseCraft HMI
- HMI → Web Content → URL 填 `https://你的域名.edgeone.app/api/page/quote`
- 其余三页同理（weather / architecture / extinct）
- Pagelist 加入 4 个页面轮播，设备 Interval 设 1440（分钟）= 每天一换

## 修改城市
`functions/api/generate.js` 里 `genWeather` 的 latitude/longitude（当前是北京）。

## 修改文案质量
`MODEL` 常量：`glm-4.7-flash`（便宜）→ 换 `glm-4-plus`（更好，贵数倍）。

## 图片增强（路径 B，后续可选）
当前是纯 HTML 海报风。若要 AI 生图 + 6 色量化，用本地 Python 跑
image-gen + epaper-image-adapter 出 800×480 PNG，再随代码一起部署到静态目录，
改对应页面模板把图片区域换成 `<img src="/images/today.png">`。
