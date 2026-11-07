/**
 * A reply about 6000 dp tall at phone width, for the fold's tests and shots:
 * paragraphs, a heading, a 30-item numbered list and 120 lines of code.
 */
const WORDS = "the caravan stops at the bastion and the ward holds while the beacons relight ";

export function longReply(): string {
  const paras = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} opens here: ${WORDS.repeat(4)}`);
  const list = Array.from({ length: 30 }, (_, i) => `${i + 1}. Item ${i + 1}: ${WORDS}`);
  const code = Array.from({ length: 120 }, (_, i) => `int Line${i} = ${i};`);
  return [...paras.slice(0, 10), "### New work", list.join("\n"), "```cpp\n" + code.join("\n") + "\n```", ...paras.slice(10), "The last paragraph."].join("\n\n");
}
