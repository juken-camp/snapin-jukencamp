// api/auth/init.js
// 新規ユーザー登録後にフロントから呼ぶ
// - Firestore に users ドキュメントを作成
// - jukencamp_official を自動フォロー

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

if (!getApps().length) {
  initializeApp({
    credential: cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db   = getFirestore();
const auth = getAuth();

const OFFICIAL_UID = 'jukencamp_official';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // フロントから Firebase IDトークンを受け取って検証
  const authHeader = req.headers.authorization ?? '';
  const idToken = authHeader.replace('Bearer ', '');

  let decoded;
  try {
    decoded = await auth.verifyIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: '認証トークンが無効です。' });
  }

  const uid = decoded.uid;
  const { displayName } = req.body ?? {};

  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();

  // 既存ユーザーは何もしない
  if (snap.exists) {
    return res.status(200).json({ message: 'already initialized' });
  }

  const batch = db.batch();

  // users ドキュメント作成
  batch.set(userRef, {
    uid,
    displayName: displayName ?? 'SnapIn生徒',
    avatarUrl:   null,
    role:        'student',
    bio:         '',
    followingCount: 1,   // 公式フォロー済みで1スタート
    followerCount:  0,
    aiEnabled:   true,
    suspended:   false,
    createdAt:   FieldValue.serverTimestamp(),
  });

  // jukencamp_official を自動フォロー
  const followRef = db.collection('follows').doc(`${uid}_${OFFICIAL_UID}`);
  batch.set(followRef, {
    followerUid:  uid,
    followingUid: OFFICIAL_UID,
    createdAt:    FieldValue.serverTimestamp(),
  });

  // 公式アカウントの followerCount をインクリメント
  const officialRef = db.collection('users').doc(OFFICIAL_UID);
  batch.update(officialRef, {
    followerCount: FieldValue.increment(1),
  });

  try {
    await batch.commit();
  } catch (e) {
    console.error('[auth/init] batch failed:', e.message);
    return res.status(500).json({ error: '初期化に失敗しました。' });
  }

  return res.status(200).json({ message: 'initialized', uid });
}
