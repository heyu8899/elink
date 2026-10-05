/**
 * 管理接口：GET /api/status
 * 密钥通过 X-Cron-Secret 请求头传入（兼容原来的 ?key= 方式）。
 *
 * 返回各页面状态（是否已生成、更新时间、大小），以及 AI 图片资产状态。
 *
 * 注：单页重生成暂未实现 —— CF Pages Functions 之间无法互相调用，
 * 需要先把生成逻辑抽成共享模块（见 roadmap 第二批）。
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secret = env.CRON_SECRET;
  const provided = request.headers.get("X-Cron-Secret") || url.searchParams.get("key");
  if (secret && provided !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const kv = env.DASHBOARD_KV;
  if (!kv) return new Response("DASHBOARD_KV 未绑定", { status: 500 });

  const PAGES = ["quote", "weather", "architecture", "extinct", "landmark"];
  const page = url.searchParams.get("page");
  const force = url.searchParams.get("force");

  if (page && force) {
    return new Response(JSON.stringify({
      ok: false,
      hint: "单页重生成尚未实现，请用 /api/generate 全量刷新（约 30-60 秒）",
    }, null, 2), { headers: { "Content-Type": "application/json; charset=utf-8" } });
  }

  const status = {};
  for (const name of PAGES) {
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
  const img = await kv.getWithMetadata("img:landmark", "arrayBuffer");
  status["img:landmark"] = {
    generated: !!img.value,
    size: img.value ? img.value.byteLength : 0,
    contentType: img.metadata?.contentType || "未知",
    updatedAt: img.metadata?.updatedAt || "未知",
  };

  return new Response(JSON.stringify({ pages: status }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
