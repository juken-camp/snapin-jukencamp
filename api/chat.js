// /api/chat.js — Vercel Serverless Function
//
// SnapIn の AI 機能を Anthropic API に接続するエンドポイント。
//
// 認証:
//   - リクエストヘッダ x-snapin-token が必須
//   - 生徒token: 該当生徒が aiEnabled なら通る、claim 解除されてたら弾く
//   - 管理者token: 常に通る
//
// 例外: 英語ミラーの「翻訳モード」(body.mode === 'translate') だけは
//   ログイン不要で叩ける。認可の前に処理し、端末/IPごとの1日上限＋共有キャッシュを適用する。
//   (関数を増やさないため、専用の /api/translate を作らずここに相乗りさせている)

import Anthropic from '@anthropic-ai/sdk';
import { Redis } from '@upstash/redis';
import crypto from 'crypto';
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Snapin-Token, X-Snapin-Dev');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 英語ミラー: 翻訳モード (ログイン不要)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const TRANSLATE_SYSTEM =
  "You are a silent translation layer inside a note-taking app. " +
  "Translate the user's Japanese into natural, clear English that a Japanese student can read and learn from. " +
  "Stay faithful and keep it simple. " +
  "Output ONLY the English translation — no quotes, no notes, no labels, no preamble. " +
  "If the input contains no Japanese, output it unchanged.";

// 英→日 (翻訳機モード): 英語のみのメモを日本語に訳して、字幕として下にそっと出す。
const TRANSLATE_SYSTEM_EN2JA =
  "You are a silent translation layer inside a Japanese note-taking app. " +
  "Translate the user's English into natural, clear Japanese that a Japanese student can read and learn from. " +
  "If the input is a single word, give its common Japanese meaning(s) concisely (you may list a few core meanings separated by 、). " +
  "If it is a phrase or sentence, translate it naturally. " +
  "Stay faithful and keep it simple. " +
  "Output ONLY the Japanese translation — no quotes, no notes, no labels, no romaji, no preamble. " +
  "If the input contains no English, output it unchanged.";

// 英検レベル別の英文難易度ガイド (日→英の字幕にだけ付与)。文法・文長・表現を級に合わせ、必要な専門語は残す。
function eikenGuidance(level) {
  switch (level) {
    case '5':
      return ' Write at about Eiken grade 5 (Japanese first-year junior high): use only very basic grammar (simple present and past, be-verbs) and very common words, in short sentences. Avoid the perfect tenses, the passive voice, relative clauses, and idioms. You may keep essential topic-specific terms.';
    case '4':
      return ' Write at about Eiken grade 4 (Japanese second-year junior high): use basic grammar (present, past, future, simple comparatives, basic conjunctions) in short sentences. Avoid the perfect tenses, the passive voice, and complex relative clauses where you can.';
    case '3':
      return ' Write at about Eiken grade 3 (Japanese junior-high graduate): you may use the present perfect, the passive voice, relative pronouns, and infinitives/gerunds, but keep them simple and the sentences fairly short, with common everyday vocabulary. Keep essential topic-specific terms.';
    case 'pre2':
    default:
      return ' Write at about Eiken grade pre-2 (Japanese first-to-second-year high school): natural, clear English of moderate complexity, kept readable. Avoid unnecessarily advanced or literary phrasing.';
  }
}

// すべて環境変数で上書き可能 (Vercel の Settings → Environment Variables)
const TR_MODEL     = process.env.TRANSLATE_MODEL || 'claude-haiku-4-5-20251001';
const TR_MAX_CHARS = parseInt(process.env.TR_MAX_CHARS || '1500', 10); // 1行が長すぎる入力は翻訳しない
const TR_DEV_DAILY = parseInt(process.env.TR_ANON_DAILY || '150', 10); // 端末ごと 1日の翻訳回数上限
const TR_IP_DAILY  = parseInt(process.env.TR_IP_DAILY  || '5000', 10); // IPごと 1日の翻訳回数上限 (学校の共有wifi想定で高め)
const TR_CACHE_TTL = 60 * 60 * 24 * 30; // 共有キャッシュ 30日
const TR_CNT_TTL   = 60 * 60 * 48;      // カウンタ 48時間で自動消滅

