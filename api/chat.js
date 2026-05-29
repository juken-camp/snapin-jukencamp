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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// システムプロンプト (フォールバック用)
// フロント側から system が送られて来なかった場合の保険。
// フロント側 (index.html の callAI) と内容を揃えておく。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const FALLBACK_SYSTEM_PROMPT = [
  'あなたは学習支援のアシスタントです。生徒が保存したメモやノート(写真・テキスト・リスト)について、生徒が理解できるよう丁寧に答えてください。',
  '',
  '【回答の姿勢】',
  '・必要な背景や理由も含めて、しっかり説明してください。短すぎると不親切に感じられます。',
  '・かといって冗長にする必要はありません。質問に対して必要な情報を、過不足なく丁寧に伝えるのが目標です。',
  '・数学・理科などの解説では、考え方の筋道、途中式、用語の意味、なぜそうなるかの理由まで含めて答えてください。',
  '・暗記事項の質問なら、答えだけでなく覚え方のヒントや関連事項も添えると親切です。',
  '・必ず「です・ます調」で話してください。タメ語（「だよ」「だね」「〜じゃん」「〜だ」など）は絶対に使わないでください。',
  '・ただし堅苦しくならず、生徒が話しかけやすい温かみのある言葉遣いを心がけてください。',
  '・説教調や上から目線は避けてください。',
  '',
  '【書式のルール】',
  '・返信はプレーンテキストで書いてください。Markdown 記法 (# 見出し、**強調**、*斜体*、`コード`、- 箇条書きなど) は一切使わないでください。',
  '・箇条書きが必要な時は行頭に「・」を使ってください。',
  '・話題の区切りでは空行(\\n\\n)を入れてください。これは表示側で段落ごとに別の吹き出しに分割するために重要です。',
  '・たとえば「結論」→空行→「理由の説明」→空行→「補足や例」のような構成にしてください。1つの吹き出しは概ね 3〜6 文程度を目安にしてください。',
  '',
  '【避けること】',
  '・「いかがでしたか?」のような閉じの定型文。',
  '・「〜について解説します」「ご質問にお答えします」のような前置き。本題から入ってください。',
].join('\n');

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
        max_tokens: 2048, // 表や長文画像でも切れないように余裕を持たせる
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
    // 3. 長文の解説を求めるキーワードがあれば Sonnet (より自然な日本語と構成力)
    // 4. それ以外は Haiku (安く速く、雑談・確認には十分)
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
      // 推論・計算系のキーワード
      const sonnetKeywords = /計算|解いて|解説|なぜ|理由|証明|求めて|どうして|=|\+|\-|×|÷|公式|証明して|プログラム|コード|微分|積分|方程式|論理|なぜなら|理屈|仕組み/;
      // 長文回答を期待するキーワード (「まとめて」「全部」「最初から最後まで」など)
      const longAnswerKeywords = /まとめて|全部|すべて|一覧|最初から最後|最後まで|くわしく|詳しく|順番に|それぞれ|どんな/;
      if (sonnetKeywords.test(lastText) || longAnswerKeywords.test(lastText)) {
        model = 'claude-sonnet-4-6';
      } else {
        model = 'claude-haiku-4-5-20251001';
      }
    }

    // max_tokens: 旧 1024 だと長い解説で途中で切れていた (例: 教科書15項目を順に解説)。
    // Haiku 4.5 / Sonnet 4.6 はいずれも 64K 出力に対応しているので、4096 まで余裕を持って許容する。
    // コスト面では、画像入力1リクエストあたり総額の差は数円以下なので影響は軽微。
    const result = await client.messages.create({
      model,
      max_tokens: 4096,
      system: system || FALLBACK_SYSTEM_PROMPT,
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

    // stop_reason が max_tokens の場合は念のためログを残す (Vercel 側で気づけるように)
    if (result.stop_reason === 'max_tokens') {
      console.warn('AI response was cut by max_tokens limit. Consider raising max_tokens further.');
    }

    return res.status(200).json({
      content: text,
      // デバッグ用 (フロントには使わないが、必要に応じて参照できる)
      stop_reason: result.stop_reason,
    });
  } catch (err) {
    console.error('AI error:', err);
    return res.status(500).json({
      error: err.message || 'Internal server error',
    });
  }
}
