# approval-line-reading Specification

## Purpose
规定 apply 前的签字 hook 如何读取评审汇总中的裁决行与签字行，以及共用样本、测试和规则文本的要求。

## Requirements

### Requirement: The approval hook SHALL read the verdict line and the signature line from the last key line

`skills/openspec-technical-review/hooks/check-review-approval.sh` SHALL read the verdict line only from lines that match `^[-*>\s]*Gate-Verdict[:：]`. It SHALL read the signature line only from lines of the original text that match `^[-*>\s]*Technical Review Approved:`. White space in these patterns SHALL be ASCII white space and the non-ASCII characters in `UNICODE_SPACES` of `scripts/lib/review-approval-samples.mjs`. When more than one line matches a pattern, the hook SHALL use the last matching line. A key in the middle of a line, in backticks, in a table cell, or after other text at the start of the line SHALL NOT make the line a verdict line or a signature line.

The rules for the verdict value and for the signature value SHALL NOT change: the verdict value is the first word of ASCII letters and underscores after the last marker of the line, and the signature value is the text after the last `Technical Review Approved:` of the line and before `签署人`, without white space. The hook SHALL give the same result in the C locale and in a UTF-8 locale.

When no line matches the signature pattern, the hook SHALL deny apply, and the reason SHALL say that the signature line starts at the start of a line.

#### Scenario: Signed signature in the body before a blank signature line
- **WHEN** the body of `review-summary.md` contains the line ``R3 已签字（`Technical Review Approved: tigger`），本轮重走后签字作废。``
- **AND** the last lines of the file are `Gate-Verdict: READY_FOR_HUMAN_APPROVAL` and `Technical Review Approved: __________`
- **THEN** the hook denies apply because the signature line is blank

#### Scenario: Ready verdict of the previous round before a blocked verdict line
- **WHEN** the body of `review-summary.md` contains the line `- Gate-Verdict: READY_FOR_HUMAN_APPROVAL（R3 的裁决）`
- **AND** the human confirmation section contains `Gate-Verdict: BLOCKED` and `Technical Review Approved: tigger 2026-11-08`
- **THEN** the hook denies apply because the verdict is `BLOCKED`

#### Scenario: Quoted signature line before a blank signature line
- **WHEN** the body of `review-summary.md` contains the line `> Technical Review Approved: tigger`
- **AND** the last line of the file is `Technical Review Approved: __________`
- **THEN** the hook denies apply because the signature line is blank

#### Scenario: Blocked verdict of the previous round before a ready verdict line
- **WHEN** the body of `review-summary.md` contains the line `- Gate-Verdict: BLOCKED（R2 的裁决）`
- **AND** the human confirmation section contains `Gate-Verdict: READY_FOR_HUMAN_APPROVAL` and `Technical Review Approved: tigger 2026-11-08`
- **THEN** the hook allows apply

#### Scenario: Signed line after the placeholder
- **WHEN** `review-summary.md` contains the line `Technical Review Approved: __________`
- **AND** the user adds the line `Technical Review Approved: 张三 2026-11-08` at the end of the file
- **THEN** the hook allows apply

#### Scenario: Example in a sentence after a blank signature line
- **WHEN** the line after `Technical Review Approved: __________` is ``签字行写成 `Technical Review Approved: 张三 2026-11-08`。``
- **THEN** the hook denies apply because the signature line is blank

#### Scenario: Signature only in the middle of a line
- **WHEN** the only lines of `review-summary.md` that contain `Technical Review Approved:` are `签字：Technical Review Approved: 张三` and `| Technical Review Approved: 张三 |`
- **THEN** the hook denies apply because the signature line is missing
- **AND** the reason contains `行首`

#### Scenario: Signature line after a full-width space
- **WHEN** a line of `review-summary.md` starts with a full-width space (U+3000) followed by `Technical Review Approved: 张三 2026-11-08`, and no other line matches the signature pattern
- **THEN** the hook allows apply in the C locale and in a UTF-8 locale

#### Scenario: Marker broken by a no-break space
- **WHEN** the only signature-like line is `Technical` followed by a no-break space (U+00A0) and `Review Approved: 张三 2026-10-14`
- **THEN** the hook denies apply because the signature line is missing

### Requirement: The shared samples SHALL contain whole summaries that the hook test and the gate test both run

`scripts/lib/review-approval-samples.mjs` SHALL export summary samples. Each summary sample SHALL contain a name, the lines of one `review-summary.md`, and the expected result that the gate rules give: whether the hook allows apply, the `approval` value and the `gateVerdict` value of `facts`. The expected result SHALL come from the gate rules, not from one of the implementations. The first summary sample SHALL be a signed signature mentioned in the body before a blank signature line.

The file SHALL also export single lines that mention the signature marker but are not signature lines, and signature lines after non-ASCII white space. The single-line groups SHALL be added to the signature samples that both tests already run. The summary samples and the single-line samples SHALL together cover each scenario of the requirement above.

`scripts/test-approval-hook.mjs` SHALL assert the hook result of each summary sample in the C locale and in a UTF-8 locale. `scripts/test-implementation-gate.mjs` SHALL assert the `facts` result of each summary sample, and it SHALL assert that the hook result and the `facts` result agree for each summary sample in both locales.

#### Scenario: New summary sample runs in both tests
- **WHEN** a summary sample is added to `scripts/lib/review-approval-samples.mjs`
- **THEN** `npm run test:hook` and `npm run test:gate` both run it without a change to the test files

#### Scenario: Hook and facts disagree on a summary sample
- **WHEN** the hook allows a summary sample and `facts` reports `blank` or `missing` for it
- **THEN** `npm run test:gate` fails and names the sample

#### Scenario: Expected result differs from the hook
- **WHEN** the hook denies a summary sample whose expected result allows apply
- **THEN** `npm run test:hook` fails and names the sample and the locale

### Requirement: The rule text SHALL state the same reading rule as the hook

`skills/openspec-technical-review/shared/gate-policy.md`「机器可读裁决行」and `skills/openspec-technical-review/shared/apply-gate-check.md` SHALL state the reading rule of the requirement above: the key at the start of the line, and the last matching line. The commands in `apply-gate-check.md` SHALL list all matching lines and SHALL NOT use `grep -m1`.

`skills/openspec-technical-review/SKILL.md` Step 2 item 16 and the summary prompt of `skills/openspec-technical-review/technical-review-gate.workflow.js` SHALL state the rule for the writer of the summary: the human confirmation section is the last section, and a quote of the verdict line or the signature line in the body does not start at the start of a line. `workflow/OpenSpec-AI-研发流程.md`「签字格式」and the signature item in `docs/devops-openspec-integration-guide.md` SHALL state that the signature line starts at the start of a line. `scripts/test-doc-consistency.mjs` SHALL assert these texts.

#### Scenario: Apply gate check lists all matching lines
- **WHEN** `apply-gate-check.md` is read
- **THEN** its commands do not contain `grep -m1`
- **AND** its text contains `行首` and `最后一行`

#### Scenario: Writer rule in the review skill and the workflow prompt
- **WHEN** `SKILL.md` Step 2 item 16 and the summary prompt of `technical-review-gate.workflow.js` are read
- **THEN** both state that the human confirmation section is the last section
- **AND** both state that a quote of the verdict line or the signature line in the body does not start at the start of a line

#### Scenario: Rule text removed from one place
- **WHEN** `gate-policy.md` no longer contains `最后一行`
- **THEN** `npm run test:consistency` fails and names the file
