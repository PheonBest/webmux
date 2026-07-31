import { randomUUID } from "node:crypto";

export function generateFallbackBranchName(): string {
  return `change-${randomUUID().slice(0, 8)}`;
}

/** Name for a temporary "recovery" worktree/branch spun up to hold uncommitted
 *  changes relocated out of the main repo root (see
 *  `relocateUncommittedChangesToWorktree` in adapters/git.ts and
 *  `LifecycleService.recoverDirectSwitchConflict`). Prefixed `resolve-` so it
 *  reads as an auto-created recovery artifact rather than a normal feature
 *  branch someone chose to work on. */
export function generateRecoveryBranchName(baseBranch: string): string {
  return `resolve-${baseBranch}-${randomUUID().slice(0, 8)}`;
}
