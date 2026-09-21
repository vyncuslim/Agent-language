# Retired VAML 0.1 history migration (procedure only)

No history rewrite, force push, repository deletion, release deletion or tag deletion was performed.

## Confirmed historical exposure

Commit 68342a2 contains the retired public 0.1 16-bit semantic registry, readable examples, grammar, specification and Python codec. The active branch removed these through f212e9c, 2e94fbf, 35484b1, 60a2889, 7ec9aaf and 774184c. Deleting current files does not remove their historical blobs.

Known paths:

- registry/vaml-core-0.1.json
- spec/VAML-0.1.md
- spec/grammar.ebnf
- examples/training.jsonl
- sdk/python/vaml.py
- tests/test_vaml.py

Old README.md, AGENTS.md and manifest revisions also describe readable semantics and examples. Removing only the six paths is not a complete purge. Inspect every branch, tag, renamed copy, commit message and public artifact before choosing filters. The remote tag listing was empty at this review; verify again before any future operation.

0.2 no longer imports these files. Private HMAC identities and fresh session codes do not derive from the published 0.1 registry. History cleanup is not required to make an unrelated 0.2 semantic key secret.

## Authorized future cleanup plan

1. Obtain explicit owner authorization for rewritten refs and any branch protection changes. Announce a write freeze and coordinate forks, open PRs, integrations and collaborators.
2. On a protected backup volume, create a mirror clone and an offline bundle. Preserve a second untouched mirror, all refs, release metadata and artifacts. A mirror alone does not back up release assets or server-side PR refs.
3. Test git filter-repo in a disposable copy of that backup; record the exact tool version and commit/ref map. Do not run the filter against an active checkout.
4. Inventory historical copies, including renamed files and readable sections in README/AGENTS/manifest. The following removes only known legacy paths; it is deliberately not represented as a complete purge:

```sh
git clone --mirror https://github.com/vyncuslim/Agent-language.git Agent-language-backup.git
git -C Agent-language-backup.git bundle create ../Agent-language-before-rewrite.bundle --all
git -C Agent-language-backup.git bundle verify ../Agent-language-before-rewrite.bundle
git clone --mirror --no-local Agent-language-backup.git Agent-language-filtered.git
git -C Agent-language-filtered.git filter-repo --invert-paths \
  --path registry/vaml-core-0.1.json \
  --path spec/VAML-0.1.md --path spec/grammar.ebnf \
  --path examples/training.jsonl --path sdk/python/vaml.py \
  --path tests/test_vaml.py
```

5. For mixed modern/legacy files, prepare a reviewed content/blob callback or replacement rules in a private external file. Match historical contents precisely; do not globally remove arbitrary English words from modern source. Preserve a complete current 0.2 snapshot for comparison.
6. Scan all surviving refs and reachable objects, inspect rewritten diffs, run npm ci/build/tests/demo/privacy, and compare current trees. Re-sign commits/tags only under the owner's agreed policy. Rewrites change SHAs, signatures, PR diffs and downstream commit references.
7. Prepare a proposed old-to-new ref list and backup recovery procedure for owner review. **Stop before pushing rewritten history until specifically authorized.** No automatic force-push command is included here. Prefer explicitly listed refs and expected-old-ref checks; never use a blind mirror push that could delete unrelated refs.
8. After an approved migration, have collaborators make fresh clones and prevent old branches from reintroducing history. Coordinate GitHub support for server caches/PR refs if needed.

A rewrite cannot revoke existing public clones, forks, downloads, caches or screenshots. If actual credentials were ever exposed, revoke/rotate them independently of history deletion. Preserve old backups privately and access-control them; backups retain removed material.
