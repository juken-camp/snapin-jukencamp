// /api/og-fetch.js — Vercel Serverless Function
//
// URL を受け取って、ページの <meta og:*> や <title> を抽出して返す。
// SnapIn の「URLメモ」機能で使う。CORS 回避のためサーバ経由で取得する。
//
// リクエスト: POST /api/og-fetch
//   body: { url: "https://example.com/article" }
// レスポンス:
//   200 { ok:true, url, finalUrl, title, description, image, siteName, host, warning? }
//   400 { ok:false, error:"..." }
//   429 { ok:false, error:"rate limit" }
//
// 認証は付けない (URL を貼るだけの軽量API。レート制限のみで防御)。

// --- 簡易レート制限 (Vercel の関数インスタンスがホットなら有効) ---
const RATE_WINDOW_MS = 60_000;    // 1分間で
const RATE_LIMIT     = 30;        // 同一IPあたり30回まで
const _rateBuckets = new Map();   // ip -> { count, resetAt }

function rateLimit(ip) {
  const now = Date.now();
  let b = _rateBuckets.get(ip);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _rateBuckets.set(ip, b);
  }
  b.count++;
  return b.count <= RATE_LIMIT;
}

// --- URL バリデーション & SSRF 対策 ---
// プライベートIP・loopback・linkLocal を弾く (DNSリバインディング全対策ではないが、
// 一般的な踏み台用途を防ぐ基本ガード)
function isAllowedUrl(u) {
  let parsed;
  try { parsed = new URL(u); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  // ホスト名がIPアドレスの場合: プライベート/ループバックは拒否
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 10) return false;
    if (a === 127) return false;
    if (a === 0) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  // localhost / 内部ドメインっぽいものは弾く
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  return true;
}

// HTML から <meta og:*> / <title> / <link rel="icon"> を取り出す。
// 簡易正規表現ベース。本格的なパーサ (cheerio) を入れる必要はない用途。
function extractMeta(html, baseUrl) {
  const out = {};

  // <title>
  const mTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (mTitle) out.titleTag = decodeEntities(mTitle[1].trim()).slice(0, 300);

  // meta タグを全部拾う
  const metaRe = /<meta\b([^>]*)>/gi;
  let m;
  const metas = [];
  while ((m = metaRe.exec(html)) !== null) {
    const attrs = parseAttrs(m[1]);
    metas.push(attrs);
  }
  for (const a of metas) {
    const name = (a.property || a.name || '').toLowerCase();
    const content = a.content;
    if (!name || !content) continue;
    if (name === 'og:title') out.ogTitle = decodeEntities(content).slice(0, 300);
    else if (name === 'og:description') out.ogDescription = decodeEntities(content).slice(0, 600);
    else if (name === 'og:image') out.ogImage = resolveUrl(content, baseUrl);
    else if (name === 'og:site_name') out.ogSiteName = decodeEntities(content).slice(0, 200);
    else if (name === 'og:url') out.ogUrl = content;
    else if (name === 'twitter:title' && !out.ogTitle) out.ogTitle = decodeEntities(content).slice(0, 300);
    else if (name === 'twitter:description' && !out.ogDescription) out.ogDescription = decodeEntities(content).slice(0, 600);
    else if (name === 'twitter:image' && !out.ogImage) out.ogImage = resolveUrl(content, baseUrl);
    else if (name === 'description' && !out.ogDescription) out.ogDescription = decodeEntities(content).slice(0, 600);
  }

  // <link rel="icon"> / "apple-touch-icon"
  const linkRe = /<link\b([^>]*)>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const a = parseAttrs(m[1]);
    const rel = (a.rel || '').toLowerCase();
    if (!a.href) continue;
    if (/apple-touch-icon/.test(rel) && !out.appleIcon) out.appleIcon = resolveUrl(a.href, baseUrl);
    else if ((rel === 'icon' || rel === 'shortcut icon') && !out.icon) out.icon = resolveUrl(a.href, baseUrl);
  }

  return out;
}

function parseAttrs(s) {
  // 属性 key="value" / key='value' / key=value を雑に拾う
  const out = {};
  const re = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toLowerCase()] = (m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
  }
  return out;
}

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function resolveUrl(href, baseUrl) {
  try { return new URL(href, baseUrl).toString(); }
  catch { return null; }
}

