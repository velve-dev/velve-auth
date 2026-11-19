# Security policy

`@velve/auth` decides who is signed in, so a fault in it can hand one person's
account to another. Please report anything that could do that privately, and
not in a public issue, pull request or discussion.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**, or go to
<https://github.com/velve-dev/velve-auth/security/advisories/new>.

A useful report says:

- the version or commit you tested;
- the configuration that matters (identity mode, enabled factors, plugins);
- the steps or a test that shows the problem, and what an attacker gains;
- whether you have told anyone else.

You get an answer within seven days. The report stays private while a fix is
prepared. When the fixed version is published, the advisory is published with
it, and you are credited unless you ask not to be.

## Supported versions

Only the newest major version receives security fixes. A fix is released as a
new version of that major; older majors get no further releases.

## Scope

In scope: the published package — everything under `src/`, the shipped
migrations, the HTTP handler, the client export — and the release workflow
that builds it.

Out of scope: the consuming application's own code, its reverse proxy, its
mail delivery and its database administration. `DOCUMENTATION.md` and the
guide under `docs/guide/` say what an application must still protect itself.
