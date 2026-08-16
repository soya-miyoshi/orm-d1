# Contributing

**Short version: issues are welcome, but I cannot promise a reply. Pull requests are very
unlikely to be merged — please don't write one expecting that. If you depend on this
software, fork it.**

## Why you are seeing this

GitHub shows this file when you start a pull request or open an issue, so it is worth being
straight with you at the point where you would otherwise begin work.

The project is maintained; it is not open to contributions. Those are different things, and
what follows is about my capacity to review and own other people's changes, not about how
welcome you are here.

### Pull requests

**Likely to go unmerged.** Reviewing a patch properly means understanding it, checking it
against the invariants in [`CLAUDE.md`](./CLAUDE.md), running it, and then owning it
afterwards — and that last part is the one I cannot commit to. So please do not spend an
evening on a patch for this repository on the assumption it will land. It probably will
not, and I would rather you knew that beforehand than found out by waiting.

If you have already written one, you are welcome to open it. Just treat it as a public
record for other people running forks rather than as something in a queue.

### Issues

**Welcome — genuinely. I just cannot guarantee a response.**

Open one. A described bug, a reproduction, a note that some corner of D1 behaves
differently than documented: all of that is worth having written down, and an issue is
useful to the next person even if I never reply to it. Several forks reading the same
public bug report is a better outcome than everyone rediscovering it privately.

So: no response guarantee, no triage promise, no timeline. Not a closed door either.

### Feature requests

You can file one, under the same terms — it is a note for whoever picks this up, not a
request I am able to act on.

## Security

I **cannot guarantee the security of this software.** There is no embargo process, no
advisory, and no promise that a fix ships on any particular timeline.

You are welcome to open an issue for a vulnerability, and for anything already public that
is probably the right call — it warns other people running forks. But please do not wait on
a patch from here before protecting your own users. Fix it in your fork and tell them.

[`docs/07-security.md`](./docs/07-security.md) documents what the compiler guarantees, which
APIs opt out of those guarantees, and where the trust boundaries sit. It is written for
someone auditing their own copy, because that is the review that will actually happen.

## What to do if you depend on this

**Fork it.** The MIT license permits that without condition, and it is the arrangement that
matches reality: you own the copy you run, you review it, and you patch it on your own
schedule rather than waiting on an upstream that is not answering.

If you want your fork to be usable by others, publish it under your own package name. You
do not need permission and you do not need to ask.

The repository is set up to make that viable rather than merely legal:

```bash
npm install
npm run check   # typecheck → build → test → kit typecheck → kit build
```

Tests run in two projects — Node for the pure layers, workerd with a real D1 binding for
everything that touches the platform. [`docs/`](./docs/README.md) documents the library's
behaviour, and [`kit/README.md`](./kit/README.md) the migration CLI.
[`CLAUDE.md`](./CLAUDE.md) states the invariants that govern changes: no dependencies in
`src/`, no symbol that Drizzle does not also have, and never loosening a test to reach
green.

## If this changes

If enough funding or a volunteer maintainer appears, this file will say so. The project is
otherwise in a state where it could be picked up — the design is written down, the test
suite is real, and releases are automated.
