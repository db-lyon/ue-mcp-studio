/**
 * The app's own pages outside a project (pairing, projects, paired devices,
 * about), in the look of the relay's pages and Studio's shell: the page glow
 * over the theme's background, the bar (the brand, or a back button and the
 * page's name), and under it either a centred state (a glyph, a title, a
 * line, what to do) or a list page (an eyebrow, a lead, cards of rows).
 */
import type { ReactElement, ReactNode } from "react";
import { Pressable, ScrollView, useWindowDimensions, View, type RefreshControlProps, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { Card, font, Label, PageGlow, StateGlyph, T, useTheme, type StateGlyphName } from "../ui";
import { Brand } from "../views/NavDrawer";
import { OFFLINE_STRIP } from "../views/OfflineBanner";
import { useDeviceOnline } from "../native/online";

/** .bar: the brand on a top-level page; a back button and the page's name on one under it. */
export function AppBar({ title, back, onBack, actions }: { title?: string; back?: string; onBack?: () => void; actions?: ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        height: 50 + insets.top,
        paddingTop: insets.top,
        paddingLeft: Math.max(onBack ? 6 : 14, insets.left),
        paddingRight: Math.max(actions ? 8 : 14, insets.right),
        backgroundColor: t.c.barBg,
        borderBottomWidth: 1,
        borderBottomColor: t.c.line,
        zIndex: 30,
      }}
    >
      {onBack ? (
        <Pressable accessibilityRole="button" accessibilityLabel={back ? `Back to ${back}` : "Back"} onPress={onBack} style={({ pressed }) => ({ width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: t.radius, borderWidth: 1, borderColor: pressed ? t.c.line : "transparent", backgroundColor: pressed ? t.c.panel2 : "transparent" })}>
          <Svg width={18} height={18} viewBox="0 0 16 16" fill="none" stroke={t.c.muted} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M10 3L5 8l5 5" />
          </Svg>
        </Pressable>
      ) : null}
      {title ? (
        <T accessibilityRole="header" numberOfLines={1} style={{ ...font(t, "sans", 600, 15, 1.3), color: t.c.text, flexShrink: 1, minWidth: 0 }}>
          {title}
        </T>
      ) : (
        <View accessibilityRole="header" accessibilityLabel="UE-MCP Studio">
          <Brand />
        </View>
      )}
      <View style={{ flex: 1 }} />
      {actions}
    </View>
  );
}

/**
 * A whole page. `stage` centres a state under the bar, set a fifth of the way
 * down as the relay's stage is on a phone; otherwise the content is a list
 * page from the top. A footer stays at the foot over the bar's colour.
 */
export function Page({
  children,
  stage = false,
  scroll = true,
  footer,
  refreshControl,
  title,
  back,
  onBack,
  actions,
}: {
  children: ReactNode;
  stage?: boolean;
  scroll?: boolean;
  footer?: ReactNode;
  refreshControl?: ReactElement<RefreshControlProps>;
  title?: string;
  back?: string;
  onBack?: () => void;
  actions?: ReactNode;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  // The offline strip lies over the top of the page; the page starts below it.
  const offline = !useDeviceOnline();
  const pad: ViewStyle = {
    paddingTop: (stage ? Math.min(180, Math.max(32, Math.round(height * 0.2))) : 24) + (offline ? OFFLINE_STRIP : 0),
    paddingLeft: Math.max(16, insets.left),
    paddingRight: Math.max(16, insets.right),
    paddingBottom: footer ? 16 : Math.max(24, insets.bottom),
    gap: 16,
    alignItems: stage ? "center" : "stretch",
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg }}>
      <PageGlow top={insets.top} />
      <AppBar title={title} back={back} onBack={onBack} actions={actions} />
      {scroll ? (
        <ScrollView style={{ flex: 1 }} refreshControl={refreshControl} keyboardShouldPersistTaps="handled" contentContainerStyle={[{ flexGrow: 1 }, pad]}>
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, pad]}>{children}</View>
      )}
      {footer ? <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: Math.max(16, insets.bottom), gap: 8, borderTopWidth: 1, borderTopColor: t.c.line, backgroundColor: t.c.barBg }}>{footer}</View> : null}
    </View>
  );
}

/**
 * .state: a whole-page state laid out as Studio's lock screen: the glyph, the
 * title, the line under it, then whatever the state shows and its actions.
 */
export function StateView({ glyph, title, lead, children, note, actions }: { glyph: StateGlyphName; title: string; lead: ReactNode; children?: ReactNode; note?: ReactNode; actions?: ReactNode }) {
  const t = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={{ width: "100%", maxWidth: 420, alignItems: "center", gap: 10 }}>
      <StateGlyph name={glyph} />
      <T accessibilityRole="header" style={{ ...font(t, "sans", 600, 20, 1.25), color: t.c.text, textAlign: "center" }}>
        {title}
      </T>
      {typeof lead === "string" ? <T style={{ color: t.c.dim, textAlign: "center", marginBottom: 6 }}>{lead}</T> : lead}
      {children}
      {/* What went wrong last, always just above what to do about it. */}
      {note ? <View style={{ alignSelf: "stretch" }}>{note}</View> : null}
      {actions ? <View style={{ alignSelf: "stretch", gap: 8, marginTop: 8 }}>{actions}</View> : null}
    </View>
  );
}

/** The eyebrow and the sentence under it, as the relay's project list opens. */
export function PageHead({ eyebrow, lead }: { eyebrow: string; lead?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6, marginBottom: -2 }}>
      <Label>{eyebrow}</Label>
      {lead ? typeof lead === "string" ? <T style={{ color: t.c.dim }}>{lead}</T> : lead : null}
    </View>
  );
}

/** h2: a section's label above its card. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <Label style={{ marginTop: 8, marginBottom: -8 }}>{children}</Label>;
}

/** .list .card: rows in one card, 6 in from its edge, 2 apart. */
export function ListCard({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <Card padded={false} style={[{ padding: 6, gap: 2 }, style]}>
      {children}
    </Card>
  );
}

/** button.project: a lead (a dot), the name and its line, and what it offers; the current one on the accent wash. */
export function ListRow({ lead, title, sub, right, onPress, disabled, label, current }: { first?: boolean; lead?: ReactNode; title: string; sub?: ReactNode; right?: ReactNode; onPress?: () => void; disabled?: boolean; label?: string; current?: boolean }) {
  const t = useTheme();
  const body = (
    <>
      {lead}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <T numberOfLines={1} style={{ ...font(t, "sans", 600, 14.5, 1.3), color: t.c.text }}>
          {title}
        </T>
        {sub ? typeof sub === "string" ? <T style={{ ...font(t, "sans", 400, 12, 1.3), color: t.c.dim }}>{sub}</T> : sub : null}
      </View>
      {right}
    </>
  );
  const style: ViewStyle = {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    paddingVertical: 9,
    paddingHorizontal: 12,
    borderRadius: t.editor ? t.radius : 7,
    borderWidth: 1,
    borderColor: current ? t.c.accentLine : "transparent",
    backgroundColor: current ? t.c.accentWash : "transparent",
    opacity: disabled ? 0.6 : 1,
  };
  if (!onPress) return <View style={style}>{body}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label ?? title} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={({ pressed }) => [style, pressed && !current && { backgroundColor: t.c.panel2 }]}>
      {body}
    </Pressable>
  );
}

/** The chevron a row that opens something ends with. */
export function Chevron() {
  const t = useTheme();
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={t.c.dim} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M6 3.5L10.5 8 6 12.5" />
    </Svg>
  );
}
