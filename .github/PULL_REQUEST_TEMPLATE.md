<!--
Thanks for opening a PR! A few quick notes:

- The PR title is what ends up in the changelog. Write it like a changelog
  entry, not a commit message — see CONTRIBUTING.md.
- Keep the description focused on **why** the change is needed; the diff
  speaks to the **what**.
- For anything user-visible, please add a changeset:
  `npm run changeset`
-->

## Summary

<!-- One or two sentences explaining what this PR changes. -->

## Why

<!--
Why is this change needed? Examples:
- the bug it fixes,
- the use case it enables,
- the trade-offs you considered,
- any follow-ups left for a future PR.
-->

## Changes

<!--
Bulleted list of the user-facing or behavior-affecting changes.
Skip this section if the PR is internal-only (refactor, tests, CI).
-->

-

## Testing

<!--
How did you verify the change? New fixtures under `tests/fixtures/`?
For scanner / pruner work, please add a test that would have failed before
your change — see CONTRIBUTING.md → "Working on the scanner / pruner".
-->

## Checklist

- [ ] Tests added or updated to cover the change
- [ ] `npm run typecheck` passes locally
- [ ] `npm test` passes locally
- [ ] Added a changeset (`npm run changeset`) — **or** this PR has no observable effect on published behavior (refactor, internal docs, CI/test-only) and doesn't need one
- [ ] If this changes observable behavior, the relevant section of `README.md` is updated in this PR
- [ ] If this PR changes `tsup.config.ts`, `files`, `exports`, `bin`, or anything affecting the published tarball: verified locally with `npm publish --dry-run` **and** smoke-tested by installing the `npm pack`'d tarball into a scratch project ([details](https://github.com/DevAOC/pkg-optimize/blob/main/CONTRIBUTING.md#verifying-the-published-artifacts))
