# DDL recognition contract v1

This is the unchanged structural language and input-safety contract. Section numbers
are retained for internal cross-references. References to `check-behavior-v1` here
identify the frozen recognition/refusal vocabulary, not a compatibility policy.
Only the CREATE TABLE and lexical portions are implemented today. Other statement
shells remain specified future work. No new grammar is authorized by the public profile.

## 3. Input Profile v1

### 3.1 Canonical byte boundary

The core input is a stable `Uint8Array`.

1. Read `byteLength` before decoding or lexical processing.
2. If `byteLength` is greater than 262,144, refuse with `input_too_large`.
3. The limit is inclusive: exactly 262,144 raw bytes proceeds to the remaining input checks.
4. A leading UTF-8 BOM counts toward the raw limit.
5. After the size check, snapshot the accepted bytes before analysis. The core must not mutate the caller's array.

The canonical API assumes that the byte sequence is stable for the duration of the call. Concurrent mutation of shared backing storage does not describe a fixed input sequence and is outside the determinism contract; CLI and browser adapters must not supply such storage.

### 3.2 UTF-8 and NUL

Decode strict scalar-valid UTF-8. Refuse with `invalid_utf8` for:

- an invalid leading byte;
- an invalid or missing continuation byte;
- an overlong encoding;
- a UTF-8 encoding of U+D800–U+DFFF;
- a value above U+10FFFF.

Refuse U+0000 anywhere in the decoded input with `nul_byte_not_in_profile`.

No decoder replacement character may be introduced on behalf of invalid bytes.

### 3.3 BOM

Accept zero or one UTF-8 BOM (`EF BB BF`) only at raw byte offset zero. After the raw-size check and valid UTF-8 check, remove that one leading U+FEFF before lexing.

No other U+FEFF is stripped. Outside a quoted/comment/body region, it refuses with `unexpected_bom`. Inside an identifier, it is an unsafe invisible-format character. Inside other quoted content, it is retained semantically and escaped if rendered.

### 3.4 Line endings and line accounting

Do not globally normalize line endings. CR and LF may be data inside strings, dollar-quoted bodies, and quoted identifiers.

Outside quoted regions:

- CRLF is whitespace and counts as one diagnostic line break;
- lone CR is whitespace and counts as one line break;
- lone LF is whitespace and counts as one line break.

Inside quoted regions, the decoded scalar sequence is preserved. Report output always uses LF.

Line 1 begins at the first decoded scalar after an optional stripped BOM. Columns are counted in Unicode scalar values from 1. Byte spans remain the authoritative internal location.

### 3.5 Unicode normalization

Do not apply NFC, NFD, NFKC, NFKD, locale-sensitive case conversion, confusable folding, or any other Unicode normalization. Distinct quoted identifier sequences remain distinct.

### 3.6 Identifier profile

An unquoted identifier is exactly:

```text
[A-Za-z_][A-Za-z0-9_$]*
```

ASCII letters in an unquoted identifier are folded to lowercase for identity comparison. Source spelling may be retained for diagnostics but does not determine identity.

If an unquoted word begins with ASCII identifier characters and then contains a non-ASCII scalar, refuse with `unquoted_non_ascii_identifier`. If the grammar expects an identifier and the next scalar is non-ASCII, use the same refusal. Any other non-ASCII scalar outside a quoted string, quoted identifier, dollar-quoted body, or comment refuses with `syntax_not_in_profile`. V1 does not attempt locale- or runtime-dependent PostgreSQL character classification or case folding.

Remediation text is fixed:

> check-behavior-v1 accepts non-ASCII identifiers only when they are double-quoted. Supply the exact double-quoted identifier or an equivalent declaration in the accepted profile.

A double-quoted identifier:

- begins and ends with `"`;
- represents an embedded `"` as `""`;
- may contain safe printable Unicode;
- preserves its decoded scalar sequence exactly;
- must not be empty;
- must not contain U+0000, CR, LF, C0/C1 controls, DEL, bidi controls, Unicode line/paragraph separators, or a code point in the closed invisible-format table below.

An empty double-quoted identifier `""` refuses with `syntax_not_in_profile` at the location of
its opening `"`. Detection may occur after observing the closing quote; a decoded embedded quote
represented by `""` inside a quoted identifier is identifier content and is not empty.

After quote decoding, every identifier component must encode to at most 63 UTF-8 bytes. A longer identifier refuses with `identifier_outside_profile`. This is an identity rule for the standard PostgreSQL 63-byte identifier profile, not a performance limit.

Quoted-identifier refusals are selected in this order under the decoding rules above:

1. On the first unsafe scalar, refuse immediately with `identifier_contains_unsafe_character` at
   that scalar.
2. Otherwise, if EOF is reached before the identifier closes, refuse with
   `unterminated_quoted_identifier` at the opening `"`.
3. Otherwise, once the identifier has closed safely and is nonempty, evaluate its decoded identity
   against the 63-byte limit. A longer identifier refuses with `identifier_outside_profile` at its
   opening `"`.

Unsafe content therefore takes precedence over unterminated structure, which takes precedence over
decoded length. Do not report or depend on a final decoded identifier length for a construct that
did not close safely.

The fixed unsafe identifier table is the union below. It deliberately includes every Unicode 17.0 `Default_Ignorable_Code_Point` and every Unicode 17.0 format (`Cf`) character. The literal ranges, not a runtime Unicode-property query, govern `check-behavior-v1`:

- U+0000–U+001F and U+007F–U+009F;
- U+00AD, U+034F, U+0600–U+0605, U+061C, U+06DD, U+070F, U+0890–U+0891, U+08E2;
- U+115F, U+1160, U+17B4, U+17B5, U+180B–U+180F;
- U+200B–U+200F, U+202A–U+202E, U+2060–U+206F;
- U+2028 and U+2029 (line and paragraph separators);
- U+3164, U+FE00–U+FE0F, U+FEFF, U+FFA0, U+FFF0–U+FFFB;
- U+110BD, U+110CD, U+13430–U+1343F, U+1BCA0–U+1BCA3, U+1D173–U+1D17A;
- U+E0000–U+E0FFF;
- U+E000–U+F8FF, U+F0000–U+FFFFD, and U+100000–U+10FFFD (private use);
- U+FDD0–U+FDEF and the final two scalar values of every plane, U+nFFFE/U+nFFFF for hexadecimal plane n=0x0–0x10 (Unicode noncharacters).

