/**
 * 共享模块：内容生成 + 认证 + 调度 + 页面配置
 *
 * 放在 functions/api/_lib.js —— 下划线开头的文件不会被 Pages 当作路由，
 * 仅供其他函数 import，避免 generate / refresh 两处重复代码。
 */

const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
export const MODEL = "glm-5.3-flash"; // 付费模型（0.8/2.8元每百万tokens），带 429 自动重试

// 天气城市配置：换城市只改这里
export const CITY = { name: "北京", lat: 39.9042, lon: 116.4074 };

// ---------- 通用小工具 ----------

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 北京时区的"X年X月X日"
export function getDateStr() {
  return new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric",
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
export { jsonResponse };

// ---------- 页面风格配置（白名单 JSON -> CSS） ----------
//
// 用户在管理页输入的 JSON 只认下面的字段，其余一律忽略，非法值回退默认：
// {
//   "colors": { "bg": "#RRGGBB", "text": "#RRGGBB", "accent": "#RRGGBB" },
//   "font":   { "titleSize": 16-120, "bodySize": 12-60, "family": "serif|sans" },
//   "layout": { "writingMode": "horizontal|vertical", "align": "left|center" }
// }
// writingMode=vertical 仅一言/古建筑生效；align 仅一言生效。
// 注意墨水屏 E6 只有黑白红黄蓝绿 6 色，推荐用高对比色。

const PAGE_DEFAULTS = {
  quote:        { bg: "#FFFFFF", text: "#1A1A1A", accent: "#C0392B" },
  weather:      { bg: "#FFFFFF", text: "#1A1A1A", accent: "#2C5F8A" },
  architecture: { bg: "#FFFFFF", text: "#1A1A1A", accent: "#8B2E2E" },
  extinct:      { bg: "#1C1C1C", text: "#F2F2F2", accent: "#C0392B" },
  landmark:     { bg: "#FFFFFF", text: "#1A1A1A", accent: "#8B2E2E" },
};

function clampNum(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
}

/**
 * 校验并规范化用户传入的风格 JSON。
 * @returns 规范化后的 style 对象（全部字段保证合法，可直接进模板）
 */
export function normStyle(raw, page) {
  const def = {
    titleSize: 40, bodySize: 20, family: "serif",
    writingMode: "horizontal", align: "left",
    ...(PAGE_DEFAULTS[page] || PAGE_DEFAULTS.quote),
  };
  const s = raw && typeof raw === "object" ? raw : {};
  const c = s.colors && typeof s.colors === "object" ? s.colors : {};
  const f = s.font && typeof s.font === "object" ? s.font : {};
  const l = s.layout && typeof s.layout === "object" ? s.layout : {};

  const hex = (v, d) =>
    typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toUpperCase() : d;

  const out = {
    bg: hex(c.bg, def.bg),
    text: hex(c.text, def.text),
    accent: hex(c.accent, def.accent),
    titleSize: clampNum(f.titleSize, 16, 120, def.titleSize),
    bodySize: clampNum(f.bodySize, 12, 60, def.bodySize),
    family: f.family === "sans" ? "sans" : "serif",
    writingMode: l.writingMode === "vertical" ? "vertical" : "horizontal",
    align: l.align === "center" ? "center" : "left",
  };
  out.fontFamily =
    out.family === "sans" ? '"Noto Sans SC", sans-serif' : '"Noto Serif SC", "Source Han Serif SC", serif';
  return out;
}

/**
 * 读取某页的用户配置（提示词附加要求 + 风格 JSON）。
 * KV 键：prompt:{page} / style:{page}，都不存在时用默认。
 */
async function getPageConfig(kv, name) {
  const [promptRaw, styleRaw] = await Promise.all([
    kv.get(`prompt:${name}`),
    kv.get(`style:${name}`),
  ]);
  let style = null;
  try { style = styleRaw ? JSON.parse(styleRaw) : null; } catch { /* 配置损坏则用默认 */ }
  return {
    extraPrompt: (promptRaw || "").trim().slice(0, 600),
    style: normStyle(style, name),
  };
}

// 把用户附加要求拼到提示词末尾；明确告知不得破坏 JSON 结构
function withExtra(basePrompt, extraPrompt) {
  return extraPrompt
    ? `${basePrompt}\n\n内容附加要求（只影响内容挑选与文字风格，上面要求的 JSON 结构与字段必须原样保持）：${extraPrompt}`
    : basePrompt;
}

// ---------- 内容去重（近期主题避开） ----------
// 每页维护"最近展示过的主题"列表（KV history:{page}），生成时注入提示词
// 让 GLM 避开；若仍返回重复主题，加强语气重试一次。weather 用真实数据不需要。

const MAX_HISTORY = 25;

export async function getHistory(kv, name) {
  const raw = await kv.get(`history:${name}`);
  try {
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && x) : [];
  } catch {
    return [];
  }
}

