// api/translate.js — 英語ミラー用の翻訳エンドポイント
// ・未ログインでも使える。安いモデル(Haiku)専用。賢い対話 /api/chat とは別物。
//   開放するのは「翻訳だけ」で、「先生機能(/api/chat)」はログイン必須のまま据え置く。
// ・Upstash で「端末ごと」「IPごと」の1日上限を数え、悪用とコスト暴走を防ぐ(見えない安全装置)。
// ・同じ日本語は Redis に共有キャッシュ → 2回目以降は無料・即時(全ユーザー横断)。
//
// 置き場所: あなたの Vercel プロジェクトの api/translate.js
//
// 必要な環境変数:
//   ANTHROPIC_API_KEY          … Anthropic APIキー
//   UPSTASH_REDIS_REST_URL     … Upstash(公式ライブラリ用と同じでOK)
//   UPSTASH_REDIS_REST_TOKEN
//   (任意) TRANSLATE_MODEL, TR_ANON_DAILY, TR_USER_DAILY, TR_IP_DAILY

import { Redis } from '@upstash/redis';
import crypto from 'crypto';

// ── 調整ノブ(環境変数で上書き可。コード変更なしで緩め/締められる) ──
const MODEL      = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5'; // 使えるHaiku系に合わせる(ダメなら exact 文字列を env で指定)
const ANON_DAILY = Number(process.env.TR_ANON_DAILY) || 40;   // 未ログイン: 1端末あたり / 24h
const USER_DAILY = Number(process.env.TR_USER_DAILY) || 500;  // ログイン  : 1端末あたり / 24h
const IP_DAILY   = Number(process.env.TR_IP_DAILY)   || 2000; // IPごとの安全ネット(学校の共有wifiも考慮して高め)
const MAX_CHARS  = 1000;                 // 1回に送れる文字数の上限(長文一発の大量消費を防ぐ)
const CACHE_TTL  = 60 * 60 * 24 * 30;    // 共有キャッシュ保持: 30日
const WINDOW     = 60 * 60 * 24;         // 上限のリセット: 24h(ローリング)

const SYS = "You are a silent translation layer inside a note-taking app. Translate the user's Japanese into natural, clear English that a Japanese student can read and learn from. Stay faithful and keep it simple. Output ONLY the English translation — no quotes, no notes, no labels, no preamble. If the input contains no Japanese, output it unchanged.";

let redis = null;
try { redis = Redis.fromEnv(); } catch (e) { redis = null; }

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return req.headers['x-real-ip'] || 'noip';
}
function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }

// INCR + 初回だけ EXPIRE。上限内なら true。Redis不調時は通す(機能優先)。
// ※コスト保護を最優先にしたいなら、catch と「redisなし」を return false に変える。
async function underLimit(key, limit) {
  if (!redis) return true;
  try {
    const n = await redis.incr(key);
    if (n === 1) await redis.expire(key, WINDOW);
    return n <= limit;
  } catch (e) { return true; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method' }); return; }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    let text = (body.text || '').toString().trim();
    if (!text) { res.status(400).json({ error: 'empty' }); return; }
    if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS);

    // 1) 共有キャッシュ(同じ日本語は翻訳しない / 上限も消費しない)
    const cacheKey = 'entr:' + sha1(text);
    if (redis) {
      try {
        const hit = await redis.get(cacheKey);
        if (hit) { res.status(200).json({ translation: hit, cached: true }); return; }
      } catch (e) { /* キャッシュ読み失敗は無視して続行 */ }
    }

    // 2) 1日上限(端末ごと + IPごとの安全ネット)
    const ip    = clientIp(req);
    const dev   = (req.headers['x-snapin-dev'] || '').toString().slice(0, 64) || ip;
    const token = (req.headers['x-snapin-token'] || '').toString();
    // ※トークンは厳密検証していない(偽装してもIP上限で頭打ちなのでコストは守られる)。
    //   厳密にするなら、ここで /api/chat と同じ方式でトークンを検証して tier を決める。
    const perDevice = token ? USER_DAILY : ANON_DAILY;
    const okDev = await underLimit('trd:' + dev, perDevice);
    const okIp  = await underLimit('tri:' + ip, IP_DAILY);
    if (!okDev || !okIp) { res.status(429).json({ error: 'rate_limited' }); return; }

    // 3) 翻訳(Haiku)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) { res.status(500).json({ error: 'no_key' }); return; }
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYS,
        messages: [{ role: 'user', content: text }],
      }),
    });
    if (!aiRes.ok) { res.status(502).json({ error: 'upstream' }); return; }
    const data = await aiRes.json();
    let en = Array.isArray(data.content)
      ? data.content.map(b => (b && b.text ? b.text : '')).join('').trim()
      : '';
    en = en.replace(/^["「『]+/, '').replace(/["」』]+$/, '').trim();
    if (!en) { res.status(502).json({ error: 'empty_out' }); return; }

    // 4) 共有キャッシュに保存(次からは全ユーザーに無料で配れる)
    if (redis) { try { await redis.set(cacheKey, en, { ex: CACHE_TTL }); } catch (e) {} }

    res.status(200).json({ translation: en });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
}