The selection is traceable to the Unicode 17.0 [derived core properties](https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt) and [derived general categories](https://www.unicode.org/Public/17.0.0/ucd/extracted/DerivedGeneralCategory.txt). Those references explain how the table was selected; they are not runtime data dependencies. The literal table is behavior-versioned and must not be broadened, narrowed, or replaced with host Unicode properties without `check-behavior` version review.

Structural identifier acceptance is distinct from public product-policy evaluation.
The active public profile owns any additional compatibility observations.

### 3.7 Browser UTF-16 adapter

The browser receives a JavaScript string from the textarea. Before `TextEncoder`:

1. If the UTF-16 code-unit length is greater than 262,144, return `input_too_large` without scanning or encoding. Every valid scalar representation of that many code units would exceed the raw-byte cap.
2. Otherwise scan UTF-16 code units from start to end while computing the exact UTF-8 byte length without allocation.
3. A high surrogate must be followed immediately by a low surrogate. A low surrogate must be preceded as part of a valid pair.
4. On the first lone surrogate, return the browser-adapter refusal `browser_lone_surrogate` without invoking `TextEncoder`.
5. If the valid string's computed UTF-8 length is greater than 262,144, return `input_too_large` without invoking `TextEncoder`.
6. Otherwise encode the string as UTF-8 and pass the resulting bytes to the core.

This makes adapter work and allocation bounded by the same approved magnitude as core input while preventing `TextEncoder` from silently substituting U+FFFD. Browser or operating-system changes that occur before the checker receives the textarea value are outside the raw-byte contract.

## 4. Lexical grammar

### 4.1 Whitespace

Outside quoted regions, the accepted whitespace scalars are U+0009 (tab), U+000C (form feed), U+000A (LF), U+000D (CR), and U+0020 (space). Other unquoted control or non-ASCII whitespace refuses as `syntax_not_in_profile`.

### 4.2 Comments

Accept:

- `--` through but not including the next CR or LF, or through end of input;
- `/* ... */` block comments with PostgreSQL-style nesting.

Block-comment nesting must be tracked iteratively. If EOF is reached while a block comment remains open, refuse with `unterminated_block_comment` at the first `/` of the outermost opening `/*`. EOF establishes the refusal but is not its reported location; the refusal retains neither nested opener locations nor attacker-controlled source text. Comments behave as whitespace for token separation and otherwise do not affect an analyzed report.

### 4.3 Standard strings

A standard string begins and ends with `'`. Two adjacent quotes `''` represent one quote. Backslash has no special lexical meaning in a standard string under this profile. Unterminated input refuses with `unterminated_string`.

Standard strings are decoded only where the accepted statement grammar requires a semantic string value, such as an enum label or trigger argument. Elsewhere they may remain token spans.

### 4.4 E-prefixed strings

The lexer recognizes an ASCII `E` or `e` immediately followed by `'` as an E-prefixed string. For finding its end, a backslash protects the next scalar and `''` protects a quote.

Lexical formation and `unterminated_string` handling remain source-token responsibilities. A safely closed E-prefixed string is accepted directly as a `default_atom` in §5 and as an atomic protected token inside an admitted opaque/balanced traversal. V1 does not decode its escapes or semantic value in either position, and the bounded cast suffix in §5 is the only direct DEFAULT tail.

An E-prefixed string is not accepted as an enum label, function body, policy/trigger/object name, comment text value, or any other value the analyzer must decode. Use in such a semantic-value position refuses with `escape_string_semantics_not_in_profile`.

### 4.5 Quoted identifiers and Unicode escape syntax

Double-quoted identifiers follow §3.6. Unterminated input refuses with `unterminated_quoted_identifier`.

At a demanded token boundary, ASCII `U` or `u` immediately followed by `&` and then immediately by `"` or `'` refuses with `unicode_escape_syntax_not_in_profile` at the `U`. The source stage stops there and does not scan the Unicode quoted construct. This earlier refusal subsumes every authentic PostgreSQL `UESCAPE` clause, so v1 has no separately reachable parser-level `UESCAPE` detector.

Bare unquoted `UESCAPE` remains an ordinary folded ASCII word whose meaning is parser-contextual, and `"UESCAPE"` remains a quoted identifier. `U & ...` with trivia or other separation is not the contiguous Unicode introducer. UESCAPE-like content inside a protected string, E-prefixed string, comment, or dollar body remains protected content.

### 4.6 Dollar-quoted bodies

A dollar delimiter is `$`, an optional ASCII tag, and another `$`. A non-empty tag matches:

```text
[A-Za-z_][A-Za-z0-9_]*
```

The closing delimiter is the exact same byte sequence, case-sensitive. Content has no escape processing. Semicolons, quotes, comments, and other dollar delimiters inside the body do not end the outer body unless they exactly match its delimiter.

An unterminated body refuses with `unterminated_dollar_quote`. A safely closed body is one atomic protected token. Dollar-quoted content is accepted only where the statement grammar explicitly permits it; an admitted opaque/balanced traversal is such a permission. Body contents do not affect parser delimiter balance, commas, semicolons, keywords, or statement boundaries.

### 4.7 Other tokens

The lexer recognizes:

- ASCII numeric token spans defined below;
- punctuation `(`, `)`, `[`, `]`, `,`, `.`, and `;`;
- maximal runs of the ASCII operator characters shown below;
- dollar-position tokens `$` followed by ASCII digits inside opaque expressions;
- ASCII word tokens, which parser productions compare with keywords case-insensitively.

The lexer does not reproduce PostgreSQL's version-specific keyword categories. An uppercase grammar literal matches a folded ASCII word token contextually. In a production position that asks for `identifier`, an ASCII word matching §3.6 may be consumed as an identifier; if a keyword alternative and an identifier alternative both begin at the same position, the keyword alternative wins. Quoting removes that profile ambiguity.

This is a deterministic recognizer rule, not proof that every accepted identifier spelling is legal in every PostgreSQL version. Reports do not assert that the supplied SQL would execute; accepted fixtures making PostgreSQL syntax claims require the independent validation in the top-level release criteria.

Recognition is lexical only. An operator or numeric token is not a claim that arbitrary PostgreSQL expression syntax is valid.

```text
+ - * / < > = ~ ! @ # % ^ & | ` ? :
```

```text
numeric_token :=
    digit { digit } [ "." { digit } ] [ ( "e" | "E" ) [ "+" | "-" ] digit { digit } ]
  | "." digit { digit } [ ( "e" | "E" ) [ "+" | "-" ] digit { digit } ]
```

Hexadecimal, octal, binary, underscore-separated, `NaN`, and `Infinity` numeric spellings are outside v1.

### 4.8 Statement boundaries

A semicolon at parser structural depth zero may terminate a top-level statement according to the enclosing grammar. At positive structural depth in an admitted opaque/balanced traversal, it is opaque material. A semicolon inside a protected comment, string, quoted identifier, or dollar body does not affect either decision. §5 defines structural depth and caller-owned boundaries.

The final statement may omit its semicolon. Consecutive semicolons or an otherwise empty statement refuse with `empty_statement_not_in_profile`. Trailing whitespace and comments are allowed after the final statement or final semicolon.

### 4.9 Finite top-level dispatch

After whitespace and comments, the parser examines at most four significant folded ASCII word tokens. It uses longest exact prefix matching against this table and no other top-level family:

| Dispatch prefixes | Family parser |
| --- | --- |
| `CREATE TABLE`, `CREATE TEMP TABLE`, `CREATE TEMPORARY TABLE` | target `CREATE TABLE` |
| `CREATE TYPE` | enum `CREATE TYPE` |
| `ALTER TABLE` | `ALTER TABLE` constraint/RLS forms |
| `CREATE POLICY` | `CREATE POLICY` |
| `CREATE FUNCTION`, `CREATE OR REPLACE FUNCTION` | trigger-function shell |
| `CREATE TRIGGER`, `CREATE CONSTRAINT TRIGGER` | trigger shell |
| `CREATE INDEX`, `CREATE UNIQUE INDEX` | narrow index shell |
| `COMMENT ON` | comment shell |

The dispatch prefixes are part of `check-behavior-v1`. In particular, `CREATE UNLOGGED TABLE`, `CREATE VIEW`, `CREATE FOREIGN TABLE`, `CREATE SEQUENCE`, and `CREATE OR REPLACE TRIGGER` do not dispatch to a recognized family.

Dispatch and refusal are deterministic:

| Input condition | Refusal | Diagnostic location |
| --- | --- | --- |
| The significant prefix matches one row above, but that family's grammar cannot continue | `syntax_not_in_profile` | the first token at which the selected grammar cannot continue unambiguously |
| EOF is reached while the significant tokens are a proper prefix of one or more dispatch prefixes | `syntax_not_in_profile` | end of input |
| The significant prefix cannot match any row above | `unsupported_statement` | the first significant token of that top-level statement |

An unsupported-family diagnostic may safely preview the shortest significant token prefix that establishes that no row can match; its location remains the first token. Demanded lexical refusals occur before dispatch. Once dispatched, a family-specific parse never falls back to `unsupported_statement`. Once unsupported dispatch or selected-family grammar is decisive, the source stage stops demanding tokens; a later malformed construct or delimiter defect cannot replace that result. The entire input refuses on the first deterministic statement parse failure in source order; no parser recovery or later-statement search is performed.

## 5. Common grammar terms

The grammar notation is descriptive EBNF:

- literals in uppercase are ASCII case-insensitive keywords;
- `identifier` means an accepted unquoted or quoted identifier;
- `qualified_name := identifier [ "." identifier ]`;
- `simple_column_list := "(" identifier { "," identifier } ")"`;
- `unsigned_integer` is one or more ASCII decimal digits;
- `type_word` is an accepted identifier or an ASCII word token in type position other than `CONSTRAINT`, `NOT`, `NULL`, `PRIMARY`, `UNIQUE`, `CHECK`, `REFERENCES`, `DEFAULT`, or `GENERATED`;
- `type_name := type_word | identifier "." type_word`;
- `type_span := type_name [ "(" unsigned_integer [ "," unsigned_integer ] ")" ] { "[" "]" }`;
- bracketed items are optional;
- braces mean zero or more repetitions;
- `opaque_parenthesized` is a non-empty, balanced token span including its outer parentheses;
- `opaque_expression` is a non-empty balanced token span terminated only by the enclosing grammar at delimiter depth zero.

`simple_column_list` is ordered structural evidence. Each identifier occurrence retains its source
order, quoted-versus-unquoted form, normalized identity, and exact source span. A table-level
primary-key or unique declaration does not reorder, sort, or discard that evidence when forming
its modeled key identity.

### 5.0 Existing serial declaration observation

A type span is serial shorthand if and only if it is unqualified, unquoted, has
no modifiers and no array suffix, and its ASCII-folded name is exactly `smallserial`,
`serial` or `bigserial`. Quoted, qualified, modified and array lookalikes are not
serial shorthand. `serial2`, `serial4` and `serial8` are not part of this closed
observation even though PostgreSQL may accept additional spellings. Other accepted
type words remain ordinary type spans. This definition documents the already-frozen
conflict/requiredness observation; it adds no grammar or implementation behavior.

For the declaration only, these spellings correspond respectively to smallint,
integer and bigint columns with sequence-default generation. This is PostgreSQL 17
syntax meaning, not proof of any actual sequence, default, ownership or permissions.
The public profile independently requires review of the resulting generation behavior.
See [PostgreSQL 17 serial types](https://www.postgresql.org/docs/17/datatype-numeric.html#DATATYPE-SERIAL).
The literal definition above is self-contained; the link is explanatory, not a build input.

### 5.1 Demand-driven balanced and opaque traversal

Parser-visible delimiter pairs are exactly `(` with `)` and `[` with `]`. Quotes, comments, and dollar delimiters belong to protected lexical constructs and never enter the parser delimiter stack. The token source forms those constructs and selects their malformed or unterminated lexical refusals; it does not perform an eager whole-input delimiter-balance pass.

Structural balance is typed, LIFO, iterative, lazy, and parser-owned. An opener becomes outstanding only after a grammar production commits to it or an admitted opaque/balanced traversal accepts it. When demanded input supplies a closing delimiter with no matching outstanding opener, or one that mismatches the stack top, refuse with `unbalanced_delimiter` at that closing token. If EOF arrives with outstanding committed openers and no earlier failure, select `unbalanced_delimiter` at the most recently opened still-unclosed delimiter, which is the stack top. EOF establishes that defect but does not become its reported location. A matching delimiter whose contents violate the grammar is not an imbalance; the applicable grammar/profile result applies instead.

The family parser owns whether an opaque region is admitted at a grammar position. The shared traversal owns typed balance, required-nonempty enforcement, and the boundary chosen by its caller. It traverses safely formed v1 material without interpreting PostgreSQL expression semantics. Admitted material includes words, quoted identifiers, numerics, supported operators and punctuation, commas, dots, standard strings, E-prefixed strings, valid dollar-position tokens, valid dollar bodies, and nested `()` and `[]`; comments and trivia are skipped without exposing their contents. Protected lexical tokens remain atomic, and every categorical lexical refusal passes through unchanged.

At structural depth zero, only the caller may identify a boundary, and the traversal leaves that boundary unconsumed. At positive depth, semicolons are ordinary opaque material. Unsupported grammar that is already decisive stops token demand, so a later delimiter or lexical defect cannot displace it.

`opaque_parenthesized` consumes an authorized outer `(`, seeds typed balance with it, requires at least one non-trivia token, traverses once through its matching outer `)`, and stops immediately afterward with following caller grammar untouched. `opaque_expression` likewise requires at least one non-trivia token and stops only at a caller-owned depth-zero boundary. Optionality belongs to the caller; a grammar production that permits no tokens does not weaken either non-empty form.

Opaque acceptance means only safe deterministic delimitation. It does not establish that the token span is a valid PostgreSQL expression.

### 5.2 Default expressions

`default_expression` is deliberately narrower than a general PostgreSQL expression:

```text
default_expression := default_atom { "::" type_span }

default_atom :=
    [ "+" | "-" ] numeric_token
  | standard_string
  | e_prefixed_string
  | NULL | TRUE | FALSE | CURRENT_DATE | CURRENT_TIMESTAMP
  | qualified_name "(" [ balanced_argument_tokens ] ")"
  | opaque_parenthesized
```

The E-prefixed-string alternative is a direct atom: its escape/value semantics are not decoded, and the displayed `:: type_span` repetition is its only accepted direct tail. `balanced_argument_tokens` uses the same traversal up to the function call's matching `)`; the caller's brackets make the argument sequence optional, while any admitted tokens retain typed balance and lexical-refusal behavior. The analyzer does not evaluate them. This grammar accepts common literal, cast, `now()`, `gen_random_uuid()`, `nextval(...)`, and session-source call shapes while refusing unbounded binary/default expression forms it cannot delimit from following column clauses without a PostgreSQL expression parser.

## 6. Accepted top-level statements

### 6.1 Target `CREATE TABLE`

Exactly one target declaration is required:

```text
CREATE [ TEMP | TEMPORARY ] TABLE [ IF NOT EXISTS ] qualified_name
"(" table_element { "," table_element } ")"
[ INHERITS "(" qualified_name { "," qualified_name } ")" ]
[ PARTITION BY opaque_expression ]
```

Only the `CREATE TABLE` prefixes in §4.9 dispatch to this family. Therefore `CREATE UNLOGGED TABLE`, `CREATE GLOBAL/LOCAL ...`, `CREATE FOREIGN TABLE`, `CREATE VIEW`, and `CREATE MATERIALIZED VIEW` refuse as `unsupported_statement`. After a recognized `CREATE TABLE` prefix, `OF`, `LIKE`, typed-table syntax, and every unlisted clause refuse as `syntax_not_in_profile`.

`TEMP`/`TEMPORARY`, `INHERITS`, and `PARTITION BY` are recognized to preserve explicit structural observations. Their presence does not cause refusal if the remainder matches this grammar.

Under the current closed §6.1 grammar, `PARTITION BY opaque_expression` is terminal: no v1 `CREATE TABLE` suffix follows it. After `BY`, require at least one non-trivia token and traverse safely formed tokens once, finishing at EOF or stopping before a top-level semicolon. A semicolon at positive delimiter depth remains opaque material. No word, including `USING`, `WITH`, `ON`, or `TABLESPACE`, is a terminator, and no hidden suffix recognition occurs inside the opaque span. Supporting suffixes after `PARTITION BY` requires an explicit reviewed grammar-version change.

`table_element` is either a column definition or supported table constraint.

#### Column definition

```text
identifier type_span { column_clause }
```

`type_span` is exactly the form in §5. An ASCII keyword may be a `type_word` only because the parser is already in the type position; this does not make it an identifier elsewhere. Multiword type spellings and other type syntax are outside v1. The parser retains accepted type spans without assigning product compatibility.

Accepted `column_clause` forms are:

```text
[ CONSTRAINT identifier ] NOT NULL
[ CONSTRAINT identifier ] NULL
[ CONSTRAINT identifier ] PRIMARY KEY
[ CONSTRAINT identifier ] UNIQUE
[ CONSTRAINT identifier ] CHECK opaque_parenthesized
[ CONSTRAINT identifier ] REFERENCES qualified_name [ simple_column_list ]
DEFAULT default_expression
GENERATED ALWAYS AS opaque_parenthesized STORED
GENERATED ( ALWAYS | BY DEFAULT ) AS IDENTITY [ opaque_parenthesized ]
```

##### Column-clause cardinality and conflicts

The accepted profile models one occurrence at most of each column-clause kind: `PRIMARY KEY`, `UNIQUE`, `CHECK`, `REFERENCES`, `DEFAULT`, stored generated, and identity. A second occurrence of any one kind refuses with `conflicting_column_declaration`; the recognizer does not attempt PostgreSQL semantic-equivalence analysis. Explicit nullability has one shared slot: exactly one `NULL` or one `NOT NULL` may occur, and any repeated or mixed explicit nullability refuses with the same reason.

Column-clause cardinality and declaration validity are resolved before inline `PRIMARY KEY` or
`UNIQUE` occurrences are eligible to establish modeled key declarations. Therefore a second
occurrence of the same single-cardinality inline key-clause kind on the same physical column
establishes `conflicting_column_declaration` at the later clause establishment token and is not
eligible to establish an additional modeled primary key or modeled unique declaration. This is a
clause-slot repetition on one column, distinct from multiple separately valid declarations that
later collide at modeled-object level under §7.3. A syntactically complete explicit
`CONSTRAINT identifier` wrapper on such an occurrence still retains its independent constraint-name
evidence under §7.3; this eligibility rule changes only modeled-key establishment.

The following pairs refuse with `conflicting_column_declaration`:

- explicit `NULL` with `NOT NULL`, `PRIMARY KEY`, identity, or serial shorthand;
- stored generated with any `DEFAULT`, identity, or serial shorthand;
- identity with any `DEFAULT` or serial shorthand;
- serial shorthand with any explicit `DEFAULT`.

`DEFAULT nextval(...)` is a `DEFAULT` for these conflict rules. Stored generated, identity, and serial shorthand are three distinct declaration observations even though their surface syntax can share words. If a lexer/parser ambiguity appears to combine serial shorthand with stored generated or identity, it refuses rather than choosing an interpretation.

Explicit `NOT NULL` agrees with requiredness established by `PRIMARY KEY`, identity, or serial shorthand and is accepted. Every other pair of single-occurrence clauses is accepted with respect to this conflict table, subject to the closed grammar and the separate target-constraint rules in §7.3.

The refusal detail contains only these trusted labels, in source occurrence order: `NULL`, `NOT NULL`, `PRIMARY KEY`, `UNIQUE`, `CHECK`, `REFERENCES`, `DEFAULT`, `GENERATED STORED`, `IDENTITY`, and `SERIAL`. Labels are joined by the trusted literal ` + `; a repeated clause repeats its label. The later clause that first establishes a conflict is the diagnostic location. No raw clause text is interpolated.

V1 does not accept column `COLLATE`, compression/storage clauses, FK actions, `MATCH`, deferrability, exclusion constraints, or other unlisted column clauses.

#### Table constraints

Accepted table constraints are:

```text
[ CONSTRAINT identifier ] PRIMARY KEY simple_column_list
[ CONSTRAINT identifier ] UNIQUE simple_column_list
[ CONSTRAINT identifier ] CHECK opaque_parenthesized
[ CONSTRAINT identifier ] FOREIGN KEY simple_column_list
  REFERENCES qualified_name [ simple_column_list ]
