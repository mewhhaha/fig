# Release Checklist

Use this checklist for `0.0.x` releases.

1. Confirm versions match:
   - `deno.json`
   - `src/version.ts`
   - `CHANGELOG.md`
2. Run local verification:
   - `deno task check`
   - `deno task test`
   - `deno task entrypoint:check`
   - `deno task release:binary:check`
3. Commit the release changes.
4. Create and push the tag:

```bash
git tag v0.0.1
git push origin v0.0.1
```

5. Confirm the GitHub Release has Linux, macOS, Windows, and `SHA256SUMS` assets.
