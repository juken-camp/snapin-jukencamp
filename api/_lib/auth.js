// /api/_lib/auth.js — SnapIn 認証ユーティリティ
//
// HMAC-SHA256 を使ったシンプルなステートレス token。
// 依存ライブラリ不要 (node:crypto 標準モジュール)。
//
// Token のペイロード:
//   { role, sub, did, iat }
//     role: 'admin' | 'student'
//     sub: 名前(student) or 'admin'(admin)
//     did: deviceId
//     iat: 発行時刻 (ms)
//
// Token の形:
//   base64url(payloadJSON).base64url(hmac)
//
// 検証は HMAC を再計算して一致するか比較するだけ。
// 失効は admin 側で「この生徒の claim を解除」した時に、
// claim 情報が消えるので claim 必須エンドポイントは通らなくなる。
// (token 自体は形式的には valid のままだが、API 側で claim 照合する)

import crypto from 'node:crypto';

const SECRET = process.env.TOKEN_SECRET || '';

if (!SECRET) {
  console.warn('[auth] TOKEN_SECRET is not set. Tokens will not be secure.');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Base64URL ヘルパ
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// HMAC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Token 発行 / 検証
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// payload は plain object。
// 例: signToken({ role:'student', sub:'和田一真', did:'dev_xxx' })
export function signToken(payload) {
  const p = Object.assign({}, payload, { iat: payload.iat || Date.now() });
  const payloadStr = b64url(JSON.stringify(p));
  const sig = b64url(hmac(payloadStr));
  return `${payloadStr}.${sig}`;
}

// 戻り値: { ok:true, payload } | { ok:false, reason }
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'missing' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadStr, sig] = parts;

  // HMAC を再計算して比較 (timing-safe)
  const expected = b64url(hmac(payloadStr));
  if (expected.length !== sig.length) return { ok: false, reason: 'invalid_sig' };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return { ok: false, reason: 'invalid_sig' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadStr).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed_payload' };
  }
  return { ok: true, payload };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 管理者 token 発行 (Kazuma 専用)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// admin パスワードを使って手動で1度だけ発行する。
// 発行後、Kazuma のブラウザの localStorage に token を保存して使う。
export function signAdminToken(deviceId) {
  return signToken({
    role: 'admin',
    sub: 'admin',
    did: deviceId || 'admin-device',
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 名前正規化 (表記ゆれ吸収)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//
// 子供は半角/全角スペースを混ぜたり、カナ/ひらがなを混ぜたりする。
// 「和田一真」「和田 一真」「わだいっしん」「ワダイッシン」 などを
// なるべく同じ key にまとめる。
//
// ただし「漢字 vs ひらがな」は別物扱い (これは admin 側で readings に
// 別表記を登録できるようにして吸収する)。
export function normalizeName(name) {
  if (typeof name !== 'string') return '';
  let s = name;
  // すべての空白(半角/全角/タブ/改行)を除去
  s = s.replace(/[\s\u3000]+/g, '');
  // カタカナ → ひらがな
  s = s.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  // 大文字 → 小文字 (英字)
  s = s.toLowerCase();
  return s;
}

// 誕生日4桁の正規化 (MMDD)
// "1117" "11/17" "11-17" "11月17日" すべて "1117" にする
export function normalizeBirthday(bd) {
  if (typeof bd !== 'string' && typeof bd !== 'number') return '';
  const s = String(bd).replace(/\D/g, ''); // 数字だけ抽出
  if (s.length === 0) return '';
  // 最後の4桁を採用 (年が混ざってても末尾4桁=MMDDを取れる)
  return s.slice(-4).padStart(4, '0');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// リクエストから token を取り出す
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ヘッダ x-snapin-token を見る
export function getTokenFromReq(req) {
  return req.headers['x-snapin-token'] || req.headers['X-Snapin-Token'] || null;
}

// 認可ヘルパ: req から token を取って検証し payload を返す
// 戻り値: { ok:true, payload } | { ok:false, reason }
export function authFromReq(req) {
  const token = getTokenFromReq(req);
  if (!token) return { ok: false, reason: 'missing' };
  return verifyToken(token);
}
