import { writeFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { tempDir } from '@tauri-apps/api/path';

/**
 * Write binary data to a temp file and return the absolute path.
 * Consolidates all `writeFile + tempDir + path join` patterns in the codebase.
 */
export async function writeTempFile(fileName: string, data: Uint8Array): Promise<string> {
  await writeFile(fileName, data, { baseDir: BaseDirectory.Temp });
  const dir = await tempDir();
  return `${dir}${dir.endsWith('/') ? '' : '/'}${fileName}`;
}
