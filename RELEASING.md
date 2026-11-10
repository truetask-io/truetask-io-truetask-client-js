# Releasing

A tag publishes this package.
No token is stored anywhere: npm authenticates the workflow itself through OIDC, which it calls trusted publishing, and the same identity signs the tarball so the npm page shows it as provenance.

## Once, before the first release

1. Create `truetask-io/truetask-client-js` on GitHub, empty.
   Decline the README and the license it offers, since this history already has them.
2. Add a deploy key with write access, then push `main`.
3. Create the `@truetask` organisation on npm.
   A scope cannot be created by a publish, so this comes first.
   Public packages in it are free.
4. Publish `0.1.0` once by hand, so the package exists for a trusted publisher to be attached to:

```bash
npm login
npm publish --access public
```

5. On npm, open the package's Settings -> Trusted publisher -> GitHub Actions:
   - Repository: `truetask-io/truetask-client-js`
   - Workflow: `publish.yml`
   - Environment: `npm`

6. In the repo's Settings -> Environments, create `npm`.
7. Remove the token `npm login` wrote: `rm ~/.npmrc`.
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

npm only unpublishes a version inside 72 hours, and only when nothing depends on it.
After that a mistake costs a patch release.