async function pushHistory(kv, name, item) {
  const hist = await getHistory(kv, name);
  const next = [item, ...hist.filter((h) => h !== item)].slice(0, MAX_HISTORY);
  await kv.put(`history:${name}`, JSON.stringify(next));
}

// 主题字段：quote 是 text，其他页是 name
function topicOf(d) {
  return String((d && (d.name || d.text)) || "").trim();
}

/**
 * 带去重的页面内容生成。
 * @returns {Promise<{data: object, style: object}>}
 */
async function genDeduped(kv, page, env, basePrompt) {
  const cfg = await getPageConfig(kv, page);
  const hist = await getHistory(kv, page);
  const avoid = hist.length
    ? `注意：以下主题最近已展示过，必须避开：${hist.join("、")}。`
    : "";

  let data = parseLoose(await glm(withExtra(avoid + basePrompt, cfg.extraPrompt), env));

  // 模型没听话仍返回重复主题时，加强语气重试一次
  const topic = topicOf(data);
  if (topic && hist.includes(topic)) {
    const retry =
      `${basePrompt}重要：${topic} 刚刚展示过，绝对不可以再选，请换一个完全不同的主题。${avoid}`;
    data = parseLoose(await glm(withExtra(retry, cfg.extraPrompt), env));
  }

  const finalTopic = topicOf(data);
  if (finalTopic) await pushHistory(kv, page, finalTopic);

  return { data, style: cfg.style };
}

// ---------- 认证（会话 Cookie + 管理密钥双轨） ----------

const SESSION_COOKIE = "epd_session";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

async function hmacSign(secret, msg) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// 校验会话 cookie（token 形如 `${expiry}.${hmac}`，防篡改、带过期）
export async function verifySession(request, env) {
  const secret = env.CRON_SECRET;
  if (!secret) return false;
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(token.slice(0, dot));
  const sig = token.slice(dot + 1);
  if (!exp || !sig || Date.now() > exp) return false;
  const expected = await hmacSign(secret, `admin:${exp}`);
  return sig === expected;
}

// 登录密码：优先 ADMIN_PASSWORD，未配置则复用 CRON_SECRET
export function adminPassword(env) {
  return env.ADMIN_PASSWORD || env.CRON_SECRET || "";
}

