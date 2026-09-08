# Releasing Inkwell

A release is one thing: a version tag pushed to GitHub. Everything after that is
automatic, and nothing else publishes anything. A merge to `main` runs the full
test and image build, but never touches the registry — `latest` moves only when
a maintainer tags.

## Cutting a release

```sh
# 1. The tag and the package must agree; the workflow refuses the release if
#    they do not, because the image's version label comes from the tag.
npm version 1.2.3 --no-git-tag-version
git commit -am "Release 1.2.3"

# 2. The tag is the trigger.
git tag -a v1.2.3 -m "Inkwell 1.2.3"
git push origin main --follow-tags
```

Git tags use a `v` prefix. Docker tags do not: `v1.2.3` publishes `1.2.3`.

Watch the run under **Actions → Release**. It runs the same checks a pull
request runs — tests, migrations, setup, module parse, production dependency
audit, Compose and Unraid template validation, a real container clean-install
and persistence smoke, and a build of both architectures — and only then
builds and pushes. A tag that cannot pass CI never reaches the registry.

## What lands in GHCR

`ghcr.io/whoiscalebbrown/inkwell`, one multi-platform manifest covering
`linux/amd64` and `linux/arm64`, tagged:

| Git tag | Docker tags |
| --- | --- |
| `v1.2.3` | `latest`, `1`, `1.2`, `1.2.3` |
| `v1.2.3-rc.1` | `1.2.3-rc.1` only |

A prerelease is cut the same way — `npm version 1.2.3-rc.1`, tag `v1.2.3-rc.1` —
and the version check applies to it too. A prerelease deliberately claims none
of the moving tags. Someone tracking
`latest`, `1` or `1.2` cannot be given a release candidate by accident.

Each image carries OCI metadata: title, description, source repository,
documentation, licence, vendor, and — filled in per release — version,
revision (the commit SHA) and creation time. The workflow also attaches a
signed build provenance attestation and an SBOM, and the GitHub Release notes
carry the exact manifest digest, which is the only identifier a rollback or a
support question can be pinned to.

## One-time setup on the first release

Three things have to be public before a stranger — or an Unraid server — can
follow this path. None of them happen automatically.

1. **The GHCR package.** GHCR creates a new package as **private**. Unraid
   checks for updates anonymously, so a private package means it can never see
   a new digest and never offers Update. After the first successful release,
   open the package page (Repository → Packages → inkwell → Package settings)
   and set its visibility to **public**.
2. **The repository.** The Unraid template's `Icon` and `TemplateURL` are
   `raw.githubusercontent.com` links, which 404 while the repository is
   private, and the install instructions fetch the template from the same
   place. GitHub also declines to store build attestations for a user-owned
   private repository — the release workflow skips that step rather than fail,
   so a private repository still publishes a usable image, just without the
   `gh attestation verify` half.
3. **Actions.** Enabled by default; nothing to configure. The release
   authenticates with `GITHUB_TOKEN` and needs no secret.

Confirm the result from a machine that is not logged in:

```sh
docker pull ghcr.io/whoiscalebbrown/inkwell:latest
```

## Verifying a published release

```sh
# Both architectures present in one manifest:
docker buildx imagetools inspect ghcr.io/whoiscalebbrown/inkwell:1.2.3

# The metadata that release claims:
docker buildx imagetools inspect ghcr.io/whoiscalebbrown/inkwell:1.2.3 \
  --format '{{json .Image}}' | grep -i 'org.opencontainers'

# GitHub's signed provenance for that exact digest:
gh attestation verify oci://ghcr.io/whoiscalebbrown/inkwell:1.2.3 \
  --repo WhoIsCalebBrown/inkwell
```

`imagetools inspect` must list a `linux/amd64` and a `linux/arm64` entry. The
release workflow asserts the same thing before it writes the release notes, so
a manifest missing an architecture fails the run rather than reaching a user.
(Entries with an `unknown/unknown` platform are the attestations, not
architectures.)

## How the update reaches people

Unraid does not watch this repository. It asks GHCR for the digest behind the
tag in the template — `:latest` — and compares it with the digest it already
pulled. A new release changes that digest, so the container's Docker page shows
**update ready**, and Update pulls the new image, removes the container, and
recreates it from the same saved template. The `/config` host path is part of
that template, so the appdata directory is untouched: the same SQLite database,
setup state, covers and backups are there when the new image starts. Commits,
branches and Git tags are invisible to it; only a published image digest is not.

Compose deployments are the same idea by hand:

```sh
docker compose pull && docker compose up -d
```

Pinning `INKWELL_VERSION=1.2.3` in `.env` opts out of both: the digest behind an
exact version never changes, so nothing will offer an upgrade until that value
does.

## Rolling back

Set `INKWELL_VERSION` to the previous version (or, on Unraid, edit the
template's repository tag) and redeploy. Migrations run forward only: if the
release you are leaving ran one, restore the pre-migration backup from
`/config/backups` before starting the older image. See the upgrade section of
[the self-hosting guide](self-hosting.md).

## Fixing a bad release

Do not move a published tag. Publish the next patch version instead: retagging
leaves everyone who already pulled with an image whose digest no longer matches
anything, and Unraid will offer them an "update" that is a downgrade.
