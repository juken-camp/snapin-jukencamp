// /api/join.js — SnapIn 団体メンバー 参加(join)エンドポイント
//
// 団体(チーム)の参加コードで、塾生以外の会社・家族・グループのメンバーが
// 自分でアカウントを作る/再ログインするための公開エンドポイント。
//
// 既存の claim.js と同じ「1アカウント＝1端末」モデルを踏襲する:
//   - メンバーは snapin:students に保存する (生徒と同じ構造 + teamId)
//   - 本人確認 = 名前 + 4桁の暗証番号(本人が初回に設定)
//   - claimedBy(deviceId) で端末を縛り、別端末からの参加は force でのみ引き継ぎ
//   - token は signToken({ role:'student', sub:memberId, did:deviceId }) で発行
//   → me.js / chat.js / claim.js は変更不要。メンバーは生徒と同じ扱いになる。
//
// リクエスト:
//   POST /api/join
//   body: { code, name, secret, deviceId, force? }
//     code   : 参加コード (団体ごと)
//     name   : メンバーの名前
//     secret : 4桁の暗証番号 (初回設定、以降の再ログインで使う)
//     force  : 別端末から引き継ぐ場合 true (名前+暗証番号が合っていれば deviceId 上書き)
//
// レスポンス (成功):
//   { ok:true, token, student:{ id, name, group, shelfIds, aiEnabled } }
//   ※ claim.js と同じ shape にして、index.html 側の成功処理を共用する
//
// レスポンス (失敗):
//   { ok:false, reason }
//     'bad_request'     入力不備
//     'invalid_code'    コードが存在しない / 無効化された団体
//     'wrong_secret'    暗証番号が違う (remaining: 残り試行回数)
//     'locked'          連続失敗でロック中 (retryAfterSec)
//     'already_claimed' 別端末で使用中 (force なし)
//     'server_error'    サーバー側エラー

import { Redis } from '@upstash/redis';
import { signToken, normalizeName } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';
const TEAMS_KEY = 'snapin:teams';

// 連続失敗ロックの設定 (総当たりで他人の名前を乗っ取られないように)
const MAX_FAILS = 5;            // 連続失敗の上限
const LOCK_MS = 10 * 60 * 1000; // ロック時間 (10分)

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// 参加コードの正規化 (大文字化・空白と紛らわしい区切りを除去)
function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[\s\-]/g, '');
}

// 暗証番号の正規化 (数字だけ・先頭から指定桁)
function normalizeSecret(secret, digits) {
  return String(secret == null ? '' : secret).replace(/\D/g, '').slice(0, digits);
}

// メンバーID生成
function newMemberId() {
  const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return 'mem_' + rnd;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { name, deviceId } = body;
    const force = body.force === true;
    const code = normalizeCode(body.code);

    if (!code || !name || !deviceId) {
      return res.status(400).json({ ok: false, reason: 'bad_request' });
    }

    const inputName = normalizeName(name);
    if (!inputName) {
      return res.status(400).json({ ok: false, reason: 'bad_request' });
    }

    // ── 団体をコードで特定 ──
    const teams = (await redis.get(TEAMS_KEY)) || [];
    const team = teams.find(t => t && !t.disabled && normalizeCode(t.code) === code);
    if (!team) {
      return res.status(200).json({ ok: false, reason: 'invalid_code' });
    }

    const digits = Number(team.secretDigits) === 6 ? 6 : 4;
    const inputSecret = normalizeSecret(body.secret, digits);
    if (inputSecret.length !== digits) {
      return res.status(400).json({ ok: false, reason: 'bad_request' });
    }

    const students = (await redis.get(STUDENTS_KEY)) || [];

    // ── この団体内で同名のメンバーを探す (団体スコープで照合) ──
    const idx = students.findIndex(s => {
      if (!s || s.teamId !== team.id) return false;
      const sName = normalizeName(s.name || '');
      const sKey = normalizeName(s.nameKey || '');
      return inputName === sName || (sKey && inputName === sKey);
    });

    const now = Date.now();

    // ── 既存メンバー: 再ログイン / 端末引き継ぎ ──
    if (idx >= 0) {
      const member = students[idx];

      if (member.revoked) {
        return res.status(200).json({ ok: false, reason: 'revoked' });
      }

      // ロック中か
      if (member.lockUntil && member.lockUntil > now) {
        return res.status(200).json({
          ok: false,
          reason: 'locked',
          retryAfterSec: Math.ceil((member.lockUntil - now) / 1000),
        });
      }

      // 暗証番号の照合
      if (String(member.birthday) !== inputSecret) {
        member.failCount = (member.failCount || 0) + 1;
        if (member.failCount >= MAX_FAILS) {
          member.lockUntil = now + LOCK_MS;
          member.failCount = 0;
        }
        students[idx] = member;
        await redis.set(STUDENTS_KEY, students);
        const remaining = member.lockUntil && member.lockUntil > now
          ? 0 : Math.max(0, MAX_FAILS - (member.failCount || 0));
        return res.status(200).json({ ok: false, reason: 'wrong_secret', remaining });
      }

      // 端末判定: 単一端末モデルでは別端末は force でのみ引き継ぐ。
      // 複数端末を許可している団体ではこのチェックを行わない (どの端末でも入れる)。
      const multi = team.multiDevice === true;
      if (!multi && member.claimedBy && member.claimedBy !== deviceId && !force) {
        return res.status(200).json({ ok: false, reason: 'already_claimed' });
      }

      // ログイン成立 (初回 / 同端末 / force / 複数端末許可)。
      // claimedBy は「最後に使った端末」として更新する (複数端末でも記録は残す)。
      member.claimedBy = deviceId;
      member.claimedAt = now;
      member.failCount = 0;
      member.lockUntil = 0;
      member.multiDevice = multi;     // 団体の設定に追従
      students[idx] = member;
      await redis.set(STUDENTS_KEY, students);

      const token = signToken({ role: 'student', sub: member.id, did: deviceId });
      return res.status(200).json({
        ok: true,
        token,
        student: {
          id: member.id,
          name: member.name,
          group: member.group || '',
          shelfIds: Array.isArray(member.shelfIds) ? member.shelfIds : [],
          aiEnabled: member.aiEnabled !== false,
        },
      });
    }

    // ── 新規メンバー: 団体の設定をスナップショットして作成 ──
    const member = {
      id: newMemberId(),
      name: String(name).trim().slice(0, 40),
      nameKey: '',
      birthday: inputSecret,                 // 4桁暗証番号 (本人が設定)
      group: team.name || '',                // 表示用に団体名 (既存 group フィールド)
      teamId: team.id,                       // どの団体か (メンバー識別用・新フィールド)
      shelfIds: Array.isArray(team.shelfIds) ? team.shelfIds.slice(0, 200) : [],
      aiEnabled: team.aiEnabled !== false,
      multiDevice: team.multiDevice === true,  // 複数端末を許可する団体か
      claimedBy: deviceId,
      claimedAt: now,
      revoked: false,
      viaJoin: true,                         // join 経由フラグ (admin で見分ける用)
      failCount: 0,
      lockUntil: 0,
      createdAt: now,
    };
    students.push(member);
    await redis.set(STUDENTS_KEY, students);

    const token = signToken({ role: 'student', sub: member.id, did: deviceId });
    return res.status(200).json({
      ok: true,
      token,
      student: {
        id: member.id,
        name: member.name,
        group: member.group,
        shelfIds: member.shelfIds,
        aiEnabled: member.aiEnabled,
      },
    });
  } catch (err) {
    console.error('join error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error', error: err.message });
  }
}
