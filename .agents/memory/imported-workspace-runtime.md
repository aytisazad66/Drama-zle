---
name: Imported workspace runtime
description: Replit-specific startup behavior for this imported multi-artifact workspace
---

The imported workspace may have no installed workspace dependencies even when the lockfile is present. Install from the lockfile before starting artifact workflows.

**Why:** The Expo workflow fails with `Command "expo" not found` when the workspace has not been installed; this is an environment setup issue rather than an Expo code issue.

**How to apply:** Treat the artifact configuration as the source of truth for runtime ports. The API artifact receives its port from the workflow (currently 8080) and is exposed through `/api`; do not assume the generic API template port 5000.