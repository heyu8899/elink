/**
 * 图片输出：GET /api/img/landmark
 *
 * 从 KV 读取 AI 生成的图片字节并返回给设备。
 *
 * 为什么要有这一层：智谱 CogView 返回的是带签名的临时链接（约 7 天后失效），
 * 直接引用会让墨水屏过几天就没图。generate.js 会在生图后立刻把字节存进
 * KV（键 img:landmark），这里负责以稳定 URL 提供出去。
 *
 * 缓存策略：页面里的 img src 带 ?v=版本号，图片更新时 URL 跟着变，
 * 因此这里可以放心用长缓存 + immutable。
 */

export async function onRequestGet({ params, env }) {
  const name = params.name; // 目前只有 landmark
  const kv = env.DASHBOARD_KV;
  if (!kv) return new Response("DASHBOARD_KV 未绑定", { status: 500 });

  const { value, metadata } = await kv.getWithMetadata(`img:${name}`, "arrayBuffer");
  if (!value) return new Response("no image", { status: 404 });

  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/png",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}
