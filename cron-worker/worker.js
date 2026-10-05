/**
 * Cloudflare Worker：每天定时触发墨水屏看板内容生成
 * Cloudflare 的 cron 是 UTC 时区：北京时间 07:00 = UTC 23:00（前一天）
 * 所以 cron 表达式填 "0 23 * * *"
 *
 * 环境变量（在 Worker 设置里配）：
 *   SITE_URL     = 你的 Pages 域名，如 https://xxx.pages.dev
 *   CRON_SECRET  = 与 Pages 项目里配的一致
 */

export default {
  // 定时触发入口
  async scheduled(event, env, ctx) {
    ctx.waitUntil(trigger(env));
  },

  // 手动触发入口：访问 https://该worker域名/run
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const result = await trigger(env);
      return new Response(result, { headers: { "Content-Type": "application/json" } });
    }
    return new Response("墨水屏看板定时器运行中。手动触发请访问 /run", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};

async function trigger(env) {
  const target = `${env.SITE_URL}/api/generate?key=${env.CRON_SECRET}`;
  try {
    const res = await fetch(target);
    return await res.text();
  } catch (e) {
    return JSON.stringify({ ok: false, error: String(e) });
  }
}
