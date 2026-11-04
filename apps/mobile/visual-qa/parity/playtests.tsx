import type { ReactNode } from "react";
import { View } from "react-native";
import { Pill, WebButton } from "../../src/ui/controls";
import { Glyph } from "../../src/ui/glyphs";

export const PLAYTEST_SCENES: Record<string, () => ReactNode> = {
  probe: () => (
    <View testID="probe" style={{ flexDirection: "row", gap: 10, padding: 10 }}>
      <WebButton small title="Refresh" />
      <Pill tone="warn" text="Needs you" />
      <Glyph name="trash" />
    </View>
  ),
};
