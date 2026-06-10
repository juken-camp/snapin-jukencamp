// /api/shelves.js — SnapIn 公式棚 API（誤消失ガード＋ゴミ箱つき）
//
// Upstash Redis を使って、Kazumaさんが admin.html で投稿した公式棚を、
// 全生徒の index.html から見える状態にする。
//
// ─────────────────────────────────────────
// キー設計:
//   snapin:shelf-ids        → 公開中ライブラリIDの配列（軽量・目次）
//   snapin:shelf:{id}       → 各ライブラリのデータ（画像込み、個別保存）
//   snapin:shelf-ids:prev   → 直前の目次（上書き前に自動退避：ワンステップ復元用）
//   snapin:shelf-ids:trash  → ゴミ箱 [{id, deletedAt}]（7日間保持→自動完全削除）
//
// 安全機構（設計ミスによる突然消失を防ぐ）:
//   1) 目次を0件で全消し上書きする保存は拒否する
//   2) 目次の件数が大きく減る上書きは、明示的な force が無い限り拒否する
//   3) 目次を上書きする直前に、現在の目次を snapin:shelf-ids:prev に退避する
//
// ゴミ箱（誤削除対策）:
//   - 削除は「ゴミ箱へ移動」(action:'trash')。本体は消さず、目次から trash へ移すだけ。
//   - 復元 (action:'restore')、完全削除 (action:'purge')。
//   - GET ?trash=1（管理者のみ）でゴミ箱一覧。アクセス時に7日超を自動で完全削除。
//   - 利用者(index)が見る通常GETは従来どおり snapin:shelf-ids のみ。ゴミ箱は見えない。
// ─────────────────────────────────────────

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const IDS_KEY = 'snapin:shelf-ids';
const PREV_KEY = 'snapin:shelf-ids:prev';
const TRASH_KEY = 'snapin:shelf-ids:trash';
const TRASH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7日
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
    await redis.set(PREV_KEY, currentIds);
  }
  await redis.set(IDS_KEY, newIds);
}