```

No constraint options follow these forms in v1.

### 6.2 `CREATE TYPE ... AS ENUM`

```text
CREATE TYPE qualified_name AS ENUM
"(" standard_string { "," standard_string } ")"
```

At least one enum label is required. Labels preserve order and decoded standard-string value. E-prefixed labels are not accepted. Duplicate declarations of the same normalized type identity refuse with `ambiguous_declaration`.

Other `CREATE TYPE` forms are not accepted.

### 6.3 `ALTER TABLE ... ADD CONSTRAINT`

```text
ALTER TABLE [ ONLY ] qualified_name ADD table_constraint
```

Exactly one action is accepted per statement. The constraint grammar is §6.1. Comma-separated actions and all other `ALTER TABLE` actions refuse except the RLS forms in §6.4.

### 6.4 RLS state declarations

Accept exactly:

```text
ALTER TABLE [ ONLY ] qualified_name ENABLE ROW LEVEL SECURITY
ALTER TABLE [ ONLY ] qualified_name DISABLE ROW LEVEL SECURITY
ALTER TABLE [ ONLY ] qualified_name FORCE ROW LEVEL SECURITY
ALTER TABLE [ ONLY ] qualified_name NO FORCE ROW LEVEL SECURITY
```

RLS enabled state and force state are independent axes. The input may declare at most one enabled state (`ENABLE` or `DISABLE`) and at most one force state (`FORCE` or `NO FORCE`). `ENABLE` plus `FORCE`, for example, is not a conflict. Repeating one axis or declaring both values on one axis refuses with `ambiguous_declaration`; the checker does not execute statements in sequence to choose a winner.

### 6.5 `CREATE POLICY`

```text
CREATE POLICY identifier ON qualified_name
[ AS ( PERMISSIVE | RESTRICTIVE ) ]
[ FOR ( ALL | SELECT | INSERT | UPDATE | DELETE ) ]
[ TO policy_role { "," policy_role } ]
[ USING opaque_parenthesized ]
[ WITH CHECK opaque_parenthesized ]
```

`policy_role` is an identifier or `PUBLIC`, `CURRENT_ROLE`, `CURRENT_USER`, or `SESSION_USER`. Clauses occur in the displayed order and at most once.

Omitted `AS`, `FOR`, and `TO` are recorded using PostgreSQL's syntax defaults for the supplied declaration: permissive, all commands, and public. Recording those declared/defaulted terms does not prove that the policy exists or is effective in a live catalog.

The accepted command/clause combinations are:

- `INSERT`: optional `WITH CHECK`, no `USING`;
- `SELECT` or `DELETE`: optional `USING`, no `WITH CHECK`;
- `UPDATE` or `ALL`: optional `USING` and optional `WITH CHECK`.

Any other combination refuses with `syntax_not_in_profile`. The analyzer records clauses actually supplied; it does not label an omitted `WITH CHECK` as supplied merely because PostgreSQL may derive behavior from `USING` for some commands.

Policy expressions remain opaque and are not interpreted by the structural recognizer.

### 6.6 Bounded trigger-function declaration

V1 accepts only a no-argument function shell returning `trigger`:

```text
CREATE [ OR REPLACE ] FUNCTION qualified_name "(" ")" RETURNS TRIGGER
function_option { function_option }

