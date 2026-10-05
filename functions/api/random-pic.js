/**
 * 随机图片：GET /api/random-pic（固定地址，公开访问）
 *
 * 每天随机展示图库中的一张：
 *   GET /api/random-pic            → 当天内固定一张（以北京日期为种子），每天自动换
 *   GET /api/random-pic?each=1     → 每次访问都随机一张
 *   GET /api/random-pic?folder=xx  → 只从 pic:index 中名字以 xx/ 开头的图里抽
 *
 * 数据源为图床索引 pic:index（上传时自动维护），只挑 contentType 为 image/* 的。
 */

export async function onRequestGet({ request, env }) {
  const kv = env.DASHBOARD_KV;
  if (!kv) return new Response("DASHBOARD_KV 未绑定", { status: 500 });

  const url = new URL(request.url);
  const each = url.searchParams.get("each") === "1";
  const folder = (url.searchParams.get("folder") || "").trim().replace(/^\/+|\/+$/g, "");

  const raw = await kv.get("pic:index");
  let items = [];
  try { items = raw ? JSON.parse(raw) : []; } catch { /* 索引损坏视为空 */ }

  let pool = (Array.isArray(items) ? items : []).filter(
    (i) => i && i.name && (i.contentType || "").startsWith("image/")
  );
  if (folder) pool = pool.filter((i) => i.name === folder || i.name.startsWith(folder + "/"));

  if (!pool.length) return new Response("no images", { status: 404 });

  let pick;
  if (each) {
    pick = pool[Math.floor(Math.random() * pool.length)];
  } else {
    // 当天固定：北京日期字符串做种子，同一天所有访问返回同一张
    const day = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    let h = 0;
    for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    pick = pool[h % pool.length];
  }

  const { value, metadata } = await kv.getWithMetadata(`pic:${pick.name}`, "arrayBuffer");
  if (!value) return new Response("not found", { status: 404 });

  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || pick.contentType || "image/png",
      "Cache-Control": each ? "no-store" : "public, max-age=3600",
      "X-Pic-Name": encodeURIComponent(pick.name),
    },
  });
}
