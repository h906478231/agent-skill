# autopilot-entry Specification

## Purpose
托管入口：`/opsx:autopilot` 从 apply 阶段起托管变更与撤回托管、前置条件、托管记录，以及门禁脚本把 `decisions/` 等托管文件当作产物接受。

## Requirements

### Requirement: The autopilot command SHALL hand over a change only from the apply stage onward

`autopilot.mjs start <name>` SHALL first select a configured project by the management project rule of spec `autopilot-scheduler`, then read its active entry from `progress.mjs --json`. It SHALL accept the change only when `rule` is one of `R6` to `R11`. On acceptance it SHALL create `decisions/autopilot.json` in the change directory with `status` `active`, `startedAt`, `rule` and `tier`, and SHALL print a reminder that the user does not edit the same repository while the change is under autopilot. When `rule` is one of `R1` to `R5`, it SHALL exit with code 1, print the rule and its `blockers`, and SHALL NOT write files. When the change already has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1 and SHALL NOT change the record. One checkout SHALL implement one change at a time (`phases.md`「同一检出只实现一个变更」): when the `implementing` list of the progress view has another change whose validated `changeState.state` is not `paused`, or another batch of the same project, in an active or archived change directory, has an autopilot record with `status` `active` or `exiting`, it SHALL exit with code 1, print the names of those changes, and SHALL NOT write files. When the progress view has no active change with this name, it SHALL exit with code 2.

When the output of the progress view has no `implementing` array, `autopilot.mjs start` SHALL exit with code 2, print that the copy of `openspec-change-progress` needs to be synced, and SHALL NOT write files. When the progress entry of the change has no key `reviewStale`, or `reviewStale` is `null`, it SHALL exit with code 2, print that the copies of `openspec-change-progress` and `openspec-technical-review` need to be synced together, and SHALL NOT write files. When the current branch (`git symbolic-ref --short HEAD`) is not the `baseBranch` of the project, it SHALL exit with code 1, print the current branch, and SHALL NOT write files. When `git config user.name` of the project is empty, it SHALL exit with code 1, print `user.name`, and SHALL NOT write files. When the selected record has `status` `void`, `start` SHALL use the shared project protection to check the previous batch's complete decision list. It SHALL set each remaining `pending` or `answered` decision to `void` with `voidReason` `上一次托管遗留` and print the verified `request.checkFailures` items of those decisions. An incomplete list or a failed write SHALL leave the old record unchanged and return a nonzero result. Only after it proves that no old open decision remains SHALL it write `status` `active` with a new `startedAt`, `rule` and `tier`, without the earlier batch's `implSnapshot`, `exit`, or handoff data. A retry SHALL NOT rewrite decisions already voided.

Under the shared project protection, before legacy decision cleanup or publication, `start` SHALL check the saved `returnHandoff` IDs of all same-project, same-name candidates, including `void` archives. It SHALL apply the terminal handoff verification in `autopilot-scheduler`. If any referenced alert is still `answered` or cannot be verified as `used`, `start` SHALL return nonzero and retain that batch and decision. Once verified complete, that handoff no longer blocks the other admission checks.

Before admission, a live lock has to be verified for the selected project and batch. A verified same-batch lock or an unknown lock that cannot be excluded SHALL fail start with code 1 and leave the record unchanged. A verified lock for another project or batch SHALL NOT reject start on the basis of the selected batch's lock check alone. The independent same-checkout occupancy rule below and the original pending-check guards still apply.

新托管准入 SHALL 要求进度视图输出 `changeStateVersion: 1`。每个活跃条目的 `changeState` SHALL 符合 `change-pause` 的读取契约，`implementing` 中每个名称 SHALL 唯一对应一个可读条目。字段缺失、版本未知、名称无法对应、任一活跃变更状态未知或事实读取失败时 SHALL 退出 2，列出原因，不得写文件。目标变更为 `paused` 时 SHALL 退出 1，提示先恢复推进。

