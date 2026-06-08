// /api/shelves.js — SnapIn 公式棚 API（誤消失ガード入り）
//
// Upstash Redis を使って、Kazumaさんが admin.html で投稿した公式棚を、
// 全生徒の index.html から見える状態にする。
//
// ─────────────────────────────────────────
// キー設計:
//   snapin:shelf-ids        → ライブラリIDの配列（軽量・目次）
//   snapin:shelf:{id}       → 各ライブラリのデータ（画像込み、個別保存）
//   snapin:shelf-ids:prev   → 直前の目次（上書き前に自動退避：ワンステップ復元用）
//
// ★追加した安全機構（設計ミスによる突然消失を防ぐ）:
//   1) 目次を0件で全消し上書きする保存は拒否する
//   2) 目次の件数が大きく減る上書きは、明示的な force が無い限り拒否する
//      （通常の1件削除は DELETE 経由なのでここには来ない）
//   3) 目次を上書きする直前に、現在の目次を snapin:shelf-ids:prev に退避する
//      → 万一おかしくなっても: SET snapin:shelf-ids <prev の値> で即復旧できる
// ─────────────────────────────────────────

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const IDS_KEY = 'snapin:shelf-ids';
const PREV_KEY = 'snapin:shelf-ids:prev';
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

// 目次を安全に上書きする。上書き前に必ず prev へ退避する。
async function safeSetIds(currentIds, newIds) {
  if (Array.isArray(currentIds) && currentIds.length > 0) {
    // 直前の目次を退避（ワンステップ復元用）
    await redis.set(PREV_KEY, currentIds);
  }
  await redis.set(IDS_KEY, newIds);
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
  // POST: ライブラリを保存 (管理者専用)
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
        const newIds = shelves.map(s => s.id).filter(Boolean);

        // 現在の目次を読む（ガードと退避の基準）
        const currentIds = (await redis.get(IDS_KEY)) || [];
        // ユーザーが管理画面で明示的に承認したときだけ true（大幅減を許可する印）
        const force = body.force === true;

        // ── ガード1: 0件での全消し上書きは常に拒否 ──
        if (newIds.length === 0 && currentIds.length > 0) {
          console.warn('shelves POST refused: would empty index', { currentCount: currentIds.length });
          return res.status(409).json({
            error: 'refused: would wipe shelf index to empty',
            currentCount: currentIds.length,
          });
        }

        // ── ガード2: 件数が大きく減る上書きは force が無い限り拒否 ──
        //   （1件減は許容＝うっかり1個消えても止めないが、複数減は止める）
        if (!force && currentIds.length >= 2 && newIds.length < currentIds.length - 1) {
          console.warn('shelves POST refused: sharp shrink', { from: currentIds.length, to: newIds.length });
          return res.status(409).json({
            error: 'refused: shelf count would drop sharply; pass force:true to override',
            from: currentIds.length,
            to: newIds.length,
          });
        }

        // ── 上書き前に現在の目次を退避してから保存 ──
        await safeSetIds(currentIds, newIds);
        await Promise.all(shelves.map(s => s.id ? redis.set(shelfKey(s.id), s) : null));
        return res.status(200).json({ ok: true, count: shelves.length });
      }

      // 新方式: 1ライブラリずつ保存（追加のみ＝消える危険なし）
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

      // IDリストから削除（1件だけ。上書き前に prev へ退避）
      const currentIds = (await redis.get(IDS_KEY)) || [];
      const newIds = currentIds.filter(id => id !== shelfId);
      await safeSetIds(currentIds, newIds);

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
