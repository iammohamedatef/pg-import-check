# Public profile governance

## Ownership and authority

ImportFlow's product owner owns supported product scope and private production policy.
The public profile owns only the approved observable target-schema subset. Its technical
maintainer implements those public rules and may propose changes; maintainers and forks
cannot redefine ImportFlow support. An independent projection reviewer checks that
public claims are authorized and that unevaluated private obligations remain external
review requirements. A separate independent publication reviewer assesses business,
security/disclosure, rights, positioning, surface and governance. An author cannot
certify their own final publication GO.

Founder approval may authorize promotion conditionally on independent GO and cleared
rights/disclosure findings. Record the authorization reference, owner role, disposition
and date in the approval records. Do not invent an individual's approval or treat a
code commit, green CI, or technical comparison as publication permission.

## Lifecycle and immutability

Candidates cannot be evaluated by a semantic build. Promotion requires a passing
projection review, final independent GO, rights/disclosure clearance and Founder
publication/redistribution authorization. Both envelope and provenance statuses must
be `release_authoritative`; final byte digests and reviewed authority-file hashes must
match. Candidate-to-approved status changes have a different byte digest: review the
exact prepared promotion bytes and record that digest, never reuse a candidate hash.

After approval, released profile bytes and predicate/report authorities are immutable.
Changed policy, evidence semantics, threshold, outcome or applicability needs a new
profile version and affected examples. A report-byte change needs a behavior version.
Wording changes outside those authorities are separately reviewed documentation changes.
There is no silent widening, online profile substitution, or automatic regeneration.

The separate profile catalogue records candidate, active, deprecated or withdrawn status,
maintenance date and replacement identity. It may change without rewriting an old
profile. `replaced_by` in an immutable profile records only what was known at creation;
later replacements live in the catalogue. The first distributed profile supersedes
unpublished design candidates only, not a past customer support commitment.

Deprecation records a reason, effective date, replacement (or none) and whether existing
artifacts remain available for historical reproduction. Withdrawal removes endorsement
for future decisions; redistributed offline copies cannot be remotely revoked. Do not
promise indefinite support or that a stale offline catalogue knows current policy.

## Change impact and freshness

Before an ImportFlow release changes any public-facing restriction or applicability,
the product owner records either a required successor/deprecation or a reasoned no-impact
decision. Internal changes unrelated to public claims need no public profile revision.
The technical maintainer checks applicability at each checker release and at least every
90 days while the profile is actively offered. A missed review does not rewrite history:
mark the maintained catalogue stale/deprecated as appropriate and stop calling it current.
Review dates are release metadata; the pure offline evaluator never reads the clock.

Release notes classify changes as newly conflicting, newly accepted, newly unresolved,
changed applicability, or documentation-only, with before/after examples. A newly accepted
shape still requires ImportFlow's independent production review. Reports pin identity/date.

## Public attestation and distribution

Public provenance contains only the approved profile/document digests, review outcomes,
opaque review-record identities, approving owner roles, licensing and dates. Detailed
source allocations and operational evidence stay private. The private records retain the
pinned ImportFlow revision, source hashes, projection reasoning and actual review identity.
This separation permits reproducible public evaluation without exposing private authority.

Official source distribution is a selected, integrity-checked export. Its manifest covers
every distributed source file. Public repository history, if later created, must begin
from approved exported contents with no private development ancestors, refs, issues or PRs.
A new public repository must not be made by changing the private repository's visibility.
The private audit repository and historical candidates remain private and are not a
public build input. Future public changes must pass the same selected-surface review.
