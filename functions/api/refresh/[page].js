/**
 * 单页重生成：GET /api/refresh/{page}
 * page ∈ quote | weather | architecture | extinct | landmark
 *
 * 管理页的"刷新此页"按钮调用。只重新生成指定页，其余页面不受影响。
 * 鉴权同 /api/generate（cookie / X-Cron-Secret / ?key=）。
 *
 * 注：landmark 含 AI 生图，刷新耗时较长（可能 30 秒以上）。
 */

import {
  PAGE_GENERATORS,
  requireAdmin,
  getDateStr,
  jsonResponse,
} from "../_lib.js";

const COOLDOWN_MS = 15 * 1000;

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }

  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  const name = params.page;
  const fn = PAGE_GENERATORS[name];
  if (!fn) {
    return jsonResponse(
      { ok: false, error: `未知页面: ${name}，可选: ${Object.keys(PAGE_GENERATORS).join(" / ")}` },
      404
    );
  }

  // 单页刷新用独立且更短的防抖（15 秒），不与全量生成的 60 秒冷却互相干扰，
  // 方便在管理后台连续刷新不同页面（单页只烧 1 次 GLM 调用）
  const lastRun = Number((await kv.get("meta:lastPageAt")) || 0);
  if (Date.now() - lastRun < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastRun)) / 1000);
    return jsonResponse({ ok: false, error: `操作太快，请 ${wait} 秒后再试` });
  }
  await kv.put("meta:lastPageAt", String(Date.now()));

  try {
    const html = await fn(getDateStr(), env);
    const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    await kv.put(`page:${name}`, html);
    await kv.put(`meta:${name}`, ts);
    await kv.put("meta:lastSuccessAt", String(Date.now()));

    return jsonResponse({ ok: true, page: name, size: html.length, updatedAt: ts });
  } catch (e) {
    return jsonResponse({ ok: false, page: name, error: String(e) }, 500);
  }
}
