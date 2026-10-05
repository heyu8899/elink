/**
 * 每日内容生成函数（Cloudflare Pages Functions 版）
 * 触发方式：
 *   1. Cloudflare Worker 定时器（cron-worker/ 目录，每天北京时间 07:00）调用本接口
 *   2. 手动 GET /api/generate?key=你的CRON_SECRET
 *
 * 流程：GLM 生成文案 -> 渲染 4 个页面 -> 写入 KV
 * 环境变量：GLM_API_KEY（必填）、CRON_SECRET（可选，手动触发时校验）
 * KV 绑定：Cloudflare 控制台创建 KV 命名空间，绑定变量名 DASHBOARD_KV
 */

const GLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const MODEL = "glm-5.3-flash"; // 付费模型（0.8/2.8元每百万tokens），带 429 自动重试

// ---------- 页面模板（框架定死，只换内容） ----------

const BASE_STYLE = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 800px; height: 480px; overflow: hidden;
    font-family: "Noto Serif SC", "Source Han Serif SC", serif; background: #FFFFFF; color: #1A1A1A; }
`;

function pageShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${title}</title><style>${BASE_STYLE}</style></head>
<body>${bodyHtml}</body></html>`;
}

function renderQuote(d) {
  return pageShell("一言", `
  <div style="width:800px;height:480px;display:flex;flex-direction:column;justify-content:center;padding:70px 80px;box-sizing:border-box;background:#FFFFFF;">
    <div style="font-size:20px;letter-spacing:6px;color:#888;border-bottom:2px solid #C0392B;padding-bottom:12px;margin-bottom:40px;">一 言 · ${d.date}</div>
    <div style="font-size:40px;line-height:1.7;font-weight:bold;">${d.text}</div>
    <div style="margin-top:48px;font-size:24px;color:#C0392B;">—— ${d.from}</div>
    <div style="position:absolute;bottom:28px;right:36px;font-size:16px;color:#BBB;">${d.date}</div>
  </div>`);
}

function renderWeather(d) {
  return pageShell("天气", `
  <div style="width:800px;height:480px;background:#FFFFFF;box-sizing:border-box;padding:0;">
    <div style="height:150px;background:#2C5F8A;color:#FFF;padding:30px 50px;box-sizing:border-box;">
      <div style="font-size:22px;opacity:.85;">${d.city} · ${d.date}</div>
      <div style="font-size:56px;font-weight:bold;line-height:1.3;">${d.temp}°C  ${d.condition}</div>
    </div>
    <div style="padding:28px 50px;display:flex;gap:40px;border-bottom:1px solid #EEE;">
      <div><div style="font-size:16px;color:#999;">湿度</div><div style="font-size:30px;font-weight:bold;">${d.humidity}%</div></div>
      <div><div style="font-size:16px;color:#999;">风向</div><div style="font-size:30px;font-weight:bold;">${d.wind}</div></div>
      <div><div style="font-size:16px;color:#999;">温度范围</div><div style="font-size:30px;font-weight:bold;">${d.low}~${d.high}°C</div></div>
    </div>
    <div style="padding:24px 50px;font-size:22px;line-height:1.7;">${d.tip}</div>
  </div>`);
}

function renderArchitecture(d) {
  return pageShell("古建筑", `
  <div style="width:800px;height:480px;background:#FFFFFF;display:flex;">
    <div style="width:340px;background:#8B2E2E;color:#FFF;padding:36px 30px;box-sizing:border-box;display:flex;flex-direction:column;">
      <div style="font-size:18px;letter-spacing:4px;opacity:.8;">每日古建筑</div>
      <div style="font-size:38px;font-weight:bold;margin-top:16px;line-height:1.4;">${d.name}</div>
      <div style="font-size:20px;margin-top:auto;opacity:.85;">${d.location}</div>
      <div style="font-size:16px;opacity:.6;margin-top:6px;">${d.era}</div>
    </div>
    <div style="flex:1;padding:36px 40px;box-sizing:border-box;">
      <div style="font-size:19px;line-height:1.9;text-align:justify;">${d.desc}</div>
      <div style="margin-top:24px;padding-top:16px;border-top:1px dashed #CCC;font-size:16px;color:#8B2E2E;">看点 · ${d.highlight}</div>
    </div>
  </div>`);
}

