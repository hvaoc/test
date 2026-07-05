import React, { useState, useEffect } from 'react';
import {
  Modal, View, Text, TextInput, Pressable, StyleSheet, Platform, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography, radius } from '../theme';
import { useTasks } from '../store/TasksContext';
import { authenticate, updateServerProfile } from '../store/backend';
import { resendVerification, getProfile, requestReset, resetPassword } from '../store/teamApi';
import { registerAuthOpener } from '../store/authModal';

// First-class Login / Sign Up / Verify modal. Opened from anywhere via
// authModal.openAuth('login'|'signup'). The app still works offline if dismissed.
export default function AuthSheet() {
  const { refreshWorkspace } = useTasks();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('login'); // login | signup
  const [step, setStep] = useState('form'); // form | verify | forgot | reset
  const [reason, setReason] = useState(null);
  const [resetCode, setResetCode] = useState(null);
  const [newPassword, setNewPassword] = useState('');

  const [url, setUrl] = useState('http://localhost:8090');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [info, setInfo] = useState(null);

  useEffect(
    () =>
      registerAuthOpener((m, opts = {}) => {
        setReason(opts.reason || null);
        setErr(null);
        setInfo(null);
        if (m === 'reset' && opts.code) {
          setResetCode(opts.code);
          setNewPassword('');
          setStep('reset');
        } else {
          setMode(m === 'signup' ? 'signup' : 'login');
          setStep('form');
        }
        setOpen(true);
      }),
    []
  );

  const close = () => {
    setOpen(false);
    setPassword('');
    setErr(null);
    setInfo(null);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await authenticate(
        url.trim(), username.trim(), password, workspace.trim(), email.trim(),
        mode === 'signup' ? 'signup' : 'login'
      );
      await refreshWorkspace();
      setPassword('');
      if (mode === 'signup' && email.trim() && !res.verified) {
        setStep('verify');
      } else {
        close();
      }
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const doResend = async () => {
    setInfo(null);
    setErr(null);
    try {
      await resendVerification();
      setInfo('Sent — check your inbox.');
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  const doCheck = async () => {
    setInfo(null);
    setErr(null);
    try {
      const r = await getProfile();
      if (r.profile && r.profile.verified) {
        updateServerProfile({ verified: true });
        close();
      } else {
        setInfo('Not verified yet — open the link we emailed you.');
      }
    } catch (e) {
      setErr(String(e.message || e));
    }
  };

  const doForgot = async () => {
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      await requestReset(username.trim() || email.trim(), url.trim());
      setInfo('If that account exists, a reset link is on its way. Check your email.');
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    setBusy(true);
    setErr(null);
    try {
      await resetPassword(resetCode, newPassword, url.trim());
      setNewPassword('');
      setResetCode(null);
      setMode('login');
      setStep('form');
      setInfo('Password updated — sign in with your new password.');
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  const isSignup = mode === 'signup';

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close}>
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Pressable hitSlop={10} onPress={close} style={styles.x}>
            <Ionicons name="close" size={22} color={colors.textTertiary} />
          </Pressable>

          {step === 'verify' ? (
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.brand}><Text style={styles.brandText}>Verify your email</Text></View>
              <Ionicons name="mail-unread-outline" size={40} color={colors.accent} style={{ alignSelf: 'center', marginVertical: spacing.md }} />
              <Text style={styles.lead}>We emailed a verification link to{'\n'}<Text style={{ fontWeight: '700' }}>{email.trim()}</Text>.</Text>
              <Text style={styles.sub}>Open it to confirm your account. You can keep using the app meanwhile.</Text>
              {info && <Text style={styles.ok}>{info}</Text>}
              {err && <Text style={styles.err}>{err}</Text>}
              <Btn label="I've verified — continue" onPress={doCheck} />
              <Btn label="Resend email" variant="outline" onPress={doResend} />
              <Pressable onPress={close}><Text style={styles.link}>Continue without verifying</Text></Pressable>
            </ScrollView>
          ) : step === 'forgot' ? (
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.brand}><Text style={styles.brandText}>Reset password</Text></View>
              <Text style={styles.sub}>Enter your username or email and we’ll send a reset link.</Text>
              <Field icon="person-outline" value={username} onChangeText={setUsername} placeholder="Username or email" autoCapitalize="none" />
              {info && <Text style={styles.ok}>{info}</Text>}
              {err && <Text style={styles.err}>{err}</Text>}
              <Btn label={busy ? 'Please wait…' : 'Send reset link'} onPress={doForgot} disabled={busy || !username.trim()} />
              <Pressable onPress={() => { setStep('form'); setErr(null); setInfo(null); }}><Text style={styles.link}>Back to sign in</Text></Pressable>
            </ScrollView>
          ) : step === 'reset' ? (
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.brand}><Text style={styles.brandText}>Set a new password</Text></View>
              <Field icon="lock-closed-outline" value={newPassword} onChangeText={setNewPassword} placeholder="New password (min 6 chars)" secureTextEntry onSubmitEditing={doReset} />
              {err && <Text style={styles.err}>{err}</Text>}
              <Btn label={busy ? 'Please wait…' : 'Update password'} onPress={doReset} disabled={busy || newPassword.length < 6} />
              <Pressable onPress={() => { setStep('form'); setErr(null); }}><Text style={styles.link}>Cancel</Text></Pressable>
            </ScrollView>
          ) : (
            <ScrollView contentContainerStyle={styles.body}>
              <View style={styles.brand}><Text style={styles.brandText}>PlayTasks</Text></View>
              <Text style={styles.title}>{isSignup ? 'Create your account' : 'Welcome back'}</Text>
              {reason && <Text style={styles.reason}>{reason}</Text>}
              {info && <Text style={styles.ok}>{info}</Text>}

              <Field icon="person-outline" value={username} onChangeText={setUsername} placeholder={isSignup ? 'Username' : 'Username or email'} autoCapitalize="none" />
              {isSignup && (
                <Field icon="mail-outline" value={email} onChangeText={setEmail} placeholder="Email (for verification)" autoCapitalize="none" keyboardType="email-address" />
              )}
              <Field icon="lock-closed-outline" value={password} onChangeText={setPassword} placeholder="Password" secureTextEntry onSubmitEditing={submit} />

              {!isSignup && (
                <Pressable onPress={() => { setStep('forgot'); setErr(null); setInfo(null); }} style={{ alignSelf: 'flex-end' }}>
                  <Text style={styles.link}>Forgot password?</Text>
                </Pressable>
              )}

              <Pressable onPress={() => setAdvanced((a) => !a)} style={styles.advToggle}>
                <Ionicons name={advanced ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textTertiary} />
                <Text style={styles.advText}>Server &amp; workspace</Text>
              </Pressable>
              {advanced && (
                <>
                  <Field icon="server-outline" value={url} onChangeText={setUrl} placeholder="Server URL" autoCapitalize="none" />
                  <Field icon="people-outline" value={workspace} onChangeText={setWorkspace} placeholder="Workspace code (optional)" autoCapitalize="none" />
                </>
              )}

              {err && <Text style={styles.err}>{err}</Text>}
              <Btn label={busy ? 'Please wait…' : isSignup ? 'Create account' : 'Sign in'} onPress={submit} disabled={busy || !username.trim() || !password || (isSignup && !email.trim())} />

              <Pressable onPress={() => { setMode(isSignup ? 'login' : 'signup'); setErr(null); }}>
                <Text style={styles.link}>
                  {isSignup ? 'Already have an account? Sign in' : 'New here? Create an account'}
                </Text>
              </Pressable>
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

function Field({ icon, ...props }) {
  return (
    <View style={styles.field}>
      <Ionicons name={icon} size={18} color={colors.textTertiary} />
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.placeholder}
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

function Btn({ label, onPress, variant = 'primary', disabled }) {
  const primary = variant === 'primary';
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      style={[
        styles.btn,
        primary ? { backgroundColor: colors.accent } : { borderWidth: 1, borderColor: colors.separatorStrong },
        disabled && { opacity: 0.45 },
      ]}
    >
      <Text style={[styles.btnText, { color: primary ? '#fff' : colors.accent }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: {
    width: '100%', maxWidth: 380, backgroundColor: colors.overlay || colors.background,
    borderRadius: radius.xl, overflow: 'hidden', maxHeight: '90%',
    ...(Platform.OS === 'web' ? { boxShadow: '0 12px 40px rgba(0,0,0,0.3)' } : null),
  },
  x: { position: 'absolute', top: spacing.md, right: spacing.md, zIndex: 2, padding: 4 },
  body: { padding: spacing.xl, gap: spacing.md },
  brand: { alignItems: 'center', marginBottom: spacing.xs },
  brandText: { ...typography.title, color: colors.accent, fontWeight: '800' },
  title: { ...typography.title, color: colors.text, textAlign: 'center' },
  lead: { ...typography.body, color: colors.text, textAlign: 'center' },
  sub: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
  reason: { ...typography.caption, color: colors.accent, textAlign: 'center' },
  field: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surfaceMuted, borderRadius: radius.md, paddingHorizontal: spacing.md },
  input: { flex: 1, ...typography.body, color: colors.text, paddingVertical: Platform.OS === 'web' ? 12 : 10, outlineStyle: 'none' },
  advToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start' },
  advText: { ...typography.caption, color: colors.textTertiary },
  btn: { borderRadius: radius.md, paddingVertical: 12, alignItems: 'center' },
  btnText: { ...typography.body, fontWeight: '700' },
  link: { ...typography.caption, color: colors.accent, textAlign: 'center', marginTop: spacing.xs },
  err: { ...typography.caption, color: colors.overdue, textAlign: 'center' },
  ok: { ...typography.caption, color: colors.today, textAlign: 'center' },
});
