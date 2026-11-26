# Fork build: PancakeSlicer + "Shared folder"

Branches
- `feat/shared-folder`: the feature commits on top of upstream `main` (the upstream PR content).
- `hl/main`: `feat/shared-folder` + this directory (derived Dockerfile, this note). This is what we build.
  Feature fixes land on `feat/shared-folder` first and are merged into `hl/main`; the rebase below flattens those merges.

Remotes: `upstream` = github.com/ZimengXiong/PancakeSlicer, `origin` = github.com/SteffOps/PancakeSlicer,
`forgejo` = forgejo.iot.hl-sf.de/steffen/PancakeSlicer (mirror for our build).

## Update to a new upstream release (new pin)

```sh
git fetch upstream --tags
NEW=v0.5.7                       # upstream tag that matches the image tag zimengxiong/pancakeslicer:0.5.7
OLD=$(git rev-parse feat/shared-folder)       # remember the feature head before rebasing
git checkout feat/shared-folder
git rebase "$NEW"                # or upstream/main; resolve conflicts in server/ and web/src/
git rebase --onto feat/shared-folder "$OLD" hl/main   # replay the fork-only commits on the rebased feature
docker build -f deploy/share/Dockerfile \
  --build-arg BASE=zimengxiong/pancakeslicer:${NEW#v} \
  --build-arg REVISION=$(git rev-parse HEAD) \
  -t pancakeslicer-share:${NEW#v} .
git push --force-with-lease origin feat/shared-folder hl/main
git push --force-with-lease forgejo feat/shared-folder hl/main
```

Rules
- The source tree and `BASE` must be the same upstream version: the Dockerfile replaces only the Go service
  (`/app/engine/orca-webapp-server`) and the web UI (`/app/web-share`); the engine/resources come from `BASE`.
  A server built from a newer tree than the base engine can mismatch the engine contract.
- Smoke after build: `GET /api/boot` has `"share":true` with `ORCA_WEB_SHARE_DIR` set, `GET /api/share` lists the mount,
  open/slice one model, save one project, and a run without `ORCA_WEB_SHARE_DIR` returns 404 on `/api/share`.
- If upstream merges the feature (or reimplements it as a Co-authored-by commit), drop `feat/shared-folder`, switch
  back to the plain upstream image and keep only the env/volume config.

## Runtime

```
-v /mnt/<nas-folder>:/share -e ORCA_WEB_SHARE_DIR=/share
```

Optional: `ORCA_WEB_MAX_UPLOAD_MB` caps writes; `ORCA_WEB_BEARER_TOKEN` also gates the read routes.
Hidden from listing and refused as path elements: dot entries, `@eaDir`, `#recycle`, `#snapshot` (Synology metadata).
Only `.stl .3mf .obj .step .stp .gcode` (incl. `.gcode.3mf`) are listed, read or written.
