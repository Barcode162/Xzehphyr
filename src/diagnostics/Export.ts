/**
 * Local-only export helpers. Files are created in the browser and handed to the
 * user (download link, Web Share sheet, or a new tab). Nothing is uploaded.
 */

export function downloadText(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** iOS-friendly: try the share sheet with a file, fall back to download. */
export async function shareOrDownload(filename: string, text: string, mime: string): Promise<string> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  try {
    const file = new File([text], filename, { type: mime });
    if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
      await nav.share({ files: [file], title: filename });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
  }
  downloadText(filename, text, mime);
  return 'downloaded';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
