# autopilot-exit-actions Specification

## Purpose
归档后出口动作：按固定顺序执行与跳过，提交与合并、推送的起草、计划核对、确认、执行、回读与失败处理。

## Requirements

### Requirement: The scheduler SHALL run exit actions in a fixed order after archive

After the same-batch guard has passed and a change with an `active` autopilot record is in the `archived` list of the progress view, the scheduler SHALL read `decisions/autopilot.json` in its archive directory and set `status` to `exiting`. It SHALL run the exit actions in this order: `commit-merge`, `push`. Each action SHALL need one exit decision, and one round SHALL run at most one action. When an exit decision or an exit alert is answered with `暂不处理`, the scheduler SHALL skip the remaining actions. After the last action or a skip, it SHALL set `status` to `closed` and send a notice card that lists the actions done and the actions skipped. When the change is linked to a yunzhou task by the rule of `yunzhou-task-completion.md` (the change name is `yunzhou-<taskId>`, or `proposal.md` has the line `云舟任务：<taskId>`), the notice card SHALL show the task id and tell the user to complete the task in a session. The notice card SHALL also say that the files under `decisions/` of the change are not committed, and that they contain the `operator_id` of the owner.

Before drafting, executing a previously answered exit decision, retrying or sending an exit completion notice, the scheduler SHALL check the same batch, its unresolved trace and its early-archive block under spec `autopilot-scheduler`. Presence in the archived list SHALL NOT clear either check. A blocked or unverified batch SHALL NOT advance any exit action even when it has an answered decision. Ending the blocked batch by withdrawal or return to the session SHALL NOT run its exit actions.

#### Scenario: Archived change starts the exit actions
- **WHEN** the archive stage moves a change under autopilot to the archive directory and both guards pass
- **THEN** the next round sets the autopilot record to `exiting` and starts the draft of `commit-merge`

#### Scenario: Closing card names the yunzhou task
- **WHEN** the change name is `yunzhou-123` and `commit-merge` and `push` are done
- **THEN** the autopilot record has `status` `closed`
- **AND** the notice card lists `commit-merge` and `push` as done and contains the task id `123`

#### Scenario: Not now closes the autopilot
- **WHEN** the exit decision of `commit-merge` is answered with `暂不处理`
- **THEN** the autopilot record has `status` `closed`
- **AND** the notice card lists `commit-merge` and `push` as skipped

#### Scenario: An answered exit does not clear the early-archive block
- **WHEN** an earlier non-archive run moved the batch into the archive and the persisted block remains, even after its trace entry has been transferred
- **THEN** no answered exit decision, retry, draft or completion notice advances that batch

### Requirement: Exit actions SHALL run only after an answered exit decision

Each exit action SHALL follow four steps:

1. Draft: when the action needs a plan, run a headless stage with the arguments of spec `autopilot-scheduler`, except `--permission-mode dontAsk`, `--disallowedTools Edit Write MultiEdit NotebookEdit WebFetch WebSearch Agent Skill`, and `--allowedTools` with only `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)` and `Bash(git show:*)`. Read the plan from the JSON in `result`.
2. Confirm: check the plan, then create an exit decision whose card shows the plan and the options.
3. Run: after the decision is `answered`, the scheduler runs the plan itself.
4. Read back: the scheduler reads the result back, writes it to `result` of the decision, and sets the decision to `used`.

The scheduler SHALL compute the progress digest of spec `autopilot-scheduler` before and after the draft run. When the digests differ, or when the draft `result` is not valid JSON of the expected shape, it SHALL NOT create an exit decision and SHALL handle the action as failed (Requirement «A failed exit action SHALL end its exit decision and offer three choices»). Equal digests SHALL NOT create a no-progress alert. The scheduler SHALL NOT pass `git commit`, `git merge`, `git push` or `flows-cli` to any headless run.

#### Scenario: Commit plan waits for the card
- **WHEN** the draft of `commit-merge` returns a plan and the exit decision is `pending`
- **THEN** the scheduler runs no `git commit` and the branch list is unchanged

#### Scenario: Draft run has no write commands
- **WHEN** the scheduler starts the draft of `commit-merge`
- **THEN** the arguments contain `--permission-mode dontAsk` and a `--disallowedTools` value with `Edit`, `Write`, `Agent` and `Skill`
- **AND** the `--allowedTools` value contains no `git commit`, `git merge`, `git push` or `flows-cli`

