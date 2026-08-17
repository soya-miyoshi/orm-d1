# Releasing

Two packages, published in lockstep from one GitHub Release:

| package | directory | notes |
| --- | --- | --- |
| `orm-d1` | `.` | the library |
| `orm-d1-kit` | `kit/` | CLI; peer-depends on `orm-d1` |

They always share a version, and `orm-d1-kit`'s peer range is always `^<that
version>`. `.github/workflows/release.yml` refuses to publish if the tag and the two
`package.json` versions disagree — npm has no unpublish story worth relying on, so the
check runs before anything ships.

Authentication is npm **trusted publishing** (OIDC). There is no `NPM_TOKEN` and no secret
to rotate. Provenance attestations are generated automatically; do not add `--provenance`,
npm adds it for OIDC publishes itself.

## One-time setup

### 1. Push the repo

The repository has no commits and no remote yet, so nothing can run:

```bash
git add .
git commit -m "Initial commit"
gh repo create orm-d1 --public --source=. --remote=origin --push
```

CI (`.github/workflows/ci.yml`) runs on every push and PR from that point on.

### 2. Bootstrap each package with a manual publish

Trusted publishing cannot bootstrap itself: `npm trust` states plainly that "the package
you're configuring must already exist on the npm registry". So the first publish of each
name is done by hand, once, and every release after that is automated. Both names were
unclaimed as of 2026-07-27; worth re-checking before you rely on it.

The repository must be **public** for this to work end to end — provenance attestations
require it, and because npm generates them automatically for OIDC publishes, a private repo
fails the publish rather than quietly skipping the attestation.

```bash
npm login
npm run check          # typecheck → build → test → kit typecheck → kit build

npm publish                      # orm-d1
cd kit && npm publish && cd ..   # orm-d1-kit — publish AFTER orm-d1
```

> `npm pack`/`publish` select the package by **working directory**. `--prefix kit` reads
> the root `package.json` and would publish `orm-d1` twice — use `cd kit`.

Order matters: `orm-d1-kit` peer-depends on `orm-d1`, so the dependency should be resolvable
before the dependent lands.

### 3. Configure the trusted publisher

Once both names exist on the registry, from the CLI:

```bash
npm trust github orm-d1     --repo <owner>/orm-d1 --file release.yml --allow-publish
npm trust github orm-d1-kit --repo <owner>/orm-d1 --file release.yml --allow-publish

npm trust list orm-d1       # verify
npm trust list orm-d1-kit
```

`--allow-publish` is **required**, not optional: trusted-publisher configurations created
after 2026-05-20 must name at least one allowed action, and a configuration created without
one authorises nothing. (Older configurations were implicitly publish-only, which is why
guides written before that date omit the flag.)

`--file` is the workflow *filename*, not a path — it must match `release.yml` exactly. Both
packages point at the same repository and the same workflow, which is what lockstep means
here. The equivalent UI is Package → Settings → Trusted Publisher on npmjs.com.

After this, every later release is automated and no token is involved.

## Cutting a release

```bash
make release          # patch: 0.1.3 -> 0.1.4
make release minor    # 0.1.3 -> 0.2.0
make release major    # 0.1.3 -> 1.0.0
make release-dry      # print what a release would do, change nothing
```

`make release` bumps both `package.json` files and the kit's peer range, commits, pushes,
and creates the GitHub Release — which is what fires the publish.

**It does not run the gate locally, on purpose.** `ci.yml` runs `npm run check` on every
push to `main`, and `release.yml` runs it again immediately before publishing, so a third
run on a laptop bought nothing but a hard dependency on a working local toolchain — and a
weaker signal than either, since CI publishes from ubuntu with npm 11 while a laptop is
whatever it is. What the target enforces instead is that **HEAD is a commit `ci.yml` has
already passed**; it refuses to release otherwise. That also implies HEAD is pushed, since a
run cannot exist for a commit GitHub has never seen.

The one thing that reaches the registry unverified by `ci.yml` is the version-bump commit
the target creates, which changes two version strings and nothing else. `release.yml`'s own
gate is the backstop for it: if that fails, nothing is published, and the recovery is
`gh release delete v0.2.0 --cleanup-tag` plus a revert.

The target still refuses a dirty tree, a branch other than `main`, a missing or
unauthenticated `gh`, and a version already on the registry.

Doing it by hand is the same steps:

```bash
npm run version:set 0.2.0   # both package.json files + kit's peer range
git commit -am "Release 0.2.0"
git push                    # wait for ci.yml to go green
```

Then draft a GitHub Release with the tag `v0.2.0` (note the `v`; the workflow strips it) and
publish it. That fires `release.yml`, which:

1. upgrades npm — Node 22 ships npm 10.x, and trusted publishing needs ≥ 11.5.1;
2. checks the tag matches both versions and that the peer range admits them;
3. runs the full gate: typecheck → build → unit + workerd tests → kit typecheck → kit build;
4. prints both tarball manifests;
5. publishes `orm-d1`, then `orm-d1-kit`.

Publishes use `--ignore-scripts` because step 3 already ran the gate and built both
packages. Without it, `prepublishOnly` would run the entire test suite again per package,
and the kit's would rebuild against a `dist/` it does not own.

## Testing the pipeline without publishing

Actions → Release → **Run workflow**, leaving `dry_run` checked (the default). Everything
runs except the two publish steps. Uncheck it to publish from a manual run.

## If a release goes wrong

npm allows unpublishing only within 72 hours, and the version number is burned either way.
The recovery is to publish a patch, not to unpublish:

```bash
npm run version:set 0.2.1
```

If a bad version is already on the registry and should not be installed, deprecate it rather
than remove it — removal breaks anyone who already resolved it:

```bash
npm deprecate orm-d1@0.2.0 "Broken build; use 0.2.1"
```
