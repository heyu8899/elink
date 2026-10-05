/**
 * 页面配置：/api/pageconfig/{page}
 * page ∈ quote | weather | architecture | extinct | landmark
 *
 * GET     → 读取该页的提示词附加要求与风格 JSON
 * PUT     → 保存 { prompt: "内容附加要求", style: {…} 或 JSON 字符串 }
 *           style 会做白名单校验并规范化后落库，非法字段直接丢弃，写不坏页面
 * DELETE  → 清空两项配置，恢复系统默认
 *
 * 配置存 KV：prompt:{page} / style:{page}，下次生成该页时生效
 * （在管理页点"刷新此页"即可立即看到效果）。
 */

import { requireAdmin, PAGE_NAMES, normStyle, jsonResponse } from "../_lib.js";

function checkPage(params) {
  const name = params.page;
  if (!PAGE_NAMES.includes(name)) {
    return { error: jsonResponse({ ok: false, error: `未知页面: ${name}` }, 404) };
  }
  return { name };
}

export async function onRequestGet({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);
  const { name, error } = checkPage(params);
  if (error) return error;

  const [prompt, styleRaw] = await Promise.all([
    kv.get(`prompt:${name}`),
    kv.get(`style:${name}`),
  ]);
  return jsonResponse({ ok: true, page: name, prompt: prompt || "", style: styleRaw || "" });
}

export async function onRequestPut({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);
  const { name, error } = checkPage(params);
  if (error) return error;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  // 提示词：纯文本，截断到 600 字
  const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 600) : "";

  // 风格：白名单校验 + 规范化后存回（规范化后的 JSON 就是"实际生效的配置"）
  let styleStr = "";
  if (body.style !== undefined && body.style !== null && String(body.style).trim() !== "") {
    let obj = body.style;
    if (typeof obj === "string") {
      try {
        obj = JSON.parse(obj);
      } catch {
        return jsonResponse({ ok: false, error: "风格 JSON 无法解析，请检查格式" }, 400);
      }
    }
    const norm = normStyle(obj, name);
    styleStr = JSON.stringify({
      colors: { bg: norm.bg, text: norm.text, accent: norm.accent },
      font: { titleSize: norm.titleSize, bodySize: norm.bodySize, family: norm.family },
      layout: { writingMode: norm.writingMode, align: norm.align },
    });
  }

  await kv.put(`prompt:${name}`, prompt);
  if (styleStr) await kv.put(`style:${name}`, styleStr);
  else await kv.delete(`style:${name}`);

  return jsonResponse({ ok: true, page: name, prompt, style: styleStr });
}

export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);
  const { name, error } = checkPage(params);
  if (error) return error;

  await Promise.all([kv.delete(`prompt:${name}`), kv.delete(`style:${name}`)]);
  return jsonResponse({ ok: true, page: name, cleared: true });
}