export function sessionCookie(env) {
  const exp = Date.now() + SESSION_TTL_MS;
  return hmacSign(env.CRON_SECRET, `admin:${exp}`).then(
    (sig) => `${SESSION_COOKIE}=${exp}.${sig}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  );
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/**
 * 管理接口统一鉴权，三者任一即可：
 *   1. 会话 cookie（管理页登录后浏览器自动携带）
 *   2. X-Cron-Secret 请求头（Worker / 脚本调用）
 *   3. ?key= 查询参数（兼容旧用法）
 */
export async function requireAdmin(request, env) {
  const secret = env.CRON_SECRET;
  if (secret) {
    const provided =
      request.headers.get("X-Cron-Secret") || new URL(request.url).searchParams.get("key");
    if (provided === secret) return true;
  }
  return verifySession(request, env);
}

// ---------- 调度配置（管理页可改，存 KV config:schedule） ----------
// mode=daily    → 每天在 hours[] 指定的小时生成
// mode=interval → 每隔 everyHours 小时生成一次

export async function getSchedule(kv) {
  const raw = await kv.get("config:schedule");
  let cfg = null;
  try { cfg = raw ? JSON.parse(raw) : null; } catch { /* 配置损坏则回退默认 */ }
  return cfg && cfg.mode ? cfg : { mode: "daily", hours: [7] };
}

// 当前北京时间小时（0-23）
export function bjHour(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai", hour: "numeric", hour12: false,
    }).format(now)
  );
}

// cron 定时触发时判断"现在是否到了该生成的时间"
export async function shouldRunNow(kv) {
  const cfg = await getSchedule(kv);
  if (cfg.mode === "interval") {
    const everyH = Math.min(24, Math.max(1, Number(cfg.everyHours) || 24));
    const last = Number((await kv.get("meta:lastSuccessAt")) || 0);
    return Date.now() - last >= everyH * 3600 * 1000;
  }
  const hours = (Array.isArray(cfg.hours) ? cfg.hours : [cfg.hours])
    .map(Number).filter((h) => h >= 0 && h <= 23);
  return hours.includes(bjHour());
}

// ---------- 页面模板（框架定死，只换内容；颜色字号走配置） ----------

function pageShell(title, baseStyleCss, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=800, initial-scale=1, user-scalable=no">
<title>${title}</title><style>${baseStyleCss}</style></head>
<body>${bodyHtml}</body></html>`;
}

function renderQuote(d) {
  const s = d.style;
  const vertical = s.writingMode === "vertical";
  const body = vertical
    ? `
  <div style="width:800px;height:480px;position:relative;background:${s.bg};box-sizing:border-box;display:flex;flex-direction:row-reverse;justify-content:flex-start;align-items:center;padding:40px 72px;gap:30px;">
    <div style="writing-mode:vertical-rl;font-size:${s.titleSize}px;line-height:2.1;font-weight:bold;color:${s.text};max-height:390px;">${d.text}</div>
    <div style="writing-mode:vertical-rl;font-size:${s.bodySize + 4}px;letter-spacing:4px;color:${s.accent};">${d.from}</div>
    <div style="position:absolute;bottom:30px;left:44px;font-size:${s.bodySize}px;letter-spacing:5px;color:${s.text};opacity:.5;">一 言 · ${d.date}</div>
  </div>`
    : `
  <div style="width:800px;height:480px;display:flex;flex-direction:column;${s.align === "center" ? "align-items:center;text-align:center;" : ""}justify-content:center;padding:70px 80px;box-sizing:border-box;background:${s.bg};">
    <div style="font-size:${s.bodySize}px;letter-spacing:6px;color:${s.text};opacity:.55;border-bottom:2px solid ${s.accent};padding-bottom:12px;margin-bottom:40px;${s.align === "center" ? "padding-left:12px;padding-right:12px;" : ""}">一 言 · ${d.date}</div>
    <div style="font-size:${s.titleSize}px;line-height:1.7;font-weight:bold;color:${s.text};">${d.text}</div>
    <div style="margin-top:48px;font-size:${s.bodySize + 4}px;color:${s.accent};">—— ${d.from}</div>
    <div style="position:absolute;bottom:28px;right:36px;font-size:${s.bodySize}px;font-weight:bold;color:${s.text};opacity:.7;">${d.date}</div>
  </div>`;
  return pageShell("一言",
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     html, body { width: 800px; height: 480px; overflow: hidden; font-family: ${s.fontFamily}; }`,
    body);
}

function renderWeather(d) {
  const s = d.style;
  return pageShell("天气",
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     html, body { width: 800px; height: 480px; overflow: hidden; font-family: ${s.fontFamily}; background: ${s.bg}; color: ${s.text}; }`,
    `
  <div style="width:800px;height:480px;background:${s.bg};box-sizing:border-box;padding:0;">
    <div style="height:150px;background:${s.accent};color:${s.bg};padding:30px 50px;box-sizing:border-box;">
      <div style="font-size:${s.bodySize + 2}px;opacity:.85;">${d.city} · ${d.date}</div>
      <div style="font-size:${s.titleSize + 16}px;font-weight:bold;line-height:1.3;">${d.temp}°C  ${d.condition}</div>
    </div>
    <div style="padding:28px 50px;display:flex;gap:40px;border-bottom:1px solid ${s.text}22;">
      <div><div style="font-size:${s.bodySize}px;font-weight:bold;color:${s.text};opacity:.75;">湿度</div><div style="font-size:${s.bodySize + 10}px;font-weight:bold;">${d.humidity}%</div></div>
      <div><div style="font-size:${s.bodySize}px;font-weight:bold;color:${s.text};opacity:.75;">风向</div><div style="font-size:${s.bodySize + 10}px;font-weight:bold;">${d.wind}</div></div>
      <div><div style="font-size:${s.bodySize}px;font-weight:bold;color:${s.text};opacity:.75;">温度范围</div><div style="font-size:${s.bodySize + 10}px;font-weight:bold;">${d.low}~${d.high}°C</div></div>
    </div>
    <div style="padding:24px 50px;font-size:${s.bodySize + 2}px;line-height:1.7;">${d.tip}</div>
  </div>`);
}

function renderArchitecture(d) {
  const s = d.style;
  const vertical = s.writingMode === "vertical";
  const descStyle = vertical
    ? `writing-mode:vertical-rl;font-size:${s.bodySize + 4}px;line-height:2;font-weight:bold;height:360px;text-align:start;`
    : `font-size:${s.bodySize + 4}px;line-height:1.8;font-weight:bold;text-align:justify;`;
  return pageShell("古建筑",
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     html, body { width: 800px; height: 480px; overflow: hidden; font-family: ${s.fontFamily}; background: ${s.bg}; color: ${s.text}; }`,
    `
  <div style="width:800px;height:480px;background:${s.bg};display:flex;">
    <div style="width:340px;background:${s.accent};color:${s.bg};padding:36px 30px;box-sizing:border-box;display:flex;flex-direction:column;">
      <div style="font-size:${s.bodySize}px;letter-spacing:4px;font-weight:bold;">每日古建筑</div>
      <div style="font-size:${s.titleSize - 2}px;font-weight:bold;margin-top:16px;line-height:1.4;">${d.name}</div>
      <div style="font-size:${s.bodySize}px;margin-top:auto;opacity:.85;">${d.location}</div>
      <div style="font-size:${s.bodySize}px;font-weight:bold;margin-top:6px;">${d.era}</div>
    </div>
    <div style="flex:1;padding:36px 40px;box-sizing:border-box;${vertical ? "display:flex;flex-direction:row-reverse;gap:24px;" : ""}">
      <div style="${descStyle}">${d.desc}</div>
      <div style="margin-top:${vertical ? "0" : "24px"};padding-top:16px;border-top:1px dashed ${s.text}55;font-size:${s.bodySize}px;font-weight:bold;color:${s.accent};${vertical ? "align-self:flex-end;" : ""}">看点 · ${d.highlight}</div>
    </div>
  </div>`);
}

function renderExtinct(d) {
  const s = d.style;
  return pageShell("灭绝动物",
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     html, body { width: 800px; height: 480px; overflow: hidden; font-family: ${s.fontFamily}; background: ${s.bg}; color: ${s.text}; }`,
    `
  <div style="width:800px;height:480px;background:${s.bg};color:${s.text};box-sizing:border-box;padding:40px 50px;display:flex;flex-direction:column;">
    <div style="font-size:${s.bodySize}px;letter-spacing:5px;font-weight:bold;color:${s.accent};">灭绝档案 · ${d.date}</div>
    <div style="font-size:${s.titleSize + 2}px;font-weight:bold;margin-top:14px;">${d.name}</div>
    <div style="font-size:${s.bodySize + 1}px;font-weight:bold;opacity:.85;margin-top:4px;">${d.latin} · 灭绝于 ${d.year}</div>
    <div style="font-size:${s.bodySize + 4}px;line-height:1.75;font-weight:bold;margin-top:26px;text-align:justify;">${d.desc}</div>
    <div style="margin-top:auto;font-size:${s.bodySize - 1}px;font-weight:bold;opacity:.8;">${d.note}</div>
  </div>`);
}

// ---------- GLM 调用（带 429 自动重试） ----------

// 模型有时会给回复套 ```json 代码块，这里剥壳再解析
function parseLoose(raw) {
  let t = raw.trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start > 0 || end < t.length - 1) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function glm(prompt, env) {
  let lastErr = "";
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch(GLM_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 1,
        top_p: 0.95,
        // GLM-5.3-Flash 是始终思考模型：thinking 仅支持 enabled；
        // 关闭思考链会直接报 400，这里保留默认并让 reasoning_effort 走 low 控制成本
        reasoning_effort: "low",
      }),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices[0].message.content.trim();
    }
    lastErr = `GLM HTTP ${res.status}: ${await res.text()}`;
    // 429/5xx 退避重试：3s -> 8s -> 15s
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 4) await sleep(attempt === 1 ? 3000 : attempt === 2 ? 8000 : 15000);
      continue;
    }
    throw new Error(lastErr); // 4xx 其他错误不重试
  }
  throw new Error(lastErr);
}

