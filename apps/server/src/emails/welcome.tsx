/** 02 · Welcome — sent right after the account goes live. */
import * as React from "react"
import { Column, Row, Section, Text } from "@react-email/components"
import { EmailShell, H1, Mono, P, MarketingFooter, PrimaryButton } from "./components.js"
import { color, font, radius } from "./theme.js"

export interface WelcomeProps {
  /** The recipient (shown in the footer). */
  email: string
  /** Deep link that opens the app. */
  openUrl: string
  /** Quickstart docs link. */
  quickstartUrl: string
}

export const welcomeSubject = "You're in — welcome to Starbase"

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <Section style={{ marginBottom: "14px" }}>
      <Row>
        <Column style={{ width: "22px", verticalAlign: "top" }}>
          <div
            style={{
              width: "22px",
              height: "22px",
              borderRadius: radius.full,
              background: color.raised,
              border: `1px solid ${color.border}`,
              textAlign: "center",
              lineHeight: "22px",
              fontFamily: font.mono,
              fontSize: "11px",
              color: color.accent
            }}
          >
            {n}
          </div>
        </Column>
        <Column style={{ paddingLeft: "13px", verticalAlign: "top" }}>
          <Text
            style={{
              margin: 0,
              fontSize: "14px",
              lineHeight: 1.45,
              color: color.body,
              fontFamily: font.sans
            }}
          >
            {children}
          </Text>
        </Column>
      </Row>
    </Section>
  )
}

export function Welcome({ email, openUrl, quickstartUrl }: WelcomeProps) {
  return (
    <EmailShell
      preview="Run your first agent session in under a minute."
      footer={<MarketingFooter to={email} />}
    >
      <H1>
        Welcome to Starbase <span style={{ color: color.accent }}>✦</span>
      </H1>
      <P style={{ margin: "0 0 20px" }}>
        Your account&apos;s live. Starbase runs your local coding agents — <Mono size="13px">claude</Mono>,{" "}
        <Mono size="13px">codex</Mono>, <Mono size="13px">gpt</Mono> — as parallel sessions, each wired
        to a repo, branch, and PR. Here&apos;s the fast path:
      </P>
      <Step n={1}>Point Starbase at a repo — it reads your branch and open PR automatically.</Step>
      <Step n={2}>
        Start a session and hand the agent a task — <Mono size="12.5px">&quot;Refactor auth flow&quot;</Mono>.
      </Step>
      <Step n={3}>Review the diff, run checks, and merge — without leaving the window.</Step>
      <Section style={{ marginTop: "12px" }}>
        <PrimaryButton href={openUrl}>Open Starbase</PrimaryButton>
      </Section>
      <P style={{ margin: "20px 0 0", fontSize: "13px" }}>
        <a href={quickstartUrl} style={{ color: color.link, textDecoration: "none" }}>
          Read the 2-minute quickstart →
        </a>
      </P>
    </EmailShell>
  )
}

Welcome.PreviewProps = {
  email: "you@acme.dev",
  openUrl: "https://app.starbase.dev/open",
  quickstartUrl: "https://docs.starbase.dev/quickstart"
} satisfies WelcomeProps

export default Welcome
