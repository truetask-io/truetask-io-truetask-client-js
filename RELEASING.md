# Releasing

A tag publishes this package.
No token is stored anywhere: npm authenticates the workflow itself through OIDC, which it calls trusted publishing, and the same identity signs the tarball so the npm page shows it as provenance.

## Once, before the first release

1. Create `truetask-io/truetask-client-js` on GitHub, empty.
   Decline the README and the license it offers, since this history already has them.
2. Add a deploy key with write access, then push `main`.
3. Sign in to npm as `truetask`.
   `@truetask` is that account's own scope, so no organisation is needed.
4. Publish `0.1.0` once by hand, so the package exists for a trusted publisher to be attached to:

```bash
npm login
npm publish --access public
```

   This one has no provenance, since provenance is signed by a CI run and a laptop is not one.
   That is why `--provenance` lives in the workflow and not in `publishConfig`: there it would make this command fail.
   Every version after it carries provenance.

5. Attach the trusted publisher while still signed in, then read it back:

```bash
npm trust github @truetask/db --file publish.yml --repo truetask-io/truetask-client-js --env npm
npm trust list @truetask/db
```

   npm asks for the second factor, so this runs in a terminal and never in CI.
   The list is the only way to check the publisher short of a release.
   The package's Settings -> Trusted publisher page on npm does the same, with the same three values.

6. GitHub creates the `npm` environment the first time the workflow names it.
   Create it ahead in Settings -> Environments only to add yourself as a required reviewer.
7. Sign out with `npm logout`, which revokes the token `npm login` made instead of only deleting its copy.
   Every release after the first one goes through the workflow.

## Each release

1. Bump `version` in `package.json`.
2. Move the changelog's top section from `unreleased` to the version.
3. Commit, then tag and push:

```bash
git tag v0.1.0
git push origin main v0.1.0
```

The workflow refuses a tag that disagrees with `package.json`, runs the tests, and publishes with provenance.
A version already on npm is left alone, so the tag of the hand-published `0.1.0` runs green and publishes nothing.

npm only unpublishes a version inside 72 hours, and only when nothing depends on it.
After that a mistake costs a patch release.
