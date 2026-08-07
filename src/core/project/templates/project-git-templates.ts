// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * project-git-templates — the two files written into a new folder project
 * (plan-372 Phase 15).
 *
 * A project is meant to live in git. Without these, the first commit of a real
 * project is a multi-hundred-megabyte blob of GLBs stored as text diffs, and
 * the second one is a merge conflict in a binary. Writing them at creation time
 * is the only moment the user is guaranteed to be there.
 */

/**
 * `.gitattributes` — routes binary artefacts to LFS and stops git from trying
 * to diff or line-ending-normalise them.
 *
 * `-text` matters as much as the LFS filter: on Windows, git would otherwise
 * happily CRLF-mangle a `.glb` and corrupt it.
 */
export const GITATTRIBUTES_TEMPLATE = `# realvirtual project - binary artefacts
*.glb    filter=lfs diff=lfs merge=lfs -text
*.gltf   filter=lfs diff=lfs merge=lfs -text
*.splat  filter=lfs diff=lfs merge=lfs -text
*.ksplat filter=lfs diff=lfs merge=lfs -text
*.ply    filter=lfs diff=lfs merge=lfs -text
*.aasx   filter=lfs diff=lfs merge=lfs -text
*.pdf    filter=lfs diff=lfs merge=lfs -text
*.png    filter=lfs diff=lfs merge=lfs -text
*.jpg    filter=lfs diff=lfs merge=lfs -text

# Scene and manifest JSON stay plain text - they are meant to be reviewed.
*.json   text eol=lf
*.rvscene text eol=lf
`;

/**
 * `.rvprojectignore` — what never belongs in a project, and therefore never in
 * an exported `.rvproject` either.
 *
 * Caches are the important entry: they are derived data, they are large, and
 * plan-370 R4 says they live neither in the project nor in the workspace.
 */
export const RVPROJECTIGNORE_TEMPLATE = `# Derived data - never travels with the project
.cad-cache/
.trash/
*.tmp

# Secrets - see scripts/_rv-guards.mjs (SECRET_FILE_PATTERNS), which fails a
# build, a delivery and a deploy on these.
#
# secrets.local.json is the one that matters most in practice: CONNECT reads
# connect/secrets.local.json for gateway credentials, so it is the file a live
# project is most likely to acquire and least likely to notice (plan-370 §3.8).
.env
.env.*
.mcp_auth_token
secrets.local.json
*.secrets.json
*.pem
*.p12
*.pfx
credentials.json

# OS noise
.DS_Store
Thumbs.db
`;

/** File name / contents pairs to write when a folder project is created. */
export const PROJECT_GIT_TEMPLATES: { name: string; contents: string }[] = [
  { name: '.gitattributes', contents: GITATTRIBUTES_TEMPLATE },
  { name: '.rvprojectignore', contents: RVPROJECTIGNORE_TEMPLATE },
];
