// /api/claim.js — SnapIn 塾生 claim エンドポイント
//
// 生徒が フルネーム + 誕生日4桁 を入力 → 名簿照合 → token 発行
//
// リクエスト:
//   POST /api/claim
//   body: { name, birthday, deviceId }
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
//   claimedBy が違う deviceId なら → 'already_claimed' で拒否
//   (機種変は admin で claim 解除して対応)

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
    const { name, birthday, deviceId } = body;

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
    const student = students.find(s => {
      if (!s) return false;
      const sName = normalizeName(s.name || '');
      const sKey = normalizeName(s.nameKey || '');
      const matchName = (inputName === sName) || (sKey && inputName === sKey);
      const matchBd = normalizeBirthday(s.birthday || '') === inputBd;
      return matchName && matchBd;
    });

    if (!student) {
      return res.status(200).json({ ok: false, reason: 'not_found' });
    }

    if (student.revoked) {
      return res.status(200).json({ ok: false, reason: 'revoked' });
    }

    // claim 判定
    if (student.claimedBy && student.claimedBy !== deviceId) {
      return res.status(200).json({ ok: false, reason: 'already_claimed' });
    }

    // claim 成立 (初めて or 同じ端末からの再認証)
    if (!student.claimedBy) {
      student.claimedBy = deviceId;
      student.claimedAt = Date.now();
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
