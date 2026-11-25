import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  PLATFORM_OWNER_EMAIL,
  buildExistingUserUpdatePayload,
  buildNewUserDocument,
  dedupeAndSortUsers,
  normalizeUserProfile,
  toIsoDateValue,
  type AuthUserSnapshot
} from '../src/services/userSyncHelpers';
import type { UserProfile } from '../src/types';

function runAllChecks() {
  const fixedNow = '2026-11-25T10:00:00.000Z';

  // 1. New Google Account Registration
  {
    const googleAuthUser: AuthUserSnapshot = {
      uid: 'google_uid_001',
      email: 'NewGoogleStudent@gmail.com',
      emailVerified: true,
      displayName: 'Aarav Sharma',
      photoURL: 'https://lh3.googleusercontent.com/a/avatar1',
      providerData: [{ providerId: 'google.com', email: 'NewGoogleStudent@gmail.com' }],
      metadata: { creationTime: '2026-11-25T09:59:50.000Z' }
    };
    const { profile, firestoreDoc } = buildNewUserDocument(googleAuthUser, { nowIso: fixedNow });
    assert.equal(profile.uid, 'google_uid_001');
    assert.equal(firestoreDoc.uid, 'google_uid_001');
    assert.equal(firestoreDoc.role, 'user');
    assert.deepEqual(firestoreDoc.permissions, []);
    assert.equal(firestoreDoc.isPlatformOwner, false);
    assert.equal(firestoreDoc.hasAllAccess, false);
    assert.equal(firestoreDoc.isSuspended, false);
    assert.equal(firestoreDoc.subscriptionStatus, 'none');
    assert.deepEqual(firestoreDoc.allowedCategories, []);
    assert.deepEqual(firestoreDoc.assignedCourses, []);
    assert.equal(firestoreDoc.authProvider, 'google');
    assert.equal(firestoreDoc.displayName, 'Aarav Sharma');
    assert.equal(firestoreDoc.photoURL, 'https://lh3.googleusercontent.com/a/avatar1');
    assert.equal(firestoreDoc.accessExpiry, null);
    assert.equal(firestoreDoc.accessExpiryAt, null);
    assert.equal(firestoreDoc.createdAt, '2026-11-25T09:59:50.000Z');
  }

  // 2. New Email/Password Registration + Concurrent Creation Fallback
  {
    const emailAuthUser: AuthUserSnapshot = {
      uid: 'email_uid_002',
      email: 'priya.editor@example.com',
      emailVerified: false,
      displayName: null,
      providerData: [{ providerId: 'password', email: 'priya.editor@example.com' }],
      metadata: { creationTime: fixedNow }
    };
    const { firestoreDoc } = buildNewUserDocument(emailAuthUser, {
      explicitDisplayName: 'Priya Verma',
      nowIso: fixedNow
    });
    assert.equal(firestoreDoc.displayName, 'Priya Verma');
    assert.equal(firestoreDoc.authProvider, 'password');
    assert.equal(firestoreDoc.role, 'user');

    // Simulate race where Cloud Function created the doc a millisecond earlier with email prefix
    const cloudFunctionDoc = {
      uid: 'email_uid_002',
      email: 'priya.editor@example.com',
      displayName: 'priya.editor',
      role: 'user',
      authProvider: 'password',
      allowedCategories: [],
      assignedCourses: [],
      hasAllAccess: false,
      subscriptionStatus: 'none',
      createdAt: fixedNow,
      lastLogin: fixedNow,
      lastLoginAt: fixedNow
    };
    const { updatePayload, mergedProfile } = buildExistingUserUpdatePayload({
      fbUser: emailAuthUser,
      existingData: cloudFunctionDoc,
      explicitDisplayName: 'Priya Verma',
      updateLastLogin: true,
      nowIso: '2026-11-25T10:00:01.000Z'
    });
    assert.equal(updatePayload.displayName, 'Priya Verma');
    assert.equal(updatePayload.role, undefined, 'Existing role must not be touched by self-update');
    assert.equal(updatePayload.createdAt, undefined, 'createdAt must not be overwritten');
    assert.equal(mergedProfile.displayName, 'Priya Verma');
  }

  // 3. Existing User Login (Preserves Admin Roles, Custom Courses & Subscriptions)
  {
    const existingAdminAuth: AuthUserSnapshot = {
      uid: 'admin_uid_003',
      email: 'ops.admin@skillflix.io',
      emailVerified: true,
      displayName: 'Google Alias',
      photoURL: 'https://lh3.googleusercontent.com/a/newphoto',
      providerData: [{ providerId: 'google.com' }]
    };
    const existingAdminDoc = {
      uid: 'admin_uid_003',
      email: 'ops.admin@skillflix.io',
      displayName: 'Operations Lead',
      role: 'admin',
      predefinedRole: 'video_manager',
      assignedRoleTitle: 'Video Manager',
      permissions: ['dashboard.view', 'videos.create', 'students.manage'],
      hasAllAccess: false,
      allowedCategories: ['cat_alight', 'cat_capcut'],
      assignedCourses: ['cat_alight', 'cat_capcut'],
      subscriptionStatus: 'active',
      accessExpiry: '2027-01-01T00:00:00.000Z',
      isSuspended: false,
      authProvider: 'google',
      createdAt: '2026-01-10T08:00:00.000Z',
      lastLogin: '2026-11-20T08:00:00.000Z',
      lastLoginAt: '2026-11-20T08:00:00.000Z'
    };
    const { updatePayload, mergedProfile } = buildExistingUserUpdatePayload({
      fbUser: existingAdminAuth,
      existingData: existingAdminDoc,
      updateLastLogin: true,
      nowIso: fixedNow
    });

    assert.equal(updatePayload.displayName, undefined, 'Custom displayName must be preserved');
    assert.equal(updatePayload.role, undefined, 'Admin role must not be overwritten');
    assert.equal(updatePayload.permissions, undefined);
    assert.equal(updatePayload.allowedCategories, undefined);
    assert.equal(updatePayload.photoURL, 'https://lh3.googleusercontent.com/a/newphoto');
    assert.equal(updatePayload.lastLoginAt, fixedNow);
    assert.equal(mergedProfile.role, 'admin');
    assert.deepEqual(mergedProfile.allowedCategories, ['cat_alight', 'cat_capcut']);
    assert.equal(mergedProfile.createdAt, '2026-01-10T08:00:00.000Z');
  }

  // 4. Duplicate Prevention & Numeric/Timestamp Date Normalization
  {
    assert.equal(toIsoDateValue(1732500000), '2024-11-25T02:00:00.000Z');
    assert.equal(toIsoDateValue(1732500000000), '2024-11-25T02:00:00.000Z');
    assert.equal(toIsoDateValue({ seconds: 1732500000 }), '2024-11-25T02:00:00.000Z');

    const ownerProfile = normalizeUserProfile('owner_uid', {
      email: PLATFORM_OWNER_EMAIL,
      displayName: 'Ravi Owner',
      role: 'master_admin',
      isPlatformOwner: true,
      createdAt: '2025-01-01T00:00:00.000Z',
      lastLoginAt: '2026-11-01T00:00:00.000Z'
    });
    const oldStudent = normalizeUserProfile('stu_old', {
      email: 'old@example.com',
      displayName: 'Old Student',
      role: 'user',
      createdAt: '2026-05-01T00:00:00.000Z',
      lastLoginAt: '2026-05-02T00:00:00.000Z'
    });
    const brandNewStudent = normalizeUserProfile('stu_new', {
      email: 'new@example.com',
      displayName: 'Brand New Student',
      role: 'user',
      createdAt: fixedNow,
      lastLoginAt: fixedNow
    });
    const duplicateNewStudent: UserProfile = {
      ...brandNewStudent,
      displayName: 'Brand New Student Updated'
    };

    const sorted = dedupeAndSortUsers([oldStudent, brandNewStudent, ownerProfile, duplicateNewStudent]);
    assert.equal(sorted.length, 3, 'Duplicate UIDs must be collapsed to one record');
    assert.equal(sorted[0].uid, 'owner_uid', 'Platform owner stays pinned first');
    assert.equal(sorted[1].uid, 'stu_new', 'Newly registered user surfaces immediately after Owner');
    assert.equal(sorted[1].displayName, 'Brand New Student Updated');
    assert.equal(sorted[2].uid, 'stu_old');
  }

  // 5. Security: Prevent Privilege Escalation & Unverified Owner Impersonation
  {
    const unverifiedOwnerSpoof: AuthUserSnapshot = {
      uid: 'spoof_uid',
      email: PLATFORM_OWNER_EMAIL,
      emailVerified: false,
      displayName: 'Unverified Spoof'
    };
    const { firestoreDoc } = buildNewUserDocument(unverifiedOwnerSpoof, { nowIso: fixedNow });
    assert.equal(firestoreDoc.isPlatformOwner, false);
    assert.equal(firestoreDoc.role, 'user');
    assert.equal(firestoreDoc.hasAllAccess, false);
    assert.deepEqual(firestoreDoc.permissions, []);

    const verifiedOwner: AuthUserSnapshot = {
      uid: 'real_owner_uid',
      email: PLATFORM_OWNER_EMAIL,
      emailVerified: true,
      displayName: 'EditPeak Owner'
    };
    const ownerDoc = buildNewUserDocument(verifiedOwner, { nowIso: fixedNow }).firestoreDoc;
    assert.equal(ownerDoc.isPlatformOwner, true);
    assert.equal(ownerDoc.role, 'master_admin');
    assert.equal(ownerDoc.hasAllAccess, true);
  }

  // 6. Verify Firestore Rules contain safe self-update defaults and strict create checks
  {
    const rules = fs.readFileSync(path.resolve(process.cwd(), 'firestore.rules'), 'utf8');
    assert.ok(rules.includes("request.resource.data.role == 'user'"), 'rules enforce default student role on self-create');
    assert.ok(rules.includes("request.resource.data.get('email', '') == resource.data.get('email', '')"), 'rules safely guard email equality');
    assert.ok(rules.includes("request.resource.data.get('role', 'user') == resource.data.get('role', 'user')"), 'rules safely guard role equality');
    assert.ok(rules.includes('allow list: if activeAdmin();'), 'rules allow admins/owner to list users');
  }

  console.log('ALL 6 USER SYNC & SECURITY CHECKS PASSED');
}

runAllChecks();
