import React, { useMemo, useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  FlatList,
  TextInput,
  StyleSheet,
  Switch,
  Modal,
  Platform,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing, typography, radius, THEMES, getThemeId, setThemeId, subscribeTheme } from '../theme';
import { useTasks } from '../store/TasksContext';
import { authenticate, logout, serverConfig } from '../store/backend';
import { useIsWide } from '../navigation/responsive';
import { DATE_FORMATS, formatDayKey, todayKey } from '../utils/date';
import {
  getZoom,
  setZoom,
  subscribeZoom,
  ZOOM_STEP,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_DEFAULT,
} from '../utils/zoom';
import { hasWindowApi, getWindowMode, setWindowMode } from '../utils/windowMode';

// Curated IANA timezones ('' = the device's local zone).
const TIMEZONES = [
  { id: '', label: 'System default' },
  { id: 'UTC', label: 'UTC' },
  { id: 'America/Los_Angeles', label: 'Los Angeles (PT)' },
  { id: 'America/Denver', label: 'Denver (MT)' },
  { id: 'America/Chicago', label: 'Chicago (CT)' },
  { id: 'America/New_York', label: 'New York (ET)' },
  { id: 'Europe/London', label: 'London' },
  { id: 'Europe/Paris', label: 'Paris / Berlin' },
  { id: 'Asia/Dubai', label: 'Dubai' },
  { id: 'Asia/Kolkata', label: 'India (IST)' },
  { id: 'Asia/Singapore', label: 'Singapore' },
  { id: 'Asia/Tokyo', label: 'Tokyo' },
  { id: 'Australia/Sydney', label: 'Sydney' },
];

function zoneTime(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz || undefined, hour: 'numeric', minute: '2-digit', hour12: true,
    }).format(new Date());
  } catch {
    return '';
  }
}

// Every IANA time zone the runtime knows about (~400). Falls back to the curated
// list on older engines without Intl.supportedValuesOf.
const IANA_ZONES =
  typeof Intl !== 'undefined' && typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone')
    : TIMEZONES.map((t) => t.id).filter(Boolean);
// Options for the timezone Select: System default first, then every zone id.
const TZ_OPTIONS = [{ value: '', label: 'System default' }, ...IANA_ZONES.map((z) => ({ value: z, label: z }))];

// ---- Reusable content primitives -----------------------------------------

// A labelled preference row: title + hint on the left, a control on the right.
function Field({ label, hint, children, last }) {
  return (
    <View style={[styles.field, !last && styles.fieldBorder]}>
      <View style={styles.fieldLabelWrap}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {hint ? <Text style={styles.fieldHint}>{hint}</Text> : null}
      </View>
      <View style={styles.fieldControl}>{children}</View>
    </View>
  );
}

function Toggle({ value, onValueChange }) {
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ true: colors.accent, false: colors.separatorStrong }}
      ios_backgroundColor={colors.separatorStrong}
    />
  );
}

