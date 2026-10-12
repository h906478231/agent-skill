# explainer-video Specification

## Purpose
按人工要求为变更生成讲解视频：人工触发、分镜格式与分镜检查、人工签署门禁、固定场景运行器与镜头动作、产物与 git 规则。
## Requirements
### Requirement: Explainer video SHALL only be generated on explicit request

The explainer video SHALL be generated only when a user runs `/opsx:video <change> [focus]` or explicitly asks for it. No other OpenSpec command, gate or hook SHALL generate a video or require one.

#### Scenario: Archive without a video
- **WHEN** a change is archived and has no `video/` directory
- **THEN** no check reports a missing video

### Requirement: Explainer video SHALL require a valid change model

The video command SHALL run the change-model layout of the change first. When the change has no change model or the change-model check exits with a non-zero code, the command SHALL stop and SHALL tell the user to add or fix the change model.

#### Scenario: Change without a change model
- **WHEN** `/opsx:video` runs on a change whose design.md has no `change-model` block
- **THEN** the command stops before writing a storyboard and states that a change model is required

### Requirement: The storyboard SHALL be a structured block in video/storyboard.md

The storyboard SHALL be a fenced code block with the info string `storyboard` in `<changeRoot>/video/storyboard.md`. It SHALL contain `focus`, `tts` and an ordered list of `segments`. Each segment SHALL contain `narration` and `actions`. Each action SHALL be one of `show`, `highlight`, `trace`, `morph` or `focus`, and SHALL only reference machine, flow, state, transition, step or edge IDs from the change model.

#### Scenario: Action references a missing element
- **WHEN** a segment action highlights `T9` and the change model has no `T9`
- **THEN** the storyboard check exits with code 1 and reports the segment and `T9`

### Requirement: The storyboard check SHALL enforce duration, language and topic limits

The storyboard check SHALL estimate the duration from the narration at 4 Chinese characters per second and SHALL block when the estimate exceeds 180 seconds. It SHALL check every narration line with the STE `text` check and SHALL block on forbidden aliases, non-approved general words and vague words. It SHALL block when `focus` is empty.

#### Scenario: Narration too long
- **WHEN** the narration totals 800 characters
- **THEN** the storyboard check exits with code 1 and reports an estimated duration of 200 seconds

#### Scenario: Forbidden alias in narration
- **WHEN** a narration line contains `退单` and `退单` is a forbidden alias of `取消`
- **THEN** the storyboard check exits with code 1 and reports the segment, `退单` and `取消`

### Requirement: Rendering SHALL require a signed storyboard

`video/storyboard.md` SHALL contain the line `Storyboard Approved: <name> <date> <hash>`, where `<hash>` is the first 8 hexadecimal characters of the SHA-256 hash of the storyboard block, as reported by the storyboard check. The AI SHALL write the line with an empty placeholder and SHALL NOT fill it. The render command SHALL refuse to run while the placeholder is empty.

#### Scenario: Unsigned storyboard
- **WHEN** the line is `Storyboard Approved: ____`
- **THEN** the render command exits with code 1 and no rendering starts

#### Scenario: Storyboard changed after signing
- **WHEN** the storyboard block changes after the line was signed
- **THEN** the render command exits with code 1 and asks for a new signature

### Requirement: The scene runner SHALL be fixed and data-driven

The skill SHALL ship one scene runner that reads the storyboard and the layout JSON and renders with Manim Community. The AI SHALL NOT write Manim code for a change. The runner SHALL draw each element at the coordinates of the layout JSON, so the video uses the same union layout as `overview.html`. `morph` SHALL animate one view into another, such as before into after, by moving no shared element and only adding, removing or recoloring changed elements. The runner SHALL use a dark background and SHALL NOT use LaTeX objects.

#### Scenario: Morph from before to after
- **WHEN** a segment action is `morph` on `order-status` from `before` to `after`
- **THEN** unchanged states stay in place, `退款中` and `已退款` appear, and the removed transition fades out

### Requirement: Video files SHALL stay out of git

The command SHALL write audio, video and Manim cache files only under `<changeRoot>/video/media/`. The skill SHALL document the `.gitignore` entry for that directory, and `doctor` SHALL warn when the entry is missing. `video/storyboard.md` and `video/explainer.srt` SHALL be kept for commit.

#### Scenario: Ignore entry missing
- **WHEN** the project `.gitignore` does not ignore `openspec/changes/*/video/media/`
- **THEN** `doctor` reports a warning with the line to add
