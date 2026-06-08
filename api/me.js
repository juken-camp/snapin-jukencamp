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
import { authFromReq, normalizeName } from './_lib/auth.js';

const TEAMS_KEY = 'snapin:teams';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token, X-Snapin-Display, X-Snapin-Platform, X-Admin-Password');
}

// 端末計測キー
const DEVICES_ALL_KEY = 'snapin:devices:all';            // ログインした全端末(did)のSet
const DEVICES_INSTALLED_KEY = 'snapin:devices:installed'; // standalone(PWA)で起動した端末のSet

// 端末 pings を記録する。
// ★重要: ここで何が起きても本来のレスポンスには影響させない。
//   失敗は内部で握りつぶし、例外を外に投げない。
async function recordDevicePing(req, auth) {
  try {
    const did = auth && auth.payload && auth.payload.did;
    if (!did) return; // 端末IDが無ければ計測しない (安全側)

    const mode = String(req.headers['x-snapin-display'] || 'unknown').slice(0, 16);
    const platform = String(req.headers['x-snapin-platform'] || '').slice(0, 40);

    await redis.hset(`snapin:device:${did}`, {
      lastSeen: Date.now(),
      mode,
      platform,
    });
    await redis.sadd(DEVICES_ALL_KEY, did);
    if (mode === 'standalone') {
      await redis.sadd(DEVICES_INSTALLED_KEY, did);
    }
  } catch (e) {
    // 計測失敗は無視 (本処理に影響させない)
    console.error('device ping failed:', e);
  }
}

// 端末数を集計して返す。失敗時は null。
async function computeStats() {
  try {
    const [all, installed] = await Promise.all([
      redis.scard(DEVICES_ALL_KEY),
      redis.scard(DEVICES_INSTALLED_KEY),
    ]);
    return { devices: all || 0, installed: installed || 0 };
  } catch (e) {
    console.error('stats error:', e);
    return null;
  }
}

// admin パスワードのチェック (students.js と同じ方式)
function isAdminPassword(req) {
  const pass = req.headers['x-admin-password'];
  if (!pass || !process.env.ADMIN_PASSWORD) return false;
  return pass === process.env.ADMIN_PASSWORD;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });
  }

  // 端末統計の読み取り (admin.html 用): admin パスワードが正しければ数字だけ返す。
  // ※ ここはトークン検証より前。パスワードが無い/違うときは通常フローへ進む。
  if (req.query && req.query.stats && isAdminPassword(req)) {
    const stats = await computeStats();
    return res.status(200).json({ ok: true, role: 'admin', stats });
  }

  // token 検証
  const auth = authFromReq(req);
  if (!auth.ok) {
    return res.status(401).json({ ok: false, reason: 'invalid_token' });
  }

  // 管理者
  if (auth.payload.role === 'admin') {
    // ?stats=1 が付いたときだけ端末数を集計して返す (通常呼び出しには負荷を足さない)
    if (req.query && req.query.stats) {
      const stats = await computeStats();
      return res.status(200).json({ ok: true, role: 'admin', stats });
    }
    return res.status(200).json({ ok: true, role: 'admin' });
  }

  // 塾生
  if (auth.payload.role !== 'student') {
    return res.status(401).json({ ok: false, reason: 'unknown_role' });
  }

  // 端末計測 (塾生トークンのみ。失敗しても本処理に影響しない)
  await recordDevicePing(req, auth);

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
    // グループ管理者かどうか (グループの adminName と本人の名前が一致するか)
    let isGroupAdmin = false;
    if (student.teamId) {
      try {
        const teams = (await redis.get(TEAMS_KEY)) || [];
        const team = teams.find(t => t && t.id === student.teamId);
        if (team && team.adminName &&
            normalizeName(team.adminName) === normalizeName(student.name || '')) {
          isGroupAdmin = true;
        }
      } catch (_) { /* 取得失敗時は管理者扱いしない */ }
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
        teamId: student.teamId || null,
        isGroupAdmin,
      },
      claimed: true,
    });
  } catch (err) {
    console.error('me error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error' });
  }
}
