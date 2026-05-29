// /api/group-shelf.js — グループ所有の公式ライブラリ (グループ管理者が自分で作成・編集)
//
// グローバルの公式ライブラリ (snapin:shelves / Kazuma さんが admin で管理) とは
// 完全に分離する。各グループのライブラリは専用キーに保存し、エンドポイントは
// 「リクエストしたメンバーが所属するグループ」だけを対象に動く。
//
// 認証: メンバーtoken (x-snapin-token)。teamId はリクエストでは受け取らず、
//   必ずメンバーのレコードから導出する → 他グループのデータには構造上アクセス不可。
//
//   GET    /api/group-shelf
//     → 自分の所属グループのライブラリ一覧 (グループのメンバーなら誰でも閲覧可)
//        レスポンス: { ok:true, shelves:[...] }
//   POST   /api/group-shelf   body:{ shelf:{ id?, name, handle?, desc?, icon?, cards? } }
//     → ライブラリを作成/更新 (グループ管理者のみ)。ownerTeamId は強制的に自グループ。
//   DELETE /api/group-shelf   body:{ shelfId }
//     → ライブラリを削除 (グループ管理者のみ)
//
// 保存: snapin:gshelf:team:{teamId} = そのグループのライブラリ配列。
//   他グループのキーには一切触れない (キー名が teamId で固定されるため)。

import { Redis } from '@upstash/redis';
import { authFromReq, normalizeName } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';
const TEAMS_KEY = 'snapin:teams';
const MAX_SHELVES_PER_TEAM = 100;
const MAX_CARDS_PER_SHELF = 500;

function teamShelfKey(teamId) { return 'snapin:gshelf:team:' + teamId; }

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token');
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }
function newShelfId() {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return 'gshelf_' + rnd;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── メンバー認証 ──
  const auth = authFromReq(req);
  if (!auth.ok || auth.payload.role !== 'student') {
    return res.status(401).json({ ok: false, reason: 'invalid_token' });
  }

  try {
    const students = (await redis.get(STUDENTS_KEY)) || [];
    const member = students.find(s => s && s.id === auth.payload.sub);
    if (!member) return res.status(200).json({ ok: false, reason: 'student_not_found' });
    if (member.revoked) return res.status(200).json({ ok: false, reason: 'revoked' });

    // teamId は必ずメンバーのレコードから (リクエスト指定は受け付けない)
    const teamId = member.teamId;
    if (!teamId) return res.status(200).json({ ok: false, reason: 'no_team' });

    // 単一端末縛り (複数端末許可でなければ) — me.js と整合
    if (!member.multiDevice && member.claimedBy !== auth.payload.did) {
      return res.status(200).json({ ok: false, reason: 'claim_lost' });
    }

    const KEY = teamShelfKey(teamId);

    // ── GET: 自分のグループのライブラリ一覧 (メンバーなら誰でも) ──
    if (req.method === 'GET') {
      const shelves = (await redis.get(KEY)) || [];
      return res.status(200).json({ ok: true, shelves });
    }

    // ── 書き込みはグループ管理者のみ ──
    const teams = (await redis.get(TEAMS_KEY)) || [];
    const team = teams.find(t => t && t.id === teamId);
    const isAdmin = !!(team && team.adminName &&
      normalizeName(team.adminName) === normalizeName(member.name || ''));
    if (!isAdmin) {
      return res.status(403).json({ ok: false, reason: 'not_group_admin' });
    }

    const body = typeof req.body === 'string' ? (safeParse(req.body) || {}) : (req.body || {});

    // ── POST: 作成 / 更新 ──
    if (req.method === 'POST') {
      const shelf = body.shelf || {};
      const name = String(shelf.name || '').trim();
      if (!name) return res.status(400).json({ ok: false, reason: 'name_required' });

      const list = (await redis.get(KEY)) || [];
      const now = Date.now();
      const cards = Array.isArray(shelf.cards) ? shelf.cards.slice(0, MAX_CARDS_PER_SHELF) : [];

      let rec;
      const i = shelf.id ? list.findIndex(x => x && x.id === shelf.id) : -1;
      if (i >= 0) {
        rec = {
          ...list[i],
          name: name.slice(0, 60),
          handle: String(shelf.handle != null ? shelf.handle : (list[i].handle || '')).slice(0, 40),
          desc: String(shelf.desc != null ? shelf.desc : (list[i].desc || '')).slice(0, 300),
          icon: shelf.icon != null ? shelf.icon : (list[i].icon || ''),
          cards: Array.isArray(shelf.cards) ? cards : (list[i].cards || []),
          ownerTeamId: teamId,   // 強制 (改ざん防止)
          updatedAt: now,
        };
        list[i] = rec;
      } else {
        rec = {
          id: newShelfId(),
          name: name.slice(0, 60),
          handle: String(shelf.handle || '').slice(0, 40),
          desc: String(shelf.desc || '').slice(0, 300),
          icon: shelf.icon || '',
          cards,
          ownerTeamId: teamId,
          createdAt: now,
          updatedAt: now,
        };
        if (list.length >= MAX_SHELVES_PER_TEAM) {
          return res.status(200).json({ ok: false, reason: 'limit_reached' });
        }
        list.push(rec);
      }
      await redis.set(KEY, list);
      return res.status(200).json({ ok: true, shelf: rec });
    }

    // ── DELETE: 削除 ──
    if (req.method === 'DELETE') {
      const shelfId = body.shelfId;
      if (!shelfId) return res.status(400).json({ ok: false, reason: 'bad_request' });
      const list = (await redis.get(KEY)) || [];
      const next = list.filter(x => x && x.id !== shelfId);
      await redis.set(KEY, next);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  } catch (err) {
    console.error('group-shelf error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
}
