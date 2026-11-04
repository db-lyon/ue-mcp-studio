// STUB: owned by transcript. The web client's chat/AssetLink.tsx ExactAssetLink: an exact asset path as a code-styled link that opens it.
import { Text } from "react-native";
import { font, useTheme } from "../ui";

export function ExactAssetLink({ path, label }: { path: string; label: string }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="link" accessibilityHint={path} style={[font(t, "mono", 400, 12), { color: t.c.text }]}>
      {label}
    </Text>
  );
}
