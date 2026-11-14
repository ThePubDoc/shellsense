// Splits the text left of the cursor into the words of the command being typed.
// It follows shell quoting closely enough for completion; it does not evaluate anything.

export type Quote = "" | "'" | '"';

export interface Token {
  /** The word with quotes and escapes removed. */
  text: string;
  /** Index in the input where the word starts, including an opening quote. */
  start: number;
  /** For the current token: the quote that is still open at the cursor. */
  quote: Quote;
  /** True when the word is the target of a redirection such as `> file`. */
  redirect: boolean;
}

export interface Parsed {
  /** Completed words of the current command, without redirect targets or leading `VAR=value` words. */
  tokens: Token[];
  /** The word under the cursor. Its text is empty when the cursor follows whitespace. */
  current: Token;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words that make up a command: no redirect targets, no leading `VAR=value`. */
function commandWords(tokens: Token[]): Token[] {
  const words = tokens.filter((t) => !t.redirect);
  while (words.length > 0 && ASSIGNMENT.test(words[0]!.text)) words.shift();
  return words;
}

interface Scan {
  /** Commands that ended at a separator (`;`, `|`, `&&`, …), in order. */
  earlier: Token[][];
  /** Completed words of the last command. */
  tokens: Token[];
  /** The unfinished last word, if the input does not end in whitespace. */
  last: Token | null;
  quote: Quote;
  redirectNext: boolean;
}

function scan(input: string): Scan {
  const earlier: Token[][] = [];
  let tokens: Token[] = [];
  let cur: Token | null = null;
  let quote: Quote = "";
  let redirectNext = false;
  const n = input.length;

  const begin = (i: number): Token => {
    cur = { text: "", start: i, quote: "", redirect: redirectNext };
    redirectNext = false;
    return cur;
  };
  const finish = () => {
    if (cur) tokens.push(cur);
    cur = null;
  };
  // A command separator: everything typed so far belongs to an earlier command.
  const reset = () => {
    finish();
    if (tokens.length > 0) earlier.push(tokens);
    tokens = [];
    redirectNext = false;
    quote = "";
  };

  for (let i = 0; i < n; i++) {
    const c = input[i]!;
    const next = input[i + 1];

    if (quote === "'") {
      if (c === "'") quote = "";
      else cur!.text += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && next !== undefined && '"\\$`'.includes(next)) {
        cur!.text += next;
        i++;
      } else if (c === "$" && next === "(") {
        reset();
        i++;
      } else if (c === "`") reset();
      else cur!.text += c;
      continue;
    }

    if (c === "\\") {
      const tok = cur ?? begin(i);
      if (next !== undefined) {
        if (next !== "\n") tok.text += next;
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      if (!cur) begin(i);
      quote = c;
      continue;
    }
    if (c === " " || c === "\t") {
      finish();
      continue;
    }
    if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")" || c === "`") {
      reset();
      continue;
    }
    if (c === ">" || c === "<") {
      // `2>` — the digits just before the operator are a file descriptor, not a word.
      const fd = cur as Token | null;
      if (fd !== null && /^\d+$/.test(fd.text) && fd.start + fd.text.length === i) cur = null;
      else finish();
      while (i + 1 < n && ">&|".includes(input[i + 1]!)) i++;
      redirectNext = true;
      continue;
    }
    (cur ?? begin(i)).text += c;
  }
  return { earlier, tokens, last: cur, quote, redirectNext };
}

export function tokenize(input: string): Parsed {
  const { tokens, last, quote, redirectNext } = scan(input);
  const current: Token = last ?? { text: "", start: input.length, quote: "", redirect: redirectNext };
  current.quote = quote;
  return { tokens: commandWords(tokens), current };
}

/** Every command on a finished line, as plain words: `cd src && git status` gives two. */
export function splitCommands(line: string): string[][] {
  const { earlier, tokens, last } = scan(line);
  const all = [...earlier, last ? [...tokens, last] : tokens];
  return all.map((command) => commandWords(command).map((t) => t.text)).filter((words) => words.length > 0);
}