function_option :=
    LANGUAGE PLPGSQL
  | AS dollar_quoted_body
  | SECURITY ( DEFINER | INVOKER )
```

The option set must contain exactly one `LANGUAGE PLPGSQL` and exactly one `AS dollar_quoted_body`, in either order. The language name is an unquoted ASCII word compared after folding. The set may additionally contain at most one of `SECURITY DEFINER` or `SECURITY INVOKER`.

No other language, function arguments, return types, attributes, multiple body strings, SQL-standard bodies, or option forms are accepted. The declaration is accepted only as an auxiliary function for a supplied trigger; an unreferenced function refuses with `unassociated_auxiliary_declaration`.

The body is not parsed as PL/pgSQL or SQL. Function bodies remain opaque; the public behavior contract defines their review treatment.

### 6.7 `CREATE TRIGGER`

```text
CREATE [ CONSTRAINT ] TRIGGER identifier
( BEFORE | AFTER ) trigger_event { OR trigger_event }
ON qualified_name
[ FROM qualified_name ]
[ ( DEFERRABLE | NOT DEFERRABLE ) ]
[ INITIALLY ( IMMEDIATE | DEFERRED ) ]
FOR EACH ( ROW | STATEMENT )
[ WHEN opaque_parenthesized ]
EXECUTE ( FUNCTION | PROCEDURE ) qualified_name
"(" [ standard_string { "," standard_string } ] ")"
```

`trigger_event` is `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE`. An event may appear only once. `FROM`, deferrability, and `INITIALLY` are accepted only for a `CONSTRAINT` trigger. A constraint trigger must be `AFTER`, `FOR EACH ROW`, and must not include `TRUNCATE`. Any trigger including `TRUNCATE` must be `FOR EACH STATEMENT`. Shapes violating those conditions refuse with `syntax_not_in_profile`.

`REFERENCING`, `UPDATE OF`, `INSTEAD OF`, non-string arguments, and other trigger forms are not accepted.

Only a trigger whose event list contains `INSERT` participates in insert-effect reporting. Other accepted triggers are fully consumed but omitted from the insert-only report; their presence does not prove anything about triggers omitted from the supplied input.

Structural trigger acceptance does not imply supported effects. The active public
profile owns structural conflicts and review requirements.

### 6.8 Narrow `CREATE INDEX`

Accept only:

```text
CREATE [ UNIQUE ] INDEX [ IF NOT EXISTS ] identifier
ON [ ONLY ] qualified_name
[ USING BTREE ] simple_column_list
```

A unique index matching this entire form may be described as a simple declared unique index. A non-unique index matching it is fully consumed and omitted from duplicate reasoning and the report.

Expression indexes, partial indexes, predicates, `INCLUDE`, per-column collation/opclass/order/null modifiers, non-btree methods, storage parameters, tablespaces, concurrent creation, and all other syntax after a recognized index-family prefix refuse with `syntax_not_in_profile`. They are not approximated.

### 6.9 `COMMENT ON`

Accept an otherwise balanced statement of the form:

```text
COMMENT ON opaque_object_designator IS ( standard_string | NULL )
```

The object designator must be non-empty and contain no top-level semicolon. The rightmost depth-zero `IS` separates it from the value. The final value must be one standard string or `NULL`. Accepted comments are discarded and cannot affect analysis. E-prefixed comment values are not accepted.

### 6.10 Unsupported top-level input

A lexically well-formed top-level statement that does not match §4.9's finite dispatch table refuses with `unsupported_statement`. Examples include `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY`, `GRANT`, `REVOKE`, `SET`, `DO`, `CREATE EXTENSION`, `CREATE VIEW`, `CREATE FOREIGN TABLE`, and `CREATE SEQUENCE`. A demanded lexical refusal encountered while establishing dispatch precedes it; once unsupported dispatch is decisive, later tokens are not demanded. A statement that does dispatch but fails its selected family grammar refuses with `syntax_not_in_profile`.

## 7. Target association, duplicates, and consumption

### 7.1 Target count

- No target table declaration: `no_target_table`.
- More than one target table declaration: `multiple_target_tables`.
- A temporary/inherited/partitioned `CREATE TABLE` still counts as the one target; its explicit shape is handled by the envelope.

### 7.2 Name association

Policies, triggers, indexes, and `ALTER TABLE` statements must name the target under the identifier identity rules.

- A qualified target reference matches only the same qualified identity.
- An unqualified target reference matches an unqualified target declaration with the same table identity, but the target schema remains unresolved.
- A qualified reference does not silently resolve to an unqualified declaration, or vice versa.
- A recognized statement naming another relation refuses with `statement_targets_other_relation`.

Enum declarations may be auxiliary when referenced by a target column. Trigger-function declarations may be auxiliary when referenced by a supplied trigger. An accepted auxiliary declaration that is unused refuses with `unassociated_auxiliary_declaration`.

Auxiliary name association is exact under the same qualification rule: an unqualified reference does not resolve to a qualified declaration, or vice versa. No `search_path` or function-resolution rule is inferred.

Referenced FK tables are names inside constraints, not additional target declarations; they are not resolved as tables.

`COMMENT ON` statements are the sole association exception: once their closed shell is fully consumed, they are discarded regardless of object designator because they cannot affect the model.

### 7.3 Duplicate and conflicting declarations

Target-key processing has this normative stage boundary:

```text
complete structural clause occurrences
→ clause-cardinality/declaration validity
→ eligible modeled key declarations
→ modeled-key ambiguity construction
→ centralized §7.3 candidate comparison
```

Only structurally complete key occurrences that survive the applicable declaration-validity rules
are eligible to establish modeled target primary-key or unique declarations. In particular, a
same-column repeated inline `PRIMARY KEY` or `UNIQUE` occurrence invalidated by the §6.1
single-cardinality rule does not establish another modeled key and therefore does not additionally
create a target-primary-key or duplicate-modeled-unique ambiguity. This does not weaken the
modeled-object rules for independently valid declarations: separate valid inline primary keys on
different physical columns, or a valid inline primary key plus a valid table-level primary key,
still establish multiple modeled target primary keys; independently valid inline/table unique
declarations that form the same modeled unordered normalized target-column set still establish a
duplicate modeled unique identity. Clause origin and explicit constraint names do not participate
in modeled unique equality.

Refuse with `ambiguous_declaration` when accepted input contains:

- duplicate target columns after identifier normalization;
- more than one eligible modeled target primary-key declaration, whether inline, table-level, or added by `ALTER TABLE`, and whether textually identical or distinct;
- duplicate constraint, policy, trigger, index, enum-type, or function identities within their relevant namespace;
- repeated or conflicting declarations on the same RLS state axis;
- a trigger function reference matching more than one supplied function declaration;
- duplicate decoded labels within one supplied enum declaration;
- a target PK, unique, or simple-index column list, or a table-level FK local-column list, that repeats a normalized member or names a column absent from the target declaration;
- a column-level FK that explicitly names other than one referenced column, or a table FK whose explicit local and referenced lists have different lengths;
- two eligible modeled unique constraints with the same unordered set of normalized target-column identities, regardless of inline/table form, source-list order, or names;
- two modeled foreign keys with the same identity defined below, regardless of inline/table form or names;
- two simple indexes with the same uniqueness flag and normalized column list.

Every syntactically complete supported `CONSTRAINT identifier` wrapper retains an explicit
constraint-name occurrence independently from its underlying modeled constraint. All such names
on the same target relation share one relation-wide explicit-constraint-name namespace, whether
the constraint is column-level or table-level. Unnamed constraints do not participate. Name
identity uses the identifier rules in §3.6. Explicit constraint names are not compared or
namespace-coupled with index or schema identities; this does not alter the independent duplicate
index-identity rule. A constraint name does not change primary-key or unique modeled identity.

Name evidence remains present when later post-parse association or modeling makes the underlying
constraint unresolved or ambiguous. Semantic candidates are still selected only after successful
selected-statement grammar completion: an incomplete form, an unsupported form, or an earlier
lexical or grammar refusal establishes no supported constraint-name candidate. Duplicate normalized
explicit constraint names establish `ambiguous_declaration` at the later declaration's opening
`CONSTRAINT` token, and the diagnostic span is exactly that token. Preserve the earlier and later
name and wrapper occurrences separately.

A separate cross-declaration column conflict uses `conflicting_column_declaration`: if an accepted table-level or `ALTER TABLE` primary key includes a column whose definition has explicit `NULL`, the trusted clause detail is `NULL + PRIMARY KEY` or `PRIMARY KEY + NULL` in source-occurrence order. The diagnostic points to the later of the explicit `NULL` clause and the primary-key declaration. This closes the same explicit-nullability conflict as an inline primary key without treating it as a generic duplicate-object ambiguity.

Table-level primary-key and unique association is post-parse. Preserve the ordered
`simple_column_list`, complete the target `CREATE TABLE` structural parse, and build the complete
normalized target-column association before validating list members. A member associates only
when exactly one physical target column has that normalized identity. An absent member establishes
`ambiguous_declaration`. If duplicate target-column declarations make the association non-unique,
do not choose a physical column and do not derive primary-key nullability or another
column-specific consequence from that unresolved member; the existing duplicate-target-column
ambiguity governs selection. Forward references to uniquely declared later columns are therefore
valid.

A repeated normalized member within one table-level primary-key or unique list also establishes
`ambiguous_declaration`; it is not silently deduplicated. Only after every member associates
uniquely and no normalized member repeats does the declaration form its modeled key identity. That
identity is an unordered set of normalized target-column identities. Inline key declarations form
the corresponding singleton set. Consequently, inline `a UNIQUE` and table-level `UNIQUE (a)`
have the same modeled unique identity, as do `UNIQUE (a, b)` and `UNIQUE (b, a)`, while
`UNIQUE (a, b)` and `UNIQUE (a)` remain distinct. More than one modeled target primary key still
refuses under the separate target-primary-key rule, whether or not their sets are equal. Any §7.3
rule that compares a target primary-key set with a modeled unique set uses this same unordered-set
identity.

Modeled-set equality uses cardinality and normalized-identity membership. It does not use locale
comparison, add Unicode normalization, or erase the ordered source evidence retained by the
declaration.

#### Foreign-key association and modeled identity

A foreign-key structural occurrence retains its inline or table-level origin; the exact
`REFERENCES` span; the exact `FOREIGN` and `KEY` spans for a table-level occurrence; its complete
clause span; the referenced relation's one- or two-part qualification, component identities,
quoted-versus-unquoted evidence, and spans; and the original order, identifier evidence, and spans
of every local and explicit referenced-column member. An explicit constraint-name wrapper remains
separate evidence under the rules above. Structural evidence is never reordered to form modeled
identity.

The referenced relation and columns are external structural evidence. An unqualified relation is
not expanded with an inferred schema and is distinct from every qualified relation. Qualification
components use the identifier identity rules in §3.6. The checker does not apply `search_path`,
special-case an apparent self-reference, resolve a referenced catalog object, or infer referenced
columns, keys, types, existence, or installability.

Table-level FK local-column association occurs only after successful complete structural parsing.
Build the complete normalized target-column association once, then resolve every local member
against it. Forward references are valid. A member associates only when exactly one physical target
column has that normalized identity; first/last match, proximity, and physical source order are not
association rules. Column-level `REFERENCES` instead uses its containing physical target column
directly and does not repeat name-based local association.

An absent or repeated normalized member in a table-level FK local list prevents that occurrence
from establishing a modeled FK and establishes `ambiguous_declaration` at its opening `FOREIGN`
token; the diagnostic span is exactly that token. Preserve the ordered local-list evidence and do
not deduplicate it. When duplicate target-column declarations make association non-unique, do not
choose a physical column or derive any column-specific FK consequence. No additional FK-specific
ambiguity is established for that non-unique association; the existing duplicate-target-column
ambiguity governs selection.

An explicit referenced-column list on column-level `REFERENCES` must contain exactly one member.
Any other member count prevents modeled-FK establishment and establishes
`ambiguous_declaration` at the exact `REFERENCES` token. For a table FK, an explicit referenced
list must have the same member count as its local list; a mismatch likewise prevents modeled-FK
establishment and establishes `ambiguous_declaration` at the exact opening `FOREIGN` token. Each
diagnostic span is exactly its stated token. Lists are never truncated, padded, or partially paired.

When a referenced-column list is explicit and cardinality is valid, pair local and referenced
members by source position. Modeled FK identity is the normalized referenced-relation identity, an
explicit-list discriminator, and an unordered set of those normalized
`local-target-identity`-to-`referenced-column-identity` pairs. Thus simultaneously permuting both
lists preserves modeled identity, while permuting only one side changes it. This is a set of
positional pairs, not two independent unordered sets. Inline `a REFERENCES p(x)` and table-level
`FOREIGN KEY (a) REFERENCES p(x)` form the same singleton modeled identity when all other identity
components match. Constraint names and inline/table origin do not participate in equality.

A repeated normalized identifier in an explicit referenced list remains valid positional
structural evidence and may participate in modeled identity; it is not deduplicated and does not by
itself establish ambiguity. Whether the referenced relation or columns can support the FK is an
external catalog property and is not evaluated.

When the referenced-column list is omitted, retain an omitted-list discriminator and do not infer
remote key columns. Omitted-list identity consists of the normalized referenced-relation identity,
that discriminator, and the ordered sequence of associated local target-column identities. Two
such declarations are equal only when all three match in order. Reordering the local sequence
therefore changes identity. An omitted-list declaration is never equal to an explicit-list
declaration. Column-level `REFERENCES` is the singleton form of the same omitted-list rule.

Only a syntactically complete FK occurrence whose required local association and cardinality checks
succeed establishes a modeled FK. Absent or repeated local members, non-unique target association,
or invalid explicit-list cardinality prevent modeled-FK establishment; repeated remote members and
a valid omitted-list discriminator do not. A syntactically complete named occurrence still retains
its independent name evidence under the constraint-name rules above.

Two equal valid modeled FKs establish `ambiguous_declaration` at the later occurrence's opening
`REFERENCES` token for a column form or opening `FOREIGN` token for a table form. The diagnostic
span is exactly that token, and the earlier occurrence is anchored to its corresponding
`REFERENCES` or `FOREIGN` token. Duplicate detection is post-parse and uses the shared semantic
candidate selector; parsing does not maintain an authoritative `seen` set. Explicit constraint
names do not alter equality, and duplicate-name and FK candidates compete only through that shared
selector after successful grammar completion.

For semantic-candidate comparison, a column-level FK uses its containing physical column ordinal.
A table-level FK uses the existing table-level primary-key/unique convention: the lowest physical
target-column ordinal among its uniquely associated local members, or the existing table-level
sentinel when no unique target-column ordinal is implicated. It never chooses the first or last
source-list member merely because of list position, so a source-list permutation cannot create a
new ordinal rule. A deterministic modeled-object tie key, when required, uses only the identities
and discriminators above with existing Unicode-scalar identity ordering. It does not use source
spelling, constraint name, locale comparison, Unicode normalization, or collection iteration order.
Implementations may test explicit pair-set equality by cardinality and membership; any canonical
representation orders only by that existing scalar identity order and does not mutate structural
evidence.

#### Semantic-conflict selection

Lexical, dispatch, and family-grammar refusal selection completes before semantic-model conflicts are selected. The parser records every conflict candidate from §6.1 and this section without allowing collection or map iteration order to choose the refusal.

Each semantic conflict candidate has an establishment location. For a §6.1 column-clause conflict it is the raw byte start of the later clause that makes the conflict true. For a §7.3 ambiguity or cross-declaration column conflict it is the raw byte start of the later declaration—or the containing declaration for an ambiguity wholly inside one declaration—that makes the modeled condition true. Selection is:

For a repeated or absent member in a table-level primary-key or unique list, the containing
declaration location is the start of its first keyword token: `PRIMARY` or `UNIQUE`. The diagnostic
span is exactly that keyword token. Member absence is established only against the complete target
column set after structural parsing.

1. The candidate with the earliest establishment location wins.
2. At the same establishment location, `ambiguous_declaration` precedes `conflicting_column_declaration`. Declaration ambiguity prevents a unique target model and therefore precedes evaluating a column consequence of that ambiguous model.
3. Among `conflicting_column_declaration` candidates at the same location, the affected target column with the lowest physical ordinal in the target `CREATE TABLE` wins. For multiple conflicts on that same column and location, form each tie-break key by sorting its participating clause categories into this fixed order, retaining repeated categories, and compare the resulting category-rank sequences lexicographically: `NULL`, `NOT NULL`, `PRIMARY KEY`, `UNIQUE`, `CHECK`, `REFERENCES`, `DEFAULT`, `GENERATED STORED`, `IDENTITY`, `SERIAL`. This ordering is only a tie-break; rendered clause labels retain source-occurrence order.
4. Among `ambiguous_declaration` candidates at the same location, choose the candidate whose earlier participating declaration or object occurrence starts first; then the lowest implicated target-column ordinal, when any; then the normalized modeled-object identity in Unicode scalar order; then the order of the ambiguity bullets in this section. These keys are part of behavior and must not be replaced by object-property or map iteration order.

A target column therefore participates in at most one modeled target primary key. Repeated modeled constraints listed above refuse rather than being deduplicated. Multiple different unique, FK, CHECK, and simple-index declarations remain separate source-ordered observations; CHECK expressions are opaque and are never normalized for semantic equivalence.

`CREATE OR REPLACE FUNCTION` does not authorize multiple versions in one paste. The checker builds a declarative observation set; it does not execute statements sequentially.

### 7.4 Source ordering

Source statement and column order are retained. Cross-statement references may be resolved after parsing, so a non-conflicting auxiliary declaration may appear before or after its reference. No broader claim that PostgreSQL statement order is irrelevant is made.

### 7.5 Full consumption

After comments and whitespace, every input token must belong to exactly one accepted statement, and every statement must be fully consumed by its grammar. Any leftover token refuses with `syntax_not_in_profile` using the safe diagnostic rules.

No successful analysis is produced from a recognized prefix followed by unrecognized input.


### 12.3 Refusal reasons

| Reason ID | Condition | Trusted explanation | Trusted remediation |
| --- | --- | --- | --- |
| `input_empty` | No tokens remain after comments/whitespace | `Nothing remained after whitespace and comments.` | `Supply one accepted CREATE TABLE declaration.` |
| `input_too_large` | Raw input exceeds 262,144 bytes, or the browser adapter proves the encoded form must do so | `The input exceeds the 262,144 raw-byte limit for check-behavior-v1.` | `Reduce the supplied DDL to 262,144 UTF-8 bytes or fewer.` |
| `invalid_utf8` | Raw bytes are not strict scalar-valid UTF-8 | `The input is not strict scalar-valid UTF-8.` | `Supply the DDL as UTF-8 text.` |
| `nul_byte_not_in_profile` | U+0000 occurs | `The input contains a NUL byte, which is outside check-behavior-v1.` | `Remove the NUL byte and supply text input.` |
| `unexpected_bom` | U+FEFF occurs outside the one permitted leading BOM and outside a quoted/comment/body region | `A byte-order mark is present somewhere other than the start of the input.` | `Keep at most one leading UTF-8 BOM and remove the unexpected mark.` |
| `browser_lone_surrogate` | Browser adapter found an unpaired UTF-16 surrogate | `The browser input contains an unpaired UTF-16 surrogate.` | `Replace the invalid string value and try again.` |
| `unquoted_non_ascii_identifier` | Non-ASCII occurs in an unquoted identifier position | `An unquoted identifier contains non-ASCII text, whose PostgreSQL identity this profile does not reproduce.` | `check-behavior-v1 accepts non-ASCII identifiers only when they are double-quoted. Supply the exact double-quoted identifier or an equivalent declaration in the accepted profile.` |
| `identifier_outside_profile` | Decoded identifier exceeds 63 UTF-8 bytes | `An identifier is <actual> UTF-8 bytes; this profile accepts at most 63.` | `Supply a declaration whose identifier identity is unambiguous under the 63-byte profile.` |
| `identifier_contains_unsafe_character` | Identifier contains a code point prohibited by the fixed unsafe table | `An identifier contains a control, format, private-use, or noncharacter code point prohibited by this profile.` | `Rename the identifier or supply an accepted identifier without the prohibited character.` |
| `unterminated_string` | Standard/E-prefixed string has no terminator | `A string literal has no closing quote.` | `Supply a complete string literal.` |
| `unterminated_quoted_identifier` | Double-quoted identifier has no terminator | `A double-quoted identifier has no closing quote.` | `Supply a complete double-quoted identifier.` |
| `unterminated_dollar_quote` | Dollar-quoted body has no matching delimiter | `A dollar-quoted body has no exact matching closing delimiter.` | `Supply the matching case-sensitive dollar delimiter.` |
| `unterminated_block_comment` | Nested block comment has no matching close | `A block comment has no matching close.` | `Close every nested block comment.` |
| `unbalanced_delimiter` | Committed/admitted `()` or `[]` traversal encounters an unexpected or mismatched close, or reaches EOF with an outstanding opener | `A delimited construct is unbalanced.` | `Balance the parentheses or brackets in the supplied statement.` |
| `unicode_escape_syntax_not_in_profile` | ASCII `U`/`u` is immediately followed by `&` and then immediately by `"` or `'` | `PostgreSQL Unicode-escape syntax is outside check-behavior-v1.` | `Supply an equivalent directly encoded accepted form without changing identifier identity.` |
| `escape_string_semantics_not_in_profile` | E-string occurs where semantic decoding would be required | `Escape-string semantics are not accepted in this position.` | `Use the standard-string or dollar-quoted form accepted for this position.` |
| `no_target_table` | No accepted target table is present | `No accepted CREATE TABLE target was supplied.` | `Supply the one table intended for import analysis.` |
| `multiple_target_tables` | More than one target table is present | `<actual> CREATE TABLE targets were supplied; this check analyzes one.` | `Supply only the target table and its accepted auxiliary declarations.` |
| `empty_statement_not_in_profile` | Consecutive/leading empty SQL statement is present | `An empty SQL statement is outside check-behavior-v1.` | `Remove the extra semicolon.` |
| `unsupported_statement` | Top-level statement family is not accepted | `The top-level statement is outside check-behavior-v1.` | `Remove it or supply the relevant declaration in an accepted statement form.` |
| `syntax_not_in_profile` | A statement dispatches under §4.9 but does not match that family's grammar, or a profile-level syntax rule explicitly selects this refusal | `The statement does not match the closed check-behavior-v1 grammar.` | `Supply the equivalent accepted form or remove the statement.` |
| `statement_targets_other_relation` | Target-associated statement names another relation | `A target-associated statement names a different relation.` | `Supply only statements associated with the one target table.` |
| `unassociated_auxiliary_declaration` | Supplied enum/function declaration is not used by the target model | `An auxiliary declaration is not associated with the target table or its supplied trigger.` | `Remove it or supply the target declaration that references it.` |
| `conflicting_column_declaration` | A column hits an enumerated cardinality or conflict rule in §6.1 or the explicit-`NULL`/target-PK rule in §7.3 | `<column> combines conflicting or repeated column clauses: <trusted-clause-list>.` | `Supply one accepted, unambiguous declaration for <column>.` |
| `ambiguous_declaration` | A cross-column/object duplicate or conflict enumerated in §7.3 prevents a unique model | `The supplied declarations conflict or identify the same modeled object more than once.` | `Supply one unambiguous declarative definition for each modeled object.` |