其他变更只有合法的 `paused` 状态 SHALL 可从阶段推导的占用中排除。该排除 SHALL 不影响托管记录、真实运行者、运行锁及未完成核对的独立检查。托管记录检查 SHALL 覆盖同一项目活跃与归档目录中的全部批次。未完成核对检查 SHALL 使用保护内同一份读取结果，覆盖目标和每个按暂缓排除的名称；任一名称有条目时 SHALL 退出 1，不论写者状态或条目类型。其他变更虽已暂缓但仍存在实际占用时 SHALL 拒绝准入。最终准入 SHALL 与暂缓和恢复共用项目写保护。保护内 SHALL 复核活跃目录集合，以及全部活跃条目的目录实例、文件类型与状态摘要。复核 SHALL 包含目标和本次排除的暂缓项。变化或无法复核时 SHALL 退出 1，不登记。保护内 SHALL 不运行进度视图或门禁。只有复核与原有准入检查都通过时，才 SHALL 在同一保护内登记托管。作废遗留决策与登记 SHALL 绑定已复核的目标目录实例；原实例已离开活跃位置时 SHALL 退出 2，说明实际写入结果，不向同名新目录写入。原有分级、签字、分支、用户、遗留决策与记录身份检查 SHALL 继续执行。

在项目写保护内，`start` SHALL 使用 `change-pause` 的项目运行锁判据。当前检出的活锁已绑定另一批次时，也 SHALL 按实际占用拒绝。批次为 `void` 或无阶段进程字段均不改变结论。已核实属于其他项目的锁仍不单独阻断。尚未绑定批次的活锁按该判据不单独阻断。

本次准入依靠排除已核实暂缓的历史实现项时，`start` SHALL 在保护内检查同一检出的原归档批次，不按目标名称过滤。原批次为 `void`、`exit.commit-merge.ok` 为真，且 `exit.commit-merge.mergeCommit` 或 `exit.commit-merge.commit` 为非空提交标识时，SHALL 视为存在可能进入拉取的本机证据。`ok` 缺失时 SHALL 不因本条拒绝。判据 SHALL 不校验提交标识的长度或格式。没有推送托管决策也不能排除首次拉取。本次开机时间（`lib/lock.mjs` 的 `currentBootTime()`）比该批次 `decisions/autopilot.json` 的修改时间晚 60 秒以上时，SHALL 视为写为 `void` 后已重启，首次拉取和确认推送后的拉取均已停止，解除此条件。`void`、缺锁、陈旧锁、没有阶段核对记录、推送结果或远端回读均不能单独作为停止证明。

未满足上述开机时间条件、修改时间晚于当前时间、所需记录不可读、出口字段类型不符（`exit` 或 `exit.commit-merge` 存在但不是对象、`ok` 存在但不是布尔值，或 `mergeCommit`、`commit` 存在但不是字符串）、身份不能核对或扫描不完整时，`start` SHALL 退出 1，报告原批次及未决原因并提示重启后重试，不清理遗留决策、不登记、不修改原资料。本条 SHALL 只读取扫描已读的托管记录字段、该记录的修改时间和本次开机时间。完整扫描未找到此类批次时，不把其他终态历史当作占用。不依靠暂缓排除历史项时，不新增本条未决出口检查。此检查不新增拉取写者记录，不修改撤回或出口流程，也不向远端查询。

托管入口 SHALL 在运行进度视图或门禁前核验其真实路径和安装来源。脚本 SHALL 位于操作者信任的安装根，不得位于登记的项目检出中。来源无法核实时 SHALL 退出 2，不运行该脚本。

在登记前，`start` SHALL 核对当前 macOS 用户域已加载的定时服务与桥接服务。两者使用的脚本及托管目录 SHALL 与当前托管安装匹配。桥接服务唤醒的调度 SHALL 与定时服务使用同一脚本。程序 SHALL 在执行只读版本探测前核实调度脚本来源。实际入口或契约版本 1 无法核实时 SHALL 退出 2，不登记。不得以只读磁盘上的 plist 或读取进度版本代替该校验。命令 SHALL 不加载或重启服务。

