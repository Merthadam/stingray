# Repo Map: nested treemap implementation plan

Status: **Draft for review. Planning authorized; implementation NOT authorized.**

## 1. Authority and delivery gates

This plan records the current conversation's design decisions. The user chose the treemap-first design/spec discussion, approved the choices below, and then requested: “yes write the plan.” That authorizes this document, not source changes, test/app execution, or delivery.

The user owns major product decisions. Before implementation, obtain explicit approval of this plan, including the proposed technical defaults in section 4 and isolated verification in section 6. Stop and return for review if implementation requires materially different behavior, wider read limits, dependency installation, additional integrations, or expanded scope.

No commits, pushes, packaging, production-app replacement/restart, existing-preview restart, global Pi changes, workflow-state initialization, worker launches, or external services are included. This is a human-gated process conducted here, not execution through the experimental offline Pi workflow. Preserve existing unrelated working-tree edits.

## 2. Confirmed product decisions

- Replace the square-card grid with a dense nested treemap matching the supplied references: folders enclose subfolders and files, compact headers, tight spacing, variable-area rectangles, no file pictograms.
- Larger files receive more space **by total lines of code**, not bytes or changed-line counts. Folder weights aggregate their descendants.
- Fit each map view to available space. Click a folder to focus it; breadcrumbs and Back restore context. No free panning, drag-to-move, or map scrolling.
- Show **all files by default**, with unchanged files muted. Offer **Only changes**.
- Show real Git state: yellow modified, green added, red deleted; changed-folder outlines; real file/folder net `+ / −` counts. Preserve an explicit conflict state and non-color status cues.
- Click a file to open the **right-hand inspector**, initially closed. Preserve read-only Diff / Whole file views and staged/unstaged distinctions.
- Inspector divider is draggable. Expanding fills the workspace content area temporarily; restoring preserves prior map focus and sidebar width. Closing restores the full map. No persistent selected-file outline; keyboard focus remains visible.
- Deliver treemap + Git integration first. Agent identity/activity/attribution/trails and component rendering are deferred. Existing unsupported/unconnected surfaces must remain honest.

## 3. Current baseline and gaps

Read-only inspection found:

- `src/RepoMapCanvas.tsx` uses `squareGrid`, at most 24 square tiles, and contiguous name-range grouping. This is not a nested treemap.
- `src/repo-map-model.ts` already builds the folder hierarchy and aggregates Git change counts. Reuse those semantics where appropriate; replace square layout/grouping assumptions.
- `src/shared.ts` stores net additions/removals as `RepoFile.lines`. It has no total file-line count. **Do not repurpose `lines` or derive total size from additions/removals.**
- `electron/repo-map.ts` provides read-only inventory, HEAD-to-working-tree net counts, deleted-file inspection and bounded file reads. Inventory is limited to 100,000 files, with 16 MiB/15-second Git inventory command bounds; file inspection is limited to 512 KiB. Untracked/unborn counting currently reads at most 64 files per refresh, four concurrently.
- `src/RepoMap.tsx` has a closeable inspector, polling, staged/unstaged diffs and version-sensitive review acknowledgement. Width is CSS-controlled, with no drag resize or expand/restore. `CodeView` currently stops displaying after 4,000 lines.
- Historical fixed-grid evidence records build, 44 unit/integration, 44 native map and 31 desktop regression passes. Those results do not validate this proposed design. Preserve historical evidence rather than overwrite it.

## 4. Proposed technical defaults — part of plan approval

### 4.1 Line measurement and bounded reads

Use **physical text lines**, including blank lines and comments; do not introduce language parsers. Empty content is zero lines. A trailing newline does not invent an extra line; a final unterminated line counts. CRLF and LF have equivalent line-count semantics. Label the metric “text lines” in explanatory UI so it is not mistaken for executable statements.

Add a separate typed size measurement to each file: known line count or explicit unavailable/pending state, source (working tree, HEAD, or index), and reason. Keep size availability separate from Git +/- availability. Aggregate known size and unknown-file counts separately.

