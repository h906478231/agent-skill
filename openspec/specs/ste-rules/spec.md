# ste-rules Specification

## Purpose
STE 规则：以 ASD-STE100 Issue 9 为骨架的中文规则表、自编通用受控词表、模糊词清单、项目覆盖文件 `openspec/ste.yaml` 与 `config.yaml` 规则注入片段（决策见 docs/adr/0005-ste-rules-baseline.md）。
## Requirements
### Requirement: STE rules SHALL use ASD-STE100 as the baseline with traceable rule numbers

The `openspec-ste` skill SHALL provide a Chinese STE rule table. Each adopted rule SHALL carry its own identifier in the form `C-R<n>.<m>` and SHALL reference the ASD-STE100 rule number it adapts. Rules that only apply to English grammar (articles, `-ing` forms, apostrophes and similar) SHALL be listed as not adopted. The rule table SHALL paraphrase rules and SHALL NOT copy ASD-STE100 text.

#### Scenario: Adopted rule is traceable
- **WHEN** a reader looks up rule `C-R4.1` in the rule table
- **THEN** the entry shows the ASD-STE100 rule number it adapts, a Chinese paraphrase, the check method (exact match, heuristic or statistic) and the level for artifacts and for replies

#### Scenario: English-only rule is excluded
- **WHEN** an ASD-STE100 rule only constrains English grammar
- **THEN** the rule table lists it as not adopted with the reason "不适用中文"

### Requirement: The approved vocabulary SHALL be self-authored and SHALL NOT reproduce the ASD dictionary

The skill SHALL ship an approved vocabulary that maps each non-approved general word to one approved replacement, following the STE principles of one word one meaning and one part of speech. Entries SHALL be authored for Chinese technical writing and SHALL NOT be translations or excerpts of the ASD-STE100 dictionary. An entry MAY declare exception phrases that contain the non-approved word but are not violations.

#### Scenario: Non-approved word has one replacement
- **WHEN** the vocabulary contains the non-approved word `利用`
- **THEN** the entry names exactly one approved replacement, such as `使用`

#### Scenario: Exception phrase is not a violation
- **WHEN** an entry for `利用` declares the exception `利用率`
- **THEN** the text `利用率` is not reported as a non-approved word

### Requirement: The skill SHALL ship a vague-word list and sentence-length thresholds

The skill SHALL ship a default vague-word list and default sentence-length thresholds of 40 characters for descriptive sentences, 30 characters for instruction sentences and 6 sentences per paragraph. The thresholds SHALL be documented as converted from the ASD-STE100 word limits with an unverified ratio of about 1.5 characters per word.

#### Scenario: Default thresholds apply without project configuration
- **WHEN** a project has no `openspec/ste.yaml`
- **THEN** the check uses the built-in vague-word list and the 40 / 30 / 6 thresholds

### Requirement: Projects SHALL override defaults through openspec/ste.yaml

A project SHALL be able to add or remove approved-vocabulary entries, add or remove vague words, and change thresholds in `openspec/ste.yaml`. The check SHALL merge the project file over the built-in defaults. An invalid project file SHALL make the check exit with an environment error instead of silently using defaults.

#### Scenario: Project adds a vague word
- **WHEN** `openspec/ste.yaml` adds `酌情` to the vague-word list
- **THEN** the check reports `酌情` in artifacts as a vague word

#### Scenario: Invalid project file
- **WHEN** `openspec/ste.yaml` is not valid YAML or does not match the schema
- **THEN** the check exits with code 2 and names the file and the parse error

### Requirement: The skill SHALL provide a config.yaml rules snippet generated from the rule table

The skill SHALL provide a command that prints a `rules` snippet for `openspec/config.yaml`. The snippet SHALL be generated from the rule table so the rule table stays the single source. The snippet SHALL cover the proposal, design, specs and tasks artifacts.

#### Scenario: Snippet follows the rule table
- **WHEN** a rule is changed in the rule table and the snippet command runs again
- **THEN** the printed snippet contains the changed rule text

### Requirement: CONTEXT.md SHALL act as the STE technical-word extension

The CONTEXT.md format SHALL treat each `_Avoid_` entry as a forbidden alias of its term. A term entry MAY declare a category of `技术名词` (technical noun) or `技术动词` (technical verb). The `openspec-grill` CONTEXT.md format document SHALL state these rules and SHALL reference ADR-0003 and ADR-0005.

#### Scenario: Avoid entry becomes a forbidden alias
- **WHEN** CONTEXT.md defines the term `取消` with `_Avoid_: 退单、撤单`
- **THEN** `退单` and `撤单` are forbidden aliases with the replacement `取消`

#### Scenario: Term declares a category
- **WHEN** a term entry contains `_Category_: 技术动词`
- **THEN** the parsed glossary records the term as a technical verb
