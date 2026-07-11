import type { Message } from "@starbase/core"
import { Eyebrow, ClaudeGlyph } from "../components/eyebrow.js"
import { Button } from "../components/button.js"
import { StatusDot } from "../components/status-dot.js"
import { ToolCall } from "../composites/tool-call.js"
import { ThoughtBlock } from "../composites/thought-block.js"
import { Composer } from "../composites/composer.js"

/** Central transcript column: user/assistant turns, tool cards, gate, composer. */
export function ConversationView({ messages }: { messages: ReadonlyArray<Message> }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col gap-6 overflow-auto px-[30px] py-[26px]">
        {messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="flex flex-col gap-1.5">
              <Eyebrow>You</Eyebrow>
              <p className="m-0 max-w-[640px] text-[14.5px] leading-[1.6] text-text-body">{m.text}</p>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col gap-3">
              <Eyebrow accent icon={<ClaudeGlyph />}>
                Claude
              </Eyebrow>
              {m.thinking && (
                <ThoughtBlock seconds={4} defaultOpen className="max-w-[640px]">
                  {m.thinking}
                </ThoughtBlock>
              )}
              {m.text && (
                <p className="m-0 max-w-[640px] text-[14.5px] leading-[1.65] text-text-body">{m.text}</p>
              )}
              {m.toolCalls.map((tc) => (
                <ToolCall
                  key={tc.id}
                  status="success"
                  name={tc.name}
                  target={tc.target}
                  meta={tc.diff ? `+${tc.diff.added} −${tc.diff.removed}` : tc.summary}
                  className="max-w-[640px]"
                />
              ))}
              {m.gate && (
                <div className="max-w-[640px] overflow-hidden rounded-xl border border-yellow/35 bg-yellow/[0.06]">
                  <div className="flex items-center gap-2.5 px-3 py-2 text-[12.5px] font-semibold text-yellow">
                    <StatusDot tone="bg-yellow" size={7} pulse />
                    {m.gate.title}
                  </div>
                  <p className="m-0 px-3 pb-2.5 text-[13px] leading-[1.55] text-text">{m.gate.detail}</p>
                  <div className="flex gap-2 px-3 pb-3">
                    <Button variant="secondary" size="sm">
                      Reject
                    </Button>
                    <Button variant="primary" size="sm" className="bg-green text-editor hover:bg-green/90">
                      Approve
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )
        )}
      </div>
      <div className="flex-none px-[22px] pb-[18px] pt-[11px]">
        <Composer />
      </div>
    </div>
  )
}
