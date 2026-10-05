/**
 * 图床单文件：/api/pic/{name}
 *
 * GET    公开读取图片（固定地址，可直接外链 / 绑到墨水屏 / 引用 anywhere）
 * PUT    上传（需鉴权）：请求体为图片原始字节，Content-Type 头即图片类型
 * DELETE 删除（需鉴权）
 *
 * 存储用 KV（pic:{name}），单文件上限 20MB（KV 单值硬上限 25MB，留余量）。
 * 索引 pic:index 自动维护，供 /api/pic 列表与管理后台使用。
 *
 * curl 示例：
 *   curl -X PUT -H "X-Cron-Secret: 你的密钥" \
 *        -H "Content-Type: image/jpeg" \
 *        --data-binary @photo.jpg \
 *        "https://xxx.pages.dev/api/pic/photo.jpg"
 *   → 之后 https://xxx.pages.dev/api/pic/photo.jpg 即固定地址
 */

import { requireAdmin, jsonResponse } from "../_lib.js";

const MAX_SIZE = 20 * 1024 * 1024;

function safeName(raw) {
  let name;
  try { name = decodeURIComponent(raw || ""); } catch { return null; }
  // 支持文件夹结构：反斜杠统一为斜杠，压缩连续斜杠
  name = name.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!name || name.length > 200) return null;
  if (name.startsWith("/") || name.endsWith("/")) return null;
  // 每一段都不允许以点开头（防隐藏文件与路径穿越）
  if (name.split("/").some((s) => !s || s.startsWith("."))) return null;
  return name;
}

async function readIndex(kv) {
  const raw = await kv.get("pic:index");
  try {
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch { return []; }
}

// 公开读取
export async function onRequestGet({ params, env }) {
  const kv = env.DASHBOARD_KV;
  if (!kv) return new Response("DASHBOARD_KV 未绑定", { status: 500 });
  const name = safeName(params.name);
  if (!name) return new Response("bad name", { status: 400 });

  const { value, metadata } = await kv.getWithMetadata(`pic:${name}`, "arrayBuffer");
  if (!value) return new Response("not found", { status: 404 });

  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "application/octet-stream",
      // 固定地址可能被外部长期引用，同名覆盖的场景由上传方换名解决；
      // 这里给 1 小时缓存平衡新鲜度与流量
      "Cache-Control": "public, max-age=3600",
    },
  });
}

// 上传（原始字节）
export async function onRequestPut({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);
  const name = safeName(params.name);
  if (!name) return jsonResponse({ ok: false, error: "文件名不合法（≤100字符，不含路径分隔符）" }, 400);

  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return jsonResponse({ ok: false, error: "请求体为空，请直接上传图片二进制" }, 400);
  if (buf.byteLength > MAX_SIZE) {
    return jsonResponse({ ok: false, error: `文件 ${Math.round(buf.byteLength / 1048576)}MB 超过 20MB 上限（KV 单值限制 25MB）` }, 413);
  }

  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  const now = new Date().toISOString();
  await kv.put(`pic:${name}`, buf, { metadata: { contentType, size: buf.byteLength, updatedAt: now } });

  const items = (await readIndex(kv)).filter((i) => i.name !== name);
  items.unshift({ name, size: buf.byteLength, contentType, updatedAt: now });
  await kv.put("pic:index", JSON.stringify(items.slice(0, 500)));

  const origin = new URL(request.url).origin;
  return jsonResponse({
    ok: true,
    name,
    size: buf.byteLength,
    url: `${origin}/api/pic/${encodeURIComponent(name)}`,
  });
}

// 删除
export async function onRequestDelete({ params, request, env }) {
  if (!(await requireAdmin(request, env))) {
    return new Response("forbidden", { status: 403 });
  }
  const kv = env.DASHBOARD_KV;
  if (!kv) return jsonResponse({ ok: false, error: "DASHBOARD_KV 未绑定" }, 500);
  const name = safeName(params.name);
  if (!name) return jsonResponse({ ok: false, error: "文件名不合法" }, 400);

  await kv.delete(`pic:${name}`);
  const items = (await readIndex(kv)).filter((i) => i.name !== name);
  await kv.put("pic:index", JSON.stringify(items));
  return jsonResponse({ ok: true, name });
}