function renderExtinct(d) {
  return pageShell("灭绝动物", `
  <div style="width:800px;height:480px;background:#1C1C1C;color:#F2F2F2;box-sizing:border-box;padding:40px 50px;display:flex;flex-direction:column;">
    <div style="font-size:18px;letter-spacing:5px;color:#C0392B;">灭绝档案 · ${d.date}</div>
    <div style="font-size:42px;font-weight:bold;margin-top:14px;">${d.name}</div>
    <div style="font-size:18px;color:#999;margin-top:4px;">${d.latin} · 灭绝于 ${d.year}</div>
    <div style="font-size:19px;line-height:1.85;margin-top:26px;text-align:justify;">${d.desc}</div>
    <div style="margin-top:auto;font-size:15px;color:#777;">${d.note}</div>
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


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function genQuote(dateStr, env) {
  const raw = await glm(
    `请返回严格 JSON（不要 markdown 代码块）：{"text":"一句不超过22字的中文名言或诗句","from":"出处/作者"}。要求：适合电子墨水屏每日一言，避开烂大街的句子。`,
    env
  );
  const d = parseLoose(raw);
  return renderQuote({ date: dateStr, ...d });
}

// 和风天气免费 API（无 Key 版：open-meteo，国内可用）
async function genWeather(dateStr, env) {
  // 北京示例，换成你的城市改 lat/lon
  const geo = await fetch("https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=Asia%2FShanghai&forecast_days=1").then(r => r.json());
  const codeMap = {0:"晴",1:"多云",2:"多云",3:"阴",45:"雾",48:"雾",51:"毛毛雨",61:"小雨",63:"中雨",65:"大雨",71:"小雪",73:"中雪",75:"大雪",80:"阵雨",95:"雷雨"};
  const cur = geo.current, day = geo.daily;
  const cond = codeMap[cur.weather_code] || "多云";
  const raw = await glm(
    `今天${cond}，气温${day.temperature_2m_min[0]}到${day.temperature_2m_max[0]}度。请返回严格 JSON：{"tip":"不超过50字的贴心生活提示"}。`,
    env
  );
  const d = parseLoose(raw);
  return renderWeather({
    date: dateStr, city: "北京", temp: Math.round(cur.temperature_2m),
    condition: cond, humidity: cur.relative_humidity_2m,
    wind: Math.round(cur.wind_speed_10m) + "km/h",
    low: Math.round(day.temperature_2m_min[0]), high: Math.round(day.temperature_2m_max[0]),
    tip: d.tip,
  });
}

async function genArchitecture(dateStr, env) {
  const raw = await glm(
    `请随机选一座中国著名古建筑（避开最常见的故宫/长城），返回严格 JSON：{"name":"名称","location":"所在地","era":"年代","desc":"约90字的介绍","highlight":"一个看点，不超过20字"}。`,
    env
  );
  const d = parseLoose(raw);
  return renderArchitecture({ date: dateStr, ...d });
}

async function genExtinct(dateStr, env) {
  const raw = await glm(
    `请随机选一种已灭绝动物（避免连续重复常见选项），返回严格 JSON：{"name":"中文名","latin":"拉丁学名","year":"灭绝年份","desc":"约80字的介绍","note":"一句不超过25字的警示语"}。`,
    env
  );
  const d = parseLoose(raw);
  return renderExtinct({ date: dateStr, ...d });
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

async function genImage(prompt, env) {
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
    }),
  });
  if (!res.ok) throw new Error(`CogView HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error("CogView 未返回图片 URL");
  return url;
}

function renderLandmark(d) {
  return pageShell("地标", `
  <div style="width:800px;height:480px;background:#FFFFFF;display:flex;overflow:hidden;">
    <div style="width:460px;height:480px;position:relative;background:#F4F1E8;flex-shrink:0;">
      ${d.imageUrl
        ? `<img src="${d.imageUrl}" alt="${d.name}" style="width:100%;height:100%;object-fit:cover;display:block;"
             onerror="this.style.display='none';document.getElementById('imgFallback').style.display='flex';">`
        : `<div id="imgFallback" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:120px;color:#D8D2C0;">山</div>`}
    </div>
    <div style="flex:1;padding:34px 38px;box-sizing:border-box;display:flex;flex-direction:column;background:#FFFFFF;">
      <div style="font-size:16px;letter-spacing:4px;color:#888;">每日地标 · ${d.date}</div>
      <div style="font-size:34px;font-weight:bold;margin-top:10px;line-height:1.3;">${d.name}</div>
      <div style="font-size:17px;color:#666;margin-top:4px;">${d.location}</div>
      <div style="margin-top:auto;">
        <div style="font-size:23px;line-height:1.75;font-weight:bold;color:#8B2E2E;">「${d.poem}」</div>
        <div style="font-size:15px;color:#999;margin-top:6px;">${d.poemSource}</div>
      </div>
      <div style="margin-top:16px;padding-top:12px;border-top:1px dashed #CCC;font-size:15px;line-height:1.6;color:#555;">${d.desc}</div>
    </div>
  </div>`);
}

async function genLandmark(dateStr, env) {
  // 第一步：LLM 出主题 + 配套诗词（诗词与地标强关联）
  const raw = await glm(
    `请随机选一个中国城市的一处地标建筑或自然景观（每天不重复，兼顾知名与新颖），并配一句与之意境契合的古诗词。返回严格 JSON（不要代码块）：` +
    `{"name":"地标名称","location":"省市名","poem":"一句古诗（含标点不超过20字）","poemSource":"诗名·作者","desc":"地标一句话介绍，不超过40字",` +
    `"imagePrompt":"英文提示词，描述该地标的标志性外观与周围环境，简洁的扁平插画风格场景构图，30个英文单词以内"}`,
    env
  );
  const d = parseLoose(raw);

  // 第二步：拼上 E6 墨水屏风格约束后生图；失败不阻塞整页（文字页照常出）
  let imageUrl = "";
  try {
    imageUrl = await genImage(`${d.imagePrompt}. ${E6_STYLE_PROMPT}`, env);
  } catch (e) {
    console.error("生图失败，页面使用占位图:", String(e));
  }
  return renderLandmark({ date: dateStr, imageUrl, ...d });
}

// ---------- 入口（Cloudflare Pages Functions：onRequestGet 处理 GET） ----------

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secret = env.CRON_SECRET;
  if (secret && url.searchParams.get("key") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const dateStr = new Date().toLocaleDateString("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric",
  });

  const results = {};
  const tasks = [
    ["quote", genQuote], ["weather", genWeather],
    ["architecture", genArchitecture], ["extinct", genExtinct],
    ["landmark", genLandmark],
  ];
  for (const [name, fn] of tasks) {
    try {
      results[name] = { ok: true, html: await fn(dateStr, env) };
    } catch (e) {
      results[name] = { ok: false, error: String(e) };
    }
  }

  // 写入 KV（绑定名称固定为 DASHBOARD_KV）
  const kv = env.DASHBOARD_KV;
  if (!kv) throw new Error("DASHBOARD_KV 未绑定，请在 Pages 项目 Settings -> Bindings 添加 KV namespace");
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  for (const [name, r] of Object.entries(results)) {
    if (r.ok) {
      await kv.put(`page:${name}`, r.html);
      await kv.put(`meta:${name}`, ts);
    }
  }

  return new Response(JSON.stringify({
    date: dateStr,
    ok: Object.values(results).every(r => r.ok),
    detail: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? "ok" : v.error])),
  }, null, 2), { headers: { "Content-Type": "application/json" } });
}
