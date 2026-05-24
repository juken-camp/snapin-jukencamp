// /api/chat.js — Vercel Serverless Function
//
// SnapIn の AI 機能を Anthropic API に接続するエンドポイント。
//
// セットアップ:
//   1. このファイルを /api/chat.js に配置
//   2. package.json に @anthropic-ai/sdk を追加: npm install @anthropic-ai/sdk
//   3. Vercel の環境変数に ANTHROPIC_API_KEY を設定
//   4. デプロイ後、index.html の AI_ENDPOINT は '/api/chat' のままでOK

import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// CORS (同一オリジンなら不要だが、念のため)
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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

    const result = await client.messages.create({
      model: 'claude-sonnet-4-6', // 通常チャットはSonnetでバランス
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
