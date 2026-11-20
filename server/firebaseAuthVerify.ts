import crypto from 'node:crypto';
import type { PermissionKey } from '../src/types/index.ts';

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'skillflix-academy';
const PLATFORM_OWNER_EMAIL = 'editpeakstudio@gmail.com';
const GOOGLE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface CertCache {
  certs: Record<string, string>;
  expiresAt: number;
}

let certCache: CertCache | null = null;

export interface VerifiedFirebaseUser {
  uid: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  idToken: string;
}

export interface VerifiedAdminContext extends VerifiedFirebaseUser {
  role: 'owner' | 'master_admin' | 'admin';
  permissions: PermissionKey[];
}

function base64UrlDecode(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad ? normalized + '='.repeat(4 - pad) : normalized;
  return Buffer.from(padded, 'base64');
}

async function getGooglePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  const now = Date.now();
  if (!forceRefresh && certCache && certCache.expiresAt > now) {
    return certCache.certs;
  }

  const response = await fetch(GOOGLE_CERTS_URL, {
    headers: { Accept: 'application/json' }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch Firebase public keys (${response.status}).`);
  }

  const certs = (await response.json()) as Record<string, string>;
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;

  certCache = {
    certs,
    expiresAt: now + Math.max(60, maxAgeSeconds) * 1000
  };
  return certs;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseUser> {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Authentication token is missing.');
  }

  const parts = idToken.trim().split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid Firebase ID token format.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;

  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8')) as { alg?: string; kid?: string };
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Malformed Firebase ID token.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase ID token algorithm.');
  }

  let certs = await getGooglePublicCerts(false);
  let pem = certs[header.kid];
  if (!pem) {
    certs = await getGooglePublicCerts(true);
    pem = certs[header.kid];
  }
  if (!pem) {
    throw new Error('Firebase signing key was not found.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();

  const signature = base64UrlDecode(signatureB64);
  const isSignatureValid = verifier.verify(pem, signature);
  if (!isSignatureValid) {
    throw new Error('Invalid Firebase ID token signature.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
  const exp = Number(payload.exp || 0);
  const iat = Number(payload.iat || 0);
  const authTime = Number(payload.auth_time || 0);
  const sub = typeof payload.sub === 'string' ? payload.sub : '';

  if (payload.aud !== FIREBASE_PROJECT_ID) {
    throw new Error('Firebase token audience mismatch.');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (!sub) {
    throw new Error('Firebase token subject is empty.');
  }
  if (exp <= nowSeconds) {
    throw new Error('Firebase session expired. Please sign in again.');
  }
  if (iat > nowSeconds + 300 || authTime > nowSeconds + 300) {
    throw new Error('Firebase token timestamp is invalid.');
  }

  const email = typeof payload.email === 'string' ? payload.email.trim() : '';
  const emailVerified = payload.email_verified === true;
  const name = typeof payload.name === 'string' ? payload.name : undefined;

  return {
    uid: sub,
    email,
    emailVerified,
    name,
    idToken
  };
}

// ======================================================
// FIRESTORE REST API HELPERS (Verified Bearer Token)
// ======================================================

type FirestoreValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

function decodeFirestoreValue(val: FirestoreValue): unknown {
  if ('stringValue' in val) return val.stringValue;
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('booleanValue' in val) return val.booleanValue;
  if ('nullValue' in val) return null;
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    return (val.arrayValue.values || []).map(decodeFirestoreValue);
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

function encodeFirestoreValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'string') return { stringValue: val };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(encodeFirestoreValue) } };
  }
  if (typeof val === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) {
        fields[k] = encodeFirestoreValue(v);
      }
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function decodeFirestoreDocument(docJson: {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (docJson.name) {
    const parts = docJson.name.split('/');
    out.id = parts[parts.length - 1];
  }
  if (docJson.fields) {
    for (const [k, v] of Object.entries(docJson.fields)) {
      out[k] = decodeFirestoreValue(v);
    }
  }
  return out;
}

function firestoreDocUrl(collection: string, docId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${encodeURIComponent(collection)}/${encodeURIComponent(docId)}`;
}

function firestoreCollectionUrl(collection: string): string {
  return `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${encodeURIComponent(collection)}`;
}

export async function fetchFirestoreDocument(
  collection: string,
  docId: string,
  idToken: string
): Promise<Record<string, unknown> | null> {
  const res = await fetch(firestoreDocUrl(collection, docId), {
    headers: {
      Authorization: `Bearer ${idToken}`,
      Accept: 'application/json'
    }
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore read failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { name?: string; fields?: Record<string, FirestoreValue> };
  return decodeFirestoreDocument(json);
}

export async function listFirestoreCollection(
  collection: string,
  idToken: string
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let pageToken = '';

  for (let i = 0; i < 10; i++) {
    const url = new URL(firestoreCollectionUrl(collection));
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${idToken}`,
        Accept: 'application/json'
      }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Firestore list failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      documents?: Array<{ name?: string; fields?: Record<string, FirestoreValue> }>;
      nextPageToken?: string;
    };
    if (Array.isArray(json.documents)) {
      for (const docItem of json.documents) {
        items.push(decodeFirestoreDocument(docItem));
      }
    }
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }

  return items;
}

export async function upsertFirestoreDocument(
  collection: string,
  docId: string,
  data: Record<string, unknown>,
  idToken: string
): Promise<void> {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) {
      fields[k] = encodeFirestoreValue(v);
    }
  }

  const res = await fetch(firestoreDocUrl(collection, docId), {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${idToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore upsert failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function deleteFirestoreDocument(
  collection: string,
  docId: string,
  idToken: string
): Promise<void> {
  const res = await fetch(firestoreDocUrl(collection, docId), {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${idToken}`
    }
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Firestore delete failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

export async function authorizeAdmin(
  idToken: string,
  requiredPermission: 'telegram.manage' | 'payments.verify' | 'students.manage' = 'telegram.manage'
): Promise<VerifiedAdminContext> {
  const user = await verifyFirebaseIdToken(idToken);
  const isOwner = user.email.toLowerCase() === PLATFORM_OWNER_EMAIL && user.emailVerified;

  if (isOwner) {
    return {
      ...user,
      role: 'owner',
      permissions: ['telegram.manage', 'payments.verify', 'settings.manage', 'students.manage']
    };
  }

  const profile = await fetchFirestoreDocument('users', user.uid, idToken);
  if (!profile) {
    throw new Error('Administrator profile not found.');
  }
  if (profile.isSuspended === true) {
    throw new Error('Your administrator account is suspended.');
  }

  const role = typeof profile.role === 'string' ? profile.role : 'user';
  const permissions = Array.isArray(profile.permissions)
    ? (profile.permissions.filter((p): p is PermissionKey => typeof p === 'string'))
    : [];

  if (role === 'master_admin') {
    return { ...user, role: 'master_admin', permissions };
  }

  if (role === 'admin') {
    const allowed =
      permissions.includes(requiredPermission) ||
      (requiredPermission === 'telegram.manage' && permissions.includes('settings.manage')) ||
      (requiredPermission === 'students.manage' && permissions.includes('payments.verify'));
    if (allowed) {
      return { ...user, role: 'admin', permissions };
    }
  }

  throw new Error('Forbidden: You do not have permission to perform this administrative action.');
}

export function extractBearerToken(authHeader?: string): string {
  if (!authHeader || typeof authHeader !== 'string') return '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
