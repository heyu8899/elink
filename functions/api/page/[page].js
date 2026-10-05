/**
 * 页面展示函数：GET /api/page/quote | weather | architecture | extinct
 * 从 KV 读取最新生成的 HTML 返回。给 SenseCraft HMI 的 Web Content 绑定用。
 */

export async function onRequestGet({ params, env }) {
  const name = params.page; // quote / weather / architecture / extinct
  const kv = env.DASHBOARD_KV;

  const html = await kv.get(`page:${name}`);
  if (!html) {
    return new Response(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
      body{width:800px;height:480px;display:flex;align-items:center;justify-content:center;
      font-family:sans-serif;background:#fff;color:#999;font-size:28px}</style></head>
      <body>等待首次生成 · 请访问 /api/generate 触发</body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
