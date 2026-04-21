## What changed?

<!-- A short description. Reference issues with #number if applicable. -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Translation
- [ ] Documentation
- [ ] Context (.agents/) update
- [ ] Skill
- [ ] **Migration (4-repo rollout — Phase 0 ~ Phase 3 O1)**
- [ ] Other

## Migration policy

While the 4-repo migration is active (until Phase 3 O1 completes — see migration plan A.7):

- [ ] This PR is a **migration PR** — branch prefix `migration/*`, referenced in migration plan
- [ ] This PR touches `agent/**` or `gateway/**`
  - If checked without the migration prefix, please rebase the branch or split the change
- [ ] Neither of the above — normal work, freeze policy does not apply

## AI disclosure

- [ ] AI-assisted (specify tool below)
- [ ] Fully AI-generated
- [ ] No AI used

AI tool(s) used: <!-- e.g., Claude Code, Cursor, Copilot -->

## Checklist

- [ ] Tests included (new code requires new tests)
- [ ] Tests pass (`pnpm test`)
- [ ] App actually runs (VERIFY step)
- [ ] Context files updated if needed (.agents/ + .users/)
- [ ] License headers present on new files
- [ ] Commit messages in English
- [ ] AI attribution included (`Assisted-by:` trailer)

**Any language is welcome in the description.**