- Existing tracked/untracked text files: measure current working-tree contents.
- Deleted files: use the same prior-content source distinction as inspection (HEAD for staged deletions, index for unstaged deletions). Bind cached historical measurements to the relevant revision/blob identity. Handle deleted staged additions and renamed paths explicitly.
- Binary/non-UTF-8, unreadable, over-limit, symlink and submodule entries: no fabricated LOC, no automatic byte-size weighting. Explain why size is unavailable.
- Layout weight is `max(1, knownTextLines)` for known files; empty and unknown files receive a clearly documented minimum placeholder weight of 1. This is layout representation, **not a claim of one line**. Folder displayed line totals exclude unknown counts. Warn when sizing is partial.
- Retain the 512 KiB per-file read ceiling and existing inventory limits. No blanket recursive content scan, source execution, external diff/textconv, or network access.
- Share content reads with existing untracked counting where possible. Proposed combined content-count budget: at most 64 file contents per snapshot refresh, four concurrent, at most 32 MiB plus bounded oversize-detection bytes. Historical blob reads count toward that budget; use bounded Git access rather than a process per inventory entry. Existing diff/inventory subprocess limits remain separate and documented.
- Prioritize an explicitly focused/searched file and visible scope, while reserving half the batch for a fair cursor over the remaining inventory. Do not repeatedly read only the first 64 files. Collect bounded progress during normal visible-view refreshes, not a new background daemon.
- Use a bounded in-memory measurement cache (maximum 100,000 entries total, no file contents retained), keyed by canonical workspace/path and validated source identity. Dispose/evict unused state; do not persist a source index. Metadata revalidation also needs a bounded fair queue. Working-tree metadata is a freshness heuristic, not an atomic snapshot guarantee; mark unvalidated cached measurements stale, and recheck around reads. Reconcile HEAD/index changes and workspace switches without leaking old responses into a new view.
- A scheduling deadline stops admitting more count work after 2 seconds per batch; it is not a promise that an in-flight filesystem operation has a hard timeout. Bound outstanding work and prevent overlapping refresh jobs. Surface partial progress instead of claiming every file is counted instantly.

If real fixture results show these limits make the chosen experience unusable, pause with evidence and proposed alternatives; do not silently widen them.

### 4.2 Layout, density and reachability

Implement a pure, deterministic nested treemap layout, without a new package dependency. Use a squarified initial arrangement with stable sibling ordering retained across ordinary status refreshes; accept imperfect aspect ratios rather than reorder everything whenever Git badges change. Identical hierarchy, weights and viewport must produce identical geometry.

- Allocate siblings by weight within the parent's content rectangle, reserving compact header and padding space. Folder geometry contains its descendants; siblings never overlap or exceed the viewport.
- Diff-only changes that leave hierarchy/weights unchanged must not move tiles. LOC, inventory, filter, viewport and sizing-progress changes may require reflow; coalesce updates and avoid continuous movement during interaction. Do not promise invariant positions when file sizes change.
- Proportionality applies to sibling content allocations before gutters/header deductions and placeholder handling; labels must not imply mathematically exact visible-pixel ratios at every nesting depth.
- Proposed DOM budget: at most 2,000 rendered map nodes, including folder frames and aggregate tiles. Hide labels before dropping detail. Use explicit `N files` aggregate tiles for branches/tails that cannot fit safely or exceed budget, with exact counts and no duplicates/omissions. This must remain a dense nested view, not a return to 24 large cards.
- Clicking an aggregate or folder narrows scope; every drill step must reduce the represented set or advance down the hierarchy. No dead-end aggregation loops. Use bounded/iterative traversal for deep trees.
- Search covers the full inventory, not rendered nodes. It must reveal any matching file even if it was aggregated, tiny, filtered, or the inspector resizes the map. Explain when Only changes excludes a result; offer an explicit way to show it rather than silently alter the filter.
- Hover/focus details show full path, Git state, measured size/source or unknown reason, and +/- counts. Keyboard-accessible search/navigation provides an alternative to targeting tiny rectangles. Use a bounded keyboard focus model, not thousands of sequential tab stops.
- Changed-folder outlines aggregate descendant state. Keep green/red count text, textual status cues, and a distinct conflict indicator. No agent-colored trails or invented activity.