两项已加载服务 SHALL 使用与管理进程真实路径相同、可执行的 Node.js。调度只接受同副本 `scheduler.mjs --once`，桥接只接受同副本 `bridge.mjs`。两项服务 SHALL 使用同一个已核验的 `OPENSPEC_AUTOPILOT_HOME`。影响模块或脚本选择的额外参数或环境覆盖不属于本版安装方式。无法核验时 SHALL 退出 2，不登记。

只读探测 SHALL 在已核验的 Node.js 和调度脚本上使用 `--change-state-version`，不附带常规启动参数。它 SHALL 在读取托管配置或项目、取得锁、发送通知或启动阶段之前返回。成功要求退出 0 且标准输出只有 JSON 对象 `{"changeStateVersion":1}`。两次服务查询和一次探测共享 5 秒时限，单次上限 2 秒。超时、输出不符或非零退出时 SHALL 退出 2，不接纳迟到结果，不回退到常规调度。

最终准入的状态读取与候选扫描 SHALL 受 `change-pause` 的保护区时间、目录数和累计读取上限约束。归属、目录实例或任一状态摘要不能核对时 SHALL 不登记。

#### Scenario: Signed change is handed over
- **WHEN** the change has a signed `review-summary.md` and the progress view gives rule `R6`
- **THEN** `autopilot.mjs start` exits with code 0
- **AND** `decisions/autopilot.json` has `status` `active` and `rule` `R6`

#### Scenario: Change without a technical review is handed over
- **WHEN** `overview.md` has the tier line `L0`, the change has no `review-summary.md`, and the progress view gives rule `R6`
- **THEN** `autopilot.mjs start` exits with code 0 and writes `decisions/autopilot.json`

#### Scenario: Unsigned change is rejected
- **WHEN** the progress view gives rule `R5` with the blocker `签字行空白`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `R5` and `签字行空白`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Second start is rejected
- **WHEN** `decisions/autopilot.json` has `status` `active`
- **THEN** `autopilot.mjs start` exits with code 1 and the record is unchanged

#### Scenario: Change in a checkout with another implementing change is rejected
- **WHEN** the progress view gives rule `R6` for the change and lists `other-change` in `implementing`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `other-change`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Second change of the same project is rejected
- **WHEN** `other-change` of the same project has `decisions/autopilot.json` with `status` `active` and is not in `implementing`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `other-change`

#### Scenario: Unknown change is an argument error
- **WHEN** the progress view has no active change named `no-such-change`
- **THEN** `autopilot.mjs start no-such-change` exits with code 2 and writes no file

#### Scenario: Progress view without implementing is an environment error
- **WHEN** the progress view gives rule `R6` for the change and its output has `active` and `archived` but no `implementing`
- **THEN** `autopilot.mjs start` exits with code 2 and prints `openspec-change-progress`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Change on another branch is rejected
- **WHEN** the progress view gives rule `R6`, the `baseBranch` of the project is `main`, and the current branch is `fix/a`
- **THEN** `autopilot.mjs start` exits with code 1 and prints `fix/a`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Missing git user name is rejected
- **WHEN** the progress view gives rule `R6` and `git config user.name` of the project is empty
- **THEN** `autopilot.mjs start` exits with code 1 and prints `user.name`
- **AND** the change directory has no `decisions/` directory

#### Scenario: Cancelled change is handed over again
- **WHEN** `decisions/autopilot.json` has `status` `void` and `startedAt` `2026-11-06T10:00:00Z`, the progress view gives rule `R6`, and `run.lock` does not exist
- **THEN** `autopilot.mjs start` exits with code 0
- **AND** the record has `status` `active` and a `startedAt` later than `2026-11-06T10:00:00Z`

