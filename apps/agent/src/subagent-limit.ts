/** What the model is told when it starts more subagents than a turn allows, on every route. */
export const subagentLimitText = (perTurn: number): string =>
  `This turn has started its ${perTurn} subagent${perTurn === 1 ? "" : "s"}, the most Settings > Agents > Worker allows. Do this part yourself.`;