#### Scenario: Draft that changes a file is stopped
- **WHEN** the `claude` test double for the draft changes `README.md`
- **THEN** no exit decision is created and one exit alert with `status` `pending` exists

### Requirement: The commit and merge action SHALL commit only the approved files

Before the scheduler starts the archive stage by rule `R11`, it SHALL write the implementation snapshot to `implSnapshot` of the autopilot record: each path of `git status --porcelain=v1 -z --untracked-files=all -- . ':(exclude)openspec'` with its `git hash-object`, or `null` for a deleted file. It SHALL NOT write the snapshot again when it resumes the session of the archive stage.

The draft prompt of `commit-merge` SHALL contain the output of `git status --porcelain=v1 --untracked-files=all` and the main spec list, and SHALL tell the agent not to list other files under `openspec/specs/` and the files under `decisions/` of the change. The main spec list SHALL be computed for each capability name `<cap>` (each directory name under `specs/` of the change directory located by spec `autopilot-scheduler`) with `git status --porcelain=v1 -z --untracked-files=all --ignored -- openspec/specs/<cap>/spec.md`, and SHALL contain each path of these records. The draft SHALL return `branch`, `files` and `message`. Before it checks the plan, the scheduler SHALL remove from `files` each path under `decisions/` of the change directory located by spec `autopilot-scheduler`. Then it SHALL check the plan:

- the current branch is the `baseBranch` of the project;
- each path of `git diff --cached --name-only -z --no-renames` is in `files`;
- each item of `files` exactly equals the path of one record of `git status --porcelain=v1 -z --untracked-files=all --ignored`, and is a regular file (`lstat`) or a deleted tracked file (the record status has `D`, `git cat-file -e HEAD:<path>` succeeds, and `lstat` reports `ENOENT`); directories, wildcards and paths with `..` are refused, and a rename or copy record (`R`, `C`) fails the check;
- each record of the main spec list is in `files`, and each item of `files` under `openspec/specs/` is in the main spec list;
- the autopilot record has `implSnapshot`, and each item of `files` outside `openspec/` is in it, with the same `git hash-object`, or `null` for a deleted file;
- `branch` starts with the `branchPrefix` of the project, matches `^[A-Za-z0-9._/-]+$`, does not start with `-`, passes `git check-ref-format --branch`, and exists neither locally nor in `git ls-remote --heads origin`, except the branch in `exit.commit-merge.branch` of the autopilot record.

When a check fails, it SHALL handle the action as failed, and the error SHALL name the failed check and the paths. Otherwise it SHALL write `message` to a file in `drafts/`, record in `request.contentDigest` the `git hash-object` of each file (`null` for a deleted file), and create the exit decision. The card SHALL show the branch, the full message and the files. It SHALL list separately the ignored files (records with `!!`) and the deleted files, SHALL list the removed files under `decisions/` of the change as files that the user commits after the autopilot ends, and SHALL list each record of `git status --porcelain=v1 -z --untracked-files=all --ignored -- openspec/specs` that is not in the main spec list as not part of this change. Its options SHALL be `提交并合并`, `只提交到分支` and `暂不处理`. When the answer is `提交并合并` or `只提交到分支`, the scheduler SHALL:

1. read back: when `exit.commit-merge.commit` has a value, or `branch` exists and its last commit message equals `message`, compare `git rev-parse <commit>:<path>` of each file with `request.contentDigest` (`null`: the path is not in the tree) and the set of paths of `git diff-tree -r --no-renames --no-commit-id --name-only -z <commit>^ <commit>` with `files`, handle the action as failed when one differs, and continue at step 6; in this case the current branch may be `baseBranch` or `branch`;
2. when the current branch is `exit.commit-merge.branch` and points to the same commit as `baseBranch`, switch to `baseBranch`; then check that the current branch is `baseBranch` and that each staged path is in `files`, compute the `git hash-object` of each file again, and handle the action as failed when a check fails, a value differs from `request.contentDigest`, or a deleted file exists again;
3. create `branch` from `baseBranch`; when `branch` exists, equals `exit.commit-merge.branch` and points to the same commit as `baseBranch`, switch to it instead;
4. run `git add --` with the files that are not ignored, deleted files included, and `git add -f --` with each ignored file;
5. run `git commit -F` with the message file, and handle the action as failed when the set of paths of the new commit (`git diff-tree` as in step 1) differs from `files`;
6. with `提交并合并`, switch to `baseBranch` and run `git merge --no-ff <branch>`, unless `git merge-base --is-ancestor <branch> <baseBranch>` succeeds;
7. remove the message file.

