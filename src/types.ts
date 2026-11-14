// The subset of the Fig completion-spec format that shellsense understands.
// Specs come from @withfig/autocomplete; these types describe their runtime shape.

export type OneOrMany<T> = T | T[];

export interface FigSuggestion {
  name?: OneOrMany<string>;
  displayName?: string;
  insertValue?: string;
  description?: string;
  priority?: number;
  hidden?: boolean;
  type?: string;
  /** Fig's icon hint, e.g. `fig://icon?type=git`. Only the type is used, to pick an icon of our own. */
  icon?: string;
}

export interface ExecInput {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeout?: number;
}

export interface ExecOutput {
  stdout: string;
  stderr: string;
  status: number;
}

export type ExecuteCommand = (input: ExecInput) => Promise<ExecOutput>;

export type Template = "filepaths" | "folders" | "history" | "help";

export interface Generator {
  template?: OneOrMany<Template>;
  filterTemplateSuggestions?: (suggestions: FigSuggestion[]) => FigSuggestion[];
  script?: string | string[] | ExecInput | ((tokens: string[]) => string | string[] | ExecInput | undefined);
  scriptTimeout?: number;
  postProcess?: (out: string, tokens: string[]) => (FigSuggestion | null | undefined)[] | undefined;
  splitOn?: string;
  custom?: (tokens: string[], exec: ExecuteCommand, ctx: Record<string, unknown>) => Promise<(FigSuggestion | null | undefined)[] | undefined>;
  trigger?: unknown;
  getQueryTerm?: string | ((token: string) => string);
  cache?: { ttl?: number };
}

export interface Arg {
  name?: string;
  description?: string;
  suggestions?: (string | FigSuggestion)[];
  template?: OneOrMany<Template>;
  generators?: OneOrMany<Generator>;
  filterStrategy?: "fuzzy" | "prefix" | "default";
  isVariadic?: boolean;
  isOptional?: boolean;
  isCommand?: boolean;
}

export interface Option extends FigSuggestion {
  name: OneOrMany<string>;
  args?: OneOrMany<Arg>;
  isPersistent?: boolean;
  isRepeatable?: boolean | number;
  requiresSeparator?: boolean | string;
  requiresEquals?: boolean;
  exclusiveOn?: string[];
}

export interface Subcommand extends FigSuggestion {
  name: OneOrMany<string>;
  subcommands?: Subcommand[];
  options?: Option[];
  args?: OneOrMany<Arg>;
  additionalSuggestions?: (string | FigSuggestion)[];
  filterStrategy?: "fuzzy" | "prefix" | "default";
  loadSpec?: string | Subcommand | ((token: string, exec: ExecuteCommand) => Promise<unknown>);
  generateSpec?: (tokens: string[], exec: ExecuteCommand) => Promise<Subcommand | undefined>;
  parserDirectives?: { flagsArePosixNoncompliant?: boolean };
}

export type Kind = "subcommand" | "option" | "arg" | "file" | "folder" | "branch" | "package";

/** One row of the popup, ready for the shell to display and insert. */
export interface Item {
  display: string;
  description: string;
  kind: Kind;
  /** Text that replaces the current token (from `replaceStart` to the cursor). */
  insert: string;
  /** How many characters to move the cursor back after inserting. */
  cursorBack: number;
  /** The part of `display` that matches what was typed, in code points, for highlighting. */
  matchStart: number;
  matchLength: number;
  /** True when this row was used here before, which is why it ranks above the others. */
  recent: boolean;
}

export interface Result {
  /** Index into the line (in code points) where the replaced token starts. */
  replaceStart: number;
  items: Item[];
  /** True when the word under the cursor already is one of the rows, so Enter should run the line instead of inserting. */
  complete: boolean;
}

export function toArray<T>(value: OneOrMany<T> | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}
