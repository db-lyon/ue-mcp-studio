// The Git changes sheet and chip, in the web client's vcs-* visual QA scenarios.
import type { ReactNode } from "react";
import { View } from "react-native";
import type { VcsStatus } from "@ue-mcp-studio/shared";
import { ChangesSheet } from "../../src/screens/git/ChangesSheet";
import { VcsChip } from "../../src/screens/git/VcsChip";
import { InScenario, scenario } from "./harness";

const vcsOf = (name: string) => (scenario(name).get?.("/v1/ext/studio/vcs", new URL("http://x/v1/ext/studio/vcs")) as { vcs: VcsStatus }).vcs;

const sheet = (name: string) => () => (
  <InScenario name={name}>
    <ChangesSheet vcs={vcsOf(name)} onClose={() => undefined} />
  </InScenario>
);

export const GIT_SCENES: Record<string, () => ReactNode> = {
  "vcs-changes": sheet("vcs-changes"),
  "vcs-changes-remote": sheet("vcs-changes-remote"),
  "vcs-changes-list-narrow": sheet("vcs-changes-list-narrow"),
  "vcs-changes-tree": sheet("vcs-changes-tree"),
  "vcs-changes-tree-remote": sheet("vcs-changes-tree-remote"),
  "vcs-changes-empty": sheet("vcs-changes-empty"),
  "vcs-changes-truncated": sheet("vcs-changes-truncated"),
  "vcs-changes-tree-collapsed": sheet("vcs-changes-tree-collapsed"),
  "vcs-changes-no-diff": sheet("vcs-changes-no-diff"),
  "vcs-chip-clean": () => (
    <InScenario name="vcs-changes-empty">
      <View style={{ width: 283, marginLeft: 10, marginTop: 700 }}>
        <VcsChip />
      </View>
    </InScenario>
  ),
  "vcs-chip": () => (
    <InScenario name="vcs-changes-list-narrow">
      <View style={{ width: 283, marginLeft: 10, marginTop: 700 }}>
        <VcsChip />
      </View>
    </InScenario>
  ),
};