function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').toString();
  if (xff) return xff.split(',')[0].trim();
  return (req.headers['x-real-ip'] || 'unknown').toString();
}
function todayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
}
function sha1(s) {
  return crypto.createHash('sha1').update(s).digest('hex');
}

// 翻訳モードの本体。失敗してもメモ体験を止めないため、原則 200 で空文字を返す。
// 上限到達のときだけ 429 を返す (フロントは 429 を見ても黙って何も出さない)。
async function handleTranslate(req, res, body) {
  try {
    const text = (body.text || '').toString().trim();
    if (!text) return res.status(200).json({ translation: '' });
    if (text.length > TR_MAX_CHARS) return res.status(200).json({ translation: '' });

    // 翻訳の向き: 'en2ja'(英語→日本語) なら英→日プロンプト。既定は ja2en(日本語→英語)。
    const dir = (body.dir === 'en2ja') ? 'en2ja' : 'ja2en';
    // 英検レベル(日→英のみ)。'5'|'4'|'3'|'pre2'、不正値は準2級。
    const level = (['5', '4', '3', 'pre2'].indexOf((body.level || '').toString()) >= 0) ? body.level.toString() : 'pre2';

    // 1) 共有キャッシュ (ヒットは無料・上限を消費しない)。向きごとにキーを分ける(同じ語でも訳が逆向き)。
    //    日→英は級ごとに別キャッシュ(同じ日本語でも級で英文が変わるため)。
    const cacheKey = (dir === 'en2ja' ? 'jatr:' : ('entr:' + level + ':')) + sha1(text);
    try {
      const hit = await redis.get(cacheKey);
      if (hit != null && hit !== '') {
        return res.status(200).json({ translation: String(hit) });
      }
    } catch (e) { /* キャッシュ障害は無視して続行 */ }

    // 2) レート制限 (端末ごと・IPごと / 1日)
    const day = todayStamp();
    const ip  = clientIp(req);
    const dev = (req.headers['x-snapin-dev'] || '').toString() || ('ip:' + ip);
    try {
      const dKey = 'trd:' + day + ':' + dev;
      const iKey = 'tri:' + day + ':' + ip;
      const dN = await redis.incr(dKey); if (dN === 1) await redis.expire(dKey, TR_CNT_TTL);
      const iN = await redis.incr(iKey); if (iN === 1) await redis.expire(iKey, TR_CNT_TTL);
      if (dN > TR_DEV_DAILY || iN > TR_IP_DAILY) {
        return res.status(429).json({ error: 'rate_limited' });
      }
    } catch (e) { /* カウンタ障害時は通す (体験優先) */ }

    // 3) 翻訳 (Haiku)
    const result = await client.messages.create({
      model: TR_MODEL,
      max_tokens: 1024,
      temperature: 0, // 翻訳は決定的に。同じ日本語＋同じ級なら、作り直しても必ず同じ英文になる(覚えた英文がブレない)。
      system: dir === 'en2ja' ? TRANSLATE_SYSTEM_EN2JA : (TRANSLATE_SYSTEM + eikenGuidance(level)),
      messages: [{ role: 'user', content: text }],
    });
    let en = result.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    en = en.replace(/^["「『]+/, '').replace(/["」』]+$/, '').trim();

    // 4) キャッシュ保存 (空でなければ)
    if (en) {
      try { await redis.set(cacheKey, en, { ex: TR_CACHE_TTL }); } catch (e) {}
    }

    return res.status(200).json({ translation: en });
  } catch (err) {
    console.error('translate error:', err);
    return res.status(200).json({ translation: '' }); // 失敗してもメモ体験は止めない
  }
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

  // body を先に読む (翻訳モードの判定を認可より前に行うため)
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    body = {};
  }

  // ─── 英語ミラー: 翻訳モード (ログイン不要・端末/IPごとに1日上限・共有キャッシュ) ───
  // ※ 認可より前に処理する。先生機能(チャット/OCR)は従来どおりログイン必須のまま。
  if (body && body.mode === 'translate') {
    return handleTranslate(req, res, body);
  }

  // 認可 (ここから先はログイン必須)
  const authResult = await authorize(req);
  if (!authResult.ok) {
    return res.status(authResult.status).json({ error: 'Unauthorized', reason: authResult.reason });
  }

  try {
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
