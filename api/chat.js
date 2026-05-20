// api/chat.js
// SnapIn AIチャットエンドポイント
// - Haiku / Sonnet 自動切り替え
// - aiUsage を Firestore に記録
// - ユーザーの aiEnabled / suspended チェック

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ── Firebase Admin 初期化（Vercel環境変数から読む）──
if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercelの環境変数では改行が\\nになるので置換
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = getFirestore();

// ── Haiku / Sonnet 判定キーワード ──
const SONNET_KEYWORDS = [
  '計算', '数学', '方程式', '関数', '証明', '図形', '積分', '微分',
  '因数分解', '二次方程式', '連立', '三角形', '円', '角度', '体積',
  'なぜ', 'なんで', 'どうして', '詳しく', '詳細', '解説', 'ちゃんと',
  'わかりやすく', 'くわしく', '教えて', '長文', '記述', '論述',
  '物理', '化学', '反応式', '電気', '力学', '電流', '電圧', '磁場',
  '複雑', '難しい', 'むずかしい', '難問', '応用',
];

const HAIKU_MODEL  = 'claude-haiku-4-5-20251001';
const SONNET_MODEL = 'claude-sonnet-4-20250514';

function selectModel(question = '', caption = '') {
  const text = (question + ' ' + caption).toLowerCase();
  return SONNET_KEYWORDS.some(kw => text.includes(kw))
    ? SONNET_MODEL
    : HAIKU_MODEL;
}

// ── コスト試算（USD/トークン）──
const COST = {
  [HAIKU_MODEL]:  { input: 0.80 / 1_000_000, output: 4.00 / 1_000_000 },
  [SONNET_MODEL]: { input: 3.00 / 1_000_000, output: 15.00 / 1_000_000 },
};

function estimateCost(model, inputTokens, outputTokens) {
  const c = COST[model] ?? COST[HAIKU_MODEL];
  return c.input * inputTokens + c.output * outputTokens;
}

// ── aiUsage をFirestoreに書き込む（失敗してもレスポンスは返す）──
async function recordUsage({ uid, postId, model, question, usage }) {
  if (!uid) return; // uidなし（旧クライアント）は記録しない
  try {
    await db.collection('aiUsage').add({
      uid,
      postId:           postId ?? null,
      model,
      question:         (question ?? '').substring(0, 200), // 200文字まで
      inputTokens:      usage?.input_tokens  ?? 0,
      outputTokens:     usage?.output_tokens ?? 0,
      estimatedCostUSD: estimateCost(
        model,
        usage?.input_tokens  ?? 0,
        usage?.output_tokens ?? 0
      ),
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[aiUsage] Firestore write failed:', e.message);
  }
}

// ── ユーザーチェック（停止・AI無効） ──
async function checkUser(uid) {
  if (!uid) return { ok: true }; // uidなし（旧クライアント）はスルー
  try {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return { ok: true }; // ユーザー未登録もスルー
    const data = snap.data();
    if (data.suspended)       return { ok: false, reason: 'アカウントが停止されています。' };
    if (data.aiEnabled === false) return { ok: false, reason: 'AI機能が無効になっています。管理者にお問い合わせください。' };
    return { ok: true };
  } catch (e) {
    console.error('[checkUser] Firestore read failed:', e.message);
    return { ok: true }; // Firestore障害時はブロックしない
  }
}

// ── メインハンドラ ──
export default async function handler(req, res) {
  // CORS（必要なら）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    uid,            // ユーザーID（新クライアントから）
    postId,         // 投稿ID（記録用）
    question,       // 最新の質問テキスト（モデル選択に使う）
    caption,        // 投稿のキャプション（モデル選択補助）
    messages,       // Anthropic形式のメッセージ配列
    system,         // システムプロンプト（任意）
    max_tokens,     // 上限（任意、デフォルト600）
    // 後方互換：旧クライアントはmodelを直接渡してくる場合がある
    model: modelOverride,
  } = req.body ?? {};

  // ユーザー状態チェック
  const userCheck = await checkUser(uid);
  if (!userCheck.ok) {
    return res.status(403).json({ error: userCheck.reason });
  }

  // モデル選択（新クライアント：question/captionから自動判定）
  const model = modelOverride
    ? (modelOverride.includes('sonnet') ? SONNET_MODEL : HAIKU_MODEL) // 旧クライアント互換
    : selectModel(question, caption);

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages is required' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  // Anthropic APIリクエスト
  const body = {
    model,
    max_tokens: max_tokens ?? 600, // デフォルト600でコスト抑制
    messages,
  };
  if (system) body.system = system;

  let anthropicData;
  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':         'application/json',
        'x-api-key':            apiKey,
        'anthropic-version':    '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    anthropicData = await apiRes.json();

    if (!apiRes.ok) {
      console.error('[Anthropic] API error:', anthropicData);
      return res.status(apiRes.status).json({ error: anthropicData });
    }
  } catch (e) {
    console.error('[Anthropic] fetch failed:', e.message);
    return res.status(502).json({ error: 'AI接続エラー。しばらく待ってから試してください。' });
  }

  // aiUsage 記録（非同期・待たない）
  recordUsage({
    uid,
    postId,
    model,
    question,
    usage: anthropicData.usage,
  }).catch(() => {}); // エラーを握りつぶしてレスポンスを優先

  // クライアントに返す（使用モデルも含める）
  return res.status(200).json({
    ...anthropicData,
    _model: model, // どのモデルを使ったかフロントに伝える（デバッグ・表示用）
  });
}