After each step that creates the branch, the commit or the merge commit, the scheduler SHALL write the branch, the commit id or the merge commit id to `exit.commit-merge` of the autopilot record, with the expected status `exiting` and the `startedAt` read before the round. The scheduler SHALL keep the steps done in memory and SHALL write them to `result.steps` of the decision when the decision becomes `used`. When such a write returns `false`, the scheduler SHALL stop the remaining steps, run `git merge --abort` when a merge is in progress, and write a log line with the steps done. With `只提交到分支`, the checkout SHALL stay on `branch`, and the closing notice card SHALL show the branch and tell the user to switch to `baseBranch` before the next handover.

All git commands SHALL run with argument arrays and without a shell.

#### Scenario: Approved plan is committed and merged
- **WHEN** the plan lists two changed files and the answer is `提交并合并`
- **THEN** `baseBranch` has a merge commit whose second parent is the branch commit, and the branch commit changes exactly the two files

#### Scenario: Plan with an unchanged file is refused
- **WHEN** the plan lists a file that `git status` does not show
- **THEN** no exit decision and no commit are created, and one exit alert is created

#### Scenario: Directory path is refused
- **WHEN** the plan lists `foo-service/`, and the directory has an ignored file `foo-service/application-local.yml`
- **THEN** no exit decision is created and the branch list is unchanged

#### Scenario: New main spec under an ignored directory is committed
- **WHEN** the change has the delta spec `specs/x/spec.md`, `.gitignore` has `/openspec`, the plan lists the new file `openspec/specs/x/spec.md`, and the answer is `提交并合并`
- **THEN** the card listed `openspec/specs/x/spec.md` as an ignored file
- **AND** the branch commit contains `openspec/specs/x/spec.md`

#### Scenario: File changed after the card is refused
- **WHEN** a file of the plan changes after the exit decision is created, and the answer is `提交并合并`
- **THEN** no commit is created, and the exit decision has `status` `used` with `result.ok` `false`

#### Scenario: Invalid branch name is refused
- **WHEN** the draft returns the branch `fix/x;touch /tmp/autopilot-p`
- **THEN** no exit decision is created, one exit alert is created, and `/tmp/autopilot-p` does not exist

#### Scenario: Plan without a new main spec is refused
- **WHEN** the change has the delta spec `specs/x/spec.md`, `.gitignore` has `/openspec`, `openspec/specs/x/spec.md` is a new file, and the draft returns `files` without it
- **THEN** no exit decision is created, and the exit alert names `openspec/specs/x/spec.md`

#### Scenario: Main spec of another change is not in the list
- **WHEN** the change has the delta spec `specs/x/spec.md`, and `openspec/specs/x/spec.md`, `openspec/specs/y/spec.md` (left by another change) and `openspec/specs/.DS_Store` are not committed
- **THEN** the draft prompt lists only `openspec/specs/x/spec.md` as the main spec list
- **AND** the card lists `openspec/specs/y/spec.md` and `openspec/specs/.DS_Store` as not part of this change

#### Scenario: Plan with a main spec of another change is refused
- **WHEN** the change has the delta spec `specs/x/spec.md`, and the draft returns `files` with `openspec/specs/x/spec.md` and `openspec/specs/y/spec.md`
- **THEN** no exit decision is created, and the exit alert names `openspec/specs/y/spec.md`

#### Scenario: Plan on another branch is refused
- **WHEN** the `baseBranch` of the project is `main`, the current branch is `fix/a`, and the draft returns a valid plan
- **THEN** no exit decision is created, and the exit alert names `fix/a`

#### Scenario: Deleted tracked file is committed
- **WHEN** the tracked file `scripts/old.mjs` is deleted in the work tree, the plan lists it, and the answer is `提交并合并`
- **THEN** the card listed `scripts/old.mjs` as a deleted file
- **AND** the branch commit deletes `scripts/old.mjs`, and `git status` does not show it