#### Scenario: Hand over while the cancelled stage still runs is rejected
- **WHEN** `decisions/autopilot.json` has `status` `void`, and `run.lock` verifies a live instance of the same project and batch
- **THEN** `autopilot.mjs start` exits with code 1 and the record is unchanged

#### Scenario: New handover voids leftover decisions
- **WHEN** `decisions/autopilot.json` has `status` `void` and an `implSnapshot`, `decisions/D-0006.json` has `status` `pending`, the progress view gives rule `R6`, and `run.lock` does not exist
- **THEN** `autopilot.mjs start` exits with code 0, and `D-0006.json` has `status` `void` with `voidReason` `上一次托管遗留`
- **AND** the record has `status` `active` and no `implSnapshot`

#### Scenario: New handover lists the check failures of a leftover alert
- **WHEN** `decisions/autopilot.json` has `status` `void`, and the session alert decision `D-0007` has `status` `pending` and a `request.checkFailures` item for `STD-02`
- **THEN** `autopilot.mjs start` exits with code 0, `D-0007.json` has `status` `void`, and the output names `STD-02`

#### Scenario: Progress entry without reviewStale is an environment error
- **WHEN** the progress view gives rule `R6` for the change and its entry has no key `reviewStale`
- **THEN** `autopilot.mjs start` exits with code 2, prints both skill names, and does not write files

#### Scenario: A different project's same-name lock does not reject start
- **WHEN** the working directory belongs to the configured project of the selected change and a verified live lock belongs to a different project with the same change name
- **THEN** start applies its other checks and does not reject because of that lock

#### Scenario: A new handover waits for a previous return to the session
- **WHEN** a same-name `void` batch, including one in an archive, names a verified `answered` return-to-session alert and `start` obtains project protection before the scheduler completes it
- **THEN** `start` returns nonzero and leaves the previous batch and its alert unchanged
- **AND** after the scheduler completes and verifies that same alert as `used`, a new attempt proceeds through the other admission checks

#### Scenario: Failed leftover cleanup keeps the previous batch
- **WHEN** the selected previous record is `void` and its decisions cannot be completely listed or one open decision cannot be voided
- **THEN** start returns nonzero, reports whether the list or a write failed, and does not publish another `startedAt`

#### Scenario: 暂缓的历史变更不占用托管入口
- **WHEN** A 为 enabled 且规则为 R6，DDD 为 paused 且仍在 implementing，契约为版本 1，全部其他检查通过
- **THEN** A 可以交给托管，DDD 的任务与状态保持不变

#### Scenario: 暂缓者不能直接进入托管
- **WHEN** 目标变更的状态为 paused
- **THEN** start 退出 1，提示先恢复，不创建托管记录

#### Scenario: 暂缓不能覆盖实际占用
- **WHEN** DDD 为 paused，但项目仍有 active 或 exiting 的其他批次，或未确认停止的运行者
- **THEN** start 拒绝准入，不因暂缓标记而绕过占用检查

#### Scenario: 同检出的出口活锁阻止新托管
- **WHEN** 同一检出的另一批次已写为 `void`，仍持有绑定该批次的活锁，锁未记录阶段进程
- **THEN** `start` 退出 1，不清理遗留决策、不登记
- **AND** 锁已核实属于其他项目且其余检查通过时，`start` 不因该锁拒绝

#### Scenario: 缺少运行锁不能解除未决出口的阻断
- **WHEN** 新托管依靠排除暂缓历史项，同一检出的已撤回归档批次的提交与合并已标记 `ok` 并保留提交结果，运行锁已缺失或陈旧，本次开机时间不晚于该批次托管记录的修改时间加 60 秒
- **THEN** `start` 退出 1，指出原批次并提示重启后重试，不清理决策或写入新批次
- **AND** 上述拒绝也适用于未创建推送托管决策的批次，以及已有原推送确认的批次

#### Scenario: 重启后解除未决出口
- **WHEN** 新托管依靠排除暂缓历史项，同一检出的已撤回归档批次符合未决出口判据，本次开机时间比该批次托管记录的修改时间晚 60 秒以上，其余检查均通过
- **THEN** `start` 可以登记，原批次资料不变

