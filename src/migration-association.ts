import type { IdentifierIdentity } from "./create-table-parser-primitives.js";
import type { CreateTableToken, SourceSpan } from "./create-table-token-source.js";
import { ddlQualifiedIdentityKey } from "./ddl-evidence.js";
import type {
  MigrationDocumentIndex,
  MigrationStatement,
  MigrationTargetCandidate,
} from "./migration-document.js";

export type MigrationNotEvaluatedKind =
  | "missing_base_declaration"
  | "multiple_base_declarations"
  | "unlogged_relation"
  | "association_limit_exceeded"
  | "add_column"
  | "drop_column"
  | "drop_constraint"
  | "drop_policy"
  | "drop_table"
  | "drop_trigger"
  | "rename"
  | "alter_column_type"
  | "drop_default_or_identity"
  | "unsupported_target_alter"
  | "associated_statement_without_base"
  | "relevant_statement_not_recognized"
  | "generation_column_not_in_base"
  | "duplicate_type_declaration"
  | "unresolved_schema_association";

export type MigrationNotEvaluated = {
  readonly kind: MigrationNotEvaluatedKind;
  readonly statementKind: string;
  readonly span: SourceSpan;
  readonly detail: string;
  readonly constraintName?: IdentifierIdentity;
};

export type GeneratedColumnEvidence = {
  readonly column: IdentifierIdentity;
  readonly source: "identity" | "default";
  readonly identityMode?: "always" | "by_default" | null;
  readonly span: SourceSpan;
};

export type MigrationAssociationPlan = {
  readonly target: MigrationTargetCandidate;
  readonly base: MigrationStatement | null;
  readonly supportedStatements: readonly MigrationStatement[];
  readonly generatedColumns: readonly GeneratedColumnEvidence[];
  readonly notEvaluated: readonly MigrationNotEvaluated[];
  readonly ignoredTargetStatements: readonly MigrationStatement[];
};

/**
 * Bounds target-local association work independently of the whole-document
 * statement/token caps. Real audited targets are far below this ceiling; input
 * beyond it remains visible as NOT_EVALUATED rather than triggering quadratic
 * target projection work or silently dropping relevant SQL.
 */
export const MAX_TARGET_ASSOCIATED_STATEMENTS = 256;

export function planMigrationTargetAssociation(
  index: MigrationDocumentIndex,
  target: MigrationTargetCandidate,
): MigrationAssociationPlan {
  const declarations = target.declarationStatementOrdinals
    .map((ordinal) => index.statementByOrdinal.get(ordinal))
    .filter((statement): statement is MigrationStatement => statement !== undefined);
  const notEvaluated: MigrationNotEvaluated[] = [];
  const generatedColumns: GeneratedColumnEvidence[] = [];
  const supportedStatements: MigrationStatement[] = [];
  const ignoredTargetStatements: MigrationStatement[] = [];
  const base = declarations.length === 1 ? (declarations[0] ?? null) : null;
  const hasUsableBase = base !== null && base.relationModifier !== "unlogged";
  let associatedStatementCount = 0;
  let associationLimitReported = false;

  if (declarations.length === 0) {
    notEvaluated.push({
      kind: "missing_base_declaration",
      statementKind: "ALTER TABLE",
      span: target.firstSeenSpan,
      detail:
        "No CREATE TABLE declaration for this exact target identity is present in the document.",
    });
  } else if (declarations.length > 1) {
    notEvaluated.push({
      kind: "multiple_base_declarations",
      statementKind: "CREATE TABLE",
      span: declarations[1]?.span ?? target.firstSeenSpan,
      detail: "More than one CREATE TABLE declaration names this exact target identity.",
    });
  } else if (base?.relationModifier === "unlogged") {
    notEvaluated.push({
      kind: "unlogged_relation",
      statementKind: "CREATE UNLOGGED TABLE",
      span: base.span,
      detail: "UNLOGGED relation semantics are outside the audited v0.2 recognition boundary.",
    });
  }

  const targetKey = target.key;
  for (const statement of index.statements) {
    if (statement.target === null || ddlQualifiedIdentityKey(statement.target) !== targetKey)
      continue;
    if (statement.kind === "create_table") continue;
    associatedStatementCount += 1;
    if (associatedStatementCount > MAX_TARGET_ASSOCIATED_STATEMENTS) {
      if (!associationLimitReported) {
        associationLimitReported = true;
        notEvaluated.push({
          kind: "association_limit_exceeded",
          statementKind: statementLabel(statement),
          span: statement.span,
          detail: `More than ${MAX_TARGET_ASSOCIATED_STATEMENTS} target-local statements affect this table; statements after that limit were not evaluated.`,
        });
      }
      continue;
    }
    if (target.scope === "schema_unresolved") {
      notEvaluated.push({
        kind: "unresolved_schema_association",
        statementKind: statementLabel(statement),
        span: statement.span,
        detail:
          "The relation has no declared schema, so this later statement was not combined with the base declaration.",
      });
      continue;
    }
    if (statement.kind === "alter_table") {
      const action = classifyAlter(statement);
      if (action.kind === "supported") {
        if (hasUsableBase) supportedStatements.push(statement);
        else notEvaluated.push(associatedStatementWithoutBase(statement));
      } else if (action.kind === "generated") {
        if (hasUsableBase) generatedColumns.push(action.evidence);
        else {
          notEvaluated.push({
            kind: "generation_column_not_in_base",
            statementKind: "ALTER TABLE",
            span: statement.span,
            detail:
              "This value-generation statement was not evaluated because no single supported CREATE TABLE declaration establishes the base target shape.",
          });
        }
      } else if (action.kind === "ignored") ignoredTargetStatements.push(statement);
      else notEvaluated.push(action.evidence);
      continue;
    }
    if (statement.kind === "create_policy" || statement.kind === "create_trigger") {
      if (hasUsableBase) supportedStatements.push(statement);
      else notEvaluated.push(associatedStatementWithoutBase(statement));
      continue;
    }
    if (
      statement.kind === "drop_policy" ||
      statement.kind === "drop_table" ||
      statement.kind === "drop_trigger"
    ) {
      notEvaluated.push({
        kind: statement.kind,
        statementKind: statementLabel(statement),
        span: statement.span,
        detail:
          statement.kind === "drop_policy"
            ? "DROP POLICY was detected but not applied by this analyzer; the final policy set is not established."
            : statement.kind === "drop_table"
              ? "DROP TABLE was detected but not applied by this analyzer; the final target existence and shape are not established."
              : "DROP TRIGGER was detected but not applied by this analyzer; the final trigger set is not established.",
      });
      continue;
    }
    if (statement.kind === "create_index") {
      if (statement.uniqueIndex && hasUsableBase) supportedStatements.push(statement);
      else if (statement.uniqueIndex) notEvaluated.push(associatedStatementWithoutBase(statement));
      else ignoredTargetStatements.push(statement);
    }
  }

  supportedStatements.sort((left, right) => left.ordinal - right.ordinal);
  return {
    target,
    base,
    supportedStatements,
    generatedColumns,
    notEvaluated,
    ignoredTargetStatements,
  };
}

