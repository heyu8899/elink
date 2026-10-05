/**
 * 页面展示函数：GET /api/page/quote | weather | architecture | extinct | landmark
 * 从 KV 读取最新生成的 HTML 返回。给 SenseCraft HMI 的 Web Content 绑定用。
 * 返回时注入视口适配脚本：设备视口宽 < 800px 时整体等比缩放，保证墨水屏满屏显示。
 */

const WAIT_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=800, initial-scale=1, user-scalable=no"><style>
body{width:800px;height:480px;display:flex;align-items:center;justify-content:center;
font-family:sans-serif;background:#fff;color:#999;font-size:28px}</style></head>
<body>等待首次生成 · 请访问 /api/generate 触发</body></html>`;

const FIT_SCRIPT = `<script>
(function(){
  function fit(){
    try {
      var w = document.documentElement.clientWidth || window.innerWidth || 800;
      if (w > 0 && w < 800) {
        var s = w / 800;
        var b = document.body;
        b.style.transformOrigin = 'top left';
        b.style.transform = 'scale(' + s + ')';
        b.style.marginRight = -(800 - w) + 'px';
      }
    } catch(e) {}
  }
  fit();
  window.addEventListener('resize', fit);
})();
</script></body>`;

export async function onRequestGet({ params, env }) {
  const name = params.page; // quote / weather / architecture / extinct / landmark
  const kv = env.DASHBOARD_KV;

  let html = await kv.get(`page:${name}`);
  if (!html) html = WAIT_HTML;

  // 注入缩放适配脚本（幂等：已含脚本则跳过）
  if (!html.includes("FIT_SCRIPT_APPLIED")) {
    html = html.replace("</body>", `<!--FIT_SCRIPT_APPLIED-->${FIT_SCRIPT}`);
  }

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
