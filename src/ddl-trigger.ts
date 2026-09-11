import type { DdlTrigger } from "./ddl-evidence.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { DdlParser } from "./ddl-parser.js";

export function parseDdlTrigger(p: DdlParser, start: SourceSpan, constraint: boolean): DdlTrigger {
  const name = p.identifier();
  const timingToken = p.peek();
  const timing = p.choice(["before", "after"]);
  if (constraint && timing !== "after") p.fail(timingToken);
  const events: DdlTrigger["events"][number][] = [];
  do {
    const eventToken = p.peek();
    const event = p.choice(["insert", "update", "delete", "truncate"]);
    if (events.includes(event) || (constraint && event === "truncate")) p.fail(eventToken);
    events.push(event);
  } while (p.optionalWord("or"));
  p.word("on");
  const table = p.qualified();
  let from: DdlTrigger["from"] = null;
  if (p.isWord("from")) {
    if (!constraint) p.fail();
    p.consume();
    from = p.qualified();
  }
  let deferrable: boolean | null = null;
  if (p.isWord("deferrable") || p.isWord("not")) {
    if (!constraint) p.fail();
    deferrable = !p.optionalWord("not");
    p.word("deferrable");
  }
  let initially: DdlTrigger["initially"] = null;
  if (p.isWord("initially")) {
    if (!constraint) p.fail();
    p.consume();
    initially = p.choice(["immediate", "deferred"]);
  }
  p.word("for");
  p.word("each");
  const forEachToken = p.peek();
  const forEach = p.choice(["row", "statement"]);
  if ((constraint && forEach !== "row") || (events.includes("truncate") && forEach !== "statement"))
    p.fail(forEachToken);
  const whenSpan = p.optionalWord("when") ? p.opaque() : null;
  p.word("execute");
  p.choice(["function", "procedure"]);
  const functionName = p.qualified();
  p.punctuation("(");
  const args: string[] = [];
  if (!p.isPunctuation(")")) {
    do {
      args.push(p.string().value);
    } while (p.optionalPunctuation(","));
  }
  p.punctuation(")");
  return {
    name,
    table,
    constraint,
    timing,
    events,
    from,
    deferrable,
    initially,
    forEach,
    whenSpan,
    function: functionName,
    arguments: args,
    span: p.spanFrom(start),
  };
}
