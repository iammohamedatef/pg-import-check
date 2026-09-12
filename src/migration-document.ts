import {
  contextualRefusalForDemand,
  createTableTokenSource,
  MAX_IDENTIFIER_BYTES,
  type CreateTableToken,
  type LexicalRefusal,
  type SourceSpan,
} from "./create-table-token-source.js";
import {
  spanning,
  type IdentifierIdentity,
  type QualifiedIdentity,
} from "./create-table-parser-primitives.js";
import { ddlQualifiedIdentityKey } from "./ddl-evidence.js";
import type { AcceptedRawInput } from "./input-profile.js";

export const MAX_MIGRATION_STATEMENTS = 20_000;
export const MAX_MIGRATION_TOKENS = 150_000;
export const MAX_MIGRATION_TARGETS = 5_000;

export type MigrationStatementKind =
  | "create_table"
  | "alter_table"
  | "create_type"
  | "create_index"
  | "create_policy"
  | "create_trigger"
  | "drop_policy"
  | "drop_table"
  | "drop_trigger"
  | "other"
  | "empty";

export type MigrationStatement = {
  readonly ordinal: number;
  readonly kind: MigrationStatementKind;
  readonly tokens: readonly CreateTableToken[];
  readonly span: SourceSpan;
  readonly target: QualifiedIdentity | null;
  readonly objectIdentity: QualifiedIdentity | null;
  readonly uniqueIndex: boolean;
  readonly relationModifier: "temporary" | "unlogged" | null;
};

export type MigrationTargetCandidate = {
  readonly key: string;
  readonly identity: QualifiedIdentity;
  readonly scope: "public" | "outside_public_profile" | "schema_unresolved";
  readonly declarationStatementOrdinals: readonly number[];
  readonly alterStatementOrdinals: readonly number[];
  readonly firstSeenSpan: SourceSpan;
};

export type MigrationDocumentIndex = {
  readonly input: AcceptedRawInput;
  readonly statements: readonly MigrationStatement[];
  readonly statementByOrdinal: ReadonlyMap<number, MigrationStatement>;
  readonly targets: readonly MigrationTargetCandidate[];
  readonly targetByKey: ReadonlyMap<string, MigrationTargetCandidate>;
  readonly typeDeclarations: ReadonlyMap<string, readonly MigrationStatement[]>;
};

export type MigrationDocumentRefusal =
  | LexicalRefusal
  | {
      readonly refusalId: "document_string_semantics_not_in_profile";
      readonly span: SourceSpan;
    }
  | {
      readonly refusalId: "document_target_lifecycle_not_bounded";
      readonly span: SourceSpan;
    }
  | { readonly refusalId: "document_too_many_statements"; readonly actual: number }
  | { readonly refusalId: "document_too_many_tokens"; readonly actual: number }
  | { readonly refusalId: "document_too_many_targets"; readonly actual: number };

export type MigrationDocumentIndexResult =
  | { readonly kind: "indexed"; readonly index: MigrationDocumentIndex }
  | { readonly kind: "refused"; readonly refusal: MigrationDocumentRefusal };

type ClassifiedStatement = Omit<MigrationStatement, "ordinal" | "tokens" | "span">;

type MutableTarget = {
  identity: QualifiedIdentity;
  declarationStatementOrdinals: number[];
  alterStatementOrdinals: number[];
  firstSeenSpan: SourceSpan;
};