function hostOf(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

// --- メイン ---
export default async function handler(req, res) {
  // CORS (同一オリジンなら不要だが、念のため明示)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-snapin-token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  // レート制限
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!rateLimit(ip)) {
    res.status(429).json({ ok: false, error: 'rate limit' });
    return;
  }

  // body 取得 (Vercel は通常 JSON を自動パースするが、念のため両対応)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  if (!body || typeof body !== 'object') body = {};
  let url = String(body.url || '').trim();
  if (!url) { res.status(400).json({ ok: false, error: 'url required' }); return; }
  // スキーマ省略時は https を補う
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (!isAllowedUrl(url)) {
    res.status(400).json({ ok: false, error: 'url not allowed' });
    return;
  }

  // ── YouTube は専用処理 (oEmbed / Data API) で正確なタイトル+サムネを取る ──
  const yt = await tryYouTube(url);
  if (yt) { res.status(200).json(yt); return; }

  // タイムアウト付き fetch
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8秒タイムアウト

  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // 一般的なブラウザを装う (一部サイトはbot UAを弾くため)
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.8',
      },
    });
    clearTimeout(timer);

    const finalUrl = r.url || url;
    const host = hostOf(finalUrl);
    const ctype = r.headers.get('content-type') || '';

    // HTTP エラーでも 200 で返す (フロントで「URLは保存できるが情報取れず」扱いにする)
    if (!r.ok) {
      console.warn('og-fetch HTTP error', r.status, url);
      res.status(200).json({
        ok: true,
        url, finalUrl,
        title: host, description: '', image: null,
        siteName: host, host,
        warning: 'HTTP ' + r.status,
      });
      return;
    }

    // 非HTML (画像/PDFなど): URLは保存できるが情報なしで返す
    if (!/text\/html|application\/xhtml/i.test(ctype)) {
      const fileName = decodeURIComponent((finalUrl.split('/').pop() || '').split('?')[0] || host);
      res.status(200).json({
        ok: true,
        url, finalUrl,
        title: fileName || host,
        description: '', image: null,
        siteName: host, host,
        warning: 'non-html: ' + ctype,
      });
      return;
    }

    // HTML 本文を取得 (容量制限: 先頭 512KB だけ読む。OGP は head に集中するので十分)
    const reader = r.body.getReader();
    let received = 0;
    const MAX_BYTES = 512 * 1024;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (received >= MAX_BYTES) {
        try { reader.cancel(); } catch (_) {}
        break;
      }
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));

    // charset 推定 (header → meta → default utf-8)
    let charset = 'utf-8';
    const ctMatch = /charset=([^;\s]+)/i.exec(ctype);
    if (ctMatch) charset = ctMatch[1].toLowerCase();
    // まず utf-8 として読み、meta charset を見つけたら再デコード
    let html = buf.toString('utf-8');
    const metaCharset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(html);
    if (metaCharset) {
      const cs = metaCharset[1].toLowerCase();
      if (cs !== charset && (cs === 'shift_jis' || cs === 'shift-jis' || cs === 'euc-jp' || cs === 'iso-2022-jp')) {
        try {
          html = new TextDecoder(cs).decode(buf);
        } catch (_) { /* utf-8 のまま */ }
      }
    }

    const meta = extractMeta(html, finalUrl);
    res.status(200).json({
      ok: true,
      url, finalUrl,
      title: meta.ogTitle || meta.titleTag || host || '',
      description: meta.ogDescription || '',
      image: meta.ogImage || meta.appleIcon || meta.icon || null,
      siteName: meta.ogSiteName || host || '',
      host,
    });

  } catch (e) {
    clearTimeout(timer);
    console.error('og-fetch error', url, e && e.message);
    // フェッチ失敗でも URL 自体は保存できるよう、最低限の host だけ返す。
    const host = hostOf(url);
    res.status(200).json({
      ok: true,
      url,
      finalUrl: url,
      title: host || '',
      description: '',
      image: null,
      siteName: host || '',
      host,
      warning: 'fetch failed: ' + (e && e.message ? e.message : 'unknown'),
    });
  }
}

// ───────────────────────── YouTube 専用処理 ─────────────────────────
// 目的: グリッドのタイトルを「www.youtube.com」ではなく動画名/再生リスト名にし、
//       サムネを確実に表示する。
//   - 動画URL    → oEmbed (キー不要) でタイトル+サムネ
//   - 再生リスト → Data API (YOUTUBE_API_KEY) で正式タイトル。無ければ先頭動画にフォールバック
// YouTube でなければ null を返し、通常の OGP 取得に進む。

