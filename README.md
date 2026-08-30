# Thoth Plugins Marketplace

This repository is the canonical marketplace for the `thoth-mem` and
`thoth-agents` Codex and Claude Code plugins. It contains catalog metadata and
validation tooling only; plugin code remains in each product repository.

Each plugin has an independent semantic version and an immutable Git tag. The
registry pins both values, so releasing one plugin does not change the other.

## Repository layout

- `catalog/plugins.json` is the source of truth for plugin versions, tags,
  repositories, required Skills, and display metadata.
- `.agents/plugins/marketplace.json` is the generated Codex catalog.
- `.claude-plugin/marketplace.json` is the generated Claude Code catalog.
- `scripts/` renders, updates, and validates the catalogs.
- `tests/` verifies cross-host agreement, source manifests, Skill inventory,
  cache topology, and target-only updates.

Both generated catalogs use the internal marketplace name `thoth-plugins`.
Their plugin entries use `git-subdir` sources pinned to `v<version>` and the
`plugin/` directory in the corresponding product repository.

## Validate a checkout

Use Node.js 22.12.0 or newer and pnpm 11.20.0.

```sh
pnpm test
pnpm run validate
```

`pnpm test` runs the dependency-free catalog contract tests. `pnpm run
validate` additionally clones every pinned product tag and checks both native
manifests and the declared Skill entrypoints.

After editing `catalog/plugins.json`, regenerate and validate the descriptors:

```sh
pnpm run catalog:render
pnpm test
pnpm run validate
```

## Bootstrap the remote

For the initial publication of this repository:

```sh
git init -b main
git remote add origin https://github.com/EremesNG/thoth-plugins.git
pnpm test
pnpm run validate
git add -- catalog package.json pnpm-lock.yaml scripts tests .gitignore README.md .agents .claude-plugin
git commit -m "feat: initialize Thoth plugin marketplace"
git push -u origin main
```

The publication branch is `main`. Use a normal push; never force-push catalog
history.

## Release handoff

Run releases from the plugin repository:

```sh
pnpm run release:patch
# or release:minor / release:major
```

The release command performs these operations in order:

1. update and verify the plugin version;
2. create the product commit and tag;
3. push the product commit and tag;
4. run `release:marketplace`.

The marketplace publisher first proves that `v<version>` is visible in the
product remote. It then clones `thoth-plugins` from `main` into a fresh temporary
directory, updates only the selected plugin, runs the central tests and catalog
validation, commits the three catalog files, and performs a normal push.

If step 4 fails after the product tag was pushed, retry only the catalog handoff:

```sh
pnpm run release:marketplace
```

This command is idempotent. It does not change `package.json`, create another
product version, or create another catalog commit when the pin is already
current.

## Concurrent updates

Every publication starts from a fresh clone. If another release advances
central `main` before the final push, Git rejects the non-fast-forward update.
Keep the product version and tag unchanged, then rerun `pnpm run
release:marketplace`. Do not resolve a catalog race with `--force`.

## Roll back a catalog publication

Roll back with an ordinary commit on central `main`:

```sh
git revert <catalog-commit>
pnpm test
pnpm run validate
git push origin main
```

Reverting a catalog commit changes only marketplace discovery. It does not
delete product tags, uninstall plugins, or modify any Codex or Claude Code
cache.
