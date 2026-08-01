import { lstatSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const SYMLINK_PATH = resolve(import.meta.dirname, '..', '.opencode', 'plugins', 'anthropic-auth')

// existsSync follows the link, so a dangling one would look absent.
if (lstatSync(SYMLINK_PATH, { throwIfNoEntry: false })) {
  unlinkSync(SYMLINK_PATH)
  console.log('[dev:clean] Removed symlink')
} else {
  console.log('[dev:clean] No symlink found, nothing to clean')
}
