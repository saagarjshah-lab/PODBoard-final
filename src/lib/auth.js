import { supabase, ALLOWED_DOMAIN } from './supabaseClient.js';
import { claimMemberByEmail } from './db.js';

// Kept in sync with public.is_admin() / public.is_super_admin() in
// supabase/schema_update.sql: this account is always treated as super
// admin, even before profiles.role is manually set, so the client and the
// database RLS never disagree.
const HARD_CODED_ADMIN_EMAIL = 'sashah@adobe.com';

let currentSession = null;
let currentProfile = null; // { id, email, role }
let mode = 'signin'; // 'signin' | 'signup' | 'reset'

export function getSession() { return currentSession; }
export function getProfile() { return currentProfile; }

/** True for admin-tier or higher (admin OR super_admin). Grants access to the Admin Workspace. */
export function isAdmin() {
  if (!currentProfile) return false;
  const role = currentProfile.role;
  return role === 'admin' || role === 'super_admin' || (currentProfile.email || '').toLowerCase() === HARD_CODED_ADMIN_EMAIL;
}

/** True only for super_admin. Gates role assignment and global settings (branding/default capacity). */
export function isSuperAdmin() {
  if (!currentProfile) return false;
  return currentProfile.role === 'super_admin' || (currentProfile.email || '').toLowerCase() === HARD_CODED_ADMIN_EMAIL;
}

/** 'super_admin' | 'admin' | 'member' — for display and role-gating decisions. */
export function getRoleTier() {
  if (isSuperAdmin()) return 'super_admin';
  if (isAdmin()) return 'admin';
  return 'member';
}

function isAdobeEmail(email) {
  return typeof email === 'string' && email.trim().toLowerCase().endsWith(ALLOWED_DOMAIN);
}

async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, email, role')
    .eq('id', userId)
    .single();
  if (error) {
    console.error('Could not load profile', error);
    return null;
  }
  return data;
}

/** Sets the URL hash to reflect the signed-in user's tier, without a full page reload. */
function routeForRole(tier) {
  const target = tier === 'member' ? '#/member' : '#/admin';
  if (window.location.hash !== target) window.location.hash = target;
}

/* ================= Two-factor authentication (TOTP via supabase.auth.mfa) =================
   These wrappers centralize every supabase.auth.mfa.* call in this module,
   consistent with auth.js owning all supabase.auth.* usage app-wide (db.js
   owns all supabase.from(...) usage). The Security modal in main.js calls
   these rather than touching the Supabase client directly. */

/** Lists this account's enrolled MFA factors ({ totp: [...], all: [...] }). */
export async function mfaListFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return data;
}

/** Starts TOTP enrollment. Returns { id, totp: { qr_code, secret, uri } }. Not yet active until verified. */
export async function mfaEnrollTotp() {
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' });
  if (error) throw error;
  return data;
}

/** Verifies a 6-digit code against a factor — used both to complete enrollment and to satisfy a login challenge. */
export async function mfaVerifyCode(factorId, code) {
  const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId });
  if (challengeErr) throw challengeErr;
  const { error: verifyErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challenge.id, code });
  if (verifyErr) throw verifyErr;
}

/** Removes an MFA factor (used for both "cancel enrollment" and "disable 2FA"). */
export async function mfaUnenroll(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

/** True if this session is missing a second factor it's enrolled for (needs to complete an MFA challenge). */
async function needsMfaChallenge() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return null;
  if (data.nextLevel === 'aal2' && data.currentLevel !== data.nextLevel) {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.find((f) => f.status === 'verified');
    if (factor) return factor.id;
  }
  return null;
}

/**
 * Wires up the login screen and returns once auth state is known.
 * onAuthed(profile) is called whenever a valid @adobe.com session becomes
 * fully authenticated (password verified, and MFA challenge cleared if
 * the account has 2FA enabled). onSignedOut() is called on sign-out or
 * when no session exists.
 */