#### Scenario: 提交与合并未完成的批次不构成未决出口
- **WHEN** 新托管依靠排除暂缓历史项，已撤回归档批次保存了 `commit`，但 `exit.commit-merge.ok` 缺失，其余检查均通过
- **THEN** `start` 不因未决出口拒绝

#### Scenario: 时钟异常不解除未决出口
- **WHEN** 符合未决出口判据的批次，其托管记录的修改时间晚于当前时间
- **THEN** `start` 退出 1，不登记

#### Scenario: 出口字段格式错误
- **WHEN** 新托管依靠排除暂缓历史项，同一检出的已撤回归档批次的 `exit.commit-merge` 是数组
- **THEN** `start` 退出 1，按无法核验报告该批次，不登记

#### Scenario: 其他终态历史不构成未决出口
- **WHEN** 新托管依靠排除暂缓历史项，完整扫描仅发现不符合未决出口判据的终态历史，其余检查均通过
- **THEN** `start` 可以登记，不修改历史资料

#### Scenario: 旧进度契约不能识别暂缓
- **WHEN** 进度视图缺少 changeStateVersion 或条目没有 changeState
- **THEN** start 退出 2，提示配套同步副本，不写文件

#### Scenario: 其他变更状态无法确认
- **WHEN** 一个活跃变更的状态为 unknown，或其事实读取失败
- **THEN** start 退出 2，列出该变更与原因，不把它当作可排除项

#### Scenario: 另一项未暂缓的变更仍然阻断
- **WHEN** DDD 已暂缓，但 migrate-assets-to-tigger 仍为 enabled 且在 implementing
- **THEN** start 仍因 migrate-assets-to-tigger 拒绝准入

#### Scenario: 已加载的调度与管理副本不一致
- **WHEN** 管理入口、进度和门禁支持版本 1，但已加载的定时或桥接入口指向旧副本
- **THEN** `start` 退出 2，指出不匹配的服务，不登记托管

#### Scenario: 后台解释器不匹配
- **WHEN** 调度和桥接指向匹配的脚本，但后台 Node.js 的真实路径与管理进程不同
- **THEN** `start` 退出 2，不登记，不执行从服务读取的命令

#### Scenario: 版本探测超过共同截止时间
- **WHEN** 查询和探测总用时达到 5 秒且尚未确认成功，或探测返回非预期 JSON
- **THEN** `start` 退出 2，指出失败步骤，不启动常规调度，不登记

#### Scenario: 历史变更先恢复推进
- **WHEN** `start` 的快照按暂缓排除了一个历史变更，但该变更在最终准入复核前恢复
- **THEN** `start` 退出 1，不沿用快照中的排除结论，不写托管记录

#### Scenario: 最终准入时活跃目录集合变化
- **WHEN** `start` 取得快照以后、最终复核以前，项目新增一个活跃变更目录
- **THEN** `start` 退出 1，提示重新读取进度，不写托管记录

#### Scenario: 已归档的其他批次仍在出口
- **WHEN** 同一项目另一个变更已归档，其批次为 `exiting`，其余检查通过
- **THEN** `start` 退出 1，列出该批次，不写托管记录

#### Scenario: 被排除的暂缓项仍有未完成核对
- **WHEN** 新托管依靠排除暂缓的 DDD，未完成核对文件中有 DDD 的条目，写者已退出或条目类型为 `version-handoff`
- **THEN** `start` 退出 1，指出 DDD 的未完成核对，不登记

#### Scenario: 登记前目标目录被替换
- **WHEN** `start` 最终复核以后，目标活跃目录被归档，原位置出现同名新目录
- **THEN** `start` 退出 2，说明实际写入结果
- **AND** 同名新目录中没有托管记录或作废的决策

### Requirement: The autopilot command SHALL cancel an autopilot and stop its running stage without deleting files