export function createMigrationDocumentIndex(
  input: AcceptedRawInput,
): MigrationDocumentIndexResult {
  const source = createTableTokenSource(input);
  const statements: MigrationStatement[] = [];
  let current: CreateTableToken[] = [];
  let tokenCount = 0;

  for (;;) {
    const step = source.next();
    if (step.kind === "refused") return { kind: "refused", refusal: step.refusal };
    if (step.kind === "eof") {
      if (current.length > 0) {
        const refusal = appendStatement(statements, current);
        if (refusal !== null) return { kind: "refused", refusal };
      }
      break;
    }

    tokenCount += 1;
    if (tokenCount > MAX_MIGRATION_TOKENS) {
      return {
        kind: "refused",
        refusal: { refusalId: "document_too_many_tokens", actual: tokenCount },
      };
    }
    current.push(step.token);
    if (isPunctuation(step.token, ";")) {
      const refusal = appendStatement(statements, current);
      if (refusal !== null) return { kind: "refused", refusal };
      current = [];
    }
  }

  for (const statement of statements) {
    const refusal = documentStatementRefusal(statement);
    if (refusal !== null) return { kind: "refused", refusal };
  }

  const targets = new Map<string, MutableTarget>();
  const typeDeclarations = new Map<string, MigrationStatement[]>();
  for (const statement of statements) {
    if (statement.kind === "create_type" && statement.objectIdentity !== null) {
      const key = ddlQualifiedIdentityKey(statement.objectIdentity);
      const existing = typeDeclarations.get(key);
      if (existing === undefined) typeDeclarations.set(key, [statement]);
      else existing.push(statement);
    }
    if (
      (statement.kind !== "create_table" && statement.kind !== "alter_table") ||
      statement.target === null
    ) {
      continue;
    }
    if (statement.kind === "alter_table" && !isCandidateAlterTable(statement.tokens)) continue;
    const key = ddlQualifiedIdentityKey(statement.target);
    let target = targets.get(key);
    if (target === undefined) {
      target = {
        identity: statement.target,
        declarationStatementOrdinals: [],
        alterStatementOrdinals: [],
        firstSeenSpan: statement.target.span,
      };
      targets.set(key, target);
      if (targets.size > MAX_MIGRATION_TARGETS) {
        return {
          kind: "refused",
          refusal: { refusalId: "document_too_many_targets", actual: targets.size },
        };
      }
    }
    if (statement.kind === "create_table")
      target.declarationStatementOrdinals.push(statement.ordinal);
    else target.alterStatementOrdinals.push(statement.ordinal);
  }

  const candidates: MigrationTargetCandidate[] = [...targets.entries()].map(([key, target]) => ({
    key,
    identity: target.identity,
    scope:
      target.identity.qualifier === null
        ? "schema_unresolved"
        : target.identity.qualifier.identity === "public"
          ? "public"
          : "outside_public_profile",
    declarationStatementOrdinals: target.declarationStatementOrdinals,
    alterStatementOrdinals: target.alterStatementOrdinals,
    firstSeenSpan: target.firstSeenSpan,
  }));

  return {
    kind: "indexed",
    index: {
      input,
      statements,
      statementByOrdinal: new Map(statements.map((statement) => [statement.ordinal, statement])),
      targets: candidates,
      targetByKey: new Map(candidates.map((target) => [target.key, target])),
      typeDeclarations,
    },
  };
}

function appendStatement(
  statements: MigrationStatement[],
  tokens: readonly CreateTableToken[],
): MigrationDocumentRefusal | null {
  const actual = statements.length + 1;
  if (actual > MAX_MIGRATION_STATEMENTS) {
    return { refusalId: "document_too_many_statements", actual };
  }
  const first = tokens[0];
  const last = tokens.at(-1);
  if (first === undefined || last === undefined) throw new Error("Statement token invariant");
  const demandedIdentityRefusal = statementIdentityRefusal(tokens);
  if (demandedIdentityRefusal !== null) return demandedIdentityRefusal;
  const classified = classifyStatement(tokens);
  const identityRefusal = classifiedIdentityRefusal(classified);
  if (identityRefusal !== null) return identityRefusal;
  statements.push({
    ordinal: statements.length,
    tokens,
    span: spanning(first.span, last.span),
    ...classified,
  });
  return null;
}

/**
 * Keep profile refusals attached to identity positions that the bounded document
 * grammar already recognizes. A contextual non-ASCII token is intentionally
 * tolerated in unrelated SQL, but must not make a target-bearing statement
 * disappear before exact association can be decided.
 */
