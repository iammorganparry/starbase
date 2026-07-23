import { describe, expect, it } from "vitest"
import { parseCodexSkillRoots } from "./codex-skills.js"

describe("parseCodexSkillRoots", () => {
  it("keeps only enabled installed plugins", () => {
    expect(
      parseCodexSkillRoots(
        JSON.stringify({
          installed: [
            {
              name: "figma",
              installed: true,
              enabled: true,
              source: { path: "/plugins/figma" }
            },
            {
              name: "disabled",
              installed: true,
              enabled: false,
              source: { path: "/plugins/disabled" }
            }
          ]
        })
      )
    ).toStrictEqual([{ sourcePath: "/plugins/figma", namespace: "figma" }])
  })

  it("treats malformed CLI output as no plugin skills", () => {
    expect(parseCodexSkillRoots("not json")).toStrictEqual([])
  })
})
