import { fuzzyFilter, type AutocompleteItem } from '@earendil-works/pi-tui';
import { REASONING_LEVELS, type PickerModel, type ModelSelection, type Reasoning } from './model-types.js';

export interface Choice { value: string; description: string }
/** Format caller-discovered levels without lookup, filtering, or reordering. */
export function reasoningChoices(levels: readonly Reasoning[]): Choice[] {
  return levels.map(value => ({ value, description: value === 'default' ? 'Keep legacy provider behavior' : `Set reasoning to ${value}` }));
}
export type Scope = 'global' | 'project';
export const SCOPE_CHOICES: readonly Readonly<Choice>[] = Object.freeze([
  Object.freeze({ value: '--global', description: 'Use global settings (default save scope)' }),
  Object.freeze({ value: '--project', description: 'Use project settings (writes require trust)' }),
]);
export function scopedArguments(args: string): { scope: Scope; args: string[] } | undefined {
  const tokens = args.trim() ? args.trim().split(/\s+/) : [];
  const flags = tokens.filter(token => token.startsWith('--'));
  if (flags.length > 1 || flags.some(flag => !SCOPE_CHOICES.some(choice => choice.value === flag))) return undefined;
  return { scope: flags[0] === '--project' ? 'project' : 'global', args: tokens.filter(token => !token.startsWith('--')) };
}
export interface CompletionSpec {
  commands: readonly Choice[];
  modelCommands: readonly string[];
  isolatedCommands?: Readonly<Record<string, readonly Choice[]>>;
  models?: (command: string) => readonly PickerModel[] | Promise<readonly PickerModel[]>;
  reasoning?: (project: boolean) => readonly Choice[] | Promise<readonly Choice[]>;
  validateModel: (command: string, pair: ModelSelection) => void;
}
type Syntax = { base: string; fragment: string; args: string[]; scoped: boolean; project: boolean };
function isolatedChoices(spec: CompletionSpec, command: string): readonly Choice[] | undefined {
  return spec.isolatedCommands && Object.hasOwn(spec.isolatedCommands, command) ? spec.isolatedCommands[command] : undefined;
}
function syntax(prefix: string, spec: CompletionSpec): Syntax | undefined {
  const fragment = prefix.match(/\S*$/)![0];
  const base = prefix.slice(0, prefix.length - fragment.length);
  const parsed = scopedArguments(base);
  if (!parsed) return undefined;
  const { args } = parsed;
  const scoped = /(?:^|\s)--(?:global|project)(?:\s|$)/u.test(base);
  const [command, argument] = args;
  const isolated = isolatedChoices(spec, command);
  if (isolated) {
    if (scoped || args.length > 2 || (argument && !isolated.some(choice => choice.value === argument))) return undefined;
  } else if (command === 'show') {
    if (args.length > 1) return undefined;
  } else if (command === 'reasoning') {
    if (args.length > 2 || (argument && !REASONING_LEVELS.some(level => level === argument))) return undefined;
  } else if (command === 'timeout') {
    if (args.length > 2 || (argument && argument !== 'default' &&
      (!/^[0-9]+$/.test(argument) || Number(argument) < 1 || Number(argument) > 2147483647))) return undefined;
  } else if (spec.modelCommands.includes(command)) {
    if (args.length > 3) return undefined;
  } else if (command) return undefined;
  return { base, fragment, args, scoped, project: parsed.scope === 'project' };
}
async function choices(input: Syntax, spec: CompletionSpec): Promise<readonly Choice[]> {
  const { args, fragment, scoped, project } = input;
  const [command, provider] = args;
  const isolated = isolatedChoices(spec, command);
  const scopes = scoped || isolated ? [] : SCOPE_CHOICES;
  if (fragment.startsWith('--')) return scopes;
  if (!command) return [...spec.commands.filter(choice => !scoped || !isolatedChoices(spec, choice.value)), ...scopes];
  if (isolated) return args.length === 1 ? isolated : [];
  if (command === 'show' || ((command === 'reasoning' || command === 'timeout') && args.length === 2) || args.length === 3) return scopes;
  if (command === 'timeout') return [{ value: 'default', description: 'Remove the scoped timeout and restore inheritance' }];
  if (command === 'reasoning') return await spec.reasoning?.(project) ?? [];
  const models = await spec.models?.(command) ?? [];
  if (!provider) {
    return [...new Set(models.map(model => model.provider))].sort((a, b) => a.localeCompare(b))
      .filter(value => value.toLowerCase().startsWith(fragment.toLowerCase()))
      .map(value => ({ value, description: `Available ${command} provider` }));
  }
  const candidates = models.filter(model => model.provider === provider).sort((a, b) => a.id.localeCompare(b.id));
  return fuzzyFilter(candidates, fragment, model => `${model.id} ${model.name ?? ''}`)
    .map(model => ({ value: model.id, description: model.name || `Available ${command} model` }));
}
export async function argumentCompletions(prefix: string, spec: CompletionSpec): Promise<AutocompleteItem[] | null> {
  const input = syntax(prefix, spec);
  if (!input) return null;
  try {
    const catalog = spec.modelCommands.includes(input.args[0]) && input.args.length < 3 && !input.fragment.startsWith('--');
    const candidates = await choices(input, spec);
    const matched = catalog ? candidates : candidates.filter(choice => choice.value.startsWith(input.fragment));
    const items = matched.filter(choice => {
      if (!catalog) return true;
      if (choice.value.startsWith('--')) return false;
      try {
        spec.validateModel(input.args[0], { provider: input.args[1] ?? choice.value, model: input.args[1] ? choice.value : 'placeholder' });
        return true;
      } catch { return false; }
    }).map(choice => ({ value: `${input.base}${choice.value} `, label: choice.value, description: choice.description }));
    return items.length ? items : null;
  } catch { return null; }
}
/** Each registration owns its context. Pending results cannot survive a context change. */
export function completionContext<T>(complete: (prefix: string, context?: T) => Promise<AutocompleteItem[] | null>) {
  let context: T | undefined, revision = 0;
  return {
    set(next?: T) { context = next; revision++; },
    async complete(prefix: string) {
      const before = revision;
      const items = await complete(prefix, context);
      return before === revision ? items : null;
    },
  };
}
