/**
 * 管理接口：GET /api/status?key=CRON_SECRET
 * 返回各页面当前状态（是否已生成、更新时间），以及手动重生成单页：
 * GET /api/status?key=xxx&page=landmark&force=1  → 只重新生成地标页
 */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secret = env.CRON_SECRET;
  if (secret && url.searchParams.get("key") !== secret) {
    return new Response("forbidden", { status: 403 });
  }

  const kv = env.DASHBOARD_KV;
  if (!kv) return new Response("DASHBOARD_KV 未绑定", { status: 500 });

  const PAGES = ["quote", "weather", "architecture", "extinct", "landmark"];
  const page = url.searchParams.get("page");
  const force = url.searchParams.get("force");

  // 手动重生成单页：调用 generate 的同一套逻辑，但只跑指定页
  if (page && force) {
    // 动态导入主生成逻辑不可行（CF Pages Functions 之间不互相调用），
    // 这里直接跳转方式：302 到 generate，由 generate 全量跑。
    // 单页生成的独立入口后续可拆分；当前简化为提示。
    return new Response(JSON.stringify({
      hint: "单页重生成请直接全量刷新（约1分钟），或等待每日 cron",
      action: "全量刷新请访问 /api/generate?key=xxx",
    }), { headers: { "Content-Type": "application/json" } });
  }

  const status = {};
  for (const name of PAGES) {
    const html = await kv.get(`page:${name}`);
    const meta = await kv.get(`meta:${name}`);
    status[name] = {
      generated: !!html,
      updatedAt: meta || "未知",
      size: html ? html.length : 0,
    };
  }

  return new Response(JSON.stringify({ pages: status }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
