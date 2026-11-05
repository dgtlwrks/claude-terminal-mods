// The person's layout file as a test session sees it: absent, the given layout (or text), or an Error to throw.

// biome-ignore lint: the test registrar's overloads are not worth spelling out here
export function layoutFiles(on: any, own?: unknown) {
  on('env.get', (_$: unknown, e: { name: string }) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.read', (_$: unknown, e: { path: string }) => {
    if (own instanceof Error) throw own // a file that exists and cannot be read
    return e.path === '/home/test/.claude/terminal-layout.json' && own !== undefined
      ? { value: typeof own === 'string' ? own : JSON.stringify(own) }
      : { deny: 'ENOENT: no such file' }
  })
}