#### Scenario: File changed by the archive stage is refused
- **WHEN** `implSnapshot` maps `scripts/a.mjs` to one object id, the archive stage changes `scripts/a.mjs`, and the plan lists it
- **THEN** no exit decision is created, and the exit alert names `scripts/a.mjs`

#### Scenario: Commit to the branch only keeps the checkout on the branch
- **WHEN** the answer to `commit-merge` is `只提交到分支` and the answer to `push` is `推送`
- **THEN** the current branch is the plan branch
- **AND** the closing notice card shows the plan branch and `baseBranch`

#### Scenario: Files under decisions are not committed
- **WHEN** the project tracks `openspec/` in git, the plan lists `decisions/autopilot.json` of the archive directory of the change, and the answer is `提交并合并`
- **THEN** the card listed `decisions/autopilot.json` as a file that the user commits after the autopilot ends
- **AND** the branch commit contains no file under `decisions/`, and `baseBranch` has a merge commit whose second parent is the branch commit

#### Scenario: Staged file outside the plan is refused
- **WHEN** `notes/draft.md` was staged before the handover and the plan does not list it
- **THEN** no exit decision is created, and the exit alert names `notes/draft.md`

#### Scenario: Plan without a snapshot is refused
- **WHEN** the autopilot record has no `implSnapshot` and the plan lists `scripts/a.mjs`
- **THEN** no exit decision is created, and one exit alert is created

### Requirement: The push action SHALL only fast-forward the remote base branch

The scheduler SHALL run `push` only when `exit.commit-merge` of the autopilot record has a commit id. Before it creates the exit decision of `push`, the scheduler SHALL run `git fetch origin` and write to `request.commits` the short id and subject of each commit of `git rev-list origin/<baseBranch>..<commit to push>`, where the commit to push is the merge commit, or the branch commit with `只提交到分支`. The card SHALL show the branch, the remote and every item of `request.commits`, with the options `推送` and `暂不处理`. When the answer is `推送`, the scheduler SHALL run `git fetch origin` and compute the list again, and SHALL handle the action as failed when it differs from `request.commits`. When `origin/<baseBranch>` is not an ancestor of the merge commit, it SHALL handle the action as failed and push nothing. Otherwise it SHALL push the branch, and push the merge commit to `refs/heads/<baseBranch>`. When the commit action was `只提交到分支`, it SHALL push only the branch. It SHALL read back the remote reference with `git ls-remote`.

#### Scenario: Push fast-forwards the base branch
- **WHEN** the remote base branch is an ancestor of the merge commit and the answer is `推送`
- **THEN** the remote base branch points to the merge commit and the remote has the branch

#### Scenario: Moved remote base stops the push
- **WHEN** the remote base branch has a commit that the merge commit does not contain
- **THEN** the remote is unchanged, the exit decision has `result.ok` `false`, and an exit alert is created

#### Scenario: Push card lists a local commit
- **WHEN** local `baseBranch` had a commit `L` that `origin/<baseBranch>` does not have before the handover, and the push decision is created
- **THEN** the card lists the short id and subject of `L`
- **AND** after the answer `推送`, the remote base branch contains `L`

### Requirement: A failed exit action SHALL end its exit decision and offer three choices

An exit action SHALL be handled as failed when the plan check fails, the draft changes the progress digest, the draft result is not valid JSON of the expected shape, `request.contentDigest` differs from the work tree or from the tree of the existing commit, the paths of the commit differ from `files`, `git merge` reports a conflict (the scheduler SHALL run `git merge --abort` first), the commits to push differ from `request.commits`, the remote base branch has moved, or the read-back does not show the result. When the action failed before a commit, the current branch is `exit.commit-merge.branch`, and that branch points to the same commit as `baseBranch`, the scheduler SHALL first switch to `baseBranch`. Then the scheduler SHALL:

1. set the exit decision, when it exists, to `used` with `result.ok` `false`, `result.error` and `result.steps`;
2. set `exit.<action>` of the autopilot record to `failed`;
3. create an exit alert decision with `request.exitAction` and without `request.sessionId`, whose card has the options `重试本项`, `暂不处理` and `回会话处理`.

