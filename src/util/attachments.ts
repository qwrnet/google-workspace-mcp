import { constants } from 'node:fs';
import { lstat, open, readlink, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, relative, sep } from 'node:path';

/** Largest attachment google_gmail_save_attachment will write. Gmail itself caps received mail at 25 MB. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface AttachmentInfo {
  part_id: string;
  attachment_id: string | null;
  filename: string;
  mime_type: string;
  size: number;
}

interface MessagePart {
  partId?: string | null;
  mimeType?: string | null;
  filename?: string | null;
  body?: { attachmentId?: string | null; size?: number | null; data?: string | null } | null;
  parts?: MessagePart[] | null;
}

/**
 * Every part of a Gmail message payload that carries a named file, depth first. Parts
 * without a filename (body text, inline images referenced only by Content-ID) are skipped.
 */
export function listAttachments(payload: MessagePart | null | undefined): AttachmentInfo[] {
  const found: AttachmentInfo[] = [];
  const walk = (part: MessagePart) => {
    // A named leaf is a file, even a zero-byte one with neither data nor attachmentId. A named
    // container (a forwarded message/rfc822) counts when Gmail offers it as a whole attachment.
    if (part.filename && (part.body?.attachmentId || !part.parts?.length)) {
      found.push({
        part_id: part.partId ?? '',
        attachment_id: part.body?.attachmentId ?? null,
        filename: part.filename,
        mime_type: part.mimeType || 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    }
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return found;
}

/** Finds a part by its partId ("0", "1.2", ...), which unlike attachmentId is stable between fetches. */
export function findPart(payload: MessagePart | null | undefined, partId: string): MessagePart | undefined {
  if (!payload) return undefined;
  if ((payload.partId ?? '') === partId) return payload;
  for (const child of payload.parts ?? []) {
    const hit = findPart(child, partId);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Checks where an attachment may be written. The path must be absolute and normalized, its
 * parent must be an existing directory reached without symlinks, and when root is given the
 * file must be inside it. Returns an error message, or null when the path is acceptable.
 */
export async function checkOutputPath(outputPath: string, root?: string): Promise<string | null> {
  if (!isAbsolute(outputPath)) return `output_path must be absolute: ${outputPath}`;
  if (normalize(outputPath) !== outputPath || outputPath.endsWith(sep)) {
    return `output_path must be a normalized file path (no "..", "." or trailing slash): ${outputPath}`;
  }

  const parent = dirname(outputPath);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch {
    return `Parent directory does not exist: ${parent}`;
  }
  if (!parentStat.isDirectory()) return `Parent is not a directory: ${parent}`;

  const realParent = await realpath(parent);
  if (realParent !== parent) {
    return `Parent directory must not go through a symlink: ${parent} resolves to ${realParent}`;
  }

  if (root) {
    const rel = relative(await realpath(root).catch(() => root), outputPath);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return `output_path must be inside GOOGLE_ATTACHMENTS_ROOT (${root}): ${outputPath}`;
    }
  }
  return null;
}

/** Writes bytes to a new file (mode 600). Never overwrites or follows an existing file or symlink. */
export async function writeNewFile(outputPath: string, bytes: Buffer): Promise<void> {
  const handle = await open(outputPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(outputPath).catch(() => {});
    throw err;
  }
  await handle.close();
}

export interface OutputTarget {
  /** Creates the file inside the directory that was checked, even if its path has since been swapped. */
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

/**
 * Validates outputPath (see checkOutputPath) and holds its parent directory open across the
 * download. The confinement rules, decided once:
 *
 * - Linux (/proc available): after opening the parent, the kernel's path for the held directory
 *   (readlink /proc/self/fd/N) must equal the checked parent exactly. That covers a swap of any
 *   ancestor, not just the last component. The file is then created through that handle, so
 *   later swaps cannot redirect it.
 * - No /proc, GOOGLE_ATTACHMENTS_ROOT set: refused, since confinement cannot be guaranteed.
 * - No /proc, no root: best effort. The path is checked again just before the write. This guards
 *   against mistakes, not against a same-user process racing the write.
 */
export async function openOutputTarget(outputPath: string, root?: string): Promise<OutputTarget | { error: string }> {
  const pathError = await checkOutputPath(outputPath, root);
  if (pathError) return { error: pathError };
  if (await lstat(outputPath).then(() => true, () => false)) return { error: `File already exists: ${outputPath}` };

  const parent = dirname(outputPath);
  let dir: FileHandle;
  try {
    dir = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  } catch (err) {
    return { error: `Cannot open ${parent}: ${(err as NodeJS.ErrnoException).code || err}` };
  }

  const viaFd = `/proc/self/fd/${dir.fd}`;
  const heldPath = process.platform === 'linux' ? await readlink(viaFd).catch(() => null) : null;
  if (heldPath !== null) {
    if (heldPath !== parent) {
      await dir.close();
      return { error: `Parent directory changed while it was being checked: ${parent}` };
    }
    const target = `${viaFd}/${basename(outputPath)}`;
    return { write: (bytes) => writeNewFile(target, bytes), close: () => dir.close() };
  }

  await dir.close();
  if (root) return { error: 'GOOGLE_ATTACHMENTS_ROOT needs /proc/self/fd (Linux) to confine writes safely' };
  return {
    write: async (bytes) => {
      const again = await checkOutputPath(outputPath);
      if (again) throw new Error(again);
      await writeNewFile(outputPath, bytes);
    },
    close: async () => {},
  };
}