function associatedStatementWithoutBase(statement: MigrationStatement): MigrationNotEvaluated {
  const actionIndex = statement.kind === "alter_table" ? alterActionIndex(statement.tokens) : null;
  const constraintName =
    actionIndex !== null &&
    word(statement.tokens[actionIndex]) === "add" &&
    word(statement.tokens[actionIndex + 1]) === "constraint"
      ? (identifier(statement.tokens[actionIndex + 2]) ?? undefined)
      : undefined;
  return {
    kind: "associated_statement_without_base",
    statementKind: statementLabel(statement),
    span: statement.span,
    detail:
      "This associated statement was not evaluated because no single supported CREATE TABLE declaration establishes the base target shape.",
    ...(constraintName === undefined ? {} : { constraintName }),
  };
}

function statementLabel(statement: MigrationStatement): string {
  switch (statement.kind) {
    case "alter_table":
      return "ALTER TABLE";
    case "create_index":
      return "CREATE INDEX";
    case "create_policy":
      return "CREATE POLICY";
    case "create_trigger":
      return "CREATE TRIGGER";
    case "drop_policy":
      return "DROP POLICY";
    case "drop_table":
      return "DROP TABLE";
    case "drop_trigger":
      return "DROP TRIGGER";
    case "create_table":
      return "CREATE TABLE";
    case "create_type":
      return "CREATE TYPE";
    case "other":
      return "SQL statement";
    case "empty":
      return "empty statement";
  }
}

type AlterClassification =
  | { readonly kind: "supported" }
  | { readonly kind: "ignored" }
  | { readonly kind: "generated"; readonly evidence: GeneratedColumnEvidence }
  | { readonly kind: "not_evaluated"; readonly evidence: MigrationNotEvaluated };