### 4.3 Inspector and full-file reading

Keep inspector state in the existing Repo Map surface: open/closed, sidebar width, expanded/restored, selected file and reading mode. Preserve map navigation state while expanded; avoid unmounting and recreating the map unnecessarily.

- Default sidebar approximately 40% of map content width; clamp drag width to preserve usable map and reader areas. Use a pointer-captured divider with keyboard resizing and an accessible separator role/value.
- At the existing 760×540 compact fixture, retain a side-by-side sidebar without horizontal workspace overflow. If available content width is too small for both minimums, offer/use the explicit full-content reader state; never silently stack the map beneath the inspector.
- Store preferred width for the current mounted workspace only; no new settings persistence. Restore width subject to current viewport clamps.
- Expand fills only workspace content, not project navigation or the entire app window. Restore preserves file, mode, scroll position where feasible, map focus and prior width. Close returns focus to the map.
- Escape priority: dismiss search results; otherwise restore an expanded reader; otherwise close the sidebar; otherwise navigate up the focused map. Nested controls must not trigger multiple Escape actions.
- Whole file must make every line of a successfully loaded bounded text file reachable. Replace the 4,000-line hard display truncation with bounded incremental/virtualized rendering. Preserve the 512 KiB service ceiling and explicit notices for unavailable content. Likewise avoid silently truncating loaded diffs. Do not inject source as HTML.
- Retain polling, deleted-content provenance, literal-path handling, unknown/error states and version-sensitive review invalidation. Prevent stale asynchronous results after selection/workspace changes.

## 5. Implementation sequence and file scope (not started)

### Step 1 — Size contract and measurement service

Files: `src/shared.ts`, `electron/repo-map.ts`; optionally new focused `electron/repo-map-size.ts` to keep budgeting/cache logic isolated; `tests/repo-map.test.ts`.

Add size states, bounded measurement/cache scheduling and separate partial-size reporting. Preserve existing net diff counts and inspection safety. Unit-test semantics, limits, cache invalidation and Git edge cases before UI wiring.

Focused-scope priority may require an optional validated snapshot request hint. If used, update only the relevant forwarding/validation in `electron/git.ts`, `electron/main.ts`, `electron/preload.ts`, `src/api.ts`, `src/shared.ts` and demo bridge. Verify workspace ownership and inventory membership; it must not become an arbitrary filesystem-read endpoint. No new IPC endpoint unless review demonstrates a need.

### Step 2 — Pure layout model

Files: `src/repo-map-model.ts`, optional new `src/repo-map-layout.ts`, `tests/repo-map.test.ts`.

Separate tree/aggregate computation from geometry and visible-detail projection. Add weighted nested rectangles, bounded aggregation, search reveal and navigation identity. Replace obsolete square-grid tests while preserving equivalent reachability and aggregate guarantees.

### Step 3 — Treemap renderer and navigation

Files: `src/RepoMapCanvas.tsx`, `src/repo-map.css`, `src/LineCounts.tsx` only if needed for compact presentation, `src/demo.ts`.

Render nested frames/tiles from model geometry, breadcrumbs, scope focus, search, status legend, partial-size notice and accessible details. Add deterministic synthetic demo data with varied sizes, nested folders, all Git states and unknown sizing. Keep existing application visual language while matching reference density and hierarchy.

### Step 4 — Dynamic right inspector

Files: `src/RepoMap.tsx`, `src/repo-map.css`; optional new `src/RepoMapCodeView.tsx` if needed to isolate bounded full-content rendering.

Implement resize, expand/restore, Escape ordering and map-state preservation. Make all loaded file/diff lines accessible. Keep unsupported Preview/Agent tracker states honest; do not add integrations or redesign those features.

### Step 5 — Integrated verification, visual review and documentation

Files: `tests/repo-map.test.ts`, `tests/repo-map.mjs`, `tests/desktop.mjs`; `tests/git.test.ts` only for directly affected service contracts; `README.md`, `STATUS.md` after actual verification.

