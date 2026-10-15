# Publish to npm under the mcdp-adk organization

The package is published to npm as `@mcdp-adk/pi-telegram-notify`, under the npm organization named after the GitHub owner, and installing from the git repository stays supported. An npm install gives the developer a release to pin and upgrade from, rather than whatever `main` holds, and a published name can never be reused, so it matches the GitHub repository rather than an npm user. Releases are published by a workflow through npm trusted publishing, so no npm token exists. npm trusts a workflow only for a package that already exists, so 0.1.0 is published by hand and carries no provenance.

## Considered Options

- Git as the only source: pi installs it without a registry, but every install follows a branch or a hand-picked commit rather than a release.
- The unscoped name `pi-telegram-notify`: free, but a permanent name outside the owner's organization, unlike the owner's other pi packages.
- Publishing every release by hand: needs no workflow, but each release depends on a logged-in machine and carries no provenance.
- A placeholder version published by hand so that 0.1.0 could come from the workflow with provenance: takes a second hand publish to gain provenance on one release.