// ゴミ箱を取得し、7日を過ぎたものは本体ごと完全削除して返す（自動purge）。
async function getTrashAndPurge() {
  let trash = (await redis.get(TRASH_KEY)) || [];
  if (!Array.isArray(trash)) trash = [];
  const now = Date.now();
  const isExpired = (t) => t && t.deletedAt && (now - t.deletedAt) > TRASH_TTL_MS;
  const expired = trash.filter(isExpired);
  if (expired.length > 0) {
    await Promise.all(expired.map(t => redis.del(shelfKey(t.id))));
    trash = trash.filter(t => !isExpired(t));
    await redis.set(TRASH_KEY, trash);
  }
  return trash;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {
    try {
      // ── ゴミ箱一覧 (管理者のみ) ＋ 7日超の自動完全削除 ──
      if (req.query && req.query.trash === '1') {
        if (!checkAuth(req)) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const trash = await getTrashAndPurge();
        const bodies = await Promise.all(trash.map(t => redis.get(shelfKey(t.id))));
        const shelves = trash
          .map((t, i) => bodies[i] ? Object.assign({}, bodies[i], { deletedAt: t.deletedAt }) : null)
          .filter(Boolean);
        return res.status(200).json({ shelves });
      }

      // 公開GETはCDN(エッジ)でキャッシュ可能：全員同じ内容で認証不要。
      //  s-maxage=60               → エッジに60秒キャッシュ（この間オリジン関数を叩かない）
      //  stale-while-revalidate=300 → 期限切れ後も古い内容を即返しつつ、裏で更新を取りにいく
      // ※ ゴミ箱GET(trash=1)はこの行より前で return 済みなのでキャッシュされない。
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

      // ── 通常: 公開中の棚を返す (認証不要 / 利用者アプリもこれを読む) ──
      let ids = (await redis.get(IDS_KEY)) || [];

      // 旧データ（snapin:shelves）との後方互換: IDリストが空なら旧キーから移行
      if (ids.length === 0) {
        const legacy = (await redis.get('snapin:shelves')) || [];
        if (legacy.length > 0) {
          ids = legacy.map(s => s.id).filter(Boolean);
          await redis.set(IDS_KEY, ids);
          for (const shelf of legacy) {
            if (shelf.id) await redis.set(shelfKey(shelf.id), shelf);
          }
          return res.status(200).json({ shelves: legacy });
        }
      }

      if (ids.length === 0) {
        return res.status(200).json({ shelves: [] });
      }

      const results = await Promise.all(ids.map(id => redis.get(shelfKey(id))));
      const shelves = results.filter(Boolean);
      return res.status(200).json({ shelves });
    } catch (err) {
      res.setHeader('Cache-Control', 'no-store'); // エラー応答はキャッシュさせない
      console.error('shelves GET error:', err);
      return res.status(500).json({ error: err.message, shelves: [] });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST: 保存 / ゴミ箱操作 (管理者専用)
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'POST') {
    if (!checkAuth(req)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

      // ── ゴミ箱へ移動 (削除＝即消去ではなく、ここへ退避) ──
      if (body && body.action === 'trash') {
        const id = body.shelfId;
        if (!id) return res.status(400).json({ error: 'shelfId required' });
        // 目次から外す（prev退避つき）
        const currentIds = (await redis.get(IDS_KEY)) || [];
        if (currentIds.includes(id)) {
          await safeSetIds(currentIds, currentIds.filter(x => x !== id));
        }
        // ゴミ箱に追加（重複防止）。本体 snapin:shelf:{id} はそのまま残す。
        let trash = (await redis.get(TRASH_KEY)) || [];
        if (!Array.isArray(trash)) trash = [];
        if (!trash.some(t => t && t.id === id)) {
          trash.push({ id, deletedAt: Date.now() });
          await redis.set(TRASH_KEY, trash);
        }
        return res.status(200).json({ ok: true });
      }

      // ── ゴミ箱から復元 ──
      if (body && body.action === 'restore') {
        const id = body.shelfId;
        if (!id) return res.status(400).json({ error: 'shelfId required' });
        // ゴミ箱から外す
        let trash = (await redis.get(TRASH_KEY)) || [];
        if (!Array.isArray(trash)) trash = [];
        trash = trash.filter(t => !(t && t.id === id));
        await redis.set(TRASH_KEY, trash);
        // 本体が残っていれば目次へ戻す
        const exists = await redis.get(shelfKey(id));
        if (exists) {
          let ids = (await redis.get(IDS_KEY)) || [];
          if (!ids.includes(id)) {
            ids.push(id);
            await redis.set(IDS_KEY, ids);
          }
        }
        return res.status(200).json({ ok: true, restored: !!exists });
      }

      // ── ゴミ箱から完全削除 (本体ごと消す) ──
      if (body && body.action === 'purge') {
        const id = body.shelfId;
        if (!id) return res.status(400).json({ error: 'shelfId required' });
        let trash = (await redis.get(TRASH_KEY)) || [];
        if (!Array.isArray(trash)) trash = [];
        trash = trash.filter(t => !(t && t.id === id));
        await redis.set(TRASH_KEY, trash);
        await redis.del(shelfKey(id));
        return res.status(200).json({ ok: true });
      }

      // 旧クライアントとの後方互換: shelves配列で来た場合は全件保存
      if (Array.isArray(body.shelves)) {
        const shelves = body.shelves;
        const newIds = shelves.map(s => s.id).filter(Boolean);

        const currentIds = (await redis.get(IDS_KEY)) || [];
        const force = body.force === true;

        // ガード1: 0件での全消し上書きは常に拒否
        if (newIds.length === 0 && currentIds.length > 0) {
          console.warn('shelves POST refused: would empty index', { currentCount: currentIds.length });
          return res.status(409).json({
            error: 'refused: would wipe shelf index to empty',
            currentCount: currentIds.length,
          });
        }
        // ガード2: 件数が大きく減る上書きは force が無い限り拒否（1件減は許容）
        if (!force && currentIds.length >= 2 && newIds.length < currentIds.length - 1) {
          console.warn('shelves POST refused: sharp shrink', { from: currentIds.length, to: newIds.length });
          return res.status(409).json({
            error: 'refused: shelf count would drop sharply; pass force:true to override',
            from: currentIds.length,
            to: newIds.length,
          });
        }

        await safeSetIds(currentIds, newIds);
        await Promise.all(shelves.map(s => s.id ? redis.set(shelfKey(s.id), s) : null));
        return res.status(200).json({ ok: true, count: shelves.length });
      }

      // 新方式: 1ライブラリずつ保存（追加のみ＝消える危険なし）
      const { shelf } = body || {};
      if (!shelf || !shelf.id) {
        return res.status(400).json({ error: 'shelf with id is required' });
      }
      let ids = (await redis.get(IDS_KEY)) || [];
      if (!ids.includes(shelf.id)) {
        ids.push(shelf.id);
        await redis.set(IDS_KEY, ids);
      }
      await redis.set(shelfKey(shelf.id), shelf);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('shelves POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // DELETE: 1つのライブラリを削除 (管理者専用・後方互換)
  // 注: admin.html は通常この経路を使わず、ゴミ箱(action:'trash')を使う。
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
      const currentIds = (await redis.get(IDS_KEY)) || [];
      await safeSetIds(currentIds, currentIds.filter(id => id !== shelfId));
      await redis.del(shelfKey(shelfId));
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('shelves DELETE error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
