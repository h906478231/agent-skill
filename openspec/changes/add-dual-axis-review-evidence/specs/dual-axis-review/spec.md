## ADDED Requirements

### Requirement: The implementation review SHALL run as two independent axes

For an enabled non-L0 change, the workflow SHALL run a Standards Review and a Spec Fidelity Review against the same fixed implementation baseline. Each axis SHALL have a distinct responsibility and SHALL produce an independent report.

#### Scenario: Both review axes receive the same baseline
- **WHEN** the implementation review starts
- **THEN** the workflow records one base commit or equivalent baseline, one current implementation fingerprint, and one review scope for both axes

#### Scenario: Review axes do not anchor on each other
- **WHEN** the Standards Review or Spec Fidelity Review is executed
- **THEN** that reviewer reads the change artifacts and fixed implementation diff but does not read the other axis's original report before producing its own report

### Requirement: Standards Review SHALL only assess implementation quality

The Standards Review SHALL assess project conventions, reuse, readability, dead code, complexity, test maintainability, and other implementation-level quality concerns. It SHALL NOT replace the pre-implementation Technical Review of architecture, concurrency, performance, database, or security design.

#### Scenario: Standards Review finds an implementation quality issue
- **WHEN** the diff contains duplicated logic or a project convention violation
- **THEN** the Standards Review records an actionable finding with a `STD-` identifier, precise location, severity, rationale, and recommended fix

#### Scenario: Standards Review does not redesign the approved solution
- **WHEN** the implementation follows the approved design but an alternative architecture could be imagined
- **THEN** the Standards Review does not create a finding solely to propose that alternative architecture

### Requirement: Spec Fidelity Review SHALL only assess requirement and design fidelity

The Spec Fidelity Review SHALL check the implementation against the proposal, design, specs, tasks, declared Seam, and scenarios. It SHALL identify missing requirements, uncovered scenarios, incomplete tasks, out-of-scope behavior, and deviations from recorded design decisions.

#### Scenario: A required scenario is not implemented
- **WHEN** a spec scenario has no implementation or test evidence
- **THEN** the Spec Fidelity Review records an actionable finding with a `SPEC-` identifier and marks the review blocked when the omission is a Blocker

#### Scenario: Implementation deviates from a design decision
- **WHEN** the code uses a different persistence, concurrency, or interface decision than `design.md`
- **THEN** the Spec Fidelity Review records the deviation and requires the design or implementation to be reconciled before approval

### Requirement: Review outputs SHALL preserve independent reports and a separate summary

The workflow SHALL store the original reports separately and MAY create a summary for status and gate decisions. The summary SHALL reference, but SHALL NOT replace, reorder, or delete the original findings.

#### Scenario: Both reports are generated
- **WHEN** the two review axes complete
- **THEN** the change directory contains `review/standards.md`, `review/spec-fidelity.md`, and `review/code-review-summary.md`

#### Scenario: One axis has an open Blocker
- **WHEN** either original report contains an unclosed Blocker
- **THEN** the summary verdict is `BLOCKED` and Archive SHALL reject the change until the Blocker is closed or explicitly handled by the existing review governance rules
