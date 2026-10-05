/**
 * 图床列表：GET /api/pic（需鉴权）
 * 返回已上传图片的索引（名称/大小/类型/时间）。
 * 索引存 KV pic:index，上传/删除时自动维护。
 */

import { requireAdmin, jsonResponse } from "./_lib.js";

export async function onRequestGet({ request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);

  const raw = await kv.get("pic:index");
  let items = [];
  try { items = raw ? JSON.parse(raw) : []; } catch { /* 索引损坏视为空 */ }
  return jsonResponse({ ok: true, items: Array.isArray(items) ? items : [] });
}