// ---------- 各页面生成（读用户配置：提示词附加要求 + 风格） ----------

export async function genQuote(dateStr, env) {
  const { data, style } = await genDeduped(env.DASHBOARD_KV, "quote", env,
    `请返回严格 JSON（不要 markdown 代码块）：{"text":"一句不超过22字的中文名言或诗句","from":"出处/作者"}。要求：适合电子墨水屏每日一言，避开烂大街的句子。`);
  return renderQuote({ date: dateStr, style, ...data });
}

// 天气数据用 open-meteo 免费 API（无 Key，国内可用）
export async function genWeather(dateStr, env) {
  const cfg = await getPageConfig(env.DASHBOARD_KV, "weather");
  const geo = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${CITY.lat}&longitude=${CITY.lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Asia%2FShanghai&forecast_days=1`).then(r => r.json());
  const codeMap = {0:"晴",1:"多云",2:"多云",3:"阴",45:"雾",48:"雾",51:"毛毛雨",61:"小雨",63:"中雨",65:"大雨",71:"小雪",73:"中雪",75:"大雪",80:"阵雨",95:"雷雨"};
  const cur = geo.current, day = geo.daily;
  const cond = codeMap[cur.weather_code] || "多云";
  const raw = await glm(
    withExtra(
      `今天${cond}，气温${day.temperature_2m_min[0]}到${day.temperature_2m_max[0]}度。请返回严格 JSON：{"tip":"不超过50字的贴心生活提示"}。`,
      cfg.extraPrompt
    ),
    env
  );
  const d = parseLoose(raw);
  return renderWeather({
    date: dateStr, style: cfg.style, city: CITY.name, temp: Math.round(cur.temperature_2m),
    condition: cond, humidity: cur.relative_humidity_2m,
    wind: Math.round(cur.wind_speed_10m) + "km/h",
    low: Math.round(day.temperature_2m_min[0]), high: Math.round(day.temperature_2m_max[0]),
    tip: d.tip,
  });
}

export async function genArchitecture(dateStr, env) {
  const { data, style } = await genDeduped(env.DASHBOARD_KV, "architecture", env,
    `请随机选一座中国著名古建筑（避开最常见的故宫/长城），返回严格 JSON：{"name":"名称","location":"所在地","era":"年代","desc":"约90字的介绍","highlight":"一个看点，不超过20字"}。`);
  return renderArchitecture({ date: dateStr, style, ...data });
}

export async function genExtinct(dateStr, env) {
  const { data, style } = await genDeduped(env.DASHBOARD_KV, "extinct", env,
    `请随机选一种已灭绝动物（避免连续重复常见选项），返回严格 JSON：{"name":"中文名","latin":"拉丁学名","year":"灭绝年份","desc":"约80字的介绍","note":"一句不超过25字的警示语"}。`);
  return renderExtinct({ date: dateStr, style, ...data });
}

// ---------- 地标建筑页：诗词 + AI 生图（E6 墨水屏适配） ----------

// 生图提示词模板：E6 只有黑白红黄蓝绿 6 色、无灰度、800x480
// 关键约束写死在 prompt 里：扁平插画、大面积色块、高对比、无渐变无细纹理
const E6_STYLE_PROMPT =
  "flat vector illustration, bold solid color blocks, high contrast, " +
  "limited color palette of red yellow blue green black on white background, " +
  "no gradient, no texture, no fine details, clean minimal composition, " +
  "thick shapes, e-ink poster style, landscape 5:3";

const IMAGE_SIZE = "1280x768"; // 5:3 比例生成，展示时缩放为 800x480

/**
 * 生图并把**图片字节落地到 KV**。
 *
 * 为什么必须落地：智谱 CogView 返回的是带签名的临时链接（几天后失效），
 * 页面若直接引用那个 URL，墨水屏过几天就只剩占位符了。
 * 所以这里立刻把图片下载下来存进 KV，页面改用 /api/img/landmark 读取。
 *
 * @returns {Promise<number>} 图片字节数
 */
export async function genImage(prompt, env) {
  const res = await fetch("https://open.bigmodel.cn/api/paas/v4/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: "cogview-4",       // 智谱生图模型，走同一个 GLM_API_KEY
      prompt,
      size: IMAGE_SIZE,
      // 关掉「AI生成」角标水印；若智谱账号未签署水印免责声明，此参数可能不生效
      // （图片仍带水印，但不会导致生成失败）
      watermark_enabled: false,
    }),
  });
  if (!res.ok) throw new Error(`CogView HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error("CogView 未返回图片 URL");

  // 立刻下载字节（临时链接会过期，不能只存 URL）
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`下载图片失败 HTTP ${imgRes.status}`);
  const buf = await imgRes.arrayBuffer();
  if (!buf.byteLength) throw new Error("下载到的图片是空的");

  await env.DASHBOARD_KV.put("img:landmark", buf, {
    metadata: {
      contentType: imgRes.headers.get("content-type") || "image/png",
      size: buf.byteLength,
      updatedAt: new Date().toISOString(),
    },
  });

  return buf.byteLength;
}

