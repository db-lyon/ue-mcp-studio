/** Studio's dark tokens, from apps/client-web/src/styles.css. */
import { Platform } from "react-native";

export const colors = {
  bg: "#0c0c0b",
  panel: "#131312",
  border: "rgba(255, 255, 255, 0.12)",
  line: "rgba(255, 255, 255, 0.07)",
  text: "#ece9e3",
  muted: "#b3b0a8",
  faint: "#8a8985",
  accent: "#e8720c",
  accentWash: "rgba(232, 114, 12, 0.10)",
  onAccent: "#140a02",
  ok: "#6cc08b",
  warn: "#e0a43a",
  warnText: "#efd09a",
  danger: "#e5604f",
  dangerText: "#f2b3aa",
  code: "#0f0f0e",
  codeText: "#d6d3cc",
  diffAdd: "rgba(108, 192, 139, 0.12)",
  diffDel: "rgba(229, 96, 79, 0.12)",
} as const;

export const mono = Platform.select({ ios: "Menlo", default: "monospace" });