When a `commit-merge` alert is answered with `重试本项` and `exit.commit-merge.commit` of the autopilot record has no value, the next round SHALL draft that action again, with the previous branch name in the prompt. When it has a value, the next round SHALL NOT draft and SHALL NOT check the plan against `git status`: it SHALL create a new exit decision with the `branch`, `files`, `message`, `request.contentDigest` and commit id of the previous one, whose card says that the commit is already on the branch. A `push` alert answered with `重试本项` SHALL instead recompute the remote and commit list under Requirement «The push action SHALL only fast-forward the remote base branch» and request a new push confirmation. It SHALL NOT reuse the commit-and-merge card or its fields. `暂不处理` SHALL skip the remaining actions and close the autopilot. `回会话处理` SHALL set the autopilot record to `void`.

Before an exit draft, retry, or new exit decision, the scheduler SHALL check capacity for a new decision ID under spec `autopilot-scheduler`. At exhaustion it SHALL NOT start the draft, overwrite history, or skip the required approval. Existing verified approvals MAY still execute under all original checks. If such an execution fails and cannot allocate an alert, it SHALL retain the failure and completed steps, stop the batch's exit actions, and issue the no-ID notice for manual handling. It SHALL NOT draft or repeat the failed action without another approval.

Before each step of an answered exit decision, the scheduler SHALL read back the steps already done (Requirement «The commit and merge action SHALL commit only the approved files», step 1 and step 6); when the remote base branch points to the merge commit, it SHALL skip the push. It SHALL write the steps done to `result.steps` when the decision becomes `used`, whether the action succeeds or fails. At any time a change SHALL have at most one decision with `status` `pending` or `answered`.

#### Scenario: Merge conflict ends the exit decision
- **WHEN** `baseBranch` changed the same line after the branch was created, and the answer is `提交并合并`
- **THEN** the work tree has no merge in progress, and the exit decision has `status` `used` with `result.ok` `false`
- **AND** one exit alert with `status` `pending` exists, and it is the only decision of the change with `status` `pending` or `answered`

#### Scenario: Retry drafts the action again
- **WHEN** the exit alert of `commit-merge` is answered with `重试本项`, and `exit.commit-merge.commit` of the autopilot record has no value
- **THEN** the next round starts a draft run of `commit-merge` whose prompt contains the previous branch name
- **AND** the exit alert has `status` `used`

#### Scenario: Retry after a commit only merges
- **WHEN** the commit `C1` is on `fix/x`, the merge failed with a conflict, the conflicting commit on `baseBranch` is then reverted, and the exit alert is answered with `重试本项`
- **THEN** the next round starts no draft run and creates an exit decision whose card says that the commit is already on the branch
- **AND** after the answer `提交并合并`, the tip of `fix/x` is still `C1` and `baseBranch` has a merge commit whose second parent is `C1`

#### Scenario: Retry after a failure before the commit completes the commit
- **WHEN** a `pre-commit` hook makes the first commit fail after the branch `fix/x` is created, the hook is then removed, and the exit alert is answered with `重试本项`
- **THEN** the current branch was `baseBranch` when the exit alert was created
- **AND** after the new answer `提交并合并`, `fix/x` has one commit and `baseBranch` has a merge commit whose second parent is that commit

#### Scenario: Commit with a path outside the plan is refused on read-back
- **WHEN** `exit.commit-merge.commit` is `C1`, `C1` changes a path that is not in `files`, and the exit decision of `commit-merge` is `answered`
- **THEN** the scheduler does not merge, and the exit decision has `result.ok` `false`

#### Scenario: Interrupted execution does not commit twice
- **WHEN** the exit decision of `commit-merge` is `answered`, the branch exists with the last commit message equal to the plan message, and the merge is not done
- **THEN** the next round merges the branch into `baseBranch`
- **AND** the tip of the branch is the same commit as before the round

#### Scenario: Interrupted after the switch to the base branch is merged in the next round
- **WHEN** `exit.commit-merge.commit` is `C1`, the current branch is `baseBranch`, the work tree has the content of `baseBranch`, and the exit decision of `commit-merge` is `answered`
- **THEN** the next round creates no commit and merges `C1` into `baseBranch`
- **AND** the exit decision has `result.ok` `true`

#### Scenario: Cancel during the push stops the remaining steps
- **WHEN** the answer to `push` is `推送`, the `git fetch origin` of the push takes 2 seconds, and `autopilot.mjs cancel` runs during the fetch
- **THEN** `autopilot.mjs cancel` exits with code 0 only after the scheduler releases `run.lock`
- **AND** the remote is unchanged after the round, and the log names the steps done