Replace old square geometry/card-count assertions with treemap guarantees. Do not weaken unrelated regression checks. New evidence belongs in ignored `artifacts/testing/repo-map-treemap/`, including screenshots, actual command results, measured performance and known limitations. Do not overwrite fixed-grid evidence or copy its pass counts as new results.

No dependency or lockfile changes planned. Any other file changes require a scope review first.

## 6. Verification and acceptance gates (future execution only)

### Model/service checks

- Text counts: empty, LF/CRLF, blank/comment lines, unterminated last line, Unicode, binary/invalid encoding, oversized/growing files and read failures.
- Git: clean, staged/unstaged changes and cancellation, untracked, deleted, staged additions deleted before commit, renamed/heavily edited files, unborn/orphan/corrupt HEAD, conflicts, odd literal filenames.
- Preserve Git index and working-file contents; external diff/textconv never execute. Traversal, ignored paths, symlink parents, cross-workspace reads and invalid priority hints remain rejected.
- Budgets: exact file/concurrency/byte caps; progressive fair advancement; bounded metadata/cache work; stale and pending presentation; HEAD/index/workspace invalidation; no overlapping work or stale responses.
- Geometry: finite nonnegative rectangles, containment, no sibling overlap, deterministic layout, larger known weight gets larger sibling allocation, exact aggregation, no duplicate/omitted inventory entries and terminating drill-down.
- Stress: 100,000-entry model fixtures, flat and deeply nested trees, mixed/unknown/zero weights, long paths; search to the final entry. Record runtime rather than claim native 100k performance from model tests.

### Native UI and visual checks

Use temporary Git repositories and isolated app data only; test-owned Electron processes must be cleaned up. Never reuse production or existing-preview app data.

- Dense multi-level hierarchy is visually recognisable; changed states/counts and folder outlines match real fixture Git results.
- All files default; Only changes; breadcrumbs, Back, aggregate drill-down, tiny-file search and clean/empty/error/partial-size states.
- File click opens right sidebar; Diff/Whole file, staged/unstaged sections and deleted source labels work.
- Pointer and keyboard resizing; width clamp; expand/restore; close; Escape ordering; workspace switch; stale async response protection; polling/review invalidation.
- A file below 512 KiB with more than 4,000 lines has its last line reachable; validate similarly bounded long diffs and safe text rendering.
- At least 2,048 real fixture files for native density testing; instrument rendered-node bound and interaction timings. Cover 760×540 and a wide desktop viewport, sidebar closed/open/resized/expanded. No unintended map or workspace scrollbars/overflow.
- Screenshots: whole overview, focused folder, Only changes, unknown sizing, diff sidebar, whole-file sidebar, wide/narrow divider positions, expanded/restored reader and compact view.
- No renderer exceptions; existing desktop regressions stay passing. Real agent behavior and component execution are explicitly outside validation.

Commands after implementation approval:

```sh
npm run build
npm test
npm run test:repo-map
npm run test:desktop
git diff --check
```

Verify each native test's evidence-directory configuration before running so artifacts land in the new directory. Review newly created files as well as tracked diffs; `git diff --check` alone does not cover untracked source files. Existing renderer chunk warnings must be recorded, not hidden.

### User review and delivery

Passing tests are necessary but insufficient for the visual target. Present synthetic-fixture screenshots and measured limitations for user review. Obtain approval for any further visual scope changes. An interactive personal preview, commit/push, app packaging or installed-app promotion is a separate request with its own current-state and safety checks.

## 7. Completion checklist

- [ ] User approves implementation plan and isolated verification scope.
- [ ] Size contract/budget semantics implemented and tested.
- [ ] Nested weighted layout and complete reachability verified.
- [ ] Treemap/Git UI integrated without fabricated metrics or activity.
- [ ] Right inspector resize/expand/restore and full bounded reading verified.
- [ ] Fresh build, unit, native map and desktop results recorded.
- [ ] Reference-based visual review presented; unresolved issues stated.
- [ ] README/STATUS describe only delivered, verified behavior and remaining limits.

**Current stopping point:** plan written for review. No implementation or verification execution is authorized by this document.
