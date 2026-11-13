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

export function tokenize(input: string): Parsed {
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
    tokens = [];
    cur = null;
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

  const current: Token = cur ?? { text: "", start: n, quote: "", redirect: redirectNext };
  current.quote = quote;

  const words = tokens.filter((t) => !t.redirect);
  while (words.length > 0 && ASSIGNMENT.test(words[0]!.text)) words.shift();
  return { tokens: words, current };
}
