// /api/photo.js — Vercel Serverless Function
//
// SnapIn の写真クラウド保存。写真の実データ(画像)を Cloudflare R2 に
// ユーザーごと・カードごとに保存し、別端末や再インストール後に復元できるようにする。
//
// テキスト・メモは /api/sync.js (Redis) に、写真の実データだけをこちら (R2) に置く。
//
// 認証: x-snapin-token が必須 (chat.js / sync.js と同じ)。有効な塾生/管理者のみ。
//
// 必要な環境変数 (Vercel に設定):
//   R2_ACCOUNT_ID        … Cloudflare アカウントID
//   R2_ACCESS_KEY_ID     … R2 の S3互換 アクセスキーID
//   R2_SECRET_ACCESS_KEY … R2 の S3互換 シークレット
//   R2_BUCKET            … バケット名
//
// 依存: @aws-sdk/client-s3 (package.json に追加し npm install してください)

import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Redis } from '@upstash/redis';
import { authFromReq } from './_lib/auth.js';

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';
const BUCKET = process.env.R2_BUCKET;
const MAX_BYTES = 8 * 1024 * 1024; // 1枚あたり最大8MB(デコード後)

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  // 新しめの @aws-sdk は自動で checksum ヘッダ(x-amz-checksum-*)を付けるが、
  // R2 の署名付きURL(PUT)ではこれが原因で SignatureDoesNotMatch になることがある。
  // 必要なときだけ計算する設定にして、署名付きアップロードを安定させる。
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token, X-Admin-Password');
}

// chat.js / sync.js と同じ認可チェック
async function authorize(req) {
  const auth = authFromReq(req);
  if (!auth.ok) return { ok: false, reason: 'invalid_token', status: 401 };
  const payload = auth.payload;
  if (payload.role === 'admin') return { ok: true, payload };
  if (payload.role === 'student') {
    const students = (await redis.get(STUDENTS_KEY)) || [];
    const student = students.find(s => s && s.id === payload.sub);
    if (!student) return { ok: false, reason: 'student_not_found', status: 403 };
    if (student.revoked) return { ok: false, reason: 'revoked', status: 403 };
    if (student.claimedBy !== payload.did) return { ok: false, reason: 'claim_lost', status: 403 };
    return { ok: true, payload, student };
  }
  return { ok: false, reason: 'unknown_role', status: 401 };
}

function userId(payload) {
  return payload.role === 'admin' ? ('admin:' + (payload.sub || 'root')) : payload.sub;
}

// カードIDを安全なキー片に (英数・ハイフン・アンダースコアのみ)
function safeId(s) {
  return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
}

function photoKey(payload, cardId) {
  return `photos/${safeId(userId(payload))}/${safeId(cardId)}`;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json' });
  }
  const action = body.action;

  // ─── 共有ライブラリの写真 (管理者専用 / R2のグローバル領域 + 公開URLで配信) ───
  // shelves.js と同じ x-admin-password 認証。写真は shelfphotos/ に置き、公開URL(R2_PUBLIC_URL)で
  // 全生徒が直接読む。棚データにはこの公開URLだけを保存するので、棚の保存が軽くなる(413の根本対策)。
  if (action === 'shelf-put' || action === 'shelf-delete') {
    const pass = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      if (action === 'shelf-put') {
        const m = /^data:([^;]+);base64,(.+)$/.exec(body.dataUrl || '');
        if (!m) return res.status(400).json({ error: 'invalid_dataurl' });
        const buf = Buffer.from(m[2], 'base64');
        if (buf.length > MAX_BYTES) {
          return res.status(413).json({ error: 'too_large', size: buf.length, max: MAX_BYTES });
        }
        const photoId = safeId(body.photoId) || (Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
        const ShelfKey = `shelfphotos/${photoId}`;
        await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: ShelfKey, Body: buf, ContentType: m[1] }));
        const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
        return res.status(200).json({ ok: true, photoId, key: ShelfKey, url: base ? `${base}/${ShelfKey}` : null });
      }
      // shelf-delete: photoId か url から後始末 (任意)
      const pid = safeId(body.photoId || (body.url ? String(body.url).split('/').pop() : ''));
      if (pid) { try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: `shelfphotos/${pid}` })); } catch (e) {} }
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('shelf photo error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  }

  // ─── 共有ライブラリの大きいファイル(動画など)用: 署名付きPUT URLを発行 (管理者専用) ───
  // base64でJSONに載せると Vercel関数のボディ上限(約4.5MB)に当たるため、ブラウザから
  // R2 へ直接アップロードできる一時URLを返す。保存先キーと公開URLも併せて返す。
  // ※ R2バケットに PUT を許可する CORS 設定が必要 (下記返り値の uploadUrl の取得後に効く)。
  if (action === 'shelf-put-url') {
    const pass = req.headers['x-admin-password'];
    if (!process.env.ADMIN_PASSWORD || pass !== process.env.ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
      const contentType = String(body.contentType || 'application/octet-stream');
      const photoId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      const ShelfKey = `shelfphotos/${photoId}`;
      // 署名時の ContentType と、クライアントが PUT 時に送る Content-Type は一致させること。
      const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: ShelfKey, ContentType: contentType });
      const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 600 }); // 10分有効
      const base = (process.env.R2_PUBLIC_URL || '').replace(/\/+$/, '');
      return res.status(200).json({
        ok: true,
        photoId,
        key: ShelfKey,
        uploadUrl,
        url: base ? `${base}/${ShelfKey}` : null,
      });
    } catch (err) {
      console.error('shelf put-url error:', err);
      return res.status(500).json({ error: err.message || 'Internal server error' });
    }
  }

  // ─── 従来: ユーザーごとの写真 (x-snapin-token 認証) ───
  const authResult = await authorize(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: 'Unauthorized', reason: authResult.reason });
  }

  const cardId = body.cardId;
  if (!cardId) return res.status(400).json({ error: 'cardId required' });
  const Key = photoKey(authResult.payload, cardId);

  try {
    // ─── アップロード: dataURL を R2 にバイナリ保存 ───
    if (action === 'put') {
      const m = /^data:([^;]+);base64,(.+)$/.exec(body.dataUrl || '');
      if (!m) return res.status(400).json({ error: 'invalid_dataurl' });
      const contentType = m[1];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > MAX_BYTES) {
        return res.status(413).json({ error: 'too_large', size: buf.length, max: MAX_BYTES });
      }
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET, Key, Body: buf, ContentType: contentType,
      }));
      return res.status(200).json({ ok: true });
    }

    // ─── ダウンロード: R2 から取り出して dataURL で返す (無ければ null) ───
    if (action === 'get') {
      try {
        const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
        const bytes = await obj.Body.transformToByteArray();
        const b64 = Buffer.from(bytes).toString('base64');
        const type = obj.ContentType || 'image/jpeg';
        return res.status(200).json({ ok: true, dataUrl: `data:${type};base64,${b64}` });
      } catch (e) {
        // NoSuchKey など → まだ無い
        return res.status(200).json({ ok: true, dataUrl: null });
      }
    }

    // ─── 削除 (任意) ───
    if (action === 'delete') {
      try { await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key })); } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'unknown_action' });
  } catch (err) {
    console.error('photo error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