function statementIdentityRefusal(tokens: readonly CreateTableToken[]): LexicalRefusal | null {
  const first = word(tokens[0]);
  if (first === "alter" && word(tokens[1]) === "table") {
    let at = 2;
    if (word(tokens[at]) === "if" && word(tokens[at + 1]) === "exists") at += 2;
    if (word(tokens[at]) === "only") at += 1;
    return qualifiedIdentityRefusal(tokens, at);
  }

  if (first !== "create") return null;
  let at = 1;
  if (word(tokens[at]) === "or" && word(tokens[at + 1]) === "replace") at += 2;
  if (
    word(tokens[at]) === "temp" ||
    word(tokens[at]) === "temporary" ||
    word(tokens[at]) === "unlogged"
  ) {
    at += 1;
  }

  if (word(tokens[at]) === "table") {
    at += 1;
    if (
      word(tokens[at]) === "if" &&
      word(tokens[at + 1]) === "not" &&
      word(tokens[at + 2]) === "exists"
    ) {
      at += 3;
    }
    return qualifiedIdentityRefusal(tokens, at);
  }
  if (word(tokens[at]) === "type") return qualifiedIdentityRefusal(tokens, at + 1);

  if (word(tokens[at]) === "unique") at += 1;
  if (word(tokens[at]) === "constraint" && word(tokens[at + 1]) === "trigger") at += 1;
  if (!["index", "policy", "trigger"].includes(word(tokens[at]) ?? "")) return null;
  return identityRefusalAfterOn(tokens, at + 1);
}

function identityRefusalAfterOn(
  tokens: readonly CreateTableToken[],
  start: number,
): LexicalRefusal | null {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isPunctuation(token, "(")) depth += 1;
    else if (isPunctuation(token, ")")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && word(token) === "on") {
      let targetAt = index + 1;
      if (word(tokens[targetAt]) === "only") targetAt += 1;
      return qualifiedIdentityRefusal(tokens, targetAt);
    }
  }
  return null;
}

function qualifiedIdentityRefusal(
  tokens: readonly CreateTableToken[],
  at: number,
): LexicalRefusal | null {
  const first = tokens[at];
  if (first === undefined) return null;
  const firstRefusal = contextualRefusalForDemand(first, "identifier");
  if (firstRefusal !== null) return firstRefusal;
  if (identifier(first) === null || !isPunctuation(tokens[at + 1], ".")) return null;
  const second = tokens[at + 2];
  return second === undefined ? null : contextualRefusalForDemand(second, "identifier");
}

function classifyStatement(tokens: readonly CreateTableToken[]): ClassifiedStatement {
  if (tokens.length === 1 && isPunctuation(tokens[0], ";")) return emptyStatement();
  const first = word(tokens[0]);
  if (first === "create") return classifyCreate(tokens);
  if (first === "drop") return classifyDrop(tokens);
  if (first === "alter" && word(tokens[1]) === "table") return classifyAlterTable(tokens);
  return otherStatement();
}

function classifyDrop(tokens: readonly CreateTableToken[]): ClassifiedStatement {
  const objectKind = word(tokens[1]);
  if (objectKind !== "policy" && objectKind !== "table" && objectKind !== "trigger")
    return otherStatement();

  let at = 2;
  if (word(tokens[at]) === "if" && word(tokens[at + 1]) === "exists") at += 2;
  const object = parseQualifiedIdentity(tokens, at);
  if (object === null) return otherStatement();
  at = object.next;
  if (objectKind !== "table") {
    if (object.value.qualifier !== null || word(tokens[at]) !== "on") return otherStatement();
    at += 1;
  }
  const target = objectKind === "table" ? object : parseQualifiedIdentity(tokens, at);
  if (target === null) return otherStatement();

  let trailing = target.next;
  if (word(tokens[trailing]) === "cascade" || word(tokens[trailing]) === "restrict") trailing += 1;
  if (!isPunctuation(tokens[trailing], ";") || trailing !== tokens.length - 1)
    return otherStatement();

  return {
    kind:
      objectKind === "policy"
        ? "drop_policy"
        : objectKind === "table"
          ? "drop_table"
          : "drop_trigger",
    target: target.value,
    objectIdentity: null,
    uniqueIndex: false,
    relationModifier: null,
  };
}

