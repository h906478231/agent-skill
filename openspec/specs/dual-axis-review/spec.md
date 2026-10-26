# dual-axis-review Specification

## Purpose
实现后评审拆成 Standards 与 Spec Fidelity 两个独立评审轴：两轴基于同一基线各写原始报告，互不读取，另由汇总报告裁决。
## Requirements
### Requirement: The implementation review SHALL run as two independent axes

For an enabled non-L0 change, the workflow SHALL run a Standards Review and a Spec Fidelity Review against the same fixed implementation baseline. Each axis SHALL have a distinct responsibility and SHALL produce an independent report.

#### Scenario: Both review axes receive the same baseline
- **WHEN** the implementation review starts
- **THEN** the workflow records one base commit or equivalent baseline, one implementation fingerprint, and one review scope for both axes
- **AND** the implementation fingerprint is the fingerprint of the change head when `tasks.md` declares a valid change head (capability `change-head`), and the current implementation fingerprint otherwise

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

### Requirement: A configured Sonar scan SHALL cover the changed lines after the two axes

When the project configures Sonar (`sonar-project.properties` or `sonar.projectKey`), `SONAR_HOST_URL` and `SONAR_TOKEN` are set, and the server status is `UP`, `/opsx:quality` SHALL run SonarScanner after the summary with branch or pull-request parameters. The scan SHALL NOT write its result into the analysis of the main branch. Only the issues on the lines changed since the `Base Commit` of the review baseline SHALL be handled; the agent SHALL record them and the failed quality-gate conditions in `review/sonar.md`. In this case the Standards Review SHALL NOT assess copy-paste duplication, cognitive complexity, unused private code and commented-out code, and empty catch blocks. Verify SHALL report a CRITICAL issue for each recorded issue or condition that the user has not marked as a false positive or accepted with a reason.

#### Scenario: Sonar finds an issue on a changed line
- **WHEN** the scan reports an issue on a line that the change modified
- **THEN** `review/sonar.md` lists the issue
- **AND** the main agent adds a task to fix it before verify

#### Scenario: Issue on an unchanged line
- **WHEN** the scan reports an issue on a line that the change did not modify
- **THEN** `review/sonar.md` does not list the issue
- **AND** the change does not fix it

#### Scenario: Sonar is not configured
- **WHEN** the project has no Sonar configuration
- **THEN** `/opsx:quality` does not scan
- **AND** the Standards Review assesses all its checks

### Requirement: Review outputs SHALL preserve independent reports and a separate summary

The workflow SHALL store the original reports separately and MAY create a summary for status and gate decisions. The summary SHALL reference, but SHALL NOT replace, reorder, or delete the original findings.

#### Scenario: Both reports are generated
- **WHEN** the two review axes complete
- **THEN** the change directory contains `review/standards.md`, `review/spec-fidelity.md`, and `review/code-review-summary.md`

#### Scenario: One axis has an open Blocker
- **WHEN** either original report contains an unclosed Blocker
- **THEN** the summary verdict is `BLOCKED` and Archive SHALL reject the change until the Blocker is closed or explicitly handled by the existing review governance rules