export function initAuth({ onAuthed, onSignedOut }) {
  const screen = document.getElementById('authScreen');
  const recoveryScreen = document.getElementById('recoveryScreen');
  const mfaScreen = document.getElementById('mfaChallengeScreen');
  const appRoot = document.getElementById('appRoot');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const sendBtn = document.getElementById('authSendBtn');
  const errorEl = document.getElementById('authError');
  const hintEl = document.getElementById('authHint');
  const introEl = document.getElementById('authIntro');
  const toggleEl = document.getElementById('authToggleMode');
  const forgotEl = document.getElementById('authForgotLink');
  const signOutBtn = document.getElementById('signOutBtn');

  let pendingMfaFactorId = null;

  function hideAllScreens() {
    screen.classList.add('hidden');
    recoveryScreen.classList.add('hidden');
    mfaScreen.classList.add('hidden');
    appRoot.classList.add('hidden');
  }
  function showAuthScreen(msg) {
    hideAllScreens();
    screen.classList.remove('hidden');
    if (msg) errorEl.textContent = msg;
  }
  function showRecoveryScreen() {
    hideAllScreens();
    recoveryScreen.classList.remove('hidden');
  }
  function showMfaChallengeScreen() {
    hideAllScreens();
    mfaScreen.classList.remove('hidden');
  }
  function showApp() {
    hideAllScreens();
    appRoot.classList.remove('hidden');
  }

  function applyMode() {
    errorEl.textContent = '';
    hintEl.textContent = 'Access is restricted to Adobe team accounts.';
    passwordInput.style.display = mode === 'reset' ? 'none' : '';
    if (mode === 'signup') {
      introEl.innerHTML = 'Create your account with your <strong>@adobe.com</strong> email.';
      sendBtn.textContent = 'Create account';
      toggleEl.textContent = 'Already have an account? Sign in';
      forgotEl.style.display = 'none';
      passwordInput.autocomplete = 'new-password';
    } else if (mode === 'reset') {
      introEl.innerHTML = `Enter your <strong>@adobe.com</strong> email and we'll send you a reset link.`;
      sendBtn.textContent = 'Send reset link';
      toggleEl.textContent = 'Back to sign in';
      forgotEl.style.display = 'none';
    } else {
      introEl.innerHTML = 'Sign in with your <strong>@adobe.com</strong> email and password.';
      sendBtn.textContent = 'Sign in';
      toggleEl.textContent = 'Need an account? Create one';
      forgotEl.style.display = '';
      passwordInput.autocomplete = 'current-password';
    }
  }

  toggleEl.addEventListener('click', () => {
    mode = mode === 'reset' ? 'signin' : (mode === 'signin' ? 'signup' : 'signin');
    applyMode();
  });
  forgotEl.addEventListener('click', () => {
    mode = 'reset';
    applyMode();
  });

  async function handleSubmit() {
    errorEl.textContent = '';
    const email = (emailInput.value || '').trim().toLowerCase();
    if (!email) { errorEl.textContent = 'Enter your email address.'; return; }
    if (!isAdobeEmail(email)) { errorEl.textContent = `Only ${ALLOWED_DOMAIN} addresses can sign in.`; return; }

    if (mode === 'reset') {
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      sendBtn.disabled = false;
      mode = 'signin';
      applyMode();
      if (error) { errorEl.textContent = `Could not send reset link: ${error.message}`; return; }
      hintEl.textContent = `If an account exists for ${email}, a reset link has been sent.`;
      return;
    }

    const password = passwordInput.value || '';
    if (!password || password.length < 6) { errorEl.textContent = 'Password must be at least 6 characters.'; return; }

    sendBtn.disabled = true;
    sendBtn.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      sendBtn.disabled = false;
      if (error) {
        errorEl.textContent = error.message.includes('adobe.com')
          ? `Only ${ALLOWED_DOMAIN} addresses can sign in.`
          : `Could not create account: ${error.message}`;
        applyMode();
        return;
      }
      if (data.session) {
        // Email confirmation is off — signUp already returned an active session.
        return; // onAuthStateChange will fire and take it from here.
      }
      // Email confirmation is required before the account can sign in.
      mode = 'signin';
      applyMode();
      hintEl.textContent = `Account created. Check ${email} to confirm, then sign in.`;
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    sendBtn.disabled = false;
    applyMode();
    if (error) {
      errorEl.textContent = /invalid/i.test(error.message)
        ? 'Incorrect email or password.'
        : `Could not sign in: ${error.message}`;
      return;
    }
    // onAuthStateChange fires next — handleSessionOrChallenge() decides
    // whether this account still needs an MFA challenge before completing.
  }

  sendBtn.addEventListener('click', handleSubmit);
  [emailInput, passwordInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); }));
  signOutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  window.addEventListener('hashchange', () => {
    // Guard rail: a member can't force their way into the admin route by
    // editing the URL hash directly. Admin-tier and super-admin are free to
    // view either.
    if (!currentProfile) return;
    if (window.location.hash === '#/admin' && !isAdmin()) {
      window.location.hash = '#/member';
    }
  });

  /* ---------------- Password recovery ---------------- */
  const recoveryPasswordInput = document.getElementById('recoveryPassword');
  const recoveryConfirmInput = document.getElementById('recoveryPasswordConfirm');
  const recoverySubmitBtn = document.getElementById('recoverySubmit');
  const recoveryErrorEl = document.getElementById('recoveryError');

  async function submitRecovery() {
    recoveryErrorEl.textContent = '';
    const pw = recoveryPasswordInput.value || '';
    const confirmPw = recoveryConfirmInput.value || '';
    if (pw.length < 6) { recoveryErrorEl.textContent = 'Password must be at least 6 characters.'; return; }
    if (pw !== confirmPw) { recoveryErrorEl.textContent = 'Passwords do not match.'; return; }
    recoverySubmitBtn.disabled = true; recoverySubmitBtn.textContent = 'Updating…';
    const { error } = await supabase.auth.updateUser({ password: pw });
    recoverySubmitBtn.disabled = false; recoverySubmitBtn.textContent = 'Update password';
    if (error) { recoveryErrorEl.textContent = error.message; return; }
    recoveryPasswordInput.value = ''; recoveryConfirmInput.value = '';
    const { data: { session } } = await supabase.auth.getSession();
    await handleSessionOrChallenge(session);
  }
  recoverySubmitBtn.addEventListener('click', submitRecovery);
  [recoveryPasswordInput, recoveryConfirmInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitRecovery(); }));

  /* ---------------- MFA login challenge ---------------- */
  const mfaCodeInput = document.getElementById('mfaChallengeCode');
  const mfaSubmitBtn = document.getElementById('mfaChallengeSubmit');
  const mfaErrorEl = document.getElementById('mfaChallengeError');
  const mfaSignOutLink = document.getElementById('mfaSignOutLink');

  async function submitMfaChallenge() {
    mfaErrorEl.textContent = '';
    const code = (mfaCodeInput.value || '').trim();
    if (!/^\d{6}$/.test(code)) { mfaErrorEl.textContent = 'Enter the 6-digit code.'; return; }
    mfaSubmitBtn.disabled = true; mfaSubmitBtn.textContent = 'Verifying…';
    try {
      await mfaVerifyCode(pendingMfaFactorId, code);
    } catch (e) {
      mfaSubmitBtn.disabled = false; mfaSubmitBtn.textContent = 'Verify';
      mfaErrorEl.textContent = 'Incorrect code. Try again.';
      mfaCodeInput.value = '';
      return;
    }
    mfaSubmitBtn.disabled = false; mfaSubmitBtn.textContent = 'Verify';
    mfaCodeInput.value = '';
    pendingMfaFactorId = null;
    const { data: { session } } = await supabase.auth.getSession();
    await handleSessionOrChallenge(session); // AAL is now aal2 — this resolves straight to completeSession()
  }
  mfaSubmitBtn.addEventListener('click', submitMfaChallenge);
  mfaCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitMfaChallenge(); });
  mfaSignOutLink.addEventListener('click', async () => { pendingMfaFactorId = null; await supabase.auth.signOut(); });

  applyMode();

  async function completeSession(session) {
    currentSession = session;
    const email = session.user.email || '';
    if (!isAdobeEmail(email)) {
      // Defense in depth: even if a non-adobe session somehow exists, refuse it client-side.
      await supabase.auth.signOut();
      showAuthScreen(`Only ${ALLOWED_DOMAIN} addresses are allowed. You've been signed out.`);
      return;
    }
    currentProfile = await fetchProfile(session.user.id);
    if (!currentProfile) {
      showAuthScreen('Could not load your profile. Try signing in again.');
      return;
    }
    // Best-effort: link this login to a `members` row with a matching email
    // (no-ops if already linked or no matching row exists yet).
    claimMemberByEmail(email, session.user.id).catch(() => {});

    const admin = isAdmin();
    const superAdmin = isSuperAdmin();
    const tier = getRoleTier();
    showApp();
    document.body.classList.toggle('role-member', !admin);
    document.body.classList.toggle('is-super-admin', superAdmin);
    document.getElementById('whoEmail').textContent = currentProfile.email;
    document.getElementById('whoRole').textContent = tier === 'super_admin' ? 'super admin' : tier;
    routeForRole(tier);
    onAuthed?.(currentProfile);
  }

  /** Single entry point for "a session exists — is it actually ready to use?" Used by onAuthStateChange, and re-invoked manually after recovery/MFA verification in case the corresponding auth event doesn't fire. */
  async function handleSessionOrChallenge(session) {
    if (!session) {
      currentSession = null; currentProfile = null; pendingMfaFactorId = null;
      showAuthScreen();
      onSignedOut?.();
      return;
    }
    const factorId = await needsMfaChallenge();
    if (factorId) {
      pendingMfaFactorId = factorId;
      showMfaChallengeScreen();
      return;
    }
    await completeSession(session);
  }

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      showRecoveryScreen();
      return;
    }
    await handleSessionOrChallenge(session);
  });
}
