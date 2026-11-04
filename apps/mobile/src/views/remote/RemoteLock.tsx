/**
 * The remote PIN lock as the phone meets it (apps/client-web
 * views/remote/RemoteLock.tsx): the lock screen over the whole app while the
 * computer has it locked, and the PIN sheet a sensitive action asks with. The
 * lock itself (client-core lock.ts) holds every locked request until the PIN
 * is in, then sends it again.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, BackHandler, Pressable, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";
import type { Lock, LockView } from "@ue-mcp-studio/client-core";
import { Button, font, T, useStyles, useTheme, type Theme } from "../../ui";
import { useLockView } from "../../connection";
import { haptic } from "../../native/haptics";
import { useBiometricUnlock } from "../../native/biometric";

/** Seconds left of a wait the computer set, counting down. */
function useCountdown(ms: number | undefined): number {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!ms || ms <= 0) return setLeft(0);
    const end = Date.now() + ms;
    const tick = () => setLeft(Math.max(0, Math.ceil((end - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [ms]);
  return left;
}

const MAX_PIN = 8;
const MIN_PIN = 4;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

type Biometric = ReturnType<typeof useBiometricUnlock>;

/**
 * A phone-style number pad: a dot per digit of the PIN, 1 to 9, then delete
 * and 0. It submits on the last digit. An enter key shows only while the
 * computer does not know the PIN's length yet.
 */
function PinForm({ lock, submitLabel, onCancel, bio, onUnlocked }: { lock: Lock; submitLabel: string; onCancel?: () => void; bio: Biometric; onUnlocked: (pin: string, typed: boolean) => void }) {
  const t = useTheme();
  const s = useStyles(styles);
  const view = useLockView(lock);
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [waitMs, setWaitMs] = useState<number | undefined>(view.state?.retryAfterMs);
  const left = useCountdown(waitMs);
  const remaining = view.state?.remaining;
  const blocked = busy || left > 0 || view.removed;
  const length = view.state?.pinLength;
  const max = length ?? MAX_PIN;
  const x = useRef(new Animated.Value(0)).current;

  const state = useRef({ pin, blocked, max });
  state.current = { pin, blocked, max };

  useEffect(() => {
    if (!shake) return;
    x.setValue(0);
    const step = (v: number) => Animated.timing(x, { toValue: v, duration: 72, useNativeDriver: true });
    Animated.sequence([step(-9), step(9), step(-9), step(9), step(0)]).start();
  }, [shake, x]);

  const submit = (p = state.current.pin, typed = true) => {
    if (state.current.blocked || p.length < MIN_PIN) return;
    setBusy(true);
    setError(null);
    void lock.unlock(p).then((r) => {
      setBusy(false);
      if (r.ok) {
        haptic.success();
        onUnlocked(p, typed);
        return;
      }
      if (!typed) void bio.forget();
      haptic.error();
      setPin("");
      setError(r.error);
      setWaitMs(r.retryAfterMs);
      setShake((n) => n + 1);
    });
  };
  const press = (d: string) => {
    const { pin: p, blocked: b, max: m } = state.current;
    if (b || p.length >= m) return;
    const next = p + d;
    state.current.pin = next;
    setError(null);
    setPin(next);
    if (length && next.length === length) submit(next);
  };
  const back = () => {
    if (state.current.blocked) return;
    state.current.pin = state.current.pin.slice(0, -1);
    setPin(state.current.pin);
  };
  const fingerprint = () => {
    if (state.current.blocked) return;
    void bio.unlock().then((p) => p && submit(p, false));
  };

  const dots = length ?? Math.max(MIN_PIN, pin.length);
  return (
    <View style={s.form}>
      <Animated.View accessibilityRole="text" accessibilityLabel={`${pin.length} of ${length ?? `up to ${MAX_PIN}`} digits entered`} style={[s.dots, { transform: [{ translateX: x }] }]}>
        {Array.from({ length: dots }, (_, i) => (
          <View key={i} style={[s.dot, i < pin.length && s.dotOn, shake > 0 && { borderColor: t.c.bad }]} />
        ))}
      </Animated.View>
      <View style={s.note} accessibilityRole={error ? "alert" : undefined}>
        {busy ? <T style={s.noteText}>Checking</T> : null}
        {error ? <T style={[s.noteText, { color: t.c.badText }]}>{error}</T> : null}
        {left > 0 ? <T style={s.noteText}>Try again in {left} s.</T> : null}
        {remaining !== undefined && remaining <= 5 && !view.removed ? (
          <T style={s.noteText}>
            {remaining} {remaining === 1 ? "try" : "tries"} left before this device is removed.
          </T>
        ) : null}
      </View>
      <View style={s.pad} accessibilityRole="none" accessibilityLabel="PIN keypad">
        {KEYS.map((d) => (
          <Key key={d} label={d} blocked={blocked} disabled={blocked} onPress={() => press(d)}>
            <T style={[s.keyText, blocked && { color: t.c.dim }]}>{d}</T>
          </Key>
        ))}
        <Key label="Delete" fn blocked={blocked} disabled={blocked || pin.length === 0} hide={pin.length === 0} onPress={back}>
          <Svg width={26} height={20} viewBox="0 0 26 20" fill="none" stroke={blocked || pin.length === 0 ? t.c.dim : t.c.muted} strokeWidth={1.8} strokeLinejoin="round">
            <Path d="M8 2h15a1.5 1.5 0 0 1 1.5 1.5v13A1.5 1.5 0 0 1 23 18H8l-6.5-8z" />
            <Path d="M12 7l6 6M18 7l-6 6" strokeLinecap="round" />
          </Svg>
        </Key>
        <Key label="0" blocked={blocked} disabled={blocked} onPress={() => press("0")}>
          <T style={[s.keyText, blocked && { color: t.c.dim }]}>0</T>
        </Key>
        {length ? (
          <View style={s.gap} />
        ) : (
          <Key label={submitLabel} go blocked={blocked} disabled={blocked || pin.length < MIN_PIN} onPress={() => submit()}>
            <Svg width={24} height={20} viewBox="0 0 24 20" fill="none" stroke={blocked || pin.length < MIN_PIN ? t.c.dim : t.c.onAccent} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M3 10.5l6 6L21 4" />
            </Svg>
          </Key>
        )}
      </View>
      {bio.available && bio.enabled && !view.removed ? <Button title="Unlock with fingerprint" disabled={blocked} onPress={fingerprint} /> : null}
      {onCancel ? <Button title="Cancel" variant="ghost" disabled={busy} onPress={onCancel} style={{ paddingHorizontal: 20 }} /> : null}
    </View>
  );
}

/** .pin-key, .pin-key-fn, .pin-key-go. */
function Key({ label, disabled, hide, fn, go, onPress, children, blocked }: { label: string; disabled?: boolean; hide?: boolean; fn?: boolean; go?: boolean; onPress: () => void; children: ReactNode; blocked?: boolean }) {
  const t = useTheme();
  const s = useStyles(styles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={() => {
        haptic.tap();
        onPress();
      }}
      style={({ pressed }) => [
        s.key,
        fn && s.keyFn,
        // button:disabled outranks .pin-key and .pin-key-fn: the disabled outline; .pin-key-go:disabled outranks it.
        disabled && { borderColor: t.c.disabledLine },
        go && (disabled ? s.keyGoOff : s.keyGo),
        pressed && !disabled && { backgroundColor: go ? t.c.accentDeep : t.c.lineStrong },
        blocked ? { opacity: 0.4 } : hide ? { opacity: 0 } : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

function LockGlyph() {
  const t = useTheme();
  return (
    <Svg width={40} height={40} viewBox="0 0 40 40" fill="none" stroke={t.c.accent} strokeWidth={2} style={{ marginBottom: 4 }}>
      <Rect x={9} y={18} width={22} height={16} rx={3} />
      <Path d="M14 18v-5a6 6 0 0 1 12 0v5" />
    </Svg>
  );
}

/** The whole client is locked: everything but this waits for the PIN. */
export function LockScreen({ lock, bio, onUnlocked, onRemoved }: { lock: Lock; bio: Biometric; onUnlocked: (pin: string, typed: boolean) => void; onRemoved?: () => void }) {
  const s = useStyles(styles);
  const view = useLockView(lock);
  return (
    <View style={s.screen} accessibilityViewIsModal accessibilityLabel={view.removed ? "This device was removed" : "Studio is locked"}>
      <View style={s.card}>
        <LockGlyph />
        <T style={s.title} accessibilityRole="header">
          {view.removed ? "This device was removed" : "Studio is locked"}
        </T>
        {view.removed ? (
          <>
            <T style={s.lead}>Too many wrong PINs. Pair this device again from Studio on the computer.</T>
            {onRemoved ? <Button title="Pair again" variant="primary" onPress={onRemoved} /> : null}
          </>
        ) : (
          <>
            <T style={s.lead}>Enter the PIN set in Studio on your computer.</T>
            <PinForm lock={lock} submitLabel="Unlock" bio={bio} onUnlocked={onUnlocked} />
          </>
        )}
      </View>
    </View>
  );
}

/** A sensitive action asked for the PIN: it goes ahead once the PIN is in. */
export function PinSheet({ lock, bio, onUnlocked }: { lock: Lock; bio: Biometric; onUnlocked: (pin: string, typed: boolean) => void }) {
  const s = useStyles(styles);
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => (lock.cancelPrompt(), true));
    return () => sub.remove();
  }, [lock]);
  return (
    <View style={s.backdrop}>
      <Pressable accessibilityLabel="Cancel" style={StyleSheet.absoluteFill} onPress={() => lock.cancelPrompt()} />
      <View style={s.sheet} accessibilityViewIsModal accessibilityLabel="Enter your PIN">
        <T style={s.sheetTitle} accessibilityRole="header">
          Enter your PIN
        </T>
        <T style={s.sheetLead}>This action needs the PIN set in Studio on your computer.</T>
        <PinForm lock={lock} submitLabel="Continue" onCancel={() => lock.cancelPrompt()} bio={bio} onUnlocked={onUnlocked} />
      </View>
    </View>
  );
}

/** After a typed PIN opened the lock: offered once, the fingerprint keeps it for next time. */
export function RememberOffer({ onYes, onNo }: { onYes: () => void; onNo: () => void }) {
  const s = useStyles(styles);
  return (
    <View style={s.backdrop}>
      <View style={s.sheet} accessibilityViewIsModal accessibilityLabel="Use fingerprint next time">
        <T style={s.sheetTitle} accessibilityRole="header">
          Unlock with your fingerprint?
        </T>
        <T style={s.sheetLead}>Next time, your fingerprint can enter the PIN for you. The PIN stays on this phone, and your computer still checks it.</T>
        <View style={{ flexDirection: "row", justifyContent: "center", gap: 8 }}>
          <Button title="Not now" variant="ghost" onPress={onNo} />
          <Button title="Use fingerprint next time" variant="primary" onPress={onYes} />
        </View>
      </View>
    </View>
  );
}

/**
 * The PIN lock over the open project: the lock screen while the computer has
 * it locked, the PIN sheet while a request waits for it. A phone is always a
 * paired client, so it is always on.
 */
export function RemoteLock({ lock, computerKey, onRemoved }: { lock: Lock; computerKey: string; onRemoved?: () => void }) {
  const view: LockView = useLockView(lock);
  const bio = useBiometricUnlock(computerKey);
  const [offer, setOffer] = useState<string | null>(null);
  const offered = useRef(false);
  const unlocked = (pin: string, typed: boolean) => {
    if (typed && bio.available && !bio.enabled && !offered.current) {
      offered.current = true;
      setOffer(pin);
    }
  };
  if (view.screen || view.removed) return <LockScreen lock={lock} bio={bio} onUnlocked={unlocked} onRemoved={onRemoved} />;
  if (view.prompt) return <PinSheet lock={lock} bio={bio} onUnlocked={unlocked} />;
  if (offer)
    return (
      <RememberOffer
        onYes={() => {
          void bio.remember(offer);
          setOffer(null);
        }}
        onNo={() => setOffer(null)}
      />
    );
  return null;
}

const styles = (t: Theme) => ({
  screen: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 90, alignItems: "center" as const, justifyContent: "center" as const, padding: 16, backgroundColor: t.c.bg },
  card: { width: "100%" as const, maxWidth: 360, alignItems: "center" as const, gap: 10 },
  title: { ...font(t, "sans", 600, 20, 1.25), color: t.c.text, textAlign: "center" as const },
  lead: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.dim, textAlign: "center" as const, marginBottom: 6 },
  form: { width: "100%" as const, alignItems: "center" as const, gap: 14 },
  dots: { flexDirection: "row" as const, gap: 14, justifyContent: "center" as const, minHeight: 14, paddingTop: 6, paddingBottom: 2 },
  dot: { width: 13, height: 13, borderRadius: 6.5, borderWidth: 1.5, borderColor: t.c.muted },
  dotOn: { backgroundColor: t.c.text, borderColor: t.c.text },
  note: { minHeight: 18, alignItems: "center" as const, gap: 2 },
  noteText: { ...font(t, "sans", 400, 12, t.editor ? 1.5 : 1.55), color: t.c.dim, textAlign: "center" as const },
  pad: { flexDirection: "row" as const, flexWrap: "wrap" as const, width: 72 * 3 + 24 * 2, columnGap: 24, rowGap: 14, justifyContent: "flex-start" as const },
  key: { width: 72, height: 72, borderRadius: 36, borderWidth: 1, borderColor: t.c.lineStrong, backgroundColor: t.c.panel2, alignItems: "center" as const, justifyContent: "center" as const },
  keyFn: { backgroundColor: "transparent", borderColor: "transparent" },
  keyGo: { backgroundColor: t.c.accent, borderColor: t.c.accent },
  keyGoOff: { backgroundColor: t.c.panel2, borderColor: t.c.lineStrong },
  keyText: { ...font(t, "sans", 400, 28, 1), color: t.c.text },
  gap: { width: 72, height: 72 },
  backdrop: { position: "absolute" as const, top: 0, left: 0, right: 0, bottom: 0, zIndex: 85, justifyContent: "flex-end" as const, backgroundColor: "rgba(0, 0, 0, 0.55)" },
  sheet: {
    width: "100%" as const,
    gap: 8,
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderWidth: 1,
    borderColor: t.c.line,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    backgroundColor: t.c.panel,
    shadowColor: "#000",
    shadowOpacity: 0.45,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 18 },
    elevation: 12,
  },
  sheetTitle: { ...font(t, "sans", 600, 16, 1.25), color: t.c.text, textAlign: "center" as const, ...(t.label.upper ? { textTransform: "uppercase" as const, letterSpacing: 0.16 * 16 } : {}) },
  sheetLead: { ...font(t, "sans", 400, t.base.size), lineHeight: t.base.lineHeight, color: t.c.dim, textAlign: "center" as const, marginBottom: 4 },
});