function documentStatementRefusal(statement: MigrationStatement): Extract<
  MigrationDocumentRefusal,
  {
    readonly refusalId:
      | "document_string_semantics_not_in_profile"
      | "document_target_lifecycle_not_bounded";
  }
> | null {
  const tokens = statement.tokens;
  if (word(tokens[0]) === "set") {
    let at = 1;
    if (word(tokens[at]) === "session" || word(tokens[at]) === "local") at += 1;
    if (configurationParameter(tokens[at]) === "standard_conforming_strings") {
      at += 1;
      const hasAssignment = word(tokens[at]) === "to" || operator(tokens[at]) === "=";
      if (hasAssignment) at += 1;
      const explicitlyStandard =
        hasAssignment &&
        word(tokens[at]) === "on" &&
        isPunctuation(tokens[at + 1], ";") &&
        at + 1 === tokens.length - 1;
      if (!explicitlyStandard) {
        return {
          refusalId: "document_string_semantics_not_in_profile",
          span: statement.span,
        };
      }
    }
  }

  if (
    word(tokens[0]) === "drop" &&
    ["policy", "table", "trigger"].includes(word(tokens[1]) ?? "") &&
    !["drop_policy", "drop_table", "drop_trigger"].includes(statement.kind)
  ) {
    return { refusalId: "document_target_lifecycle_not_bounded", span: statement.span };
  }
  return null;
}

function classifiedIdentityRefusal(classified: ClassifiedStatement): LexicalRefusal | null {
  for (const identity of [classified.target, classified.objectIdentity]) {
    if (identity === null) continue;
    for (const component of [identity.qualifier, identity.local]) {
      if (
        component === null ||
        component.quoted ||
        component.identity.length <= MAX_IDENTIFIER_BYTES
      )
        continue;
      return {
        refusalId: "identifier_outside_profile",
        actualUtf8ByteLength: component.identity.length,
        span: component.span,
      };
    }
  }
  return null;
}

