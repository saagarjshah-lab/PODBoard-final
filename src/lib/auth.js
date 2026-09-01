import { supabase, ALLOWED_DOMAIN } from './supabaseClient.js';
import { claimMemberByEmail } from './db.js';

let currentSession = null;
let currentProfile = null; // { id, email, role }
let mode = 'signin'; // 'signin' | 'signup'

export function getSession() { return currentSession; }
export function getProfile() { return currentProfile; }
export function isAdmin() { return currentProfile?.role === 'admin'; }

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

/** Sets the URL hash to reflect the signed-in user's role, without a full page reload. */
function routeForRole(role) {
  const target = role === 'admin' ? '#/admin' : '#/member';
  if (window.location.hash !== target) window.location.hash = target;
}

/**
 * Wires up the login screen and returns once auth state is known.
 * onAuthed(profile) is called whenever a valid @adobe.com session becomes active.
 * onSignedOut() is called on sign-out or when no session exists.
 */
export function initAuth({ onAuthed, onSignedOut }) {
  const screen = document.getElementById('authScreen');
  const appRoot = document.getElementById('appRoot');
  const emailInput = document.getElementById('authEmail');
  const passwordInput = document.getElementById('authPassword');
  const sendBtn = document.getElementById('authSendBtn');
  const errorEl = document.getElementById('authError');
  const hintEl = document.getElementById('authHint');
  const introEl = document.getElementById('authIntro');
  const toggleEl = document.getElementById('authToggleMode');
  const signOutBtn = document.getElementById('signOutBtn');

  function showAuthScreen(msg) {
    screen.classList.remove('hidden');
    appRoot.classList.add('hidden');
    if (msg) errorEl.textContent = msg;
  }
  function showApp() {
    screen.classList.add('hidden');
    appRoot.classList.remove('hidden');
  }

  function applyMode() {
    errorEl.textContent = '';
    hintEl.textContent = 'Access is restricted to Adobe team accounts.';
    if (mode === 'signup') {
      introEl.innerHTML = 'Create your account with your <strong>@adobe.com</strong> email.';
      sendBtn.textContent = 'Create account';
      toggleEl.textContent = 'Already have an account? Sign in';
      passwordInput.autocomplete = 'new-password';
    } else {
      introEl.innerHTML = 'Sign in with your <strong>@adobe.com</strong> email and password.';
      sendBtn.textContent = 'Sign in';
      toggleEl.textContent = 'Need an account? Create one';
      passwordInput.autocomplete = 'current-password';
    }
  }

  toggleEl.addEventListener('click', () => {
    mode = mode === 'signin' ? 'signup' : 'signin';
    applyMode();
  });

  async function handleSubmit() {
    errorEl.textContent = '';
    const email = (emailInput.value || '').trim().toLowerCase();
    const password = passwordInput.value || '';
    if (!email) { errorEl.textContent = 'Enter your email address.'; return; }
    if (!isAdobeEmail(email)) { errorEl.textContent = `Only ${ALLOWED_DOMAIN} addresses can sign in.`; return; }
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
    // onAuthStateChange fires next and completes the flow.
  }

  sendBtn.addEventListener('click', handleSubmit);
  [emailInput, passwordInput].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); }));
  signOutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  window.addEventListener('hashchange', () => {
    // Guard rail: a member can't force their way into the admin route by
    // editing the URL hash directly. Admins are free to view either.
    if (!currentProfile) return;
    if (window.location.hash === '#/admin' && currentProfile.role !== 'admin') {
      window.location.hash = '#/member';
    }
  });

  applyMode();

  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentSession = session;
    if (!session) {
      currentProfile = null;
      showAuthScreen();
      onSignedOut?.();
      return;
    }
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

    showApp();
    document.body.classList.toggle('role-member', currentProfile.role !== 'admin');
    document.getElementById('whoEmail').textContent = currentProfile.email;
    document.getElementById('whoRole').textContent = currentProfile.role;
    routeForRole(currentProfile.role);
    onAuthed?.(currentProfile);
  });
}
