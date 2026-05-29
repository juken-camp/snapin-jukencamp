// /api/me.js — SnapIn 塾生本人の最新情報を返すエンドポイント
//
// 用途:
//   生徒側 (index.html) が起動時・画面遷移時に呼んで、
//   admin で更新された shelfIds や aiEnabled、claim状態を取り込む。
//
// 認証:
//   x-snapin-token ヘッダで塾生tokenを受け取る。
//   管理者token (role:'admin') の場合は { ok:true, role:'admin' } を返す。
//
// レスポンス例 (生徒):
//   { ok:true, role:'student',
//     student:{ id, name, group, shelfIds, aiEnabled }, claimed:true }
//
// レスポンス例 (claim失効):
//   { ok:false, reason:'claim_lost' }  → クライアントは auth をクリア

import { Redis } from '@upstash/redis';
import { authFromReq } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }

  // token 検証
  const auth = authFromReq(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, reason: 'invalid_token' });
  }

  // 管理者
  if (auth.payload.role === 'admin') {
    return res.status(200).json({ ok: true, role: 'admin' });
  }

  // 塾生
  if (auth.payload.role !== 'student') {
    return res.status(401).json({ ok: false, reason: 'unknown_role' });
  }

  try {
    const students = (await redis.get(STUDENTS_KEY)) || [];
    const student = students.find(s => s && s.id === auth.payload.sub);
    if (!student) {
      return res.status(200).json({ ok: false, reason: 'student_not_found' });
    }
    if (student.revoked) {
      return res.status(200).json({ ok: false, reason: 'revoked' });
    }
    // claim が他端末に取られている (機種変などで解除→再claimされた)
    // ただし、複数端末を許可しているメンバー(団体)は端末縛りをしない。
    if (!student.multiDevice && student.claimedBy !== auth.payload.did) {
      return res.status(200).json({ ok: false, reason: 'claim_lost' });
    }
    return res.status(200).json({
      ok: true,
      role: 'student',
      student: {
        id: student.id,
        name: student.name || '',
        group: student.group || '',
        shelfIds: Array.isArray(student.shelfIds) ? student.shelfIds : [],
        aiEnabled: student.aiEnabled !== false,
      },
      claimed: true,
    });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
}