function renderLandmark(d) {
  const s = d.style;
  // 图片由 /api/img/landmark 提供（读 KV 里的字节）；?v= 版本号保证换图后不吃旧缓存
  const imgBlock = d.hasImage
    ? `<img src="/api/img/landmark?v=${d.imageVer}" alt="${d.name}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;"
         onerror="this.style.display='none';document.getElementById('imgFallback').style.display='flex';">`
    : "";
  return pageShell("地标",
    `* { margin: 0; padding: 0; box-sizing: border-box; }
     html, body { width: 800px; height: 480px; overflow: hidden; font-family: ${s.fontFamily}; background: ${s.bg}; color: ${s.text}; }`,
    `
  <div style="width:800px;height:480px;background:${s.bg};display:flex;overflow:hidden;">
    <div style="width:460px;height:480px;position:relative;background:${s.text}14;flex-shrink:0;">
      <div id="imgFallback" style="width:100%;height:100%;display:${d.hasImage ? "none" : "flex"};align-items:center;justify-content:center;font-size:120px;color:${s.text}33;">山</div>
      ${imgBlock}
    </div>
    <div style="flex:1;padding:34px 38px;box-sizing:border-box;display:flex;flex-direction:column;background:${s.bg};">
      <div style="font-size:${s.bodySize}px;letter-spacing:4px;font-weight:bold;opacity:.65;">每日地标 · ${d.date}</div>
      <div style="font-size:${s.titleSize - 6}px;font-weight:bold;margin-top:10px;line-height:1.3;">${d.name}</div>
      <div style="font-size:${s.bodySize + 1}px;font-weight:bold;margin-top:4px;">${d.location}</div>
      <div style="margin-top:auto;">
        <div style="font-size:${s.bodySize + 3}px;line-height:1.75;font-weight:bold;color:${s.accent};">「${d.poem}」</div>
        <div style="font-size:${s.bodySize - 1}px;font-weight:bold;opacity:.7;margin-top:6px;">${d.poemSource}</div>
      </div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed ${s.text}55;font-size:${s.bodySize}px;line-height:1.7;font-weight:bold;">${d.desc}</div>
    </div>
  </div>`);
}

