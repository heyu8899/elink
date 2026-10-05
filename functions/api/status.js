/**
 * 管理接口：GET /api/status
 * 鉴权：会话 cookie / X-Cron-Secret 头 / ?key=（见 _lib.requireAdmin）
 *
 * 返回各页面状态（是否已生成、更新时间、大小），以及 AI 图片资产状态。
 * 单页重生成由 /api/refresh/{page} 提供，管理页可直接使用。
 */

import { requireAdmin, PAGE_NAMES, jsonResponse } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }

  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  const status = {};
  for (const name of PAGE_NAMES) {
    const [html, meta] = await Promise.all([
      kv.get(`page:${name}`),
      kv.get(`meta:${name}`),
    ]);
    status[name] = {
      generated: !!html,
      updatedAt: meta || "未知",
      size: html ? html.length : 0,
    };
  }

  // AI 图片资产：存的是图片字节本身（不是会过期的临时链接）
  for (const imgKey of ["landmark", "architecture"]) {
    const img = await kv.getWithMetadata(`img:${imgKey}`, "arrayBuffer");
    status[`img:${imgKey}`] = {
      generated: !!img.value,
      size: img.value ? img.value.byteLength : 0,
      contentType: img.metadata?.contentType || "未知",
      updatedAt: img.metadata?.updatedAt || "未知",
    };
  }

  return jsonResponse({ pages: status });
}
