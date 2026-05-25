// /api/shelves.js — SnapIn 公式棚 API
//
// Upstash Redis を使って、Kazumaさんが admin.html で投稿した公式棚を、
// 全生徒の index.html から見える状態にする。
//
// ─────────────────────────────────────────
// キー設計:
//   snapin:shelf-ids        → ライブラリIDの配列（軽量）
//   snapin:shelf:{id}       → 各ライブラリのデータ（画像込み、個別保存）
//
// これにより、1ライブラリずつ保存するため413エラーを回避できる。
// ─────────────────────────────────────────

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const IDS_KEY = 'snapin:shelf-ids';
const shelfKey = (id) => `snapin:shelf:${id}`;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
}

function checkAuth(req) {
  const pass = req.headers['x-admin-password'];
  return process.env.ADMIN_PASSWORD && pass === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET: 全公開棚を返す (認証不要)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {
    try {
      // IDリストを取得
      let ids = (await redis.get(IDS_KEY)) || [];

      // 旧データ（snapin:shelves）との後方互換: IDリストが空なら旧キーから移行
      if (ids.length === 0) {
        const legacy = (await redis.get('snapin:shelves')) || [];
        if (legacy.length > 0) {
          // 旧データを新形式に移行
          ids = legacy.map(s => s.id).filter(Boolean);
          await redis.set(IDS_KEY, ids);
          for (const shelf of legacy) {
            if (shelf.id) await redis.set(shelfKey(shelf.id), shelf);
          }
          // 移行完了後、旧キーは削除しない（安全のため残す）
          return res.status(200).json({ shelves: legacy });
        }
      }

      if (ids.length === 0) {
        return res.status(200).json({ shelves: [] });
      }

      // 各ライブラリを並列取得
      const results = await Promise.all(ids.map(id => redis.get(shelfKey(id))));
      const shelves = results.filter(Boolean);

      return res.status(200).json({ shelves });
    } catch (err) {
      console.error('shelves GET error:', err);
      return res.status(500).json({ error: err.message, shelves: [] });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST: 1つのライブラリを保存 (管理者専用)
  // body: { shelf: {...} }  1ライブラリのみ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'POST') {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      // 旧クライアントとの後方互換: shelves配列で来た場合は全件保存
      if (Array.isArray(body.shelves)) {
        const shelves = body.shelves;
        const ids = shelves.map(s => s.id).filter(Boolean);
        await redis.set(IDS_KEY, ids);
        await Promise.all(shelves.map(s => s.id ? redis.set(shelfKey(s.id), s) : null));
        return res.status(200).json({ ok: true, count: shelves.length });
      }

      // 新方式: 1ライブラリずつ保存
      const { shelf } = body || {};
      if (!shelf || !shelf.id) {
        return res.status(400).json({ error: 'shelf with id is required' });
      }

      // IDリストに追加（なければ）
      let ids = (await redis.get(IDS_KEY)) || [];
      if (!ids.includes(shelf.id)) {
        ids.push(shelf.id);
        await redis.set(IDS_KEY, ids);
      }

      // ライブラリデータを保存
      await redis.set(shelfKey(shelf.id), shelf);

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('shelves POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DELETE: 1つのライブラリを削除 (管理者専用)
  // body: { shelfId: 'xxx' }
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'DELETE') {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { shelfId } = body || {};
      if (!shelfId) {
        return res.status(400).json({ error: 'shelfId is required' });
      }

      // IDリストから削除
      let ids = (await redis.get(IDS_KEY)) || [];
      ids = ids.filter(id => id !== shelfId);
      await redis.set(IDS_KEY, ids);

      // ライブラリデータを削除
      await redis.del(shelfKey(shelfId));

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('shelves DELETE error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