`autopilot.mjs cancel <name>` and `autopilot.mjs status <name>` SHALL use the shared candidate enumeration and record-identity reader of spec `autopilot-scheduler` (Requirement «The autopilot SHALL locate the managed batch for status and cancel»). `cancel` SHALL set the autopilot record from `active` or `exiting` to `void` with `voidReason` `用户撤回`, and SHALL set each eligible `pending` or `answered` decision to `void`. In both protected write sections, `cancel` SHALL verify any saved `returnHandoff` and leave its verified `answered` alert for the scheduler to finish. It SHALL report that the handoff is pending and continue cleanup of the other open decisions of that batch. Failed handoff verification SHALL return nonzero and leave its record and alert intact. Each write SHALL verify the selected batch under the project protection and compare the current `status` with the expected statuses before it writes, and SHALL write a temporary file that replaces the file by rename. When the record already has `status` `void`, `cancel` SHALL NOT write the record again and SHALL run the steps for `run.lock` below; it SHALL still void open decisions of the same batch as described after the lock. When the record has another status or does not exist, it SHALL exit with code 1 and SHALL NOT change files.

After the first write section, `cancel` SHALL read `run.lock` in the autopilot home and wait at most `cancelWaitSeconds` (default 30) when the live lock belongs to the selected project root, change and `startedAt`. Before signaling and on each 200 millisecond re-read, the lock and the process group SHALL be verified for that exact batch and lock instance. A missing `claudePid` sends no signal. If the published group is verified during the wait it SHALL receive `SIGTERM` once for that instance. A different batch SHALL NOT receive a signal; a live lock with unknown identity SHALL NOT be signaled or reported stopped. A replaced lock SHALL be checked again. Removal or replacement alone SHALL NOT prove a stored writer stopped; `cancel` SHALL verify that writer under the unfinished-check rule. When there is no live writer of the selected batch, `cancel` SHALL acquire the shared per-project write protection, re-enumerate and verify the original batch, then void its record if needed and all eligible still-open decisions of that batch, including decisions left by a failed earlier withdrawal or written during the wait. The verified handoff alert remains protected. An already void record SHALL NOT be rewritten. An already void batch with a complete list and no eligible open decision SHALL have no changes to its files. An incomplete list is not proof of cleanup; report it separately from a failed write, with only the verified batch, ID when known, and safe error category. `cancel` SHALL report nonzero for timeout, unknown writer, ambiguous ownership, failed recheck or incomplete write rather than reporting success. It SHALL NOT touch a different batch or delete files. `status` SHALL print the record and counts by decision state; its running status SHALL also check any saved writer for the selected batch. It SHALL report yes for a verified live instance, unknown for unresolved identity or exit, and no only when the selected batch has no such instance, never released it to write, or its exit has been proved. Absence, replacement or staleness of a lock alone SHALL NOT prove exit.

#### Scenario: Cancel voids open decisions
- **WHEN** the autopilot is `active`, no stage runs, and `decisions/D-0002.json` has `status` `pending`
- **THEN** after `autopilot.mjs cancel` the record has `status` `void` and `D-0002.json` has `status` `void`
- **AND** both files still exist

#### Scenario: Status counts the decisions
- **WHEN** the change has one `used` decision and one `pending` decision
- **THEN** `autopilot.mjs status` prints the record and the counts `used: 1` and `pending: 1`

#### Scenario: Cancel stops a running stage
- **WHEN** `run.lock` verifies a same-batch live test group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed, and the record has `status` `void`

#### Scenario: Cancel reports a stage that does not stop
- **WHEN** `run.lock` verifies a same-batch live test group that ignores `SIGTERM`, and `cancelWaitSeconds` is 1
- **THEN** `autopilot.mjs cancel` exits with code 1 and prints that the stage is still stopping
- **AND** the record has `status` `void`

