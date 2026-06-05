// /api/shelves-read.js — SnapIn 公式棚の読み取り専用エンドポイント (Edge Runtime)
//
// index.html の loadOfficialShelves() が共有ページを開くたびに叩く GET 専用版。
// Edge Runtime で動かすことでコールドスタートをほぼ 0 にし、共有ページを開いた
// 瞬間に最新のライブラリ名が出る（キャッシュ名 → 最新名 の差し替え窓を極小化する）。
//
// 書き込み (POST / DELETE) と管理者処理は従来どおり Node 版 /api/shelves.js が担当する。
// 管理画面からの画像つき投稿は Edge のボディ上限・メモリに収まらない可能性があるため、
// あえて「読み取りだけ」を Edge に分離している。
//
// データのキー設計は /api/shelves.js と完全に同一:
//   snapin:shelf-ids   → ライブラリ ID の配列（軽量）
//   snapin:shelf:{id}  → 各ライブラリのデータ（画像込み、個別保存）

import { Redis } from '@upstash/redis';

export const config = { runtime: 'edge' };

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const IDS_KEY = 'snapin:shelf-ids';
const shelfKey = (id) => `snapin:shelf:${id}`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...CORS,
    },
  });
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: CORS });
  }
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    let ids = (await redis.get(IDS_KEY)) || [];

    // 旧データ (snapin:shelves) との後方互換: IDリストが空なら旧キーから移行。
    // Node 版 /api/shelves.js と同じ挙動を維持しておく（通常はすでに移行済みで通らない）。
    if (ids.length === 0) {
      const legacy = (await redis.get('snapin:shelves')) || [];
      if (legacy.length > 0) {
        ids = legacy.map((s) => s.id).filter(Boolean);
        await redis.set(IDS_KEY, ids);
        for (const shelf of legacy) {
          if (shelf.id) await redis.set(shelfKey(shelf.id), shelf);
        }
        return json({ shelves: legacy });
      }
    }

    if (ids.length === 0) {
      return json({ shelves: [] });
    }

    // 各ライブラリを並列取得
    const results = await Promise.all(ids.map((id) => redis.get(shelfKey(id))));
    const shelves = results.filter(Boolean);

    return json({ shelves });
  } catch (err) {
    return json({ error: String((err && err.message) || err), shelves: [] }, 500);
  }
}