A refusal contains one primary reason. Selection proceeds by ownership stage:

1. adapter checks: the browser code-unit lower-bound size check, lone-surrogate validation, and computed UTF-8 size check, when the browser adapter is the caller;
2. whole-input core checks: raw size, strict UTF-8, leading-BOM handling, then the NUL check;
3. demanded lexical formation and refusal during the one left-to-right source stage, with `input_empty` only when no significant token exists;
4. parser-owned delimiter handling for committed or admitted structural traversal;
5. contextual profile refusal at the demanded grammar position;
6. finite dispatch and the selected-family grammar;
7. a temporary private slice-miss while an implementation slice is incomplete; this is not a released handled result and cannot replace the closed v1 grammar;
8. post-parse target count, target/auxiliary association, §6.1/§7.3 semantic conflicts, and unused auxiliary declarations, in that existing order;
9. unexpected internal defects, which remain outside handled input semantics.

No later stage displaces an earlier-stage result. A demanded lexical refusal beats a structural defect the parser has not yet received, so an unterminated protected lexical construct may beat an outstanding parser opener. An already observed delimiter mismatch beats later defects. If EOF arrives with a nonempty committed stack and no earlier failure, select `unbalanced_delimiter` at the stack-top opener; with an empty stack but incomplete grammar, use the applicable syntax/profile failure. Once unsupported dispatch or selected-family grammar is decisive, stop demanding tokens rather than scanning a malformed tail for another refusal.

