import type { DdlAlterConstraint, DdlPolicy, DdlRls } from "./ddl-evidence.js";
import type { IdentifierIdentity } from "./create-table-parser-primitives.js";
import type { SourceSpan } from "./create-table-token-source.js";
import type { DdlParser } from "./ddl-parser.js";
import { parseDdlConstraint } from "./ddl-table.js";

export type DdlAlter =
  | { kind: "addition"; value: DdlAlterConstraint }
  | { kind: "rls"; value: DdlRls };

export function parseDdlAlter(p: DdlParser, start: SourceSpan): DdlAlter {
  p.optionalWord("only");
  const table = p.qualified();
  if (p.optionalWord("add")) {
    const element = parseDdlConstraint(p);
    p.lastSpan = element.constraint.clauseSpan;
    return { kind: "addition", value: { table, element, span: p.spanFrom(start) } };
  }
  const action = p.choice(["enable", "disable", "force", "no"]);
  if (action === "no") p.word("force");
  p.word("row");
  p.word("level");
  p.word("security");
  return {
    kind: "rls",
    value: {
      table,
      axis: action === "enable" || action === "disable" ? "enabled" : "forced",
      value: action === "enable" || action === "force",
      span: p.spanFrom(start),
    },
  };
}

export function parseDdlPolicy(p: DdlParser, start: SourceSpan): DdlPolicy {
  const name = p.identifier();
  p.word("on");
  const table = p.qualified();
  const mode = p.optionalWord("as") ? p.choice(["permissive", "restrictive"]) : "permissive";
  const command = p.optionalWord("for")
    ? p.choice(["all", "select", "insert", "update", "delete"])
    : "all";
  let roles: IdentifierIdentity[] | null = null;
  if (p.optionalWord("to")) {
    roles = [p.identifier()];
    while (p.optionalPunctuation(",")) roles.push(p.identifier());
  }
  let usingSpan: SourceSpan | null = null;
  if (p.isWord("using")) {
    if (command === "insert") p.fail();
    p.consume();
    usingSpan = p.opaque();
  }
  let withCheckSpan: SourceSpan | null = null;
  if (p.isWord("with")) {
    if (command === "select" || command === "delete") p.fail();
    p.consume();
    p.word("check");
    withCheckSpan = p.opaque();
  }
  return { name, table, mode, command, roles, usingSpan, withCheckSpan, span: p.spanFrom(start) };
}