function configurationParameter(token: CreateTableToken | undefined): string | null {
  if (token?.kind === "word") return token.folded;
  if (token?.kind !== "quoted_identifier") return null;
  return token.identity.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function classifyCreate(tokens: readonly CreateTableToken[]): ClassifiedStatement {
  let at = 1;
  if (word(tokens[at]) === "or" && word(tokens[at + 1]) === "replace") at += 2;

  let relationModifier: ClassifiedStatement["relationModifier"] = null;
  if (word(tokens[at]) === "temp" || word(tokens[at]) === "temporary") {
    relationModifier = "temporary";
    at += 1;
  } else if (word(tokens[at]) === "unlogged") {
    relationModifier = "unlogged";
    at += 1;
  }

  if (word(tokens[at]) === "table") {
    at += 1;
    if (
      word(tokens[at]) === "if" &&
      word(tokens[at + 1]) === "not" &&
      word(tokens[at + 2]) === "exists"
    ) {
      at += 3;
    }
    const identity = parseQualifiedIdentity(tokens, at);
    return identity === null
      ? otherStatement()
      : {
          kind: "create_table",
          target: identity.value,
          objectIdentity: identity.value,
          uniqueIndex: false,
          relationModifier,
        };
  }

  if (word(tokens[at]) === "type") {
    const identity = parseQualifiedIdentity(tokens, at + 1);
    return identity === null
      ? otherStatement()
      : {
          kind: "create_type",
          target: null,
          objectIdentity: identity.value,
          uniqueIndex: false,
          relationModifier: null,
        };
  }

  let uniqueIndex = false;
  if (word(tokens[at]) === "unique") {
    uniqueIndex = true;
    at += 1;
  }
  if (word(tokens[at]) === "index") {
    const target = findTargetAfterOn(tokens, at + 1);
    return {
      kind: "create_index",
      target,
      objectIdentity: null,
      uniqueIndex,
      relationModifier: null,
    };
  }

  if (word(tokens[at]) === "policy") {
    return {
      kind: "create_policy",
      target: findTargetAfterOn(tokens, at + 1),
      objectIdentity: null,
      uniqueIndex: false,
      relationModifier: null,
    };
  }

  if (word(tokens[at]) === "constraint" && word(tokens[at + 1]) === "trigger") at += 1;
  if (word(tokens[at]) === "trigger") {
    return {
      kind: "create_trigger",
      target: findTargetAfterOn(tokens, at + 1),
      objectIdentity: null,
      uniqueIndex: false,
      relationModifier: null,
    };
  }

  return otherStatement();
}

function classifyAlterTable(tokens: readonly CreateTableToken[]): ClassifiedStatement {
  let at = 2;
  if (word(tokens[at]) === "if" && word(tokens[at + 1]) === "exists") at += 2;
  if (word(tokens[at]) === "only") at += 1;
  const target = parseQualifiedIdentity(tokens, at);
  return target === null
    ? otherStatement()
    : {
        kind: "alter_table",
        target: target.value,
        objectIdentity: null,
        uniqueIndex: false,
        relationModifier: null,
      };
}

/**
 * pg_dump emits `ALTER TABLE <sequence> OWNER TO ...` for sequence-like objects.
 * Ownership-only ALTERs cannot establish that an ALTER-only relation is a table,
 * so they never create a candidate. They remain indexed as surrounding SQL.
 */
function isCandidateAlterTable(tokens: readonly CreateTableToken[]): boolean {
  let at = 2;
  if (word(tokens[at]) === "if" && word(tokens[at + 1]) === "exists") at += 2;
  if (word(tokens[at]) === "only") at += 1;
  if (identifier(tokens[at]) === null) return false;
  at += 1;
  if (isPunctuation(tokens[at], ".")) {
    if (identifier(tokens[at + 1]) === null) return false;
    at += 2;
  }
  const possibleStar = tokens[at];
  if (possibleStar?.kind === "operator" && possibleStar.value === "*") at += 1;
  return word(tokens[at]) !== "owner";
}

function findTargetAfterOn(
  tokens: readonly CreateTableToken[],
  start: number,
): QualifiedIdentity | null {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (isPunctuation(token, "(")) depth += 1;
    else if (isPunctuation(token, ")")) depth = Math.max(0, depth - 1);
    else if (depth === 0 && word(token) === "on") {
      let targetAt = index + 1;
      if (word(tokens[targetAt]) === "only") targetAt += 1;
      return parseQualifiedIdentity(tokens, targetAt)?.value ?? null;
    }
  }
  return null;
}

function parseQualifiedIdentity(
  tokens: readonly CreateTableToken[],
  at: number,
): { readonly value: QualifiedIdentity; readonly next: number } | null {
  const first = identifier(tokens[at]);
  if (first === null) return null;
  if (!isPunctuation(tokens[at + 1], ".")) {
    return {
      value: { qualifier: null, local: first, span: first.span },
      next: at + 1,
    };
  }
  const second = identifier(tokens[at + 2]);
  if (second === null) return null;
  return {
    value: { qualifier: first, local: second, span: spanning(first.span, second.span) },
    next: at + 3,
  };
}

function identifier(token: CreateTableToken | undefined): IdentifierIdentity | null {
  if (token?.kind === "word") return { identity: token.folded, quoted: false, span: token.span };
  if (token?.kind === "quoted_identifier") {
    return { identity: token.identity, quoted: true, span: token.span };
  }
  return null;
}

function word(token: CreateTableToken | undefined): string | null {
  return token?.kind === "word" ? token.folded : null;
}

function operator(token: CreateTableToken | undefined): string | null {
  return token?.kind === "operator" ? token.value : null;
}

function isPunctuation(token: CreateTableToken | undefined, value: string): boolean {
  return token?.kind === "punctuation" && token.value === value;
}

function otherStatement(): ClassifiedStatement {
  return {
    kind: "other",
    target: null,
    objectIdentity: null,
    uniqueIndex: false,
    relationModifier: null,
  };
}

function emptyStatement(): ClassifiedStatement {
  return {
    kind: "empty",
    target: null,
    objectIdentity: null,
    uniqueIndex: false,
    relationModifier: null,
  };
}