export async function genLandmark(dateStr, env) {
  const { data: d, style } = await genDeduped(env.DASHBOARD_KV, "landmark", env,
    `请随机选一个中国城市的一处地标建筑或自然景观（兼顾知名与新颖），并配一句与之意境契合的古诗词。返回严格 JSON（不要代码块）：` +
    `{"name":"地标名称","location":"省市名","poem":"一句古诗（含标点不超过20字）","poemSource":"诗名·作者","desc":"地标一句话介绍，不超过40字",` +
    `"imagePrompt":"英文提示词，描述该地标的标志性外观与周围环境，简洁的扁平插画风格场景构图，30个英文单词以内"}`);

  // 拼上 E6 墨水屏风格约束后生图并落地 KV；失败不阻塞整页（文字照常出）
  let hasImage = false;
  try {
    await genImage(`${d.imagePrompt}. ${E6_STYLE_PROMPT}`, env);
    hasImage = true;
  } catch (e) {
    console.error("生图失败，页面使用占位图:", String(e));
  }

  // 版本号：让设备每天拿到新图，而不是缓存里的旧图
  const imageVer = String(Date.now());
  return renderLandmark({ date: dateStr, style, hasImage, imageVer, ...d });
}

// 页面名 → 生成函数（generate 全量与 refresh 单页共用）
export const PAGE_GENERATORS = {
  quote: genQuote,
  weather: genWeather,
  architecture: genArchitecture,
  extinct: genExtinct,
  landmark: genLandmark,
};

export const PAGE_NAMES = Object.keys(PAGE_GENERATORS);
