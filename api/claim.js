// /api/claim.js — SnapIn 塾生 claim エンドポイント
//
// 生徒が フルネーム + 誕生日4桁 を入力 → 名簿照合 → token 発行
//
// リクエスト:
//   POST /api/claim
//   body: { name, birthday, deviceId, force? }
//
// レスポンス (成功):
//   { ok:true, token, student:{ name, group, shelfIds, aiEnabled } }
//
// レスポンス (失敗):
//   { ok:false, reason: 'not_found' | 'already_claimed' | 'revoked' }
//
// 1人1端末のロジック:
//   名簿の claimedBy が null なら → claim 成立、deviceId を記録
//   claimedBy が同じ deviceId なら → そのまま token 再発行 (再ログイン用)
//   claimedBy が違う deviceId + force=true なら → 名前+誕生日が合っているので
//     deviceId を上書きして claim を成立させる (機種変・PWA再インストール対応)
//   claimedBy が違う deviceId + force なし なら → 'already_claimed' で拒否

import { Redis } from '@upstash/redis';
import { signToken, normalizeName, normalizeBirthday } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const KEY = 'snapin:students';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { name, birthday, deviceId, force } = body;

    if (!name || !birthday || !deviceId) {
      return res.status(400).json({ ok: false, reason: 'bad_request' });
    }

    const inputName = normalizeName(name);
    const inputBd = normalizeBirthday(birthday);

    if (!inputName || !inputBd || inputBd.length !== 4) {
      return res.status(400).json({ ok: false, reason: 'bad_request' });
    }

    const students = (await redis.get(KEY)) || [];

    // 名前+誕生日で照合
    // 名前は normalizeName で正規化して比較
    // (admin 側で nameKey にひらがな読みも入れておけば、漢字/かなどっちでも通る)
    const studentIdx = students.findIndex(s => {
      if (!s) return false;
      const sName = normalizeName(s.name || '');
      const sKey = normalizeName(s.nameKey || '');
      const matchName = (inputName === sName) || (sKey && inputName === sKey);
      const matchBd = normalizeBirthday(s.birthday || '') === inputBd;
      return matchName && matchBd;
    });

    if (studentIdx < 0) {
      return res.status(200).json({ ok: false, reason: 'not_found' });
    }

    const student = students[studentIdx];

    if (student.revoked) {
      return res.status(200).json({ ok: false, reason: 'revoked' });
    }

    // claim 判定
    //   - 未紐付け                      → claim 成立、deviceId 記録
    //   - 同じ deviceId                 → そのまま token 再発行
    //   - 別 deviceId + force=true      → 名前+誕生日が合っているので上書き (機種変対応)
    //   - 別 deviceId + force なし      → already_claimed で拒否
    const isSameDevice = student.claimedBy === deviceId;
    const isUnclaimed  = !student.claimedBy;
    const isOverride   = student.claimedBy && student.claimedBy !== deviceId && force === true;

    if (student.claimedBy && !isSameDevice && !isOverride) {
      return res.status(200).json({ ok: false, reason: 'already_claimed' });
    }

    // claim 成立: 未紐付け or 上書きの場合は deviceId を更新して保存
    if (isUnclaimed || isOverride) {
      student.claimedBy = deviceId;
      student.claimedAt = Date.now();
      if (isOverride) {
        // 上書きの履歴を残しておく (admin での確認用)
        student.lastOverrideAt = Date.now();
      }
      students[studentIdx] = student;
      await redis.set(KEY, students);
    }

    // token 発行
    const token = signToken({
      role: 'student',
      sub: student.id,
      did: deviceId,
    });

    return res.status(200).json({
      ok: true,
      token,
      student: {
        id: student.id,
        name: student.name,
        group: student.group || '',
        shelfIds: Array.isArray(student.shelfIds) ? student.shelfIds : [],
        aiEnabled: student.aiEnabled !== false,
      },
    });
  } catch (err) {
    console.error('claim error:', err);
    return res.status(500).json({ ok: false, reason: 'server_error', error: err.message });
  }
}
