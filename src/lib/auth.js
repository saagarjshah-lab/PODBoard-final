import { supabase, ALLOWED_DOMAIN } from './supabaseClient.js';

let currentSession = null;
let currentProfile = null; // { id, email, role }

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

/**
 * Wires up the login screen and returns once auth state is known.
 * onAuthed(profile) is called whenever a valid @adobe.com session becomes active.
 * onSignedOut() is called on sign-out or when no session exists.
 */
export function initAuth({ onAuthed, onSignedOut }) {
  const screen = document.getElementById('authScreen');
  const appRoot = document.getElementById('appRoot');
  const emailInput = document.getElementById('authEmail');
  const sendBtn = document.getElementById('authSendBtn');
  const errorEl = document.getElementById('authError');
  const hintEl = document.getElementById('authHint');
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

  async function handleSend() {
    errorEl.textContent = '';
    const email = (emailInput.value || '').trim().toLowerCase();
    if (!email) { errorEl.textContent = 'Enter your email address.'; return; }
    if (!isAdobeEmail(email)) {
      errorEl.textContent = `Only ${ALLOWED_DOMAIN} addresses can sign in.`;
      return;
    }
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send login link';
    if (error) {
      // The DB trigger rejects non-adobe.com signups server-side too; surface that here.
      errorEl.textContent = error.message.includes('adobe.com')
        ? `Only ${ALLOWED_DOMAIN} addresses can sign in.`
        : `Could not send link: ${error.message}`;
      return;
    }
    hintEl.textContent = `Check ${email} for the login link.`;
  }

  sendBtn.addEventListener('click', handleSend);
  emailInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSend(); });
  signOutBtn.addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

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
    showApp();
    document.body.classList.toggle('role-member', currentProfile.role !== 'admin');
    document.getElementById('whoEmail').textContent = currentProfile.email;
    document.getElementById('whoRole').textContent = currentProfile.role;
    onAuthed?.(currentProfile);
  });
}
