// /api/chat.js — Vercel Serverless Function
//
// SnapIn の AI 機能を Anthropic API に接続するエンドポイント。
//
// 認証:
//   - リクエストヘッダ x-snapin-token が必須
//   - 生徒token: 該当生徒が aiEnabled なら通る、claim 解除されてたら弾く
//   - 管理者token: 常に通る

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import { authFromReq } from './_lib/auth.js';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

const STUDENTS_KEY = 'snapin:students';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 認可チェック
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 戻り値: { ok:true, payload } | { ok:false, reason, status }
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
    if (!student.aiEnabled) {
      return { ok: false, reason: 'ai_disabled', status: 403 };
    }
    return { ok: true, payload, student };
  }

  return { ok: false, reason: 'unknown_role', status: 401 };
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

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { system, messages, ocrImage } = body || {};

    // OCR モード (画像から文字を読み取る)
    if (ocrImage) {
      const result = await client.messages.create({
        model: 'claude-haiku-4-5-20251001', // OCRは高速・低コストのHaikuで十分
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: ocrImage.mediaType || 'image/jpeg',
                  data: ocrImage.data,
                },
              },
              {
                type: 'text',
                text: 'この画像に写っている文字を、改行や構造を保ったまま日本語/英語のテキストとして書き出してください。前置きや説明は不要です。文字が読み取れない場合は「(文字なし)」とだけ返してください。',
              },
            ],
          },
        ],
      });
      const text = result.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return res.status(200).json({ content: text });
    }

    // 通常チャットモード
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages required' });
    }

    // ─── モデル自動選択 ───
    // 1. 画像が含まれていたら Sonnet (Vision精度重視)
    // 2. 計算・解説系のキーワードがあれば Sonnet (推論力が必要)
    // 3. それ以外は Haiku (安く速く、雑談・確認には十分)
    const hasImage = messages.some(m =>
      Array.isArray(m.content) && m.content.some(c => c && c.type === 'image')
    );
    let model;
    if (hasImage) {
      model = 'claude-sonnet-4-6';
    } else {
      // 最後のユーザーメッセージのテキストを抽出
      const lastUser = [...messages].reverse().find(m => m.role === 'user');
      let lastText = '';
      if (lastUser) {
        if (typeof lastUser.content === 'string') {
          lastText = lastUser.content;
        } else if (Array.isArray(lastUser.content)) {
          lastText = lastUser.content.map(c => (c && c.type === 'text') ? c.text : '').join(' ');
        }
      }
      const sonnetKeywords = /計算|解いて|解説|なぜ|理由|証明|求めて|どうして|=|\+|\-|×|÷|公式|証明して|プログラム|コード|微分|積分|方程式|論理|なぜなら|理屈|仕組み/;
      model = sonnetKeywords.test(lastText) ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
    }

    const result = await client.messages.create({
      model,
      max_tokens: 1024,
      system: system || 'あなたは学習支援のアシスタントです。生徒が保存したメモについて、わかりやすく端的に答えてください。説教はせず、必要な情報を簡潔に伝えます。日本語で答えます。',
      messages: messages.map((m) => ({
        role: m.role || 'user',
        content: m.content || '',
      })),
    });

    const text = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ content: text });
  } catch (err) {
    console.error('AI error:', err);
    return res.status(500).json({
      error: err.message || 'Internal server error',
    });
  }
}
