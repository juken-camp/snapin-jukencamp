// /api/teams.js — SnapIn 団体(チーム)管理エンドポイント (admin 専用)
//
// Kazuma さんが admin.html から、団体の作成・編集・参加コード発行・
// メンバーへの設定反映を行うための管理用エンドポイント。
//
// 認証:
//   admin パスワード (ADMIN_PASSWORD) で保護する。
//   送り方: ヘッダ x-admin-password / クエリ ?password= / body.password
//   ※ students.js と同じ admin 認証に合わせています。
//      もし students.js が token(role:admin) 方式なら、その方式に寄せます。
//
// データ:
//   snapin:teams … 団体オブジェクトの配列
//   団体オブジェクト:
//     { id, name, code, shelfIds[], aiEnabled, secretDigits, note, disabled, createdAt }
//   メンバーは snapin:students 側に teamId を持って入っている (join.js が作成)。
//
// エンドポイント:
//   GET  /api/teams                       → { ok, teams:[ {...team, memberCount} ] }
//   POST /api/teams { action, ... }
//     action='create'   { name, shelfIds?, aiEnabled?, secretDigits?, note? } → 新規作成(コード自動発行)
//     action='update'   { id, name?, shelfIds?, aiEnabled?, secretDigits?, note?, disabled? }
//     action='regen'    { id }                 → 参加コードを再発行
//     action='sync'     { id }                 → 所属メンバーに shelfIds/aiEnabled を反映
//     action='delete'   { id }                 → 団体を削除 (既存メンバーはそのまま残る)
//
// レスポンス: { ok:true, ... } | { ok:false, reason }

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const TEAMS_KEY = 'snapin:teams';
const STUDENTS_KEY = 'snapin:students';

// 参加コードの文字種 (紛らわしい 0/O/1/I/L を除外した大文字英数)
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
}

function isAdmin(req) {
  const pw = req.headers['x-admin-password']
    || req.query?.password
    || (typeof req.body === 'object' && req.body?.password)
    || (typeof req.body === 'string' && safeParse(req.body)?.password);
  return process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function genCode() {
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) {
    c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return c;
}

// teams 内で重複しない参加コードを作る
function genUniqueCode(teams) {
  for (let tries = 0; tries < 50; tries++) {
    const c = genCode();
    if (!teams.some(t => t && t.code === c)) return c;
  }
  // 万一ぶつかり続けたら末尾に時刻を足して必ずユニークに
  return genCode() + Date.now().toString(36).toUpperCase().slice(-2);
}

function newTeamId() {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return 'team_' + rnd;
}

function sanitizeShelfIds(v) {
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 200) : [];
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!isAdmin(req)) {
    return res.status(401).json({ ok: false, reason: 'unauthorized' });
  }

  try {
    const teams = (await redis.get(TEAMS_KEY)) || [];

    // ── 一覧取得 (メンバー数を添えて返す) ──
    if (req.method === 'GET') {
      const students = (await redis.get(STUDENTS_KEY)) || [];
      const countByTeam = {};
      for (const s of students) {
        if (s && s.teamId) countByTeam[s.teamId] = (countByTeam[s.teamId] || 0) + 1;
      }
      const withCount = teams.map(t => ({ ...t, memberCount: countByTeam[t.id] || 0 }));
      return res.status(200).json({ ok: true, teams: withCount });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
    }

    const body = typeof req.body === 'string' ? (safeParse(req.body) || {}) : (req.body || {});
    const action = body.action;

    // ── 作成 ──
    if (action === 'create') {
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, reason: 'name_required' });
      const team = {
        id: newTeamId(),
        name: name.slice(0, 60),
        code: genUniqueCode(teams),
        shelfIds: sanitizeShelfIds(body.shelfIds),
        aiEnabled: body.aiEnabled !== false,
        secretDigits: Number(body.secretDigits) === 6 ? 6 : 4,
        note: String(body.note || '').slice(0, 500),
        disabled: false,
        createdAt: Date.now(),
      };
      teams.push(team);
      await redis.set(TEAMS_KEY, teams);
      return res.status(200).json({ ok: true, team });
    }

    // ── 更新 ──
    if (action === 'update') {
      const i = teams.findIndex(t => t && t.id === body.id);
      if (i < 0) return res.status(404).json({ ok: false, reason: 'not_found' });
      const t = teams[i];
      if (body.name !== undefined) t.name = String(body.name).trim().slice(0, 60);
      if (body.shelfIds !== undefined) t.shelfIds = sanitizeShelfIds(body.shelfIds);
      if (body.aiEnabled !== undefined) t.aiEnabled = body.aiEnabled === true;
      if (body.secretDigits !== undefined) t.secretDigits = Number(body.secretDigits) === 6 ? 6 : 4;
      if (body.note !== undefined) t.note = String(body.note).slice(0, 500);
      if (body.disabled !== undefined) t.disabled = body.disabled === true;
      teams[i] = t;
      await redis.set(TEAMS_KEY, teams);
      return res.status(200).json({ ok: true, team: t });
    }

    // ── 参加コードの再発行 ──
    if (action === 'regen') {
      const i = teams.findIndex(t => t && t.id === body.id);
      if (i < 0) return res.status(404).json({ ok: false, reason: 'not_found' });
      teams[i].code = genUniqueCode(teams);
      await redis.set(TEAMS_KEY, teams);
      return res.status(200).json({ ok: true, team: teams[i] });
    }

    // ── メンバーへ設定を反映 (shelfIds / aiEnabled のスナップショットを更新) ──
    if (action === 'sync') {
      const t = teams.find(x => x && x.id === body.id);
      if (!t) return res.status(404).json({ ok: false, reason: 'not_found' });
      const students = (await redis.get(STUDENTS_KEY)) || [];
      let updated = 0;
      for (const s of students) {
        if (s && s.teamId === t.id) {
          s.shelfIds = Array.isArray(t.shelfIds) ? t.shelfIds.slice(0, 200) : [];
          s.aiEnabled = t.aiEnabled !== false;
          s.group = t.name || s.group || '';
          updated++;
        }
      }
      await redis.set(STUDENTS_KEY, students);
      return res.status(200).json({ ok: true, updated });
    }

    // ── 削除 (団体だけ消す。既存メンバーはスナップショットを持つのでそのまま使える) ──
    if (action === 'delete') {
      const next = teams.filter(t => t && t.id !== body.id);
      await redis.set(TEAMS_KEY, next);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, reason: 'unknown_action' });
  } catch (err) {
    console.error('teams error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error', error: err.message });
  }
}
