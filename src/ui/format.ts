export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function formatSeconds(s: number): string {
  if (!isFinite(s)) return '...'
  if (s < 1) return '<1 s'
  if (s < 90) return `${Math.round(s)} s`
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export const isTextLike = (mime: string, name: string): boolean =>
  mime.startsWith('text/') || /\.(txt|md|json|csv)$/i.test(name)