Except for `input_empty`, `input_too_large`, `invalid_utf8`, `browser_lone_surrogate`, and `no_target_table`, a refusal includes the first decoded source location specified by its rule. EOF-established `unbalanced_delimiter` uses the outstanding stack-top opener, and unterminated protected-token refusals use their authority-defined opening location. Only an applicable statement failure with no source fragment uses the trusted `at end of input` line. A selected §6.1 or §7.3 semantic conflict uses its establishment location from §7.3. `multiple_target_tables` points to the second target. Unsupported-family and known-family parse locations are exactly §4.9.


## 13. Safe display and diagnostics

### 13.1 Trusted templates

All report prose, headings, markers, separators, and remediation sentences are trusted source literals. Input-derived text appears only in explicit interpolation slots and always passes the appropriate safe-display function.

No finite corpus is considered proof of this boundary.

### 13.2 Safe printable Unicode

Accepted identifiers preserve safe printable Unicode subject to the escaping below and retain quoted-versus-unquoted distinction. Quoted identifiers render with surrounding `"`, and an embedded quote renders as `""`. Other rendered input fragments preserve Unicode scalars except:

- every input-derived backslash is rendered as `\\`;
- a double quote is rendered as `\"` when the fragment is enclosed in diagnostic quotes;
- LF, CR, and tab render as `\n`, `\r`, and `\t`;
- C0/C1 controls, DEL, bidi controls, the fixed non-ASCII whitespace set below, line/paragraph separators, the §3.6 unsafe table, and trusted structural glyphs render as uppercase `\u{HEX}`.

