// The manager's instructions: manager/CLAUDE.template.md filled in with the owner's settings
// (names, style, where the commands and notes live) and written to manager/CLAUDE.md every time
// the office starts. The owner's own extra rules, if any, come from <dataDir>/manager-rules.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Config, ManagerStyle } from '../config.ts';

export const STYLE_TEXT: Record<ManagerStyle, string> = {
  calm: 'Calm, warm and steady. You are always positive and always name the way forward (the next step, who does it, what the owner decides). Facts stay exact and easy to spot; a light touch of humour is fine when nothing is at stake.',
  whimsical:
    'Warm, a little vain, never mean, and given to silly, non-sensical remarks about office life: the whiteboard sulking after a tidy, the plant demanding a goal, the coffee machine holding a stand-up. The news *is* the bit: put the facts inside one small scene per reply, still exact and easy to spot. Serious news (money, deadlines, broken releases) stays gentle, with no gags.',
  plain: 'Plain and brief, like a good colleague: lead with the answer, one idea per sentence, no jokes. Facts exact, next step named.',
};

// Names go into the manager's instructions: strip anything that could read as markup or an import.
const safe = (s: string) => s.replace(/[@`{}<>\[\]\\*_#|]/g, '').trim();

export function renderManagerRules(template: string, c: Pick<Config, 'ownerName' | 'managerName' | 'managerStyle'>, o: { cli: string; data: string; ownerRules?: string }): string {
  const extra = o.ownerRules?.trim() ? `## ${safe(c.ownerName)}'s own rules\n\n${o.ownerRules.trim().replace(/^@/gm, '')}\n` : '';
  return template
    .replace(/^<!--[\s\S]*?-->\n/, '')
    .replaceAll('{{managerName}}', safe(c.managerName))
    .replaceAll('{{ownerName}}', safe(c.ownerName))
    .replaceAll('{{style}}', STYLE_TEXT[c.managerStyle])
    .replaceAll('{{cli}}', /^[\w@%+=:,./-]+$/.test(o.cli) ? o.cli : `'${o.cli.replace(/'/g, `'\\''`)}'`) // run in a shell: one word, even with spaces
    .replaceAll('{{data}}', o.data)
    .replaceAll('{{ownerRules}}', extra)
    .trimEnd() + '\n';
}

// Writes manager/CLAUDE.md when it changed. Never throws: the office starts either way.
export function writeManagerRules(dir: string, c: Config, o: { cli: string; data: string; ownerRulesFile: string }): void {
  try {
    const template = readFileSync(`${dir}/CLAUDE.template.md`, 'utf8');
    const ownerRules = existsSync(o.ownerRulesFile) ? readFileSync(o.ownerRulesFile, 'utf8').slice(0, 20_000) : '';
    const out = renderManagerRules(template, c, { cli: o.cli, data: o.data, ownerRules });
    const file = `${dir}/CLAUDE.md`;
    if (!existsSync(file) || readFileSync(file, 'utf8') !== out) writeFileSync(file, out);
  } catch (err) {
    console.error("could not write the manager's instructions:", err);
  }
}
