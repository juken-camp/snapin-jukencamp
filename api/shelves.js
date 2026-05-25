// /api/shelves.js — SnapIn 公式棚 API
//
// Upstash Redis を使って、Kazumaさんが admin.html で投稿した公式棚を、
// 全生徒の index.html から見える状態にする。
//
// ─────────────────────────────────────────
// セットアップ:
//   1. Vercel ダッシュボードで Upstash Redis (Marketplace) を作成済み
//      → KV_REST_API_URL, KV_REST_API_TOKEN が自動で環境変数に追加されている
//   2. ADMIN_PASSWORD を環境変数に追加済み
//   3. package.json で @upstash/redis を依存に追加
// ─────────────────────────────────────────

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

// 全棚を1つの大きな配列として 'snapin:shelves' というキーに保存する。
// 棚は10〜30個程度しかない想定なので、これで十分シンプル&高速。
const KEY = 'snapin:shelves';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET: 全公開棚を返す (認証不要、誰でも読める)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {
    try {
      const shelves = (await redis.get(KEY)) || [];
      return res.status(200).json({ shelves });
    } catch (err) {
      console.error('shelves GET error:', err);
      return res.status(500).json({ error: err.message, shelves: [] });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST: 棚を保存 (管理者専用)
  // ヘッダー X-Admin-Password が必要
  // body: { shelves: [...] }  全棚をまるごと保存
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'POST') {
    const pass = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { shelves } = body || {};
      if (!Array.isArray(shelves)) {
        return res.status(400).json({ error: 'shelves must be array' });
      }
      await redis.set(KEY, shelves);
      return res.status(200).json({ ok: true, count: shelves.length });
    } catch (err) {
      console.error('shelves POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
