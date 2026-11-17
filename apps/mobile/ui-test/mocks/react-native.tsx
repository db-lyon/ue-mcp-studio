/**
 * react-native for component tests: react-native-web, failing where Android
 * fails. react-native-web draws a string straight inside a View and ignores
 * an accessibilityRole Android does not know; on a phone the first throws
 * "Text strings must be rendered within a <Text> component" and the second
 * throws in ReactAccessibilityDelegate, and either closes a release app
 * (build 10: accessibilityRole="treegrid" on the asset diff).
 *
 * A ScrollView also carries what decides whether it scrolls on Android, which
 * react-native-web drops: data-nested-scroll-enabled, and data-inside-pressable
 * when a Pressable is its ancestor (a Pressable that holds the JS responder
 * intercepts the whole gesture natively, so the scroll view never scrolls).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Children, Fragment, createContext, forwardRef, isValidElement, useContext, type ComponentType, type ReactNode } from "react";
// @ts-ignore react-native-web ships no types; the app types it as react-native.
import * as RNW from "../../../../node_modules/react-native-web/dist/index.js";

// @ts-ignore as above.
export * from "../../../../node_modules/react-native-web/dist/index.js";

/** The values Android's AccessibilityRole enum takes, read from React Native's own source. */
export const ANDROID_ACCESSIBILITY_ROLES: ReadonlySet<string> = (() => {
  const file = path.resolve(__dirname, "../../node_modules/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt");
  const src = fs.readFileSync(file, "utf8");
  const body = /enum class AccessibilityRole[^{]*\{([\s\S]*?);/.exec(src)?.[1] ?? "";
  const roles = new Set((body.match(/\b[A-Z_]+\b/g) ?? []).map((r) => r.toLowerCase()));
  if (roles.size < 20) throw new Error(`could not read Android's accessibility roles from ${file}`);
  return roles;
})();

function checkRole(name: string, props: { accessibilityRole?: unknown }) {
  const r = props.accessibilityRole;
  if (typeof r === "string" && !ANDROID_ACCESSIBILITY_ROLES.has(r.toLowerCase())) {
    throw new Error(`${name}: Invalid accessibility role value: ${r} (Android throws; use role= for ARIA roles)`);
  }
}

function checkText(name: string, children: ReactNode) {
  const walk = (c: ReactNode) => {
    Children.forEach(c, (child) => {
      if (typeof child === "string" ? child !== "" : typeof child === "number") {
        throw new Error(`Text strings must be rendered within a <Text> component: ${JSON.stringify(String(child))} inside a ${name}`);
      }
      if (isValidElement(child) && child.type === Fragment) walk((child.props as { children?: ReactNode }).children);
    });
  };
  walk(children);
}

function guard<P extends { children?: ReactNode; accessibilityRole?: unknown }>(name: string, C: ComponentType<P>, text: boolean) {
  const G = forwardRef<unknown, P>((props, ref) => {
    checkRole(name, props);
    if (!text && typeof props.children !== "function") checkText(name, props.children);
    const Inner = C as unknown as ComponentType<Record<string, unknown>>;
    return <Inner {...(props as Record<string, unknown>)} ref={ref} />;
  });
  G.displayName = name;
  // The component's statics (Image.getSize and the like), never its forwardRef internals.
  for (const [k, v] of Object.entries(C)) if (!["$$typeof", "render", "displayName", "propTypes", "defaultProps"].includes(k)) (G as unknown as Record<string, unknown>)[k] = v;
  return G;
}

const R = RNW as unknown as Record<string, ComponentType<never>>;
const InPressable = createContext(false);
type Touchy = { children?: unknown; nestedScrollEnabled?: boolean; dataSet?: Record<string, unknown> };
const GuardedScrollView = guard("ScrollView", R.ScrollView, false) as unknown as ComponentType<Touchy & { ref?: unknown }>;
const GuardedPressable = guard("Pressable", R.Pressable, false) as unknown as ComponentType<Touchy & { ref?: unknown }>;
export const View = guard("View", R.View, false);
export const ScrollView = Object.assign(
  forwardRef<unknown, Touchy>((props, ref) => {
    const inside = useContext(InPressable);
    const dataSet = { ...props.dataSet, nestedScrollEnabled: props.nestedScrollEnabled ? "true" : undefined, insidePressable: inside ? "true" : undefined };
    return <GuardedScrollView {...(props as object)} dataSet={dataSet} ref={ref} />;
  }),
  { displayName: "ScrollView" },
);
export const Pressable = Object.assign(
  forwardRef<unknown, Touchy>((props, ref) => {
    const kids = props.children as ReactNode | ((s: unknown) => ReactNode);
    // The text rule reads the children as written, before they are wrapped in the provider below.
    if (typeof kids !== "function") checkText("Pressable", kids);
    const children = typeof kids === "function" ? (s: unknown) => <InPressable.Provider value>{kids(s)}</InPressable.Provider> : <InPressable.Provider value>{kids}</InPressable.Provider>;
    return <GuardedPressable {...(props as object)} ref={ref}>{children}</GuardedPressable>;
  }),
  { displayName: "Pressable" },
);
export const TouchableOpacity = guard("TouchableOpacity", R.TouchableOpacity, false);
export const KeyboardAvoidingView = guard("KeyboardAvoidingView", R.KeyboardAvoidingView, false);
export const SafeAreaView = guard("SafeAreaView", R.SafeAreaView, false);
export const Text = guard("Text", R.Text, true);
export const TextInput = guard("TextInput", R.TextInput, true);
export const Image = guard("Image", R.Image, false);