function parseYouTube(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const isYT = host === 'youtube.com' || host === 'm.youtube.com' ||
               host === 'music.youtube.com' || host === 'youtu.be';
  if (!isYT) return null;

  let videoId = null, listId = null;
  if (host === 'youtu.be') {
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (/^[\w-]{11}$/.test(seg || '')) videoId = seg;
  } else {
    const v = u.searchParams.get('v');
    if (v && /^[\w-]{11}$/.test(v)) videoId = v;
    const parts = u.pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p => p === 'shorts' || p === 'embed' || p === 'live');
    if (i >= 0 && /^[\w-]{11}$/.test(parts[i + 1] || '')) videoId = parts[i + 1];
  }
  const list = u.searchParams.get('list');
  if (list && /^[\w-]+$/.test(list)) listId = list;

  if (!videoId && !listId) return null;
  return { videoId, listId };
}

function ytThumb(videoId) {
  return 'https://img.youtube.com/vi/' + videoId + '/hqdefault.jpg';
}

// 動画の oEmbed (タイトル+サムネ, キー不要)
async function ytOEmbed(videoId) {
  try {
    const api = 'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId);
    const r = await fetchWithTimeout(api, 5000);
    if (!r || !r.ok) return null;
    const j = await r.json();
    return {
      title: (j.title || '').slice(0, 300),
      image: j.thumbnail_url || ytThumb(videoId),
      author: j.author_name || '',
    };
  } catch { return null; }
}

// 再生リストの正式名 (Data API)。キー未設定や失敗時は null。
async function ytPlaylistInfo(listId) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const api = 'https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=' +
      encodeURIComponent(listId) + '&key=' + encodeURIComponent(key);
    const r = await fetchWithTimeout(api, 5000);
    if (!r || !r.ok) return null;
    const j = await r.json();
    const sn = j && j.items && j.items[0] && j.items[0].snippet;
    if (!sn) return null;
    const th = sn.thumbnails || {};
    const img = (th.high || th.medium || th.default || {}).url || null;
    return { title: (sn.title || '').slice(0, 300), image: img };
  } catch { return null; }
}

// 再生リストの先頭動画ID (Data API)。キー未設定や失敗時は null。
async function ytFirstVideoOfPlaylist(listId) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const api = 'https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=1&playlistId=' +
      encodeURIComponent(listId) + '&key=' + encodeURIComponent(key);
    const r = await fetchWithTimeout(api, 5000);
    if (!r || !r.ok) return null;
    const j = await r.json();
    const id = j && j.items && j.items[0] && j.items[0].contentDetails && j.items[0].contentDetails.videoId;
    return /^[\w-]{11}$/.test(id || '') ? id : null;
  } catch { return null; }
}

async function fetchWithTimeout(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { signal: c.signal }); }
  catch { return null; }
  finally { clearTimeout(t); }
}

// YouTube を処理して結果オブジェクトを返す。YouTube でなければ null。
async function tryYouTube(url) {
  const info = parseYouTube(url);
  if (!info) return null;
  const host = hostOf(url);
  const base = { ok: true, url, finalUrl: url, description: '', siteName: 'YouTube', host };

  // 再生リスト優先で正式名を狙う (list が付いていれば)
  if (info.listId) {
    const pl = await ytPlaylistInfo(info.listId);          // 正式タイトル+サムネ (キー有り)
    let image = pl && pl.image ? pl.image : null;
    let title = pl && pl.title ? '[再生リスト] ' + pl.title : '';

    // サムネが無い/タイトルが無いとき、先頭動画で補う
    if (!image || !title) {
      let firstVid = info.videoId;
      if (!firstVid) firstVid = await ytFirstVideoOfPlaylist(info.listId);
      if (firstVid) {
        if (!image) image = ytThumb(firstVid);
        if (!title) {
          const oe = await ytOEmbed(firstVid);
          if (oe && oe.title) title = '[再生リスト] ' + oe.title;
        }
      }
    }
    if (!title) title = 'YouTube の再生リスト';
    return { ...base, title, image: image || null };
  }

  // 単一動画
  if (info.videoId) {
    const oe = await ytOEmbed(info.videoId);
    return {
      ...base,
      title: (oe && oe.title) ? oe.title : 'YouTube の動画',
      image: (oe && oe.image) ? oe.image : ytThumb(info.videoId),
      siteName: (oe && oe.author) ? oe.author : 'YouTube',
    };
  }
  return null;
}
