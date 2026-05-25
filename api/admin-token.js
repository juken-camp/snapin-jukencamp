// /api/admin-token.js — Kazuma 専用: 管理者token を発行
//
// 使い方:
//   1. このファイルを /api/admin-token.js に配置してデプロイ
//   2. ブラウザのアドレスバーで以下のURLを開く
//      https://snapin-jukencamp.vercel.app/api/admin-token?password=<ADMIN_PASSWORD>
//   3. 返ってきた JSON の token 値をコピー
//   4. SnapIn を開いて、ブラウザのコンソールで:
//      localStorage.setItem('snapin_token', '<コピーした token>')
//      location.reload()
//   5. 以降、Kazuma の端末では AI も公式ライブラリも全部見える
//
// セキュリティ:
//   - admin パスワードを知ってる人だけが管理者token を発行できる
//   - token を localStorage に保存 (盗まれない限り安全)
//   - もし漏れたら TOKEN_SECRET を変えれば全token無効化できる

import { signAdminToken } from './_lib/auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const password = req.query?.password
    || (typeof req.body === 'object' && req.body?.password)
    || req.headers['x-admin-password'];

  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const deviceId = req.query?.deviceId || 'admin-' + Date.now();
  const token = signAdminToken(deviceId);

  return res.status(200).json({
    ok: true,
    token,
    deviceId,
    instruction: 'ブラウザコンソールで localStorage.setItem("snapin_token", "<token>") を実行してください',
  });
}
