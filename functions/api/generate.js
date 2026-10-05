/**
 * 全量内容生成：GET /api/generate
 *
 * 触发方式：
 *   1. cron Worker 每小时调用（带 X-Cron-Secret 头）—— 只有到了管理页设置的
 *      生成时间（config:schedule）才真正生成，其余时间 skip
 *   2. 手动全量刷新：管理页按钮 / ?force=1 —— 跳过调度判断立即生成
 *
 * 鉴权：会话 cookie / X-Cron-Secret 头 / ?key= 三者任一（见 _lib.requireAdmin）
 * 防重入：60 秒冷却，防止误刷或密钥泄漏后被反复调用烧 token
 */

import {
  PAGE_GENERATORS,
  requireAdmin,
  shouldRunNow,
  getDateStr,
  jsonResponse,
} from "./_lib.js";

const COOLDOWN_MS = 60 * 1000;

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }

  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  const url = new URL(request.url);
  const force =
    url.searchParams.get("force") === "1" || request.headers.get("X-Force") === "1";
  const viaCron = !!request.headers.get("X-Cron-Secret"); // Worker 定时触发

  // 防重入冷却
  const lastRun = Number((await kv.get("meta:lastRunAt")) || 0);
  if (Date.now() - lastRun < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (Date.now() - lastRun)) / 1000);
    return jsonResponse({
      ok: false,
      error: `调用过于频繁，请 ${wait} 秒后再试`,
      lastRunAt: new Date(lastRun).toISOString(),
    });
  }
  await kv.put("meta:lastRunAt", String(Date.now()));

  // 调度判断：只有 Worker 定时触发（未 force）才检查"是否到了计划时间"；
  // 手动刷新一律立即执行
  if (viaCron && !force) {
    const due = await shouldRunNow(kv);
    if (!due) {
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: "未到计划的生成时间（在管理页可修改更新频率）",
      });
    }
  }

  const dateStr = getDateStr();

  // 并行生成：串行会把 5 页耗时叠加，landmark 含生图最慢，容易触碰函数时长上限
  const results = {};
  await Promise.all(
    Object.entries(PAGE_GENERATORS).map(async ([name, fn]) => {
      try {
        results[name] = { ok: true, html: await fn(dateStr, env) };
      } catch (e) {
        results[name] = { ok: false, error: String(e) };
      }
    })
  );

  // 写入 KV；失败的页面保留上一次的内容
  const ts = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  await Promise.all(
    Object.entries(results)
      .filter(([, r]) => r.ok)
      .flatMap(([name, r]) => [
        kv.put(`page:${name}`, r.html),
        kv.put(`meta:${name}`, ts),
      ])
  );

  const allOk = Object.values(results).every((r) => r.ok);
  if (allOk) await kv.put("meta:lastSuccessAt", String(Date.now()));

  return jsonResponse({
    date: dateStr,
    ok: allOk,
    detail: Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v.ok ? "ok" : v.error])
    ),
  });
}
