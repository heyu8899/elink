/**
 * 更新频率配置：/api/config
 *
 * GET  → 返回当前配置
 * PUT  { mode: "daily", hours: [7] }          → 每天在指定小时（北京时间）生成
 * PUT  { mode: "interval", everyHours: 12 }   → 每隔 N 小时生成一次
 *
 * 配置存 KV（config:schedule），cron Worker 每小时来问一次 /api/generate，
 * 到点才真正生成 —— 因此改频率**即时生效**，无需重新部署。
 *
 * 注意：这只控制"服务端内容生成频率"；墨水屏设备多久拉取一次
 * 由设备端 HMI 的 Interval 设置决定，两边对齐即可。
 */

import { requireAdmin, getSchedule, jsonResponse } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  return jsonResponse({ ok: true, schedule: await getSchedule(kv) });
}

export async function onRequestPut({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  let cfg;
  if (body.mode === "daily") {
    const raw = Array.isArray(body.hours) ? body.hours : [body.hours];
    const hours = [...new Set(raw.map(Number))].filter(
      (h) => Number.isInteger(h) && h >= 0 && h <= 23
    );
    if (!hours.length) {
      return jsonResponse({ ok: false, error: "hours 需为 0-23 的整数（小时）" }, 400);
    }
    cfg = { mode: "daily", hours: hours.sort((a, b) => a - b) };
  } else if (body.mode === "interval") {
    const everyHours = Number(body.everyHours);
    if (!Number.isInteger(everyHours) || everyHours < 1 || everyHours > 24) {
      return jsonResponse({ ok: false, error: "everyHours 需为 1-24 的整数" }, 400);
    }
    cfg = { mode: "interval", everyHours };
  } else {
    return jsonResponse({ ok: false, error: 'mode 需为 "daily" 或 "interval"' }, 400);
  }

  await kv.put("config:schedule", JSON.stringify(cfg));
  return jsonResponse({ ok: true, schedule: cfg });
}
