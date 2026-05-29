// /api/sync.js — Vercel Serverless Function
//
// SnapIn の「クラウドバックアップ」エンドポイント (第一歩)。
// 個人メモ(写真をのぞくテキスト・付帯情報)をユーザーごとに Redis に保存し、
// 別端末や再インストール後でも復元できるようにする。
//
// 認証:
//   - リクエストヘッダ x-snapin-token が必須 (chat.js と同じ仕組み)
//   - 有効な塾生 or 管理者のみ。バックアップはユーザーIDごとに分離保存する。
//
// 注意:
//   - この版では写真(base64画像)はバックアップ対象外 (サイズが大きいため)。
//     写真の同期は Blob ストレージ導入時に対応する。
//   - 1ユーザーあたりのペイロードは MAX_BYTES までに制限する。

import { Redis } from '@upstash/redis';
import { authFromReq } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';
const BACKUP_PREFIX = 'snapin:backup:';
const MAX_BYTES = 900 * 1024; // ~900KB (Upstash/REST の上限に余裕を持たせる)

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 認可チェック (chat.js と同じ。有効な塾生/管理者か)
// 戻り値: { ok:true, payload } | { ok:false, reason, status }
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function authorize(req) {
  const auth = authFromReq(req);
  if (!auth.ok) {
    return { ok: false, reason: 'invalid_token', status: 401 };
  }
  const payload = auth.payload;

  // 管理者は常に通す
  if (payload.role === 'admin') {
    return { ok: true, payload };
  }

  // 生徒: 名簿で現在の状態を確認
  if (payload.role === 'student') {
    const students = (await redis.get(STUDENTS_KEY)) || [];
    const student = students.find(s => s && s.id === payload.sub);
    if (!student) {
      return { ok: false, reason: 'student_not_found', status: 403 };
    }
    if (student.revoked) {
      return { ok: false, reason: 'revoked', status: 403 };
    }
    // claim 解除されていたら token は無効
    if (student.claimedBy !== payload.did) {
      return { ok: false, reason: 'claim_lost', status: 403 };
    }
    return { ok: true, payload, student };
  }

  return { ok: false, reason: 'unknown_role', status: 401 };
}

// ユーザーごとのバックアップキー (データはユーザー間で必ず分離する)
function backupKey(payload) {
  const id = payload.role === 'admin'
    ? ('admin:' + (payload.sub || 'root'))
    : payload.sub;
  return BACKUP_PREFIX + id;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 認可
  const authResult = await authorize(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: 'Unauthorized', reason: authResult.reason });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const key = backupKey(authResult.payload);
  const action = body.action;

  try {
    // ─── 復元: 保存済みバックアップを返す (無ければ null) ───
    if (action === 'pull') {
      const backup = (await redis.get(key)) || null;
      return res.status(200).json({ ok: true, backup });
    }

    // ─── バックアップ: 受け取ったペイロードを保存 ───
    if (action === 'push') {
      const payload = body.payload;
      if (!payload || typeof payload !== 'object') {
        return res.status(400).json({ error: 'payload required' });
      }
      // サイズガード (写真以外のメモ量が極端に多い場合に弾く)
      const size = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      if (size > MAX_BYTES) {
        return res.status(413).json({
          error: 'too_large',
          size,
          max: MAX_BYTES,
          message: 'バックアップが大きすぎます。',
        });
      }
      const record = {
        payload,
        savedAt: Date.now(),
        // クライアントの保存時刻も控える (将来の双方向同期での新旧判定の参考)
        clientSavedAt: typeof body.savedAt === 'number' ? body.savedAt : null,
        v: 1,
      };
      await redis.set(key, record);
      return res.status(200).json({ ok: true, savedAt: record.savedAt, size });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    console.error('sync error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