The fixed non-ASCII whitespace set is U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, and U+3000. The trusted structural glyphs are `→`, `⚠`, `—`, `✕`, and `·` when they originate in input rather than a template.

No input fragment may introduce a report newline, ANSI escape, OSC sequence, bidi control, invisible-format scalar, or trusted separator. Ordinary printable right-to-left letters remain permitted; report semantics therefore do not depend on visual ordering.

Safe printable URL-shaped text may remain visible as inert report text. The renderer does not create links, terminal hyperlinks, URL attributes, navigation, requests, location/history state, or automatic linkification from it.

In analyzed report fields, unquoted ASCII identifiers render in their lowercase identity form. Quoted identifiers render with surrounding quotes and their exact, non-normalized decoded scalar sequence after the escaping in this section. This rule applies to target, column, type, relation, policy, trigger, function, role, and index names.

### 13.3 Bounded preview

Unsupported-token diagnostics include line, column, raw byte length, and a safe preview. The preview source is the offending lexical token. For §4.9 unsupported-family dispatch it is the shortest contiguous raw span from the first significant token through the token that establishes no dispatch row can match. If an offending scalar cannot begin a token, it is the maximal source fragment from that scalar up to accepted whitespace, a semicolon, or end of input. Unterminated-token previews begin at the opening delimiter. EOF-established `unbalanced_delimiter` previews the outstanding stack-top opener. Other parser failures established at end of input use the trusted phrase `at end of input` and have no preview.