#### Scenario: Cancel waits for the scheduler without a claude process
- **WHEN** `run.lock` verifies the same scheduler instance and batch with `claudePid` `null`, and its `pid` is a live test process that removes `run.lock` after 1 second
- **THEN** the test process receives no signal
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel signals a claude process that starts during the wait
- **WHEN** `run.lock` verifies the same scheduler instance and batch with `claudePid` `null`, and after 1 second the same lock instance publishes a verified live test group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM`
- **AND** `autopilot.mjs cancel` exits with code 0 after `run.lock` is removed

#### Scenario: Cancel of a void record still stops the stage
- **WHEN** `decisions/autopilot.json` has `status` `void`, no decision of the batch has `status` `pending` or `answered`, and `run.lock` verifies a live same-batch group that removes `run.lock` and exits on `SIGTERM`
- **THEN** the test process receives `SIGTERM` and `autopilot.mjs cancel` exits with code 0
- **AND** no file of the change directory is changed

#### Scenario: Cancel of a void record voids decisions added during the wait
- **WHEN** `decisions/autopilot.json` has `status` `void`, the scheduler writes `decisions/D-0008.json` with `status` `pending` during the lock wait, and then releases `run.lock`
- **THEN** `autopilot.mjs cancel` exits with code 0 and `D-0008.json` has `status` `void`
- **AND** the autopilot record is not written again

#### Scenario: Cancel voids again a record written back by the scheduler
- **WHEN** the scheduler writes `{status: active, rerunStage: quality}` with the same `startedAt` after the cancel wrote `void`, and then releases `run.lock`
- **THEN** `autopilot.mjs cancel` exits with code 0, and the autopilot record has `status` `void`

#### Scenario: Cancel of an exiting change finds the archive directory
- **WHEN** the change is in the `archived` list of the progress view, and `decisions/autopilot.json` in its archive directory has `status` `exiting`
- **THEN** `autopilot.mjs cancel` exits with code 0 and that record has `status` `void`

#### Scenario: A same-name lock belongs to another project
- **WHEN** a live lock is verified for a batch of the same name in another project
- **THEN** cancellation of the selected batch sends no signal to that writer and status does not report that writer as the selected batch

#### Scenario: Cancel retries remaining open decisions without new decisions
- **WHEN** a previous withdrawal left the same batch void but a decision still open, and no decision was added during the current wait
- **THEN** the command voids that decision without rewriting the record, or reports a nonzero exit when the write cannot finish

#### Scenario: Cancel preserves the original alert during a terminal handoff
- **WHEN** a verified batch is `void` with an `answered` return-to-session alert in `returnHandoff`, and `cancel` obtains project protection before the scheduler completes that alert
- **THEN** cancel reports the pending handoff, preserves the original alert and record, and voids only other eligible open decisions of the same batch
- **AND** the scheduler can still set the original alert to `used` and complete the same handoff without starting an exit action

#### Scenario: No lock does not prove a saved writer exited
- **WHEN** no current lock belongs to the selected batch but the saved writer's exit cannot be verified
- **THEN** status reports unknown, and cancel does not claim that the stage has stopped

#### Scenario: An incomplete decision list does not prove withdrawal finished
- **WHEN** the selected batch is `void` and a same-batch decision file cannot be read or validated
- **THEN** cancel returns nonzero and distinguishes the incomplete list from a failed write of a known decision

### Requirement: The gate script SHALL accept the autopilot files as artifacts

`implementation-gate.mjs hygiene <changeRoot>` SHALL report no warning for `decisions/autopilot.json` and for files that match `decisions/D-<four digits>.json`. Other files under `decisions/` SHALL be reported as files outside the allowlist.

#### Scenario: Autopilot files pass hygiene
- **WHEN** the change directory contains `decisions/autopilot.json` and `decisions/D-0001.json`
- **THEN** `hygiene` reports no warning for these files

#### Scenario: Other file under decisions is reported
- **WHEN** the change directory contains `decisions/notes.md`
- **THEN** `hygiene` reports one warning for that file
