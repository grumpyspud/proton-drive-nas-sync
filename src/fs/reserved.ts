/**
 * The app's reserved folder namespace. Any folder whose name starts with
 * `.pdn-` is owned by the sync engine and must never be user-created or shown
 * in a folder picker:
 *   - `.pdn-trash`   the local recycle directory
 *   - `.pdn-part`    in-progress transfer temp files
 *   - `.pdn-device`  the future "Computers" device root (reserved ahead of time)
 */
export function isReservedDirName(name: string): boolean {
    return name.startsWith('.pdn-');
}