// A numeric stepper: −/+ around an editable value. Lets the user set any count
// (clamped to [min, max]) either by tapping or typing.
function Stepper({ value, onChange, min = 1, max = 99, step = 1 }) {
  const [text, setText] = useState(String(value));
  React.useEffect(() => { setText(String(value)); }, [value]);
  const clamp = (n) => Math.max(min, Math.min(max, n));
  const set = (n) => { const c = clamp(n); onChange(c); setText(String(c)); };
  const commit = () => {
    const n = parseInt(text, 10);
    set(Number.isFinite(n) ? n : value);
  };
  return (
    <View style={styles.stepper}>
      <Pressable onPress={() => set(value - step)} hitSlop={6} style={styles.stepBtn}>
        <Ionicons name="remove" size={18} color={value <= min ? colors.separatorStrong : colors.textSecondary} />
      </Pressable>
      <TextInput
        style={styles.stepValue}
        value={text}
        onChangeText={(t) => setText(t.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onSubmitEditing={commit}
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={3}
        returnKeyType="done"
        selectTextOnFocus
      />
      <Pressable onPress={() => set(value + step)} hitSlop={6} style={styles.stepBtn}>
        <Ionicons name="add" size={18} color={value >= max ? colors.separatorStrong : colors.textSecondary} />
      </Pressable>
    </View>
  );
}

// App zoom control: −/+ percentage stepper plus a Reset-to-100% button. Reads
// and writes the shared zoom module, and reflects keyboard/menu zooming live.
function ZoomControl() {
  const [zoom, setZoomState] = useState(() => getZoom());
  useEffect(() => subscribeZoom(setZoomState), []);
  const atDefault = Math.abs(zoom - ZOOM_DEFAULT) < 0.001;
  return (
    <View style={styles.zoomRow}>
      <View style={styles.stepper}>
        <Pressable onPress={() => setZoom(zoom - ZOOM_STEP)} hitSlop={6} style={styles.stepBtn}>
          <Ionicons name="remove" size={18} color={zoom <= ZOOM_MIN ? colors.separatorStrong : colors.textSecondary} />
        </Pressable>
        <Text style={styles.stepValue}>{Math.round(zoom * 100)}%</Text>
        <Pressable onPress={() => setZoom(zoom + ZOOM_STEP)} hitSlop={6} style={styles.stepBtn}>
          <Ionicons name="add" size={18} color={zoom >= ZOOM_MAX ? colors.separatorStrong : colors.textSecondary} />
        </Pressable>
      </View>
      <Pressable onPress={() => setZoom(ZOOM_DEFAULT)} disabled={atDefault} style={styles.zoomReset} hitSlop={6}>
        <Text style={[styles.zoomResetText, atDefault && styles.zoomResetTextOff]}>Reset</Text>
      </Pressable>
    </View>
  );
}

// Desktop-only: how the app window opens (maximized vs. remember last size).
// Persisted on the Go side; only rendered in the Wails build.
function WindowStartControl() {
  const [mode, setMode] = useState('maximized');
  useEffect(() => {
    let alive = true;
    getWindowMode().then((m) => { if (alive && m) setMode(m); });
    return () => { alive = false; };
  }, []);
  const choose = (m) => { setMode(m); setWindowMode(m); };
  return (
    <Segment
      options={[
        { value: 'maximized', label: 'Maximized' },
        { value: 'remember', label: 'Last size' },
      ]}
      value={mode}
      onChange={choose}
    />
  );
}

// A stateful toggle for the mock sections (not persisted).
function MockToggle({ label, hint, initial, last }) {
  const [on, setOn] = useState(!!initial);
  return (
    <Field label={label} hint={hint} last={last}>
      <Toggle value={on} onValueChange={setOn} />
    </Field>
  );
}

function Segment({ options, value, onChange }) {
  return (
    <View style={styles.segment}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable key={String(o.value)} onPress={() => onChange(o.value)} style={[styles.segBtn, active && styles.segBtnActive]}>
            <Text style={[styles.segText, active && styles.segTextActive]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// A dropdown select: a pill trigger showing the current value; tapping opens a
// floating menu anchored below (or above) it. `searchable` adds a filter box —
// used for the long IANA timezone list. `hintOf` renders a lazy right-side hint
// per row (so we only compute e.g. current-time for visible rows).
function Select({ value, options, onChange, searchable, hintOf, placeholder = 'Select…', width = 260 }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const win = useWindowDimensions();

  const selected = options.find((o) => o.value === value);
  const label = selected ? selected.label : placeholder;

  const openMenu = () => {
    setQuery('');
    const node = ref.current;
    if (node && node.measureInWindow) {
      node.measureInWindow((x, y, w, h) => { setAnchor({ x, y, w, h }); setOpen(true); });
    } else {
      setOpen(true);
    }
  };

  const filtered = searchable && query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  // Menu geometry: right-align to the trigger, flip above when there's no room.
  const menuW = Math.min(width, win.width - 24);
  let left = anchor ? anchor.x + anchor.w - menuW : 12;
  left = Math.max(12, Math.min(left, win.width - menuW - 12));
  const spaceBelow = anchor ? win.height - (anchor.y + anchor.h) - 16 : 400;
  const spaceAbove = anchor ? anchor.y - 16 : 400;
  const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
  const listMax = Math.max(140, Math.min(300, (openUp ? spaceAbove : spaceBelow) - (searchable ? 56 : 8)));
  const pos = anchor
    ? openUp
      ? { left, bottom: win.height - anchor.y + 4 }
      : { left, top: anchor.y + anchor.h + 4 }
    : { left: 12, top: 100 };

  return (
    <View>
      <Pressable ref={ref} onPress={openMenu} style={[styles.select, { maxWidth: width }]}>
        <Text style={styles.selectText} numberOfLines={1}>{label}</Text>
        <Ionicons name="chevron-down" size={16} color={colors.textSecondary} />
      </Pressable>
      <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.selectOverlay} onPress={() => setOpen(false)}>
          {anchor && (
            <Pressable style={[styles.menu, { width: menuW }, pos]} onPress={() => {}}>
              {searchable && (
                <View style={styles.menuSearch}>
                  <Ionicons name="search" size={15} color={colors.textTertiary} />
                  <TextInput
                    autoFocus
                    style={styles.menuSearchInput}
                    placeholder="Search time zones"
                    placeholderTextColor={colors.placeholder}
                    value={query}
                    onChangeText={setQuery}
                  />
                </View>
              )}
              <FlatList
                data={filtered}
                keyExtractor={(o) => String(o.value) || '__default'}
                style={{ maxHeight: listMax }}
                keyboardShouldPersistTaps="handled"
                initialNumToRender={24}
                maxToRenderPerBatch={24}
                windowSize={8}
                renderItem={({ item: o }) => {
                  const active = o.value === value;
                  const hint = hintOf ? hintOf(o) : o.hint;
                  return (
                    <Pressable
                      style={[styles.menuItem, active && styles.menuItemActive]}
                      onPress={() => { onChange(o.value); setOpen(false); }}
                    >
                      <Text style={[styles.menuItemText, active && styles.menuItemTextActive]} numberOfLines={1}>{o.label}</Text>
                      {hint ? <Text style={styles.menuItemHint}>{hint}</Text> : null}
                      {active && <Ionicons name="checkmark" size={16} color={colors.accent} style={{ marginLeft: spacing.sm }} />}
                    </Pressable>
                  );
                }}
                ListEmptyComponent={<Text style={styles.menuEmpty}>No matches</Text>}
              />
            </Pressable>
          )}
        </Pressable>
      </Modal>
    </View>
  );
}

// A bordered option list with a checkmark on the selected row.
function OptionList({ options, value, onChange, rightOf }) {
  return (
    <View style={styles.optionList}>
      {options.map((o) => {
        const active = value === o.value;
        return (
          <Pressable
            key={String(o.value) || 'default'}
            onPress={() => onChange(o.value)}
            style={[styles.optionRow, active && styles.optionRowActive]}
          >
            <Text style={[styles.optionText, active && styles.optionTextActive]}>{o.label}</Text>
            <View style={styles.optionRight}>
              {rightOf ? <Text style={styles.optionHint}>{rightOf(o)}</Text> : null}
              {active && <Ionicons name="checkmark" size={18} color={colors.accent} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

function Btn({ label, icon, onPress, variant = 'default' }) {
  return (
    <Pressable onPress={onPress} style={[styles.btn, variant === 'primary' && styles.btnPrimary, variant === 'outline' && styles.btnOutline]}>
      <Text style={[styles.btnText, variant === 'primary' && styles.btnTextPrimary, variant === 'outline' && styles.btnTextOutline]}>{label}</Text>
      {icon ? <Ionicons name={icon} size={15} color={variant === 'primary' ? colors.white : variant === 'outline' ? colors.accent : colors.textSecondary} /> : null}
    </Pressable>
  );
}

function GroupTitle({ children, style }) {
  return <Text style={[styles.groupTitle, style]}>{children}</Text>;
}

// ---- Section content ------------------------------------------------------

function AccountSection() {
  return (
    <>
      <View style={styles.field}>
        <View style={styles.fieldLabelWrap}>
          <GroupTitle>Plan</GroupTitle>
          <Text style={styles.bigValue}>Free</Text>
        </View>
        <Btn label="Manage plan" />
      </View>
      <View style={styles.hr} />

      <GroupTitle>Photo</GroupTitle>
      <View style={[styles.avatar, { marginTop: spacing.sm }]}>
        <Text style={styles.avatarText}>N</Text>
      </View>

      <GroupTitle style={{ marginTop: spacing.lg }}>Name</GroupTitle>
      <Text style={styles.value}>Nomm</Text>

      <Text style={[styles.groupTitle, { marginTop: spacing.lg }]}>Email</Text>
      <Text style={styles.value}>you@example.com</Text>

      <View style={{ marginTop: spacing.lg }}>
        <Btn label="Manage account" icon="open-outline" />
      </View>
      <Text style={[styles.fieldHint, { marginTop: spacing.sm }]}>
        To keep your account details secure, we'll take you to the browser to make changes.
      </Text>

      <View style={styles.links}>
        <Text style={styles.link}>Terms</Text>
        <Text style={styles.linkDot}>·</Text>
        <Text style={styles.link}>Privacy</Text>
        <Text style={styles.linkDot}>·</Text>
        <Text style={styles.link}>Delete account</Text>
      </View>
    </>
  );
}

function GeneralSection({ settings, setSetting }) {
  const sampleKey = todayKey();
  return (
    <>
      <MockToggle initial label="Confirm before deleting" hint="Ask for confirmation before moving a to-do to the Trash." />
      <Field
        label="Show completed items"
        hint="Display finished to-dos inside their project. The Logbook always keeps them."
      >
        <Toggle value={settings.showCompleted} onValueChange={(v) => setSetting('showCompleted', v)} />
      </Field>
      <Field
        label="Keep completed in place"
        hint="Leave finished to-dos at their position instead of moving them to the bottom of the list."
      >
        <Toggle value={settings.keepCompletedInPlace} onValueChange={(v) => setSetting('keepCompletedInPlace', v)} />
      </Field>
      <Field
        label="Partially expanded count"
        hint='How many to-dos a section shows in its partially-expanded state before a "show more" row.'
      >
        <Stepper
          value={settings.partialExpandCount ?? 10}
          onChange={(v) => setSetting('partialExpandCount', v)}
          min={1}
          max={99}
        />
      </Field>
      <Field
        label="Center content"
        hint="Constrain lists and projects to a centered column instead of the full width."
      >
        <Toggle value={settings.centeredContent} onValueChange={(v) => setSetting('centeredContent', v)} />
      </Field>
      {Platform.OS === 'web' && (
        <Field
          label="Zoom"
          hint="Scale the whole app. Also adjustable with ⌘+ / ⌘- / ⌘0 (or the View menu on desktop)."
          last={!hasWindowApi()}
        >
          <ZoomControl />
        </Field>
      )}
      {hasWindowApi() && (
        <Field
          label="Window on startup"
          hint="Open maximized, or remember the last window size and position."
          last
        >
          <WindowStartControl />
        </Field>
      )}

      <Field label="Date format" hint="Used for the date headers in the Calendar Day view.">
        <Select
          value={settings.dateFormat || 'weekday-long'}
          onChange={(v) => setSetting('dateFormat', v)}
          options={DATE_FORMATS.map((id) => ({ value: id, label: formatDayKey(sampleKey, id) }))}
          width={220}
        />
      </Field>
      <Field
        label="Time zone"
        hint='Sets what counts as "now"/"today" — affects Today, relative dates, overdue, and the current-time line.'
        last
      >
        <Select
          value={settings.timezone || ''}
          onChange={(v) => setSetting('timezone', v)}
          options={TZ_OPTIONS}
          hintOf={(o) => zoneTime(o.value)}
          searchable
          width={300}
        />
      </Field>
    </>
  );
}

function CalendarsSection({ settings, setSetting }) {
  return (
    <>
      <Field label="Day starts at" hint="First hour shown in the Calendar Day and Week timelines.">
        <Segment
          options={[{ value: 0, label: '12 AM' }, { value: 6, label: '6 AM' }]}
          value={settings.dayStartHour ?? 0}
          onChange={(v) => setSetting('dayStartHour', v)}
        />
      </Field>
      <Field label="Show weekends" hint="Include Saturday and Sunday in the Calendar Week view." last>
        <Toggle value={settings.showWeekends} onValueChange={(v) => setSetting('showWeekends', v)} />
      </Field>

      <View style={styles.hr} />
      <GroupTitle>Calendar accounts</GroupTitle>
      <Text style={styles.fieldHint}>Show events from your calendars alongside your to-dos.</Text>
      <View style={[styles.integ, { marginTop: spacing.sm }]}>
        <View style={styles.integLeft}>
          <Ionicons name="calendar" size={20} color={colors.textSecondary} />
          <Text style={styles.integName}>Apple Calendar</Text>
        </View>
        <Btn label="Connect" variant="outline" />
      </View>
      <View style={styles.integ}>
        <View style={styles.integLeft}>
          <Ionicons name="logo-google" size={20} color={colors.textSecondary} />
          <Text style={styles.integName}>Google Calendar</Text>
        </View>
        <Btn label="Connect" variant="outline" />
      </View>
    </>
  );
}

function BackupsSection({ reset, onClose }) {
  return (
    <>
      <MockToggle initial label="Automatic backups" hint="Back up your data to the cloud every day." />
      <Field label="Last backup" hint="Backups are encrypted end-to-end." last>
        <Text style={styles.value}>Today, 9:41 AM</Text>
      </Field>
      <View style={styles.hr} />
      <GroupTitle>Sample data</GroupTitle>
      <Text style={styles.fieldHint}>
        The app starts empty. Load a rich set of demo to-dos to explore every
        view. This replaces whatever is currently on this device.
      </Text>
      <View style={{ marginTop: spacing.md, alignItems: 'flex-start' }}>
        <Btn label="Load sample data" icon="sparkles" variant="outline" onPress={() => { reset(); onClose(); }} />
      </View>
    </>
  );
}

// Cloud sync + offline status. Every platform runs the same field-level CRDT
// (Go SQLite on desktop/mobile, JS + IndexedDB on web) so it's always a full
// offline-first replica. On web you sign in to a sync server to converge across
// devices; "Sync now" runs one push/pull cycle and reports what moved.
function SyncSection() {
  const { syncNow, backendName, reconnectSync } = useTasks();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState(() => serverConfig());
  const backend = backendName ? backendName() : 'local';
  const isWeb = Platform.OS === 'web';
  const label = {
    wails: 'Embedded SQLite CRDT (desktop)',
    native: 'Embedded SQLite CRDT (mobile)',
    wasm: 'Go CRDT via WASM + Worker (browser)',
    indexeddb: 'CRDT + IndexedDB (browser)',
    localstorage: 'CRDT + local storage',
  }[backend] || backend;

  // Sign-in form state (web).
  const [url, setUrl] = useState('http://localhost:8090');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authErr, setAuthErr] = useState(null);
  const [authBusy, setAuthBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setStatus(await syncNow());
    } catch (e) {
      setStatus({ error: String(e && e.message ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  const connect = async (mode) => {
    setAuthBusy(true);
    setAuthErr(null);
    try {
      await authenticate(url, username.trim(), password, mode);
      setCfg(serverConfig());
      reconnectSync(); // kick off initial sync + realtime
      setPassword('');
    } catch (e) {
      setAuthErr(String(e && e.message ? e.message : e));
    } finally {
      setAuthBusy(false);
    }
  };

  const disconnect = () => {
    logout();
    setCfg(null);
    setStatus(null);
    reconnectSync();
  };

  const cloud = status && status.adapter === 'server';

  return (
    <>
      <Field label="Local store" hint="Every platform is a full CRDT replica — the app works fully offline and merges per-field on sync.">
        <Text style={styles.value}>{label}</Text>
      </Field>

      {cfg ? (
        <>
          <Field label="Signed in" hint="Your devices converge automatically through this account." last>
            <Text style={styles.value}>{cfg.username || 'account'}</Text>
          </Field>
          <View style={{ marginTop: spacing.md, flexDirection: 'row', gap: spacing.md }}>
            <Btn label={busy ? 'Syncing…' : 'Sync now'} icon="sync" variant="outline" onPress={busy ? undefined : run} />
            <Btn label="Sign out" variant="outline" onPress={disconnect} />
          </View>
          {status && (
            <Text style={[styles.fieldHint, { marginTop: spacing.md }]}>
              {status.error
                ? `Sync failed: ${status.error}`
                : cloud
                ? `Synced — pushed ${status.pushed || 0}, applied ${status.applied || 0}${status.skipped ? `, kept ${status.skipped} local` : ''}.`
                : 'Saved locally.'}
            </Text>
          )}
        </>
      ) : isWeb ? (
        <>
          <View style={styles.hr} />
          <GroupTitle>Connect to sync server</GroupTitle>
          <Text style={styles.fieldHint}>
            Sign in to converge this browser with your other devices in real time. Without an account, this browser still works fully offline.
          </Text>
          <TextInput style={styles.syncInput} value={url} onChangeText={setUrl} placeholder="Server URL" placeholderTextColor={colors.placeholder} autoCapitalize="none" autoCorrect={false} />
          <TextInput style={styles.syncInput} value={username} onChangeText={setUsername} placeholder="Username" placeholderTextColor={colors.placeholder} autoCapitalize="none" autoCorrect={false} />
          <TextInput style={styles.syncInput} value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.placeholder} secureTextEntry />
          <View style={{ marginTop: spacing.md, flexDirection: 'row', gap: spacing.md }}>
            <Btn label={authBusy ? '…' : 'Sign in'} variant="primary" onPress={authBusy ? undefined : () => connect('login')} />
            <Btn label="Create account" variant="outline" onPress={authBusy ? undefined : () => connect('register')} />
          </View>
          {authErr && <Text style={[styles.fieldHint, { marginTop: spacing.sm, color: colors.overdue }]}>{authErr}</Text>}
        </>
      ) : (
        <Field label="Cloud sync" hint="Set THINGS_SYNC_URL to sync desktop/mobile against a server; otherwise a local mock adapter is used." last>
          <Text style={styles.value}>Embedded</Text>
        </Field>
      )}
    </>
  );
}

// A single two-tone theme swatch: a sidebar band against the content surface
// with an accent dot. System shows a split light/dark chip.
function ThemeSwatch({ theme }) {
  if (theme.system) {
    return (
      <View style={styles.themeSwatch}>
        <View style={[styles.themeSwatchHalf, { backgroundColor: '#f5f6f8' }]} />
        <View style={[styles.themeSwatchHalf, { backgroundColor: '#18181a' }]} />
      </View>
    );
  }
  const p = theme.palette;
  return (
    <View style={[styles.themeSwatch, { backgroundColor: p.background }]}>
      <View style={[styles.themeSwatchSidebar, { backgroundColor: p.groupedBackground }]} />
      <View style={[styles.themeSwatchDot, { backgroundColor: p.accent }]} />
    </View>
  );
}

function ThemeSection() {
  const [themeId, setThemeState] = useState(() => getThemeId());
  useEffect(() => subscribeTheme(setThemeState), []);
  return (
    <>
      <View style={styles.field}>
        <View style={styles.fieldLabelWrap}>
          <Text style={styles.fieldLabel}>Theme</Text>
          <Text style={styles.fieldHint}>
            System follows your OS light/dark setting. Every theme is two-tone — a
            tinted sidebar against the content pane.
          </Text>
        </View>
      </View>
      <View style={styles.themeGrid}>
        {THEMES.map((t) => {
          const active = t.id === themeId;
          return (
            <Pressable
              key={t.id}
              onPress={() => setThemeId(t.id)}
              style={[styles.themeCard, active && styles.themeCardActive]}
            >
              <ThemeSwatch theme={t} />
              <View style={styles.themeCardLabel}>
                <Text style={styles.themeName} numberOfLines={1}>{t.name}</Text>
                {active && <Ionicons name="checkmark-circle" size={16} color={colors.accent} />}
              </View>
            </Pressable>
          );
        })}
      </View>
    </>
  );
}

function IntegrationsSection() {
  const items = [
    { icon: 'logo-slack', name: 'Slack', desc: 'Turn messages into to-dos.' },
    { icon: 'logo-github', name: 'GitHub', desc: 'Link issues and pull requests.' },
    { icon: 'mail-outline', name: 'Email to Inbox', desc: 'Forward emails to capture them.' },
    { icon: 'logo-figma', name: 'Figma', desc: 'Attach designs to tasks.' },
  ];
  return (
    <>
      {items.map((it, i) => (
        <View key={it.name} style={[styles.integ, i < items.length - 1 && styles.fieldBorder]}>
          <View style={styles.integLeft}>
            <Ionicons name={it.icon} size={22} color={colors.textSecondary} />
            <View>
              <Text style={styles.integName}>{it.name}</Text>
              <Text style={styles.fieldHint}>{it.desc}</Text>
            </View>
          </View>
          <Btn label="Connect" variant="outline" />
        </View>
      ))}
    </>
  );
}

// Lighter placeholder sections built from a few mock rows.
function MockSection({ rows, note }) {
  return (
    <>
      {rows.map((r, i) => (
        <MockToggle key={r.label} label={r.label} hint={r.hint} initial={r.initial} last={i === rows.length - 1} />
      ))}
      {note ? <Text style={[styles.fieldHint, { marginTop: spacing.md }]}>{note}</Text> : null}
    </>
  );
}

// ---- The two-panel settings modal ----------------------------------------

export default function SettingsSheet({ visible, onClose }) {
  const { state, setSetting, reset } = useTasks();
  const insets = useSafeAreaInsets();
  const isWide = useIsWide();
  const [active, setActive] = useState('account');
  const [query, setQuery] = useState('');
  // Advanced/placeholder sections are hidden until the user expands the list.
  const [showAll, setShowAll] = useState(false);
  // On narrow screens the nav and the section are separate views (master/detail).
  const [showNav, setShowNav] = useState(true);

  const settings = state.settings;

  const SECTIONS = useMemo(() => [
    { id: 'account', label: 'Account', icon: 'person-circle-outline', render: () => <AccountSection /> },
    { id: 'general', label: 'General', icon: 'options-outline', render: () => <GeneralSection settings={settings} setSetting={setSetting} /> },
    { id: 'desktop', label: 'Desktop', icon: 'desktop-outline', hidden: true, render: () => (
      <MockSection rows={[
        { label: 'Launch at login', hint: 'Open the app automatically when you sign in.', initial: true },
        { label: 'Keep in menu bar', hint: 'Show a quick-access icon in the menu bar.' },
        { label: 'Show dock badge', hint: 'Badge the app icon with your Today count.', initial: true },
      ]} />
    ) },
    { id: 'subscription', label: 'Subscription', icon: 'card-outline', hidden: true, render: () => (
      <>
        <View style={styles.planCard}>
          <Text style={styles.planName}>Free</Text>
          <Text style={styles.fieldHint}>Unlimited to-dos and projects. Upgrade for calendar sync, backups, and teams.</Text>
          <View style={{ marginTop: spacing.md, alignItems: 'flex-start' }}>
            <Btn label="Upgrade to Pro" variant="primary" />
          </View>
        </View>
      </>
    ) },
    { id: 'theme', label: 'Theme', icon: 'color-palette-outline', render: () => <ThemeSection /> },
    { id: 'sidebar', label: 'Sidebar', icon: 'browsers-outline', hidden: true, render: () => (
      <MockSection
        rows={[
          { label: 'Show item counts', hint: 'Display the number of to-dos next to each list.', initial: true },
          { label: 'Show project progress', hint: 'Show the little progress ring on projects.', initial: true },
        ]}
        note="Tip: drag the smart lists in the sidebar to reorder them."
      />
    ) },
    { id: 'quickadd', label: 'Quick Add', icon: 'add-circle-outline', hidden: true, render: () => (
      <MockSection rows={[
        { label: 'Global shortcut', hint: 'Capture a to-do from anywhere with ⌃Space.', initial: true },
        { label: 'Paste links as titles', hint: 'Fetch the page title when you paste a URL.' },
      ]} />
    ) },
    { id: 'productivity', label: 'Productivity', icon: 'trending-up-outline', hidden: true, render: () => (
      <MockSection rows={[
        { label: 'Daily goal', hint: 'Celebrate when you clear your Today list.', initial: true },
        { label: 'Track streaks', hint: 'Count consecutive days you finish everything.' },
      ]} />
    ) },
    { id: 'reminders', label: 'Reminders', icon: 'alarm-outline', hidden: true, render: () => (
      <MockSection rows={[
        { label: 'Default reminder', hint: 'Remind me at 9:00 AM on the due date.', initial: true },
        { label: 'Nudge overdue items', hint: 'A gentle daily reminder for anything overdue.' },
      ]} />
    ) },
    { id: 'notifications', label: 'Notifications', icon: 'notifications-outline', hidden: true, render: () => (
      <MockSection rows={[
        { label: 'Push notifications', hint: 'Reminders and shared-list updates.', initial: true },
        { label: 'Play a sound', initial: true },
        { label: 'Weekly review', hint: 'A Sunday summary of the week ahead.' },
      ]} />
    ) },
    { id: 'sync', label: 'Sync', icon: 'sync-outline', render: () => <SyncSection /> },
    { id: 'backups', label: 'Backups', icon: 'cloud-upload-outline', render: () => <BackupsSection reset={reset} onClose={onClose} /> },
    { id: 'integrations', label: 'Integrations', icon: 'extension-puzzle-outline', hidden: true, render: () => <IntegrationsSection /> },
    { id: 'calendars', label: 'Calendars', icon: 'calendar-outline', render: () => <CalendarsSection settings={settings} setSetting={setSetting} /> },
  ], [settings, setSetting, reset, onClose]);

  const hiddenCount = SECTIONS.filter((s) => s.hidden).length;
  const filtered = query
    ? SECTIONS.filter((s) => s.label.toLowerCase().includes(query.toLowerCase()))
    : SECTIONS.filter((s) => showAll || !s.hidden || s.id === active);
  const current = SECTIONS.find((s) => s.id === active) || SECTIONS[0];

  const openSection = (id) => {
    setActive(id);
    setShowNav(false);
  };

  const nav = (
    <View style={[styles.nav, isWide && styles.navWide]}>
      {isWide && <Text style={styles.navTitle}>Settings</Text>}
      <View style={styles.search}>
        <Ionicons name="search" size={16} color={colors.sidebarTextTertiary} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search"
          placeholderTextColor={colors.sidebarTextTertiary}
          value={query}
          onChangeText={setQuery}
        />
      </View>
      <ScrollView style={styles.navList} showsVerticalScrollIndicator={false}>
        {filtered.map((s) => {
          const on = s.id === active;
          return (
            <Pressable key={s.id} onPress={() => openSection(s.id)} style={[styles.navItem, on && isWide && styles.navItemActive]}>
              <Ionicons name={s.icon} size={20} color={on ? colors.accent : colors.sidebarTextSecondary} />
              <Text style={[styles.navLabel, on && isWide && styles.navLabelActive]}>{s.label}</Text>
              {!isWide && <Ionicons name="chevron-forward" size={16} color={colors.sidebarTextTertiary} style={{ marginLeft: 'auto' }} />}
            </Pressable>
          );
        })}
        {filtered.length === 0 && <Text style={styles.noResults}>No settings found</Text>}
        {!query && hiddenCount > 0 && (
          <Pressable style={styles.navItem} onPress={() => setShowAll((v) => !v)}>
            <Ionicons name={showAll ? 'chevron-up' : 'ellipsis-horizontal'} size={20} color={colors.sidebarTextTertiary} />
            <Text style={[styles.navLabel, { color: colors.sidebarTextSecondary }]}>
              {showAll ? 'Show fewer' : `Show all settings`}
            </Text>
          </Pressable>
        )}
      </ScrollView>
      <Pressable style={styles.addTeam} onPress={() => {}}>
        <Ionicons name="add" size={18} color={colors.sidebarTextSecondary} />
        <Text style={styles.addTeamText}>Add team</Text>
      </Pressable>
    </View>
  );

  const detail = (
    <View style={styles.content}>
      <View style={styles.contentHeader}>
        {!isWide && (
          <Pressable hitSlop={8} onPress={() => setShowNav(true)} style={styles.back}>
            <Ionicons name="chevron-back" size={24} color={colors.accent} />
          </Pressable>
        )}
        <Text style={styles.contentTitle}>{current.label}</Text>
        <Pressable hitSlop={8} onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={22} color={colors.textSecondary} />
        </Pressable>
      </View>
      <ScrollView style={styles.contentScroll} contentContainerStyle={styles.contentInner} showsVerticalScrollIndicator={false}>
        {current.render()}
      </ScrollView>
    </View>
  );

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable
          style={[
            styles.panel,
            isWide ? styles.panelWide : [styles.panelFull, { paddingTop: insets.top, paddingBottom: insets.bottom }],
          ]}
          onPress={() => {}}
        >
          {isWide ? (
            <>
              {nav}
              {detail}
            </>
          ) : showNav ? (
            <View style={styles.mobileNav}>
              <View style={styles.contentHeader}>
                <Text style={styles.contentTitle}>Settings</Text>
                <Pressable hitSlop={8} onPress={onClose} style={styles.close}>
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>
              {nav}
            </View>
          ) : (
            detail
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const NAV_W = 248;

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'default' } : null),
  },
  panel: {
    backgroundColor: colors.background,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 24px 60px rgba(0,0,0,0.28)' },
      default: { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 40, shadowOffset: { width: 0, height: 20 }, elevation: 24 },
    }),
  },
  panelWide: {
    flexDirection: 'row',
    width: '90%',
    maxWidth: 1040,
    height: '86%',
    maxHeight: 780,
    borderRadius: 16,
  },
  panelFull: { width: '100%', height: '100%' },

  // --- Left nav (uses the sidebar tone, so the dialog is two-tone like the app) ---
  nav: { flex: 1, backgroundColor: colors.groupedBackground, paddingHorizontal: spacing.md, paddingTop: spacing.lg },
  // Fixed-width sidebar column. Explicit flex trio (not `flex: 0`) so it fully
  // overrides the base `flex: 1` on web and never shrinks to its content.
  navWide: {
    width: NAV_W,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: NAV_W,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.sidebarSeparator,
  },
  mobileNav: { flex: 1, backgroundColor: colors.groupedBackground },
  navTitle: { ...typography.title, color: colors.sidebarText, paddingHorizontal: spacing.sm, marginBottom: spacing.md },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sidebarHover,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    height: 36,
    marginBottom: spacing.md,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.sidebarText, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  navList: { flex: 1 },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: 9,
    borderRadius: radius.md,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  navItemActive: { backgroundColor: colors.sidebarSelected },
  navLabel: { ...typography.body, color: colors.sidebarText },
  navLabelActive: { color: colors.accent, fontWeight: '600' },
  noResults: { ...typography.subhead, color: colors.sidebarTextTertiary, padding: spacing.md },
  addTeam: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.sidebarSeparator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  addTeamText: { ...typography.body, color: colors.sidebarTextSecondary, fontWeight: '600' },

  // --- Right content (content tone) ---
  content: { flex: 1, backgroundColor: colors.background },
  contentHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    height: 60,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.separator,
  },
  back: { marginLeft: -spacing.sm },
  contentTitle: { ...typography.title, color: colors.text, flex: 1 },
  close: { marginRight: -spacing.sm, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  contentScroll: { flex: 1 },
  contentInner: { paddingHorizontal: spacing.xl, paddingVertical: spacing.xl, maxWidth: 720 },

  // --- Fields ---
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    paddingVertical: spacing.md,
  },
  fieldBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.separator },
  fieldLabelWrap: { flex: 1 },
  fieldLabel: { ...typography.body, color: colors.text, fontWeight: '500' },
  fieldHint: { ...typography.subhead, color: colors.textTertiary, marginTop: 2 },
  fieldControl: { flexShrink: 0 },
  groupTitle: { ...typography.subhead, color: colors.textSecondary, fontWeight: '700', textTransform: 'none' },
  value: { ...typography.body, color: colors.text, marginTop: 4 },
  syncInput: {
    ...typography.body,
    color: colors.text,
    backgroundColor: colors.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? spacing.sm : spacing.xs,
    marginTop: spacing.sm,
    minHeight: 38,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },
  bigValue: { ...typography.title, color: colors.text, marginTop: 2 },
  hr: { height: StyleSheet.hairlineWidth, backgroundColor: colors.separator, marginVertical: spacing.lg },

  // --- Stepper ---
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  stepBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  stepValue: {
    minWidth: 44,
    textAlign: 'center',
    ...typography.body,
    color: colors.text,
    fontVariant: ['tabular-nums'],
    paddingVertical: 4,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null),
  },

  // --- Zoom ---
  zoomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  zoomReset: { paddingVertical: 4, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  zoomResetText: { ...typography.subhead, color: colors.accent, fontWeight: '600' },
  zoomResetTextOff: { color: colors.textTertiary, fontWeight: '400' },

  // --- Segment ---
  segment: { flexDirection: 'row', backgroundColor: colors.separator, borderRadius: 8, padding: 2, gap: 2 },
  segBtn: { paddingHorizontal: spacing.md, paddingVertical: 5, borderRadius: 6, ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null) },
  segBtnActive: { backgroundColor: colors.background },
  segText: { ...typography.subhead, color: colors.textSecondary },
  segTextActive: { color: colors.text, fontWeight: '600' },

  // --- Select (dropdown) ---
  select: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    height: 34,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    backgroundColor: colors.background,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  selectText: { flex: 1, ...typography.subhead, color: colors.text, fontWeight: '500' },
  selectOverlay: { flex: 1, ...(Platform.OS === 'web' ? { cursor: 'default' } : null) },
  menu: {
    position: 'absolute',
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    paddingVertical: spacing.xs,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 12px 32px rgba(0,0,0,0.18)' },
      default: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 20, shadowOffset: { width: 0, height: 10 }, elevation: 16 },
    }),
  },
  menuSearch: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.sm,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: colors.separator,
  },
  menuSearchInput: { flex: 1, ...typography.subhead, color: colors.text, padding: 0, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : null) },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  menuItemActive: { backgroundColor: colors.accentSoft },
  menuItemText: { flex: 1, ...typography.subhead, color: colors.text },
  menuItemTextActive: { color: colors.accent, fontWeight: '600' },
  menuItemHint: { ...typography.caption, color: colors.textTertiary, fontVariant: ['tabular-nums'], marginLeft: spacing.sm },
  menuEmpty: { ...typography.subhead, color: colors.textTertiary, padding: spacing.md, textAlign: 'center' },

  // --- Option list ---
  optionList: { marginTop: spacing.md, gap: 4 },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  optionRowActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionText: { ...typography.body, color: colors.text },
  optionTextActive: { color: colors.accent, fontWeight: '600' },
  optionRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  optionHint: { ...typography.subhead, color: colors.textTertiary, fontVariant: ['tabular-nums'] },

  // --- Buttons ---
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.md,
    backgroundColor: colors.separator,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  btnText: { ...typography.subhead, color: colors.text, fontWeight: '600' },
  btnPrimary: { backgroundColor: colors.accent },
  btnTextPrimary: { color: colors.white },
  btnOutline: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.accent },
  btnTextOutline: { color: colors.accent },

  // --- Account ---
  avatar: { width: 84, height: 84, borderRadius: radius.md, backgroundColor: '#E91E8C', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.white, fontSize: 40, fontWeight: '700' },
  links: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl },
  link: { ...typography.subhead, color: colors.accent, textDecorationLine: 'underline' },
  linkDot: { ...typography.subhead, color: colors.textTertiary },

  // --- Integrations / plan ---
  integ: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.md },
  integLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  integName: { ...typography.body, color: colors.text, fontWeight: '500' },
  planCard: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.separatorStrong, borderRadius: radius.md, padding: spacing.lg },
  planName: { ...typography.title, color: colors.text, marginBottom: 4 },

  // --- Theme ---
  themeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
  themeCard: {
    width: 132,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separatorStrong,
    overflow: 'hidden',
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : null),
  },
  themeCardActive: { borderWidth: 2, borderColor: colors.accent },
  themeSwatch: { height: 56, flexDirection: 'row', alignItems: 'center' },
  themeSwatchSidebar: { width: '34%', height: '100%' },
  themeSwatchHalf: { flex: 1, height: '100%' },
  themeSwatchDot: { width: 16, height: 16, borderRadius: 8, marginLeft: spacing.md },
  themeCardLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    backgroundColor: colors.card,
  },
  themeName: { ...typography.subhead, color: colors.text, fontWeight: '600', flex: 1 },
});
