/**
 * 登录认证：/api/auth
 *
 * POST   { password }  → 校验密码，签发 7 天有效的会话 cookie（HttpOnly）
 * GET                  → 查询当前登录状态 { authenticated: true/false }
 * DELETE               → 登出（清除 cookie）
 *
 * 密码来源：环境变量 ADMIN_PASSWORD（推荐，与机器密钥分开）；未配置则复用 CRON_SECRET。
 * 会话令牌形如 `${过期时间戳}.${HMAC签名}`，签名密钥为 CRON_SECRET，无法伪造。
 */

import { verifySession, adminPassword, sessionCookie, clearSessionCookie, jsonResponse } from "./_lib.js";

export async function onRequestPost({ request, env }) {
  const secret = env.CRON_SECRET;
  if (!secret) {
    return jsonResponse({ ok: false, error: "服务端未配置 CRON_SECRET，无法启用登录" }, 500);
  }

  let password = "";
  try {
    ({ password } = await request.json());
  } catch { /* body 不是 JSON */ }

  if (!password || password !== adminPassword(env)) {
    return jsonResponse({ ok: false, error: "密码错误" }, 401);
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Set-Cookie": await sessionCookie(env),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export async function onRequestGet({ request, env }) {
  return jsonResponse({ authenticated: await verifySession(request, env) });
}

export async function onRequestDelete() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Set-Cookie": clearSessionCookie(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}
