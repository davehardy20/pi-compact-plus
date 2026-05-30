# GitHub Actions and branch protection cheatsheet

Use this for the `davehardy20/pi-compact-plus` repo after the CI workflow from PR #2 lands.

## 1. Enable GitHub Actions

Go to:

`Repo → Settings → Actions → General`

Set:

- **Actions permissions**:
  - Recommended simple option: **Allow all actions and reusable workflows**
  - Stricter option: allow GitHub-owned actions, because this workflow uses:
    - `actions/checkout`
    - `actions/setup-node`
- **Workflow permissions**:
  - Select **Read repository contents permission**
  - Do not enable write permissions unless a future workflow needs them.
  - Leave **Allow GitHub Actions to create and approve pull requests** disabled.

## 2. Add branch protection for `master`

Go to one of these, depending on GitHub UI version:

- `Repo → Settings → Rules → Rulesets`
- or `Repo → Settings → Branches → Branch protection rules`

Create a rule/ruleset targeting:

```text
master
```

Recommended settings:

- Require a pull request before merging
- Require status checks to pass before merging
- Require branches to be up to date before merging
- Block force pushes
- Restrict deletions

## 3. Required status check

After the workflow has run at least once, add this as a required status check:

```text
CI / Typecheck and test
```

GitHub may also display it as:

```text
Typecheck and test
```

If the check does not appear in the picker, let PR #2 run once, then return to the branch protection settings.

## 4. Current CI commands

The workflow currently runs:

```bash
npm ci
npm run typecheck
npm test
```

It does **not** run Biome yet.

## 5. Do not require Biome yet

Do not add full `biome check .` as a required check yet. The repo still has separate existing hygiene work
to do before full Biome can be a reliable required gate.

Recommended later cleanup:

1. Add/keep a `biome.json` that ignores generated output such as `dist/`.
2. Fix existing repo-wide Biome findings.
3. Add a CI step for Biome.
4. Then require the Biome check in branch protection.

## 6. PR link

Current PR:

<https://github.com/davehardy20/pi-compact-plus/pull/2>
