# change-model-rendering Specification

## Purpose
由变更模型确定性生成并集布局、布局 JSON、派生 Mermaid 与离线交互式 `overview.html`：变更前、对比、变更后三个视图共用一套坐标，供开发者看出改了什么，并供讲解视频复用。
## Requirements
### Requirement: Rendering SHALL use one union layout for before, diff and after views

The renderer SHALL lay out the union of all elements of a machine or flow, including removed elements, in one layout pass. The before view, the diff view and the after view SHALL use the same coordinates for every element they share.

#### Scenario: Unchanged state keeps its position
- **WHEN** the reader switches from the before view to the after view
- **THEN** every unchanged state stays at the same coordinates, and only added, changed or removed elements appear, change style or disappear

### Requirement: Rendering SHALL be deterministic

The renderer SHALL produce byte-identical output for the same change model and the same skill version. It SHALL sort elements by ID before layout and SHALL fix the layout random seed. Rendering SHALL NOT call an LLM.

#### Scenario: Render twice
- **WHEN** the renderer runs twice on an unchanged change model
- **THEN** both runs produce identical `overview.html` and identical layout JSON

### Requirement: Rendering SHALL refuse invalid models

The renderer SHALL run the change-model check first and SHALL NOT write any output when the check exits with code 1 or 2.

#### Scenario: Blocking finding exists
- **WHEN** the change model has a blocking finding
- **THEN** the renderer exits with code 1 and does not create or overwrite `overview.html`

### Requirement: The renderer SHALL output layout JSON for downstream consumers

The renderer SHALL provide a `layout` subcommand that prints one JSON object with, for each machine and flow, the coordinates and size of each node, the route points of each edge, the diff marker, the `before` values, the `causes` links and the scenario references. For each node and each edge, the JSON SHALL also contain `lines` and `beforeLines`: the current text and the before text, wrapped with the same rule and the same maximum width that the renderer uses to size the node or the edge label. An element without text SHALL have an empty list. The explainer video SHALL consume this JSON and SHALL draw text from these lines without wrapping it again.

#### Scenario: Layout JSON contains diff data
- **WHEN** the `layout` subcommand runs on a model where `T3` is changed
- **THEN** the JSON entry for `T3` contains `diff: changed`, its route points and its `before` values

#### Scenario: Long English word in an edge label
- **WHEN** the trigger of `T1` is `refundCompensationCallbackReceived` (34 half-width characters, wider than the 140-pixel label limit)
- **THEN** the `lines` of `T1` are `refundCompensatio` and `nCallbackReceived`, and the label box of `T1` is two lines high

### Requirement: overview.html SHALL be a single offline file

The renderer SHALL write `overview.html` in the change root as one file with inline SVG, inline CSS, inline JavaScript and the inline layout JSON. The file SHALL NOT reference any external URL, font, script or stylesheet. The file SHALL be committed to git and archived with the change.

#### Scenario: No external resources
- **WHEN** `overview.html` is generated
- **THEN** the file contains no `http://` or `https://` resource reference and opens correctly from the local file system without network access

### Requirement: overview.html SHALL support view switching and traceability

`overview.html` SHALL provide before, diff and after views for each machine and flow. In the diff view, added elements SHALL be green, changed elements SHALL be yellow and removed elements SHALL be red with a dashed line, and edges SHALL be colored the same way. Selecting a transition or step SHALL show its trigger, guard, `before` values and scenario references, and SHALL highlight the elements linked through `causes`.

#### Scenario: Select a changed transition
- **WHEN** the reader selects transition `T3` whose guard changed from `创建后 15 分钟` to `创建后 30 分钟`
- **THEN** the side panel shows both guard values and the scenario references of `T3`

#### Scenario: Select a step that causes a transition
- **WHEN** the reader selects step `S5` with `causes: [T5]`
- **THEN** transition `T5` in the state machine view is highlighted

### Requirement: overview.md SHALL embed derived Mermaid

When a change model exists, the `openspec-change-overview` skill SHALL insert the Mermaid text printed by the renderer into block 2 of `overview.md` between fixed markers, SHALL NOT edit that text, and SHALL link to `overview.html`. The Mermaid SHALL show the diff view: changed states use class styles, and transition labels carry the prefixes `➕`, `✏️` or `❌`.

#### Scenario: Overview with a change model
- **WHEN** `/opsx:overview` runs on a change whose design.md has a valid change model
- **THEN** `overview.md` block 2 contains the derived Mermaid between the markers and a link to `overview.html`

#### Scenario: Overview without a change model
- **WHEN** the change has no change model
- **THEN** `/opsx:overview` keeps the current ASCII flow in block 2 and does not create `overview.html`

