# Release automation for d1zzle + d1zzle-migrate (published in lockstep).
#
#   make release          # 0.1.3 -> 0.1.4   (patch; the default)
#   make release patch    # same as above, spelled out
#   make release minor    # 0.1.3 -> 0.2.0
#   make release major    # 0.1.3 -> 1.0.0
#   make release-dry      # print what a release would do, change nothing
#
# The GitHub Release is what publishes to npm — `.github/workflows/release.yml`
# triggers on `release: published`, not on a pushed tag. So this target's last
# step is `gh release create`, and everything before it exists to make sure that
# step cannot fire against a broken tree. See RELEASING.md.

SHELL := /bin/bash
.PHONY: release release-dry check major minor patch

# `make release minor` passes "minor" as a second *goal*, not an argument, so we
# pick it out of MAKECMDGOALS and declare no-op targets for the three words
# below — otherwise make would fail with "No rule to make target 'minor'".
BUMP := $(or $(filter major minor patch,$(MAKECMDGOALS)),patch)
major minor patch:
	@:

CURRENT = $(shell node -p "require('./package.json').version")
NEXT = $(shell node -e "const [a,b,c]=require('./package.json').version.split('.').map(Number); \
	console.log({major:[a+1,0,0],minor:[a,b+1,0],patch:[a,b,c+1]}['$(BUMP)'].join('.'))")

check:
	npm run check

release-dry:
	@echo "bump:    $(BUMP)"
	@echo "current: $(CURRENT)"
	@echo "next:    $(NEXT)  (tag v$(NEXT))"

release:
	@# A dirty tree would get swept into the release commit by `commit -am`.
	@test -z "$$(git status --porcelain)" \
		|| { echo "error: working tree is dirty; commit or stash first"; exit 1; }
	@# The workflow only exists on the default branch, and the tag must point at
	@# what CI will actually check out.
	@test "$$(git rev-parse --abbrev-ref HEAD)" = "main" \
		|| { echo "error: not on main"; exit 1; }
	@command -v gh >/dev/null \
		|| { echo "error: gh is not installed"; exit 1; }
	@gh auth status >/dev/null 2>&1 \
		|| { echo "error: gh is not authenticated; run 'gh auth login'"; exit 1; }
	@# npm has no unpublish story worth relying on, so refuse a version that is
	@# already on the registry rather than discovering it in the workflow.
	@! npm view d1zzle@$(NEXT) version >/dev/null 2>&1 \
		|| { echo "error: d1zzle@$(NEXT) is already published"; exit 1; }
	@echo "==> releasing $(CURRENT) -> $(NEXT) ($(BUMP))"
	npm run version:set $(NEXT)
	npm run check
	git commit -am "Release $(NEXT)"
	git push
	gh release create v$(NEXT) --generate-notes --title "v$(NEXT)"
	@echo "==> released v$(NEXT); watch the publish with: gh run watch"
