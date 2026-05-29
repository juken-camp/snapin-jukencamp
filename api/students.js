// /api/students.js — SnapIn 塾生名簿 API (admin 専用)
//
// データ構造 (Redis キー 'snapin:students'):
//   [
//     {
//       id: "stu_xxx",
//       name: "和田一真",          // 表示用
//       nameKey: "わだいっしん",     // 照合用 (admin 側で読みも入力)
//       birthday: "1117",          // MMDD
//       group: "港川中3",
//       shelfIds: ["shelf_xxx"],
//       aiEnabled: true,
//       claimedBy: "dev_xxx" | null,
//       claimedAt: 1234567890 | null,
//       revoked: false,
//       createdAt: 1234567890,
//     }
//   ]
//
// エンドポイント:
//   GET  /api/students        → 全名簿 (admin認証必須)
//   POST /api/students        → 名簿丸ごと保存 (admin認証必須)
//   POST /api/students?action=unclaim&id=stu_xxx
//                             → 特定生徒のclaimを解除 (機種変対応)

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KEY = 'snapin:students';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
}

function checkAdmin(req) {
  const pass = req.headers['x-admin-password'];
  if (!process.env.ADMIN_PASSWORD) return false;
  return pass === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  // すべて admin 認証必須
  if (!checkAdmin(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET: 全名簿
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'GET') {
    try {
      const students = (await redis.get(KEY)) || [];
      return res.status(200).json({ students });
    } catch (err) {
      console.error('students GET error:', err);
      return res.status(500).json({ error: err.message, students: [] });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST: 名簿保存 (まるごと) または個別アクション
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
      const action = req.query?.action || body.action;

      // ─── claim 解除 ───
      if (action === 'unclaim') {
        const id = req.query?.id || body.id;
        if (!id) return res.status(400).json({ error: 'id required' });
        const students = (await redis.get(KEY)) || [];
        const s = students.find(x => x.id === id);
        if (!s) return res.status(404).json({ error: 'student not found' });
        s.claimedBy = null;
        s.claimedAt = null;
        await redis.set(KEY, students);
        return res.status(200).json({ ok: true });
      }

      // ─── 名簿丸ごと保存 ───
      const { students } = body;
      if (!Array.isArray(students)) {
        return res.status(400).json({ error: 'students must be array' });
      }
      // 軽くバリデーション + claim 情報の上書き防止
      // (admin UI から claim フィールドが送られてきても、既存値を維持する)
      const existing = (await redis.get(KEY)) || [];
      const existingById = new Map(existing.map(s => [s.id, s]));
      const sanitized = students.map(s => {
        const old = existingById.get(s.id) || {};
        const rec = {
          id: s.id,
          name: String(s.name || '').slice(0, 100),
          nameKey: String(s.nameKey || '').slice(0, 100),
          birthday: String(s.birthday || '').slice(0, 6),
          group: String(s.group || '').slice(0, 100),
          shelfIds: Array.isArray(s.shelfIds) ? s.shelfIds.slice(0, 100) : [],
          aiEnabled: s.aiEnabled !== false,
          // claim 情報は admin から送られても無視、既存値を維持
          claimedBy: old.claimedBy || null,
          claimedAt: old.claimedAt || null,
          revoked: s.revoked === true,
          createdAt: old.createdAt || s.createdAt || Date.now(),
        };
        // 団体メンバー (api/join.js 由来) のサーバー管理フィールドを保持する。
        // admin の名簿保存で teamId 等が消えると、再ログインの団体内照合や
        // 「団体→メンバーへの反映」が壊れるため、既存値 (old) を必ず引き継ぐ。
        const teamId = old.teamId || s.teamId;
        if (teamId) rec.teamId = teamId;
        if (old.viaJoin === true || s.viaJoin === true) rec.viaJoin = true;
        if (old.multiDevice === true) rec.multiDevice = true;
        if (old.failCount) rec.failCount = old.failCount;
        if (old.lockUntil) rec.lockUntil = old.lockUntil;
        return rec;
      });
      await redis.set(KEY, sanitized);
      return res.status(200).json({ ok: true, count: sanitized.length });
    } catch (err) {
      console.error('students POST error:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
