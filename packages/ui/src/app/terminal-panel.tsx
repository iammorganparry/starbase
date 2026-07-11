/** Bottom terminal pane with shell tabs and a sample session. */
export function TerminalPanel() {
  return (
    <div className="flex h-[256px] flex-none flex-col border-t border-hairline bg-sunken">
      {/* Shell tabs */}
      <div className="flex h-9 flex-none items-stretch border-b border-hairline bg-panel pr-2">
        <div className="flex items-center gap-2 border-r border-hairline border-t-2 border-t-blue bg-sunken px-3.5">
          <span className="size-1.5 rounded-full bg-green" />
          <span className="font-mono text-[11.5px] text-text-bright">zsh — api</span>
        </div>
        <div className="flex items-center gap-2 border-r border-hairline px-3.5 opacity-60">
          <span className="size-1.5 rounded-full bg-line-strong" />
          <span className="font-mono text-[11.5px] text-muted-foreground">node</span>
        </div>
        <span className="flex items-center px-3 text-[16px] text-dim">+</span>
        <div className="flex-1" />
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-4 py-2.5 font-mono text-[12px] leading-[1.75] text-text">
        <div>
          <span className="text-green">➜</span>&nbsp;&nbsp;
          <span className="font-semibold text-cyan">api</span>{" "}
          <span className="text-blue">git:(</span>
          <span className="text-red">feat/oauth</span>
          <span className="text-blue">)</span> <span className="text-yellow">✗</span> npm test
        </div>
        <div className="h-2" />
        <div>
          <Pass /> <span className="text-muted-foreground">src/auth/</span>session.test.ts
        </div>
        <div>
          <Pass /> <span className="text-muted-foreground">src/auth/</span>refresh.test.ts
        </div>
        <div className="h-2" />
        <div>
          <span className="text-muted-foreground">Tests:</span> <span className="text-green">24 passed</span>, 24 total
        </div>
        <div>
          <span className="text-muted-foreground">Time:</span>&nbsp;&nbsp;3.42s
        </div>
        <div className="h-2.5" />
        <div>
          <span className="text-green">➜</span>&nbsp;&nbsp;
          <span className="font-semibold text-cyan">api</span>{" "}
          <span className="text-blue">git:(</span>
          <span className="text-red">feat/oauth</span>
          <span className="text-blue">)</span> <span className="text-yellow">✗</span>{" "}
          <span className="inline-block h-[15px] w-2 -translate-y-px bg-text align-middle [animation:var(--animate-pulse-dot)]" />
        </div>
      </div>

      {/* Footer */}
      <div className="flex h-7 flex-none items-center gap-2.5 border-t border-hairline bg-panel px-4 font-mono text-[10.5px] text-dim">
        <span>
          <span className="text-green">zsh</span> · ~/dev/trigify/api
        </span>
        <span className="text-line">·</span>
        <span>
          last exit <span className="text-green">0</span>
        </span>
        <div className="flex-1" />
        <span>⌃` toggle</span>
      </div>
    </div>
  )
}

function Pass() {
  return <span className="rounded-sm bg-green px-1.5 font-bold text-editor">PASS</span>
}