The preview consumes at most:

- 64 source Unicode scalar values; and
- 256 UTF-8 bytes after safe rendering.

Stop before consuming a scalar that would cross either bound. If source remains, reserve three bytes within the rendered-byte bound and append trusted `...`. The location line carries the full fragment's raw byte length. The `invalid_utf8` refusal has no decoded location or preview, so invalid bytes are never replacement-decoded or echoed.

The 64-scalar and 256-rendered-byte values are presentation limits, not parser resource limits. The byte bound limits one untrusted interpolation to one 1,024th of the approved maximum input size; the scalar bound prevents an ASCII token from defeating that bound before escaping.

The preview never uses runtime exception text and never prints a raw substring.

### 13.4 Non-identifier values

Enum labels, trigger arguments, expression summaries, and observed names use safe display. Long free-form values use the same bounded-preview limits. This keeps reports useful and output amplification linear.


## 16. Structural resource invariants

The only numeric parser resource limit in v1 is the 262,144 raw-byte cap. The 63-byte identifier rule is an identity profile, not a resource budget.

Implementations must satisfy:

- no catastrophic-backtracking regex over untrusted input;
- every lexer/parser loop advances its cursor, consumes a token, or returns;
- attacker-controlled comment and typed structural-delimiter nesting is tracked iteratively rather than through call-stack recursion;
- each admitted opaque/balanced region advances in one forward pass, without backtracking or rescanning;
- no eager whole-input structural-delimiter pass;
- work and retained token/span/structural-stack data are O(raw input size), excluding the report;
- each body is scanned at most once;
- exact dollar-delimiter matching is linear in the delimiter plus scanned body, including adversarial repeated prefixes;
- no repeated whole-input rescans;
- no repeated prefix slicing or quadratic string concatenation;
- lookup does not repeatedly scan the full declaration set;
- target-column association and modeled-declaration duplicate detection use direct indexes or
  equivalent linear-pass structures rather than pairwise declaration scans;
- each policy/default expression is observation-scanned at most once and column matching uses direct lookup rather than rescanning per target column;
- report construction and maximum report size remain O(raw input size), with a fixed behavior-dependent expansion factor;
- wall-clock timeout never selects a semantic verdict or refusal.

The raw cap inherently bounds token length, token count, statement count, delimiter nesting, and comment nesting. No separate nesting or other numeric cap is introduced without a fixture/benchmark demonstrating a concrete problem that cannot be removed more simply. A future deterministic limit requires boundary tests and `check-behavior` version review.