function classifyAlter(statement: MigrationStatement): AlterClassification {
  const actionIndex = alterActionIndex(statement.tokens);
  if (actionIndex === null)
    return unsupportedAlter(statement, "The ALTER TABLE action could not be bounded.");
  const tokens = statement.tokens;
  if (hasAdditionalAlterAction(tokens, actionIndex)) {
    return unsupportedAlter(
      statement,
      "This ALTER TABLE contains more than one action; none of its actions were evaluated.",
    );
  }
  const action = word(tokens[actionIndex]);

  if (action === "owner") return { kind: "ignored" };
  if (["enable", "disable", "force", "no"].includes(action ?? "")) {
    return wordsFrom(tokens, actionIndex, 6).includes("security")
      ? { kind: "supported" }
      : unsupportedAlter(
          statement,
          "The ALTER TABLE state change is outside the audited RLS forms.",
        );
  }

  if (action === "add") {
    const next = word(tokens[actionIndex + 1]);
    if (next === "column")
      return mutation(statement, "add_column", "ADD COLUMN changes final table shape.");
    if (["constraint", "primary", "unique", "foreign", "check"].includes(next ?? "")) {
      return { kind: "supported" };
    }
    return unsupportedAlter(statement, "Only audited ADD CONSTRAINT forms are projected in v0.2.");
  }

  if (action === "drop") {
    const next = word(tokens[actionIndex + 1]);
    if (next === "column")
      return mutation(statement, "drop_column", "DROP COLUMN changes final table shape.");
    if (next === "constraint") {
      return mutation(
        statement,
        "drop_constraint",
        "DROP CONSTRAINT changes the final constraint set.",
      );
    }
    return unsupportedAlter(
      statement,
      "The DROP action is target-relevant but outside the audited projection.",
    );
  }

  if (action === "rename")
    return mutation(statement, "rename", "RENAME changes structural identity.");

  if (action === "alter") {
    let at = actionIndex + 1;
    if (word(tokens[at]) === "column") at += 1;
    const column = identifier(tokens[at]);
    if (column === null)
      return unsupportedAlter(
        statement,
        "ALTER COLUMN does not contain a bounded column identity.",
      );
    at += 1;
    const next = word(tokens[at]);
    if (
      next === "type" ||
      (next === "set" && word(tokens[at + 1]) === "data" && word(tokens[at + 2]) === "type")
    ) {
      return mutation(
        statement,
        "alter_column_type",
        "ALTER COLUMN TYPE changes the final column type.",
      );
    }
    if (
      next === "drop" &&
      (word(tokens[at + 1]) === "default" || word(tokens[at + 1]) === "identity")
    ) {
      return mutation(
        statement,
        "drop_default_or_identity",
        "Dropping DEFAULT or IDENTITY reverses value-generation state and requires ordered projection.",
      );
    }
    if (next === "set" && word(tokens[at + 1]) === "default") {
      return {
        kind: "generated",
        evidence: { column, source: "default", span: statement.span },
      };
    }
    if (
      next === "add" &&
      word(tokens[at + 1]) === "generated" &&
      (word(tokens[at + 2]) === "always" ||
        (word(tokens[at + 2]) === "by" && word(tokens[at + 3]) === "default"))
    ) {
      const asOffset = word(tokens[at + 2]) === "always" ? 3 : 4;
      if (word(tokens[at + asOffset]) === "as" && word(tokens[at + asOffset + 1]) === "identity") {
        return {
          kind: "generated",
          evidence: { column, source: "identity", span: statement.span },
        };
      }
    }
    return unsupportedAlter(
      statement,
      "This ALTER COLUMN form is target-relevant but not projected by v0.2.",
    );
  }

  return unsupportedAlter(
    statement,
    "This target-local ALTER TABLE form is outside the audited v0.2 projection.",
  );
}

function hasAdditionalAlterAction(
  tokens: readonly CreateTableToken[],
  actionIndex: number,
): boolean {
  let parentheses = 0;
  let brackets = 0;
  for (let index = actionIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isPunctuation(token, "(")) parentheses += 1;
    else if (isPunctuation(token, ")")) parentheses = Math.max(0, parentheses - 1);
    else if (isPunctuation(token, "[")) brackets += 1;
    else if (isPunctuation(token, "]")) brackets = Math.max(0, brackets - 1);
    else if (isPunctuation(token, ",") && parentheses === 0 && brackets === 0) return true;
  }
  return false;
}

function alterActionIndex(tokens: readonly CreateTableToken[]): number | null {
  if (word(tokens[0]) !== "alter" || word(tokens[1]) !== "table") return null;
  let at = 2;
  if (word(tokens[at]) === "if" && word(tokens[at + 1]) === "exists") at += 2;
  if (word(tokens[at]) === "only") at += 1;
  if (identifier(tokens[at]) === null) return null;
  at += 1;
  if (isPunctuation(tokens[at], ".")) {
    if (identifier(tokens[at + 1]) === null) return null;
    at += 2;
  }
  const possibleStar = tokens[at];
  if (possibleStar?.kind === "operator" && possibleStar.value === "*") at += 1;
  return at;
}

function mutation(
  statement: MigrationStatement,
  kind: Extract<
    MigrationNotEvaluatedKind,
    | "add_column"
    | "drop_column"
    | "drop_constraint"
    | "rename"
    | "alter_column_type"
    | "drop_default_or_identity"
  >,
  detail: string,
): AlterClassification {
  return {
    kind: "not_evaluated",
    evidence: { kind, statementKind: "ALTER TABLE", span: statement.span, detail },
  };
}

function unsupportedAlter(statement: MigrationStatement, detail: string): AlterClassification {
  return {
    kind: "not_evaluated",
    evidence: {
      kind: "unsupported_target_alter",
      statementKind: "ALTER TABLE",
      span: statement.span,
      detail,
    },
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

function wordsFrom(tokens: readonly CreateTableToken[], start: number, count: number): string[] {
  const result: string[] = [];
  for (let index = start; index < Math.min(tokens.length, start + count); index += 1) {
    const value = word(tokens[index]);
    if (value !== null) result.push(value);
  }
  return result;
}

function isPunctuation(token: CreateTableToken | undefined, value: string): boolean {
  return token?.kind === "punctuation" && token.value === value;
}
